// routes/admin.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler, genAdmissionNumber } = require('../utils');
const { requireAdmin } = require('../middleware');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

// ═════════════════════════════════════════════
// SUPABASE STORAGE (persistent, survives redeploys)
// ═════════════════════════════════════════════
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'nexora-manuals';

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    console.log('[supabase] Client initialized');
} else {
    console.warn('[supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY — manual uploads will fall back to local disk');
}

// Use memory storage so we can push the buffer straight to Supabase
const uploadManual = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
    fileFilter: (req, file, cb) => {
        const allowed = ['.pdf', '.doc', '.docx', '.txt', '.rtf'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) cb(null, true);
        else cb(new Error('Only PDF, DOC, DOCX, TXT, RTF allowed'));
    },
});

// Sanitize filename — turn "CamScanner 05-10-2026 20.38.pdf" into
// "CamScanner_05-10-2026_20_38.pdf" so it's URL-safe
function sanitizeFilename(name) {
    const ext = path.extname(name).toLowerCase();
    const base = path.basename(name, ext)
        .replace(/[^a-zA-Z0-9_-]/g, '_')   // spaces, dots → underscore
        .replace(/_+/g, '_')                // collapse repeats
        .replace(/^_|_$/g, '');             // trim leading/trailing _
    return `${base}${ext}`;
}

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

        const spRow = await client.query(
            `SELECT admission_number FROM student_profiles WHERE user_id = $1`,
            [req.params.id]
        );
        let admission = spRow.rows[0]?.admission_number;
        if (!admission) admission = await genAdmissionNumber(client);

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

        await client.query(
            `UPDATE applications
             SET status='approved', admission_number=$1,
                 reviewed_at=NOW(), reviewed_by=$2
             WHERE user_id=$3 AND status IN ('payment_due','paid')`,
            [admission, req.user.user_id, req.params.id]
        );

        await client.query(
            `UPDATE users
             SET role = 'student',
                 status = 'active',
                 updated_at = NOW()
             WHERE id = $1 AND role != 'admin'`,
            [req.params.id]
        );

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

        const spRow = await client.query(
            `SELECT admission_number FROM student_profiles WHERE user_id = $1`,
            [app.user_id]
        );
        let admission = spRow.rows[0]?.admission_number;
        if (!admission) admission = await genAdmissionNumber(client);

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

        await client.query(
            `UPDATE applications
             SET status='approved', admission_number=$1,
                 reviewed_at=NOW(), reviewed_by=$2
             WHERE id=$3`,
            [admission, req.user.user_id, req.params.id]
        );

        await client.query(
            `UPDATE users
             SET role = 'student',
                 status = 'active',
                 updated_at = NOW()
             WHERE id = $1 AND role != 'admin'`,
            [app.user_id]
        );

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

// ─────────────────────────────────────────────
// GET /api/admin/contributors/:id
// ─────────────────────────────────────────────
router.get('/contributors/:id', requireAdmin, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT u.id, u.username, u.email, u.full_name, u.phone, u.country,
                u.status, u.created_at, u.updated_at,
                (SELECT COUNT(*)::int FROM submissions s WHERE s.contributor_id = u.id) AS submission_count
         FROM users u
         WHERE u.id = $1 AND u.role = 'contributor'`,
        [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Contributor not found' });
    res.json({ contributor: r.rows[0] });
}));

// ─────────────────────────────────────────────
// PUT /api/admin/contributors/:id
// Edit contributor account (name, phone, country, status)
// ─────────────────────────────────────────────
router.put('/contributors/:id', requireAdmin, asyncHandler(async (req, res) => {
    const { full_name, phone, country, status } = req.body || {};
    const fields = [];
    const values = [];
    let idx = 1;

    if (full_name !== undefined) { fields.push(`full_name = $${idx++}`); values.push(full_name); }
    if (phone !== undefined) { fields.push(`phone = $${idx++}`); values.push(phone); }
    if (country !== undefined) { fields.push(`country = $${idx++}`); values.push(country); }
    if (status !== undefined) {
        if (!['pending', 'active', 'rejected', 'suspended'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }
        fields.push(`status = $${idx++}`); values.push(status);
    }

    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

    values.push(req.params.id);
    const r = await db.query(
        `UPDATE users SET ${fields.join(', ')}, updated_at = NOW()
         WHERE id = $${idx} AND role = 'contributor'
         RETURNING id, username, email, full_name, phone, country, role, status`,
        values
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Contributor not found' });
    res.json({ contributor: r.rows[0] });
}));

// ─────────────────────────────────────────────
// GET /api/admin/contributors/:id/submissions
// ─────────────────────────────────────────────
router.get('/contributors/:id/submissions', requireAdmin, asyncHandler(async (req, res) => {
    const u = await db.query(
        `SELECT id, full_name, email FROM users WHERE id = $1 AND role = 'contributor'`,
        [req.params.id]
    );
    if (!u.rows.length) return res.status(404).json({ error: 'Contributor not found' });

    const s = await db.query(
        `SELECT id, title, status, submitted_at, reviewed_at, published_at, created_at, updated_at, price
         FROM submissions
         WHERE contributor_id = $1
         ORDER BY updated_at DESC`,
        [req.params.id]
    );
    res.json({ contributor: u.rows[0], submissions: s.rows });
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

/* ═══════════════════════════════════════════════════════════
   ADMIN: GET /api/admin/students/:id/audit
   Full audit of a student — for certificate issuance decisions
   ═══════════════════════════════════════════════════════════ */
router.get('/students/:id/audit', requireAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;

    // 1) Student basic info
    const stu = await db.query(
        `SELECT u.id, u.username, u.email, u.full_name, u.phone, u.country,
                u.status, u.created_at,
                sp.admission_number, sp.approval_status,
                COALESCE(sp.activation_fee_paid, FALSE) AS activation_fee_paid
         FROM users u
         LEFT JOIN student_profiles sp ON sp.user_id = u.id
         WHERE u.id = $1 AND u.role = 'student'`,
        [id]
    );
    if (!stu.rows.length) return res.status(404).json({ error: 'Student not found' });
    const student = stu.rows[0];

    // 2) Enrollments + progress + payment
    const enr = await db.query(
        `SELECT e.course_id, c.title AS course_title, c.price AS course_price,
                COALESCE(e.total_course_paid, 0) AS total_course_paid,
                (SELECT COUNT(*)::int FROM modules m WHERE m.course_id = e.course_id) AS total_modules,
                (SELECT COUNT(*)::int FROM lessons l
                    JOIN modules m ON m.id = l.module_id
                    WHERE m.course_id = e.course_id) AS total_lessons,
                (SELECT COUNT(*)::int FROM progress p
                    WHERE p.user_id = e.user_id AND p.course_id = e.course_id) AS completed_lessons
         FROM enrollments e
         JOIN courses c ON c.id = e.course_id
         WHERE e.user_id = $1
         ORDER BY e.created_at DESC`,
        [id]
    );
    const enrollments = enr.rows.map(e => ({
        ...e,
        payment_pct: e.course_price > 0
            ? Math.min(100, Math.round((e.total_course_paid / e.course_price) * 100))
            : 100,
        progress_pct: e.total_lessons > 0
            ? Math.round((e.completed_lessons / e.total_lessons) * 100)
            : 0,
        remaining_balance: Math.max(0, parseFloat(e.course_price || 0) - parseFloat(e.total_course_paid || 0)),
    }));

    // 3) Exam + CAT results
    let results = [];
    try {
        const r = await db.query(
            `SELECT course_id, assessment_type, score, total_marks, percentage, passed, submitted_at
             FROM assessment_results
             WHERE user_id = $1
             ORDER BY submitted_at DESC`,
            [id]
        );
        results = r.rows;
    } catch (e) {
        // Table may not exist yet — ignore
        results = [];
    }

    // 4) Groups + message count
    const grp = await db.query(
        `SELECT g.id, g.name, g.category,
                (SELECT COUNT(*)::int FROM group_messages gm
                    WHERE gm.group_id = g.id AND gm.user_id = $1) AS my_messages
         FROM group_members m
         JOIN groups g ON g.id = m.group_id
         WHERE m.user_id = $1`,
        [id]
    );

    // 5) Payments total
    const pay = await db.query(
        `SELECT COALESCE(SUM(amount), 0) AS total_paid,
                COUNT(*)::int AS tx_count
         FROM transactions
         WHERE user_id = $1 AND status = 'completed'`,
        [id]
    );

    // 6) Assignments
    let assignments = { submitted: 0, reviewed: 0, returned: 0 };
    try {
        const a = await db.query(
            `SELECT
                COUNT(*)::int AS submitted,
                COUNT(*) FILTER (WHERE status = 'reviewed')::int AS reviewed,
                COUNT(*) FILTER (WHERE status = 'returned')::int AS returned
             FROM assignment_submissions
             WHERE user_id = $1`,
            [id]
        );
        assignments = a.rows[0];
    } catch (e) {}

    // 7) Certificates already issued
    const cert = await db.query(
        `SELECT certificate_id, course_name, issued_date, revoked
         FROM certificates
         WHERE user_id = $1
         ORDER BY issued_date DESC`,
        [id]
    );

    // ══════════ ELIGIBILITY SCORING ══════════
    const reasons = [];
    let score = 0;

    // 30 pts — admission fee paid
    if (student.activation_fee_paid) { score += 30; }
    else reasons.push('Admission fee NOT paid');

    // 25 pts — at least one enrollment with 100% payment
    const fullyPaidCourses = enrollments.filter(e => e.payment_pct >= 100);
    if (fullyPaidCourses.length > 0) { score += 25; }
    else reasons.push('No fully-paid course');

    // 25 pts — at least one completed course (all lessons done)
    const completedCourses = enrollments.filter(e => e.progress_pct >= 100);
    if (completedCourses.length > 0) { score += 25; }
    else if (enrollments.some(e => e.progress_pct > 0)) reasons.push('Courses started but not completed');
    else reasons.push('No course started');

    // 10 pts — no failed exams on completed courses
    const failedExams = results.filter(r => r.assessment_type === 'exam' && !r.passed);
    if (failedExams.length === 0) { score += 10; }
    else reasons.push(`${failedExams.length} failed exam(s)`);

    // 10 pts — active in community (at least 1 message)
    const totalMsgs = grp.rows.reduce((s, g) => s + (g.my_messages || 0), 0);
    if (totalMsgs > 0) { score += 10; }
    else if (grp.rows.length === 0) reasons.push('Not in any group');
    else reasons.push('No group messages');

    // Determine readiness
    let verdict = 'not_ready';
    let recommendation = 'Do NOT issue yet';
    if (score >= 90 && failedExams.length === 0 && completedCourses.length > 0) {
        verdict = 'ready';
        recommendation = 'Issue the certificate — student meets all criteria';
    } else if (score >= 60) {
        verdict = 'partial';
        recommendation = 'Student is close but not fully eligible. Review reasons below.';
    }

    res.json({
        student,
        enrollments,
        results,
        groups: grp.rows,
        total_group_messages: totalMsgs,
        payments: pay.rows[0],
        assignments,
        certificates_issued: cert.rows,
        eligibility: {
            score,
            max: 100,
            verdict,
            recommendation,
            reasons,
            fully_paid_courses: fullyPaidCourses.length,
            completed_courses: completedCourses.length,
            failed_exams: failedExams.length,
        },
    });
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

// ─────────────────────────────────────────────
// POST /api/admin/manuals/upload
// Upload a PDF/DOC to Supabase Storage (persistent)
// ─────────────────────────────────────────────
router.post('/manuals/upload', requireAdmin, uploadManual.single('file'), asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const safeName = sanitizeFilename(req.file.originalname);
    const uniqueName = `${Date.now()}_${safeName}`;

    // ── Path 1: Supabase (persistent) ──
    if (supabase) {
        try {
            const { data, error } = await supabase.storage
                .from(SUPABASE_BUCKET)
                .upload(uniqueName, req.file.buffer, {
                    contentType: req.file.mimetype,
                    upsert: false,
                });

            if (error) throw error;

            const { data: urlData } = supabase.storage
                .from(SUPABASE_BUCKET)
                .getPublicUrl(uniqueName);

            console.log('[manuals/upload] Uploaded to Supabase:', urlData.publicUrl);

            return res.json({
                path: urlData.publicUrl,       // full https URL — works from any origin
                filename: uniqueName,
                originalname: req.file.originalname,
                storage: 'supabase',
            });
        } catch (err) {
            console.error('[manuals/upload] Supabase failed:', err.message);
            // fall through to local fallback
        }
    }

    // ── Path 2: Local disk (fallback — will be wiped on redeploy) ──
    const MANUALS_DIR = path.join(__dirname, '..', 'uploads', 'manuals');
    if (!fs.existsSync(MANUALS_DIR)) fs.mkdirSync(MANUALS_DIR, { recursive: true });

    const localPath = path.join(MANUALS_DIR, uniqueName);
    fs.writeFileSync(localPath, req.file.buffer);
    console.log('[manuals/upload] Saved to local disk (fallback):', localPath);

    res.json({
        path: `/uploads/manuals/${uniqueName}`,
        filename: uniqueName,
        originalname: req.file.originalname,
        storage: 'local',
    });
}));

// ─────────────────────────────────────────────
// POST /api/admin/manuals/broadcast
// Create a manual and send to ALL contributors
// ─────────────────────────────────────────────
router.post('/manuals/broadcast', requireAdmin, asyncHandler(async (req, res) => {
    const { title, course_code, instructions, file_path, file_name } = req.body || {};
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const r = await db.query(
        `INSERT INTO course_manuals
            (title, course_code, instructions, file_path, file_name, assigned_to, created_by)
         VALUES ($1, $2, $3, $4, $5, NULL, $6)
         RETURNING *`,
        [title, course_code || null, instructions || null, file_path || null,
         file_name || null, req.user.user_id]
    );
    res.status(201).json({ manual: r.rows[0] });
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

// ─────────────────────────────────────────────
// PUT /api/admin/submissions/:id
// Update submission price/metadata before publishing
// ─────────────────────────────────────────────
router.put('/submissions/:id', requireAdmin, asyncHandler(async (req, res) => {
    const { price, discount_enabled, discount_price, discount_label, discount_ends_at } = req.body || {};
    const fields = [];
    const values = [];
    let idx = 1;

    if (price !== undefined) { fields.push(`price = $${idx++}`); values.push(parseFloat(price) || 0); }

    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

    values.push(req.params.id);
    const r = await db.query(
        `UPDATE submissions SET ${fields.join(', ')}, updated_at = NOW()
         WHERE id = $${idx}
         RETURNING *`,
        values
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

// ─────────────────────────────────────────────
// POST /api/admin/submissions/:id/publish
// Publishes to courses, accepts price + discount overrides
// ─────────────────────────────────────────────
router.post('/submissions/:id/publish', requireAdmin, asyncHandler(async (req, res) => {
    const { price, discount_enabled, discount_price, discount_label, discount_ends_at } = req.body || {};

    const sRes = await db.query(`SELECT * FROM submissions WHERE id = $1`, [req.params.id]);
    if (!sRes.rows.length) return res.status(404).json({ error: 'Not found' });
    const s = sRes.rows[0];
    if (s.status !== 'approved') {
        return res.status(409).json({ error: 'Submission must be approved first' });
    }

    const finalPrice = price != null ? parseFloat(price) : parseFloat(s.price || 0);
    const finalDiscountEnabled = !!discount_enabled;
    const finalDiscountPrice = discount_price != null ? parseFloat(discount_price) : null;
    const finalDiscountLabel = discount_label || null;
    const finalDiscountEndsAt = discount_ends_at || null;

    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        const cRes = await client.query(
            `INSERT INTO courses
                (title, code, category, level, description, duration, price,
                 cover_image_url, status, created_by,
                 cat_pass_mark, exam_pass_mark, cat_unlock_hours, exam_unlock_hours,
                 discount_enabled, discount_price, discount_label, discount_ends_at,
                 original_price)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'published',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
             RETURNING *`,
            [
                s.title, s.code, s.category, s.level, s.description, s.duration,
                finalPrice, s.cover_image_url, s.contributor_id,
                s.cat_pass_mark, s.exam_pass_mark, s.cat_unlock_hours, s.exam_unlock_hours,
                finalDiscountEnabled, finalDiscountPrice, finalDiscountLabel, finalDiscountEndsAt,
                finalPrice,
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
        res.json({ ok: true, course_id: courseId, price: finalPrice });
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}));

module.exports = router;
