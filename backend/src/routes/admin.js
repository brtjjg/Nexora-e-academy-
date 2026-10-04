// routes/admin.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler, genAdmissionNumber } = require('../utils');
const { requireAdmin } = require('../middleware');

// ─────────────────────────────────────────────
// GET /api/admin/stats
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// GET /api/admin/students
// Shows all users with role='student'
// ─────────────────────────────────────────────
router.get('/students', requireAdmin, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT u.id, u.username, u.email, u.full_name, u.phone, u.country,
                u.status, u.created_at,
                sp.admission_number, sp.admission_status, sp.approval_status,
                COALESCE(sp.activation_fee_paid, FALSE) AS activation_fee_paid,
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

// ─────────────────────────────────────────────
// GET /api/admin/students/:id
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// POST /api/admin/students/:id/approve
// FIXED: now updates users.role + status + activation_fee_paid
// ─────────────────────────────────────────────
router.post('/students/:id/approve', requireAdmin, asyncHandler(async (req, res) => {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const s = await client.query(
            `SELECT u.id, u.full_name, u.email, u.role, u.status
             FROM users u
             WHERE u.id = $1
             FOR UPDATE`,
            [req.params.id]
        );
        if (!s.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Not found' });
        }

        // Get or create student_profiles row and get/create admission number
        const spRow = await client.query(
            `SELECT admission_number FROM student_profiles WHERE user_id = $1`,
            [req.params.id]
        );
        let admission = spRow.rows[0]?.admission_number;
        if (!admission) admission = await genAdmissionNumber(client);

        // Ensure student_profiles exists
        if (!spRow.rows.length) {
            await client.query(
                `INSERT INTO student_profiles (user_id, admission_number, admission_status, approval_status)
                 VALUES ($1, $2, 'approved', 'approved')`,
                [req.params.id, admission]
            );
        } else {
            await client.query(
                `UPDATE student_profiles
                 SET admission_status='approved', approval_status='approved',
                     approved_at=NOW(), approved_by=$1, admission_number=$2
                 WHERE user_id=$3`,
                [req.user.user_id, admission, req.params.id]
            );
        }

        // Update applications
        await client.query(
            `UPDATE applications
             SET status='approved', admission_number=$1,
                 reviewed_at=NOW(), reviewed_by=$2
             WHERE user_id=$3 AND status IN ('payment_due','paid')`,
            [admission, req.user.user_id, req.params.id]
        );

        // KEY FIX: promote the user to a student
        await client.query(
            `UPDATE users
             SET role = 'student',
                 status = 'active',
                 updated_at = NOW()
             WHERE id = $1 AND role != 'admin'`,
            [req.params.id]
        );

        // Mark activation fee as paid if application was paid
        const paidCheck = await client.query(
            `SELECT 1 FROM applications WHERE user_id = $1 AND payment_status = 'paid' LIMIT 1`,
            [req.params.id]
        );
        if (paidCheck.rows.length) {
            await client.query(
                `UPDATE student_profiles SET activation_fee_paid = TRUE WHERE user_id = $1`,
                [req.params.id]
            );
        }

        await client.query('COMMIT');
        res.json({ ok: true, admission_number: admission });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

// ─────────────────────────────────────────────
// POST /api/admin/students/:id/reject
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// POST /api/admin/applications/:id/approve
// MISSING ROUTE — the frontend calls this path
// ─────────────────────────────────────────────
router.post('/applications/:id/approve', requireAdmin, asyncHandler(async (req, res) => {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const a = await client.query(
            `SELECT a.id, a.user_id, a.payment_status, u.role, u.status
             FROM applications a
             JOIN users u ON u.id = a.user_id
             WHERE a.id = $1
             FOR UPDATE`,
            [req.params.id]
        );
        if (!a.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Application not found' });
        }

        const app = a.rows[0];

        // Generate admission number
        const spRow = await client.query(
            `SELECT admission_number FROM student_profiles WHERE user_id = $1`,
            [app.user_id]
        );
        let admission = spRow.rows[0]?.admission_number;
        if (!admission) admission = await genAdmissionNumber(client);

        // Upsert student_profiles
        if (!spRow.rows.length) {
            await client.query(
                `INSERT INTO student_profiles (user_id, admission_number, admission_status, approval_status, activation_fee_paid)
                 VALUES ($1, $2, 'approved', 'approved', $3)`,
                [app.user_id, admission, app.payment_status === 'paid']
            );
        } else {
            await client.query(
                `UPDATE student_profiles
                 SET admission_status='approved', approval_status='approved',
                     approved_at=NOW(), approved_by=$1, admission_number=$2
                 WHERE user_id=$3`,
                [req.user.user_id, admission, app.user_id]
            );
        }

        // Update application
        await client.query(
            `UPDATE applications
             SET status='approved', admission_number=$1,
                 reviewed_at=NOW(), reviewed_by=$2
             WHERE id=$3`,
            [admission, req.user.user_id, req.params.id]
        );

        // Promote user to student
        await client.query(
            `UPDATE users
             SET role = 'student',
                 status = 'active',
                 updated_at = NOW()
             WHERE id = $1 AND role != 'admin'`,
            [app.user_id]
        );

        // Mark activation fee paid if applicable
        if (app.payment_status === 'paid') {
            await client.query(
                `UPDATE student_profiles SET activation_fee_paid = TRUE WHERE user_id = $1`,
                [app.user_id]
            );
        }

        await client.query('COMMIT');
        res.json({ ok: true, admission_number: admission });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

// ─────────────────────────────────────────────
// POST /api/admin/applications/:id/reject
// MISSING ROUTE — the frontend calls this path
// ─────────────────────────────────────────────
router.post('/applications/:id/reject', requireAdmin, asyncHandler(async (req, res) => {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Reason required' });
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        const a = await client.query(
            `SELECT user_id FROM applications WHERE id = $1`,
            [req.params.id]
        );
        if (!a.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Application not found' });
        }
        const userId = a.rows[0].user_id;

        await client.query(
            `UPDATE student_profiles
             SET admission_status='rejected', approval_status='rejected', rejection_reason=$1
             WHERE user_id=$2`,
            [reason, userId]
        );
        await client.query(
            `UPDATE applications
             SET status='rejected', rejection_reason=$1,
                 reviewed_at=NOW(), reviewed_by=$2
             WHERE id=$3`,
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

// ─────────────────────────────────────────────
// POST /api/admin/students/:id/sponsorship
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// GET /api/admin/activities
// ─────────────────────────────────────────────
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

// ═════════════════════════════════════════════
// CONTRIBUTOR MANAGEMENT
// ═════════════════════════════════════════════

router.post('/contributors', requireAdmin, asyncHandler(async (req, res) => {
    const { email, full_name, username, password } = req.body;
    if (!email || !full_name || !username || !password) {
        return res.status(400).json({ error: 'Missing email, full_name, username, or password' });
    }
    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash(password, 10);
    try {
        const r = await db.query(
            `INSERT INTO users (username, email, password_hash, full_name, role, status)
             VALUES ($1, $2, $3, $4, 'contributor', 'active')
             RETURNING id, username, email, full_name, role, status, created_at`,
            [username, email.toLowerCase(), hash, full_name]
        );
        res.status(201).json({ contributor: r.rows[0] });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'Email or username already taken' });
        throw e;
    }
}));

router.get('/contributors', requireAdmin, asyncHandler(async (req, res) => {
    const { status } = req.query;
    const params = [];
    let sql = `
        SELECT u.id, u.username, u.email, u.full_name, u.phone, u.country,
               u.status, u.created_at,
               (SELECT COUNT(*)::int FROM submissions s WHERE s.contributor_id = u.id) AS submission_count
        FROM users u
        WHERE u.role = 'contributor'
    `;
    if (status && status !== 'all') {
        params.push(status);
        sql += ` AND u.status = $1`;
    } else {
        sql += ` AND u.status != 'rejected'`;
    }
    sql += ` ORDER BY u.created_at DESC`;
    const r = await db.query(sql, params);
    res.json({ contributors: r.rows });
}));

router.post('/contributors/:id/approve', requireAdmin, asyncHandler(async (req, res) => {
    const r = await db.query(
        `UPDATE users SET status = 'active', updated_at = NOW()
         WHERE id = $1 AND role = 'contributor'
         RETURNING id, username, email, full_name, role, status`,
        [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Contributor not found' });
    res.json({ contributor: r.rows[0] });
}));

router.post('/contributors/:id/reject', requireAdmin, asyncHandler(async (req, res) => {
    const { reason } = req.body || {};
    const r = await db.query(
        `UPDATE users SET status = 'rejected', updated_at = NOW()
         WHERE id = $1 AND role = 'contributor'
         RETURNING id, username, email, full_name, role, status`,
        [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Contributor not found' });
    res.json({ contributor: r.rows[0], reason: reason || null });
}));

router.delete('/contributors/:id', requireAdmin, asyncHandler(async (req, res) => {
    await db.query(
        `UPDATE users SET status = 'suspended', updated_at = NOW()
         WHERE id = $1 AND role = 'contributor'`,
        [req.params.id]
    );
    res.json({ ok: true });
}));

// ═════════════════════════════════════════════
// COURSE MANUALS
// ═════════════════════════════════════════════

router.post('/manuals', requireAdmin, asyncHandler(async (req, res) => {
    const { title, course_code, instructions, file_path, file_name, assigned_to } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    const r = await db.query(
        `INSERT INTO course_manuals
            (title, course_code, instructions, file_path, file_name, assigned_to, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [title, course_code || null, instructions || null, file_path || null,
         file_name || null, assigned_to || null, req.user.user_id]
    );
    res.status(201).json({ manual: r.rows[0] });
}));

router.get('/manuals', requireAdmin, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT m.*, u.full_name AS assigned_to_name
         FROM course_manuals m
         LEFT JOIN users u ON u.id = m.assigned_to
         ORDER BY m.created_at DESC`
    );
    res.json({ manuals: r.rows });
}));

router.delete('/manuals/:id', requireAdmin, asyncHandler(async (req, res) => {
    await db.query(`DELETE FROM course_manuals WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
}));

// ═════════════════════════════════════════════
// SUBMISSION REVIEW
// ═════════════════════════════════════════════

router.get('/submissions', requireAdmin, asyncHandler(async (req, res) => {
    const { status } = req.query;
    const params = [];
    let sql = `
        SELECT s.*, u.full_name AS contributor_name, u.email AS contributor_email
        FROM submissions s
        JOIN users u ON u.id = s.contributor_id
    `;
    if (status && status !== 'all') {
        params.push(status);
        sql += ` WHERE s.status = $1`;
    }
    sql += ` ORDER BY s.submitted_at DESC NULLS LAST, s.updated_at DESC`;
    const r = await db.query(sql, params);
    res.json({ submissions: r.rows });
}));

router.get('/submissions/:id', requireAdmin, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT s.*, u.full_name AS contributor_name, u.email AS contributor_email
         FROM submissions s
         JOIN users u ON u.id = s.contributor_id
         WHERE s.id = $1`,
        [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ submission: r.rows[0] });
}));

router.post('/submissions/:id/review', requireAdmin, asyncHandler(async (req, res) => {
    const { action, feedback } = req.body;
    let newStatus;
    if (action === 'approve') newStatus = 'approved';
    else if (action === 'request_changes') newStatus = 'changes_requested';
    else if (action === 'reject') newStatus = 'rejected';
    else return res.status(400).json({ error: 'Invalid action' });

    const r = await db.query(
        `UPDATE submissions
         SET status = $1, admin_feedback = $2, reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [newStatus, feedback || null, req.user.user_id, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ submission: r.rows[0] });
}));

router.post('/submissions/:id/publish', requireAdmin, asyncHandler(async (req, res) => {
    const sRes = await db.query(`SELECT * FROM submissions WHERE id = $1`, [req.params.id]);
    if (!sRes.rows.length) return res.status(404).json({ error: 'Not found' });
    const s = sRes.rows[0];
    if (s.status !== 'approved') {
        return res.status(409).json({ error: 'Submission must be approved first' });
    }
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        const cRes = await client.query(
            `INSERT INTO courses
                (title, code, category, level, description, duration, price,
                 cover_image_url, status, created_by,
                 cat_pass_mark, exam_pass_mark, cat_unlock_hours, exam_unlock_hours)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'published',$9,$10,$11,$12,$13)
             RETURNING *`,
            [
                s.title, s.code, s.category, s.level, s.description, s.duration,
                s.price, s.cover_image_url, s.contributor_id,
                s.cat_pass_mark, s.exam_pass_mark, s.cat_unlock_hours, s.exam_unlock_hours,
            ]
        );
        const courseId = cRes.rows[0].id;

        const modules = Array.isArray(s.modules) ? s.modules : [];
        for (let mi = 0; mi < modules.length; mi++) {
            const m = modules[mi];
            const mRes = await client.query(
                `INSERT INTO modules (course_id, title, position)
                 VALUES ($1, $2, $3) RETURNING id`,
                [courseId, m.title || `Module ${mi + 1}`, m.position || (mi + 1)]
            );
            const moduleId = mRes.rows[0].id;

            const lessons = Array.isArray(m.lessons) ? m.lessons : [];
            for (let li = 0; li < lessons.length; li++) {
                const l = lessons[li];
                await client.query(
                    `INSERT INTO lessons
                        (module_id, title, description, position, notes, assignment, video_url, published)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,true)`,
                    [
                        moduleId,
                        l.title || `Lesson ${li + 1}`,
                        l.description || null,
                        l.position || (li + 1),
                        l.notes || null,
                        l.assignment || null,
                        l.video_url || null,
                    ]
                );
            }
        }
        await client.query(
            `UPDATE submissions
             SET status = 'published', course_id = $1, published_at = NOW(), updated_at = NOW()
             WHERE id = $2`,
            [courseId, s.id]
        );
        await client.query('COMMIT');
        res.json({ ok: true, course_id: courseId });
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}));

module.exports = router;
