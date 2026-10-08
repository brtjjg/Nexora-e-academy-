// routes/security.js
// Read-only security monitoring API for admins.
// Mounted at: /api/security
// Requires admin or super_admin role.

const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../utils');
const { requireAuth } = require('../middleware');
const {
    getThresholds,
    blockIp,
    unblockIp,
    purgeOldEvents,
} = require('../utils/security');

// Gate for the whole router
function requireAdminRole(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!['admin', 'super_admin'].includes(req.user.role)) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

router.use(requireAuth, requireAdminRole);

// ─────────────────────────────────────────────
// GET /api/security/summary — top-line stats
// ─────────────────────────────────────────────
router.get('/summary', asyncHandler(async (req, res) => {
    const [events24h, blockedActive, blockedTotal, severityCounts, topIps] = await Promise.all([
        db.query(`SELECT COUNT(*)::int AS c FROM security_events
                  WHERE created_at > NOW() - INTERVAL '24 hours'`),
        db.query(`SELECT COUNT(*)::int AS c FROM blocked_ips
                  WHERE expires_at IS NULL OR expires_at > NOW()`),
        db.query(`SELECT COUNT(*)::int AS c FROM blocked_ips`),
        db.query(`SELECT severity, COUNT(*)::int AS c FROM security_events
                  WHERE created_at > NOW() - INTERVAL '24 hours'
                  GROUP BY severity`),
        db.query(`SELECT ip_address, COUNT(*)::int AS c
                  FROM security_events
                  WHERE created_at > NOW() - INTERVAL '24 hours'
                  GROUP BY ip_address
                  ORDER BY c DESC LIMIT 10`),
    ]);

    const bySeverity = { low: 0, medium: 0, high: 0, critical: 0 };
    severityCounts.rows.forEach(r => { bySeverity[r.severity] = r.c; });

    res.json({
        events_24h: events24h.rows[0].c,
        blocked_active: blockedActive.rows[0].c,
        blocked_total: blockedTotal.rows[0].c,
        by_severity: bySeverity,
        top_ips: topIps.rows,
    });
}));

// ─────────────────────────────────────────────
// GET /api/security/events — recent events (paginated)
// ─────────────────────────────────────────────
router.get('/events', asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const severity = req.query.severity || null;
    const type = req.query.type || null;

    const params = [];
    const where = [];
    let idx = 1;

    if (severity && ['low','medium','high','critical'].includes(severity)) {
        where.push(`severity = $${idx++}`);
        params.push(severity);
    }
    if (type) {
        where.push(`event_type = $${idx++}`);
        params.push(type);
    }

    params.push(limit);
    const sql = `
        SELECT id, event_type, severity, ip_address, user_agent,
               method, path, user_id, details, created_at
        FROM security_events
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY created_at DESC
        LIMIT $${idx}
    `;
    const r = await db.query(sql, params);
    res.json({ events: r.rows });
}));

// ─────────────────────────────────────────────
// GET /api/security/event-types — distinct types (for filters)
// ─────────────────────────────────────────────
router.get('/event-types', asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT event_type, COUNT(*)::int AS c
         FROM security_events
         WHERE created_at > NOW() - INTERVAL '30 days'
         GROUP BY event_type
         ORDER BY c DESC`
    );
    res.json({ types: r.rows });
}));

// ─────────────────────────────────────────────
// GET /api/security/blocked — list blocked IPs
// ─────────────────────────────────────────────
router.get('/blocked', asyncHandler(async (req, res) => {
    const r = await db.query(`
        SELECT ip_address, reason, severity, blocked_by, blocked_at, expires_at, notes
        FROM blocked_ips
        ORDER BY blocked_at DESC
    `);
    res.json({ blocked: r.rows });
}));

// ─────────────────────────────────────────────
// POST /api/security/blocked — manually block an IP
// body: { ip_address, reason, severity?, duration_hours? }
// ─────────────────────────────────────────────
router.post('/blocked', asyncHandler(async (req, res) => {
    const { ip_address, reason, severity = 'medium', duration_hours = null } = req.body || {};
    if (!ip_address) return res.status(400).json({ error: 'ip_address is required' });
    if (!['low','medium','high','critical'].includes(severity)) {
        return res.status(400).json({ error: 'Invalid severity' });
    }

    await blockIp({
        ip_address,
        reason: reason || `Manually blocked by ${req.user.email}`,
        severity,
        blocked_by: `admin:${req.user.user_id}`,
        duration_hours: duration_hours || null,
    });

    await db.query(
        `INSERT INTO security_events (event_type, severity, ip_address, user_id, details)
         VALUES ('admin_block', $1, $2, $3, $4::jsonb)`,
        [severity, ip_address, req.user.user_id, JSON.stringify({ reason })]
    );

    res.json({ ok: true });
}));

// ─────────────────────────────────────────────
// DELETE /api/security/blocked/:ip — unblock
// ─────────────────────────────────────────────
router.delete('/blocked/:ip', asyncHandler(async (req, res) => {
    const ip = req.params.ip;

    await unblockIp(ip);

    await db.query(
        `INSERT INTO security_events (event_type, severity, ip_address, user_id, details)
         VALUES ('admin_unblock', 'low', $1, $2, $3::jsonb)`,
        [ip, req.user.user_id, JSON.stringify({})]
    );

    res.json({ ok: true });
}));

// ─────────────────────────────────────────────
// GET /api/security/thresholds — current limits
// ─────────────────────────────────────────────
router.get('/thresholds', asyncHandler(async (req, res) => {
    const r = await db.query(`SELECT key, value, description, updated_at FROM security_thresholds ORDER BY key`);
    res.json({ thresholds: r.rows });
}));

// ─────────────────────────────────────────────
// PUT /api/security/thresholds/:key — update a limit
// body: { value }
// ─────────────────────────────────────────────
router.put('/thresholds/:key', asyncHandler(async (req, res) => {
    const { key } = req.params;
    const value = parseInt(req.body?.value, 10);
    if (!Number.isFinite(value) || value < 1) {
        return res.status(400).json({ error: 'value must be a positive integer' });
    }

    const r = await db.query(
        `UPDATE security_thresholds SET value = $1, updated_at = NOW()
         WHERE key = $2 RETURNING key, value, description`,
        [value, key]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Threshold not found' });
    res.json({ threshold: r.rows[0] });
}));

// ─────────────────────────────────────────────
// POST /api/security/purge — clean up old events (super_admin only)
// ─────────────────────────────────────────────
router.post('/purge', asyncHandler(async (req, res) => {
    if (req.user.role !== 'super_admin') {
        return res.status(403).json({ error: 'Super Admin only' });
    }
    await purgeOldEvents();
    res.json({ ok: true });
}));

module.exports = router;
