const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler, genAdmissionNumber } = require('../utils');
const { requireAdmin } = require('../middleware');

// GET /api/admin/stats
router.get('/stats', requireAdmin, asyncHandler(async (req, res) => {
    const [students, courses, enrollments, apps, txs] = await Promise.all([
        db.query(`SELECT COUNT(*)::int AS c FROM users WHERE role='student'`),
        db.query(`SELECT COUNT(*)::int AS c FROM courses`),
        db.query(`SELECT COUNT(*)::int AS c FROM enrollments`),
        db.query(`SELECT status, COUNT(*)::int AS c FROM applications GROUP BY status`),
        db.query(`SELECT payment_type, COALESCE(SUM(amount),0) AS total
                  FROM transactions WHERE status='completed'
                  GROUP BY payment_type`),
    ]);
    const appCounts = { payment_due: 0, paid: 0, approved: 0, rejected: 0 };
    apps.rows.forEach(r => { appCounts[r.status] = r.c; });
    const revenue = { course: 0, activation: 0 };
    txs.rows.forEach(r => {
        if (r.payment_type === 'COURSE_PAYMENT') revenue.course = parseFloat(r.total);
        if (r.payment_type === 'ACTIVATION_FEE') revenue.activation = parseFloat(r.total);
    });
    res.json({
        counts: {
            students: students.rows[0].c,
            courses: courses.rows[0].c,
            enrollments: enrollments.rows[0].c,
            applications: appCounts,
        },
        revenue: {
            course: revenue.course,
            activation: revenue.activation,
            total: revenue.course + revenue.activation,
        },
    });
}));

// GET /api/admin/students
router.get('/students', requireAdmin, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT u.id, u.username, u.email, u.full_name, u.phone, u.country,
                u.status, u.created_at,
                sp.admission_number, sp.admission_status, sp.approval_status,
                sp.activation_fee_paid,
                spo.sponsorship_type, spo.amount AS sponsorship_amount,
                spo.percentage AS sponsorship_percentage, spo.sponsor_name,
                (SELECT COUNT(*)::int FROM enrollments e WHERE e.user_id = u.id) AS enrollment_count,
                (SELECT COALESCE(SUM(t.amount),0) FROM transactions t
                 WHERE t.user_id = u.id AND t.status='completed') AS total_paid
         FROM users u
         LEFT JOIN student_profiles sp ON sp.user_id = u.id
         LEFT JOIN sponsorships spo ON spo.user_id = u.id AND spo.active = TRUE
         WHERE u.role = 'student'
         ORDER BY u.created_at DESC`
    );
    const students = r.rows.map(s => ({
        ...s,
        sponsorship: {
            type: s.sponsorship_type || 'none',
            amount: parseFloat(s.sponsorship_amount || 0),
            percentage: parseInt(s.sponsorship_percentage || 0, 10),
            sponsor_name: s.sponsor_name || '',
        },
    }));
    res.json({ students });
}));

// GET /api/admin/students/:id
router.get('/students/:id', requireAdmin, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT u.*, sp.*
         FROM users u
         LEFT JOIN student_profiles sp ON sp.user_id = u.id
         WHERE u.id = $1 AND u.role = 'student'`,
        [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ student: r.rows[0] });
}));

// POST /api/admin/students/:id/approve
router.post('/students/:id/approve', requireAdmin, asyncHandler(async (req, res) => {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        const s = await client.query(
            `SELECT sp.admission_number, u.id, u.full_name
             FROM users u
             JOIN student_profiles sp ON sp.user_id = u.id
             WHERE u.id = $1 FOR UPDATE`,
            [req.params.id]
        );
        if (!s.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Not found' });
        }
        let admission = s.rows[0].admission_number;
        if (!admission) admission = await genAdmissionNumber(client);

        await client.query(
            `UPDATE student_profiles
             SET admission_status='approved', approval_status='approved',
                 approved_at=NOW(), approved_by=$1, admission_number=$2
             WHERE user_id=$3`,
            [req.user.user_id, admission, req.params.id]
        );
        await client.query(
            `UPDATE applications
             SET status='approved', admission_number=$1,
                 reviewed_at=NOW(), reviewed_by=$2
             WHERE user_id=$3 AND status IN ('payment_due','paid')`,
            [admission, req.user.user_id, req.params.id]
        );
        await client.query('COMMIT');
        res.json({ ok: true, admission_number: admission });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

// POST /api/admin/students/:id/reject
router.post('/students/:id/reject', requireAdmin, asyncHandler(async (req, res) => {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Reason required' });
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await client.query(
            `UPDATE student_profiles
             SET admission_status='rejected', approval_status='rejected',
                 rejection_reason=$1
             WHERE user_id=$2`,
            [reason, req.params.id]
        );
        await client.query(
            `UPDATE applications
             SET status='rejected', rejection_reason=$1,
                 reviewed_at=NOW(), reviewed_by=$2
             WHERE user_id=$3 AND status IN ('payment_due','paid')`,
            [reason, req.user.user_id, req.params.id]
        );
        await client.query('COMMIT');
        res.json({ ok: true });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

// POST /api/admin/students/:id/sponsorship
router.post('/students/:id/sponsorship', requireAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { type, amount, percentage, sponsor_name } = req.body;
    if (!['none', 'partial', 'full'].includes(type)) {
        return res.status(400).json({ error: 'Invalid sponsorship type' });
    }
    const s = await db.query(
        `SELECT id FROM users WHERE id = $1 AND role = 'student'`,
        [id]
    );
    if (!s.rows.length) return res.status(404).json({ error: 'Student not found' });

    const existing = await db.query(
        `SELECT id FROM sponsorships WHERE user_id = $1 AND active = TRUE LIMIT 1`,
        [id]
    );
    if (existing.rows.length) {
        await db.query(
            `UPDATE sponsorships
             SET sponsorship_type = $1, amount = $2, percentage = $3,
                 sponsor_name = $4, updated_at = NOW()
             WHERE id = $5`,
            [type, amount, percentage, sponsor_name, existing.rows[0].id]
        );
    } else {
        await db.query(
            `INSERT INTO sponsorships
                (user_id, sponsor_name, sponsorship_type, amount, percentage, active)
             VALUES ($1, $2, $3, $4, $5, TRUE)`,
            [id, sponsor_name, type, amount, percentage]
        );
    }
    res.json({ ok: true });
}));

// GET /api/admin/activities
router.get('/activities', requireAdmin, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT a.*, u.full_name AS user_name
         FROM activities a
         LEFT JOIN users u ON u.id = a.user_id
         ORDER BY a.created_at DESC
         LIMIT 100`
    );
    res.json({ activities: r.rows });
}));

module.exports = router;
