// utils/security.js
// Detection + logging helpers for the Nexora security gate.
// Read-only safe: writes go only to security_events and blocked_ips.

const db = require('../db');

// ─────────────────────────────────────────────
// Read thresholds (cached for 60s)
// ─────────────────────────────────────────────
let _thresholdsCache = null;
let _thresholdsCachedAt = 0;
const THRESHOLDS_TTL_MS = 60 * 1000;

async function getThresholds() {
    const now = Date.now();
    if (_thresholdsCache && now - _thresholdsCachedAt < THRESHOLDS_TTL_MS) {
        return _thresholdsCache;
    }
    try {
        const r = await db.query(`SELECT key, value FROM security_thresholds`);
        const map = {};
        r.rows.forEach(row => { map[row.key] = parseInt(row.value, 10); });
        _thresholdsCache = map;
        _thresholdsCachedAt = now;
        return map;
    } catch (e) {
        console.error('[security] getThresholds failed:', e.message);
        return {
            failed_logins_per_10min: 10,
            requests_per_min: 120,
            suspicious_paths_per_10min: 5,
            block_duration_hours: 24,
        };
    }
}

// ─────────────────────────────────────────────
// Client IP extraction (handles proxies)
// ─────────────────────────────────────────────
function getClientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
    return req.ip || req.connection?.remoteAddress || 'unknown';
}

// ─────────────────────────────────────────────
// Log a security event
// ─────────────────────────────────────────────
async function logEvent({
    event_type,
    severity = 'low',
    ip_address,
    user_agent,
    method,
    path,
    user_id = null,
    details = {},
}) {
    try {
        await db.query(
            `INSERT INTO security_events
                (event_type, severity, ip_address, user_agent, method, path, user_id, details)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
            [
                event_type,
                severity,
                ip_address || null,
                user_agent || null,
                method || null,
                path || null,
                user_id,
                JSON.stringify(details || {}),
            ]
        );
    } catch (e) {
        console.error('[security] logEvent failed:', e.message);
    }
}

// ─────────────────────────────────────────────
// Block an IP (auto or manual)
// ─────────────────────────────────────────────
async function blockIp({
    ip_address,
    reason,
    severity = 'medium',
    blocked_by = 'auto',
    duration_hours = null,
    notes = null,
}) {
    if (!ip_address || ip_address === 'unknown') return;
    try {
        const expiresAt = duration_hours
            ? new Date(Date.now() + duration_hours * 60 * 60 * 1000)
            : null;

        await db.query(
            `INSERT INTO blocked_ips (ip_address, reason, severity, blocked_by, expires_at, notes)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (ip_address) DO UPDATE SET
                reason     = EXCLUDED.reason,
                severity   = EXCLUDED.severity,
                blocked_by = EXCLUDED.blocked_by,
                expires_at = EXCLUDED.expires_at,
                notes      = EXCLUDED.notes`,
            [ip_address, reason || null, severity, blocked_by, expiresAt, notes]
        );

        console.log(`[security] Blocked IP ${ip_address} — ${reason || 'no reason'} (expires: ${expiresAt || 'never'})`);
    } catch (e) {
        console.error('[security] blockIp failed:', e.message);
    }
}

// ─────────────────────────────────────────────
// Is this IP currently blocked? (with 30s cache)
// ─────────────────────────────────────────────
const _blockedCache = new Map(); // ip -> { blocked: bool, until: ms }
const BLOCKED_TTL_MS = 30 * 1000;

async function isIpBlocked(ip) {
    if (!ip || ip === 'unknown') return false;

    const cached = _blockedCache.get(ip);
    const now = Date.now();
    if (cached && now < cached.until) return cached.blocked;

    try {
        const r = await db.query(
            `SELECT 1 FROM blocked_ips
             WHERE ip_address = $1
               AND (expires_at IS NULL OR expires_at > NOW())
             LIMIT 1`,
            [ip]
        );
        const blocked = r.rows.length > 0;
        _blockedCache.set(ip, { blocked, until: now + BLOCKED_TTL_MS });
        return blocked;
    } catch (e) {
        console.error('[security] isIpBlocked failed:', e.message);
        return false;
    }
}

// ─────────────────────────────────────────────
// Unblock an IP
// ─────────────────────────────────────────────
async function unblockIp(ip) {
    try {
        await db.query(`DELETE FROM blocked_ips WHERE ip_address = $1`, [ip]);
        _blockedCache.delete(ip);
    } catch (e) {
        console.error('[security] unblockIp failed:', e.message);
    }
}

// ─────────────────────────────────────────────
// Count recent events of a type from an IP
// ─────────────────────────────────────────────
async function countRecentEvents({ ip, event_type, minutes }) {
    try {
        const r = await db.query(
            `SELECT COUNT(*)::int AS c FROM security_events
             WHERE ip_address = $1
               AND event_type = $2
               AND created_at > NOW() - ($3 || ' minutes')::interval`,
            [ip, event_type, minutes]
        );
        return r.rows[0].c;
    } catch (e) {
        console.error('[security] countRecentEvents failed:', e.message);
        return 0;
    }
}

// ─────────────────────────────────────────────
// Heuristic suspicious-pattern detector
// Returns { suspicious: bool, reason: string } or null
// ─────────────────────────────────────────────
function detectSuspiciousRequest(req) {
    const ua = String(req.headers['user-agent'] || '');
    const url = String(req.originalUrl || req.url || '');
    const body = typeof req.body === 'object' && req.body ? JSON.stringify(req.body) : '';

    // 1. Known scanner user agents
    const badAgents = [
        'sqlmap', 'nikto', 'nmap', 'masscan', 'acunetix',
        'dirbuster', 'gobuster', 'wfuzz', 'hydra',
        'python-requests', 'python-urllib', 'curl/', 'wget/',
        'zgrab', 'nuclei', 'httpx',
    ];
    const uaLower = ua.toLowerCase();
    for (const bad of badAgents) {
        if (uaLower.includes(bad)) {
            return { suspicious: true, reason: `Bad user agent: ${bad}`, severity: 'high' };
        }
    }

    // 2. No user agent at all (bots, scripts)
    if (!ua || ua.length < 5) {
        return { suspicious: true, reason: 'Missing user agent', severity: 'medium' };
    }

    // 3. SQL injection patterns in URL or body
    const sqlPatterns = [
        /(\bunion\b.*\bselect\b)/i,
        /(\bdrop\b\s+\btable\b)/i,
        /(\binsert\b\s+\binto\b)/i,
        /(\bdelete\b\s+\bfrom\b)/i,
        /('\s*or\s*'?\d+'?\s*=\s*'?\d+)/i,
        /(;\s*--)/,
        /(\/\*.*\*\/)/,
    ];
    for (const re of sqlPatterns) {
        if (re.test(url) || re.test(body)) {
            return { suspicious: true, reason: 'Possible SQL injection attempt', severity: 'critical' };
        }
    }

    // 4. XSS patterns
    const xssPatterns = [
        /<script[\s>]/i,
        /javascript:/i,
        /onerror\s*=/i,
        /onload\s*=/i,
    ];
    for (const re of xssPatterns) {
        if (re.test(url) || re.test(body)) {
            return { suspicious: true, reason: 'Possible XSS attempt', severity: 'high' };
        }
    }

    // 5. Path traversal
    if (url.includes('../') || url.includes('..\\')) {
        return { suspicious: true, reason: 'Path traversal attempt', severity: 'high' };
    }

    // 6. Common probe paths that are not part of our app
    const probePaths = [
        '/wp-admin', '/wp-login', '/.env', '/.git',
        '/phpmyadmin', '/admin.php', '/config.php',
        '/xmlrpc.php', '/vendor/', '/cgi-bin',
    ];
    for (const p of probePaths) {
        if (url.toLowerCase().startsWith(p)) {
            return { suspicious: true, reason: `Probe path: ${p}`, severity: 'medium' };
        }
    }

    return null;
}

// ─────────────────────────────────────────────
// Housekeeping: purge very old events (>90 days)
// ─────────────────────────────────────────────
async function purgeOldEvents() {
    try {
        const r = await db.query(
            `DELETE FROM security_events WHERE created_at < NOW() - INTERVAL '90 days'`
        );
        if (r.rowCount) console.log(`[security] purged ${r.rowCount} old events`);
    } catch (e) {
        console.error('[security] purgeOldEvents failed:', e.message);
    }
}

module.exports = {
    getThresholds,
    getClientIp,
    logEvent,
    blockIp,
    isIpBlocked,
    unblockIp,
    countRecentEvents,
    detectSuspiciousRequest,
    purgeOldEvents,
};
