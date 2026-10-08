// routes/financials.js
// Staff-only finance API.
// Mounted at: /api/financials
// All routes require an authenticated finance role.

const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../utils');
const { requireAuth } = require('../middleware');
const {
    requireFinance,
    requireFinanceManager,
    requireSuperAdmin,
} = require('../middleware/requireFinance');
const {
    resolveSplit,
    DEFAULT_CONTRIBUTOR_SHARE,
    DEFAULT_NEXORA_SHARE,
} = require('../utils/ledger');

router.use(requireAuth, requireFinance);

async function auditLog(client, req, {
    action,
    entity_type = null,
    entity_id = null,
    amount = null,
    currency = null,
    notes = null,
    metadata = {},
}) {
    await client.query(
        `INSERT INTO finance_audit_logs
            (actor_id, actor_role, action, entity_type, entity_id,
             amount, currency, notes, metadata, ip_address, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
        [
            req.user.user_id,
            req.user.role,
            action,
            entity_type,
            entity_id != null ? String(entity_id) : null,
            amount != null ? amount : null,
            currency || null,
            notes || null,
            JSON.stringify(metadata || {}),
            req.ip || null,
            req.headers['user-agent'] || null,
        ]
    );
}

// ─── GET /api/financials/dashboard ───
router.get('/dashboard', asyncHandler(async (req, res) => {
    const [revenue, contribEarn, pendingPayouts, paidOut, failedPayouts, nexoraShare, contribCount] = await Promise.all([
        db.query(`SELECT COALESCE(SUM(amount),0)::numeric AS total
                  FROM transactions
                  WHERE status='completed' AND payment_type='COURSE_PAYMENT'`),
        db.query(`SELECT COALESCE(SUM(amount),0)::numeric AS total
                  FROM ledger_entries
                  WHERE entry_type='sale_contributor_credit'`),
        db.query(`SELECT COALESCE(SUM(amount),0)::numeric AS total, COUNT(*)::int AS cnt
                  FROM payout_requests
                  WHERE status IN ('pending','under_review','approved','processing')`),
        db.query(`SELECT COALESCE(SUM(amount),0)::numeric AS total, COUNT(*)::int AS cnt
                  FROM payout_requests WHERE status='paid'`),
        db.query(`SELECT COALESCE(SUM(amount),0)::numeric AS total, COUNT(*)::int AS cnt
                  FROM payout_requests WHERE status IN ('failed','rejected')`),
        db.query(`SELECT COALESCE(SUM(amount),0)::numeric AS total
                  FROM ledger_entries WHERE entry_type='sale_nexora_credit'`),
        db.query(`SELECT COUNT(DISTINCT contributor_id)::int AS c
                  FROM ledger_entries WHERE contributor_id IS NOT NULL`),
    ]);

    res.json({
        total_revenue:        parseFloat(revenue.rows[0].total),
        contributor_earnings: parseFloat(contribEarn.rows[0].total),
        nexora_revenue:       parseFloat(nexoraShare.rows[0].total),
        pending_payouts:      { total: parseFloat(pendingPayouts.rows[0].total), count: pendingPayouts.rows[0].cnt },
        paid_out:             { total: parseFloat(paidOut.rows[0].total),        count: paidOut.rows[0].cnt },
        failed_payouts:       { total: parseFloat(failedPayouts.rows[0].total),  count: failedPayouts.rows[0].cnt },
        contributor_count:    contribCount.rows[0].c,
        default_split: {
            contributor: DEFAULT_CONTRIBUTOR_SHARE,
            nexora:      DEFAULT_NEXORA_SHARE,
        },
    });
}));

// ─── GET /api/financials/contributors ───
router.get('/contributors', asyncHandler(async (req, res) => {
    const r = await db.query(`
        SELECT
            u.id, u.username, u.email, u.full_name, u.phone, u.country, u.status,
            COALESCE(cb.available_balance, 0) AS available_balance,
            COALESCE(cb.pending_balance,   0) AS pending_balance,
            COALESCE(cb.total_earned,      0) AS total_earned,
            COALESCE(cb.total_paid,        0) AS total_paid,
            COALESCE(cb.currency, 'USD')      AS currency,
            (SELECT COUNT(*)::int FROM courses c WHERE c.created_by = u.id) AS course_count,
            (SELECT COUNT(*)::int FROM payout_requests p
             WHERE p.contributor_id = u.id
               AND p.status IN ('pending','under_review','approved','processing')) AS open_payouts
        FROM users u
        LEFT JOIN contributor_balances cb ON cb.contributor_id = u.id
        WHERE u.role = 'contributor' AND u.status = 'active'
        ORDER BY cb.available_balance DESC NULLS LAST, u.full_name
    `);
    res.json({ contributors: r.rows });
}));

// ─── GET /api/financials/contributors/:id ───
router.get('/contributors/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;

    const [user, balances, dests, payouts, courses] = await Promise.all([
        db.query(`SELECT id, username, email, full_name, phone, country, status, created_at
                  FROM users WHERE id=$1 AND role='contributor'`, [id]),
        db.query(`SELECT * FROM contributor_balances WHERE contributor_id=$1`, [id]),
        db.query(`SELECT * FROM payout_destinations WHERE contributor_id=$1 ORDER BY created_at DESC`, [id]),
        db.query(`SELECT * FROM payout_requests WHERE contributor_id=$1 ORDER BY requested_at DESC LIMIT 50`, [id]),
        db.query(`SELECT id, title, code, price, status FROM courses WHERE created_by=$1 ORDER BY created_at DESC`, [id]),
    ]);

    if (!user.rows.length) return res.status(404).json({ error: 'Contributor not found' });

    res.json({
        contributor: user.rows[0],
        balances: balances.rows[0] || {
            contributor_id: id,
            available_balance: 0,
            pending_balance: 0,
            total_earned: 0,
            total_paid: 0,
            currency: 'USD',
        },
        destinations: dests.rows,
        payouts: payouts.rows,
        courses: courses.rows,
    });
}));

// ─── GET /api/financials/contributors/:id/ledger ───
router.get('/contributors/:id/ledger', asyncHandler(async (req, res) => {
    const { id } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const r = await db.query(
        `SELECT l.*, c.title AS course_title
         FROM ledger_entries l
         LEFT JOIN courses c ON c.id = l.course_id
         WHERE l.contributor_id = $1
         ORDER BY l.created_at DESC
         LIMIT $2`,
        [id, limit]
    );
    res.json({ entries: r.rows });
}));

// ─── GET /api/financials/payouts?status= ───
router.get('/payouts', asyncHandler(async (req, res) => {
    const { status } = req.query;
    const params = [];
    let sql = `
        SELECT p.*,
               u.full_name AS contributor_name,
               u.email     AS contributor_email,
               d.method    AS destination_method,
               d.label     AS destination_label,
               d.details   AS destination_details
        FROM payout_requests p
        JOIN users u ON u.id = p.contributor_id
        LEFT JOIN payout_destinations d ON d.id = p.destination_id
    `;
    if (status && status !== 'all') {
        params.push(status);
        sql += ` WHERE p.status = $1`;
    }
    sql += ` ORDER BY p.requested_at DESC LIMIT 500`;
    const r = await db.query(sql, params);
    res.json({ payouts: r.rows });
}));

// ─── POST /api/financials/payouts ───
router.post('/payouts', requireFinanceManager, asyncHandler(async (req, res) => {
    const { contributor_id, amount, currency = 'USD', notes } = req.body || {};
    const amt = parseFloat(amount);
    if (!contributor_id || !amt || amt <= 0) {
        return res.status(400).json({ error: 'contributor_id and positive amount required' });
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const bal = await client.query(
            `SELECT available_balance FROM contributor_balances
             WHERE contributor_id=$1 FOR UPDATE`,
            [contributor_id]
        );
        const available = parseFloat(bal.rows[0]?.available_balance || 0);
        if (available < amt) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                error: `Insufficient balance. Available: ${available.toFixed(2)}`,
            });
        }

        const dest = await client.query(
            `SELECT id FROM payout_destinations
             WHERE contributor_id=$1 AND status='verified'
             ORDER BY created_at DESC LIMIT 1`,
            [contributor_id]
        );

        const refRes = await client.query(`SELECT gen_payout_ref() AS ref`);
        const payout_ref = refRes.rows[0].ref;

        const ins = await client.query(
            `INSERT INTO payout_requests
                (payout_ref, contributor_id, destination_id, amount, currency,
                 status, requested_by, notes)
             VALUES ($1,$2,$3,$4,$5,'pending',$6,$7)
             RETURNING *`,
            [payout_ref, contributor_id, dest.rows[0]?.id || null, amt, currency, req.user.user_id, notes || null]
        );

        await auditLog(client, req, {
            action: 'payout.create',
            entity_type: 'payout',
            entity_id: ins.rows[0].id,
            amount: amt,
            currency,
            notes: notes || null,
            metadata: { payout_ref },
        });

        await client.query('COMMIT');
        res.status(201).json({ payout: ins.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

// ─── POST /api/financials/payouts/:id/approve ───
router.post('/payouts/:id/approve', requireFinanceManager, asyncHandler(async (req, res) => {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const p = await client.query(
            `SELECT * FROM payout_requests WHERE id=$1 FOR UPDATE`,
            [req.params.id]
        );
        if (!p.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Payout not found' });
        }
        const payout = p.rows[0];

        if (!['pending', 'under_review'].includes(payout.status)) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: `Cannot approve from status "${payout.status}"` });
        }

        const bal = await client.query(
            `SELECT available_balance FROM contributor_balances WHERE contributor_id=$1`,
            [payout.contributor_id]
        );
        const available = parseFloat(bal.rows[0]?.available_balance || 0);
        if (available < parseFloat(payout.amount)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Contributor balance is insufficient now' });
        }

        const upd = await client.query(
            `UPDATE payout_requests
             SET status='approved',
                 reviewed_by=$1, reviewed_at=NOW(),
                 approved_by=$1, approved_at=NOW(),
                 updated_at=NOW()
             WHERE id=$2 RETURNING *`,
            [req.user.user_id, req.params.id]
        );

        await auditLog(client, req, {
            action: 'payout.approve',
            entity_type: 'payout',
            entity_id: payout.id,
            amount: parseFloat(payout.amount),
            currency: payout.currency,
            notes: `Approved payout ${payout.payout_ref}`,
            metadata: { payout_ref: payout.payout_ref },
        });

        await client.query('COMMIT');
        res.json({ payout: upd.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

// ─── POST /api/financials/payouts/:id/reject ───
router.post('/payouts/:id/reject', requireFinanceManager, asyncHandler(async (req, res) => {
    const { reason } = req.body || {};
    if (!reason || !reason.trim()) {
        return res.status(400).json({ error: 'Reason required' });
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        const p = await client.query(
            `SELECT * FROM payout_requests WHERE id=$1 FOR UPDATE`,
            [req.params.id]
        );
        if (!p.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Payout not found' });
        }
        const payout = p.rows[0];

        if (!['pending', 'under_review', 'approved'].includes(payout.status)) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: `Cannot reject from status "${payout.status}"` });
        }

        const upd = await client.query(
            `UPDATE payout_requests
             SET status='rejected',
                 rejection_reason=$1,
                 reviewed_by=$2, reviewed_at=NOW(),
                 updated_at=NOW()
             WHERE id=$3 RETURNING *`,
            [reason.trim(), req.user.user_id, req.params.id]
        );

        await auditLog(client, req, {
            action: 'payout.reject',
            entity_type: 'payout',
            entity_id: payout.id,
            amount: parseFloat(payout.amount),
            currency: payout.currency,
            notes: reason.trim(),
            metadata: { payout_ref: payout.payout_ref },
        });

        await client.query('COMMIT');
        res.json({ payout: upd.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

// ─── POST /api/financials/payouts/:id/mark-paid ───
router.post('/payouts/:id/mark-paid', requireFinanceManager, asyncHandler(async (req, res) => {
    const { payment_reference, notes } = req.body || {};

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const p = await client.query(
            `SELECT * FROM payout_requests WHERE id=$1 FOR UPDATE`,
            [req.params.id]
        );
        if (!p.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Payout not found' });
        }
        const payout = p.rows[0];

        if (!['approved', 'processing'].includes(payout.status)) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: `Cannot mark paid from status "${payout.status}"` });
        }

        await client.query(
            `INSERT INTO payout_transactions
                (payout_request_id, provider, provider_ref, amount, currency, status)
             VALUES ($1,'manual',$2,$3,$4,'success')`,
            [payout.id, payment_reference || null, payout.amount, payout.currency]
        );

        const refRes = await client.query(`SELECT gen_ledger_ref() AS ref`);
        await client.query(
            `INSERT INTO ledger_entries
                (entry_ref, contributor_id, entry_type, amount, currency,
                 is_pending, description, metadata)
             VALUES ($1,$2,'payout_debit',$3,$4,FALSE,$5,$6::jsonb)`,
            [
                refRes.rows[0].ref,
                payout.contributor_id,
                payout.amount,
                payout.currency,
                `Payout ${payout.payout_ref} marked paid`,
                JSON.stringify({
                    payout_ref: payout.payout_ref,
                    payment_reference: payment_reference || null,
                }),
            ]
        );

        const upd = await client.query(
            `UPDATE payout_requests
             SET status='paid',
                 payment_reference=$1,
                 marked_paid_by=$2,
                 marked_paid_at=NOW(),
                 updated_at=NOW(),
                 notes = COALESCE($3, notes)
             WHERE id=$4 RETURNING *`,
            [payment_reference || null, req.user.user_id, notes || null, req.params.id]
        );

        await auditLog(client, req, {
            action: 'payout.mark_paid',
            entity_type: 'payout',
            entity_id: payout.id,
            amount: parseFloat(payout.amount),
            currency: payout.currency,
            notes: notes || `Marked paid: ${payment_reference || 'no reference'}`,
            metadata: {
                payout_ref: payout.payout_ref,
                payment_reference: payment_reference || null,
            },
        });

        await client.query('COMMIT');
        res.json({ payout: upd.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

// ─── GET /api/financials/audit-logs ───
router.get('/audit-logs', asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const r = await db.query(
        `SELECT a.*, u.full_name AS actor_name, u.email AS actor_email
         FROM finance_audit_logs a
         LEFT JOIN users u ON u.id = a.actor_id
         ORDER BY a.created_at DESC
         LIMIT $1`,
        [limit]
    );
    res.json({ logs: r.rows });
}));

// ─── GET /api/financials/reports/revenue ───
router.get('/reports/revenue', asyncHandler(async (req, res) => {
    const [byCourse, byContributor, byMonth] = await Promise.all([
        db.query(`
            SELECT c.id, c.title, c.code,
                   COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type='sale_nexora_credit'), 0)::numeric AS nexora,
                   COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type='sale_contributor_credit'), 0)::numeric AS contributor
            FROM courses c
            LEFT JOIN ledger_entries l ON l.course_id = c.id
            GROUP BY c.id, c.title, c.code
            ORDER BY nexora DESC NULLS LAST
            LIMIT 100
        `),
        db.query(`
            SELECT u.id, u.full_name, u.email,
                   COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type='sale_contributor_credit'), 0)::numeric AS earned
            FROM users u
            LEFT JOIN ledger_entries l ON l.contributor_id = u.id
            WHERE u.role='contributor'
            GROUP BY u.id, u.full_name, u.email
            ORDER BY earned DESC NULLS LAST
            LIMIT 100
        `),
        db.query(`
            SELECT DATE_TRUNC('month', created_at) AS month,
                   COALESCE(SUM(amount) FILTER (WHERE entry_type='sale_nexora_credit'), 0)::numeric AS nexora,
                   COALESCE(SUM(amount) FILTER (WHERE entry_type='sale_contributor_credit'), 0)::numeric AS contributor
            FROM ledger_entries
            GROUP BY month
            ORDER BY month DESC
            LIMIT 24
        `),
    ]);
    res.json({
        by_course: byCourse.rows,
        by_contributor: byContributor.rows,
        by_month: byMonth.rows,
    });
}));

// ─── POST /api/financials/revenue-config/course/:courseId ───
router.post('/revenue-config/course/:courseId', requireFinanceManager, asyncHandler(async (req, res) => {
    const { contributor_share_percent, nexora_share_percent, override_reason } = req.body || {};
    const c = parseFloat(contributor_share_percent);
    const n = parseFloat(nexora_share_percent);

    if (isNaN(c) || isNaN(n) || c < 0 || n < 0 || Math.abs(c + n - 100) > 0.001) {
        return res.status(400).json({ error: 'Shares must be numbers >= 0 and sum to 100' });
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const r = await client.query(
            `INSERT INTO course_revenue_config
                (course_id, contributor_share_percent, nexora_share_percent,
                 override_reason, updated_by, updated_at)
             VALUES ($1,$2,$3,$4,$5,NOW())
             ON CONFLICT (course_id) DO UPDATE SET
                contributor_share_percent = EXCLUDED.contributor_share_percent,
                nexora_share_percent      = EXCLUDED.nexora_share_percent,
                override_reason           = EXCLUDED.override_reason,
                updated_by                = EXCLUDED.updated_by,
                updated_at                = NOW()
             RETURNING *`,
            [req.params.courseId, c, n, override_reason || null, req.user.user_id]
        );

        await auditLog(client, req, {
            action: 'revenue_config.update',
            entity_type: 'course',
            entity_id: req.params.courseId,
            notes: `Split set to ${c}/${n}`,
            metadata: { contributor: c, nexora: n, reason: override_reason || null },
        });

        await client.query('COMMIT');
        res.json({ config: r.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

// ─── GET /api/financials/revenue-config/course/:courseId ───
router.get('/revenue-config/course/:courseId', asyncHandler(async (req, res) => {
    const split = await resolveSplit(db, req.params.courseId);
    res.json({ course_id: req.params.courseId, ...split });
}));

// ─── POST /api/financials/run-hold-release ───
router.post('/run-hold-release', requireSuperAdmin, asyncHandler(async (req, res) => {
    const r = await db.query(`SELECT release_matured_ledger_entries() AS released`);
    res.json({ released: r.rows[0].released });
}));

module.exports = router;
