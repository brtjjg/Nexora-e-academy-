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
const { sendEmail } = require('../utils/sendEmail');

// ═════════════════════════════════════════════
// SUPABASE STORAGE
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

const uploadManual = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['.pdf', '.doc', '.docx', '.txt', '.rtf'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) cb(null, true);
        else cb(new Error('Only PDF, DOC, DOCX, TXT, RTF allowed'));
    },
});

function sanitizeFilename(name) {
    const ext = path.extname(name).toLowerCase();
    const base = path.basename(name, ext)
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
    return `${base}${ext}`;
}

// ═════════════════════════════════════════════
// EMAIL BRANDING CONSTANTS
// ═════════════════════════════════════════════
const BRAND = {
    logoUrl: 'https://nexora-certificates.vercel.app/logo.png',
    portalUrl: 'https://nexora-contributor-portal.vercel.app',
    academyUrl: 'https://nexora-e-academy.vercel.app',
    privacyUrl: 'https://nexora-e-academy.vercel.app/privacy-policy.html',
    termsUrl: 'https://nexora-e-academy.vercel.app/terms.html',
    whatsappUrl: 'https://chat.whatsapp.com/Cc07MSgeXeTCJTdJCAuRkN',
    supportEmail: 'nexoraacademyhelpdesk@gmail.com',
    principalName: 'Eng. Brian Ondieki',
    principalTitle: 'Principal, Nexora Academy',
    primaryColor: '#0B1F3A',
    accentColor: '#29A9E8',
    goldColor: '#D4A63A',
};

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
// GET /api/admin/students/:id/audit
// ─────────────────────────────────────────────
router.get('/students/:id/audit', requireAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;

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

    const enr = await db.query(
        `SELECT e.course_id,
                c.title AS course_title,
                COALESCE(e.course_price, c.price, 0) AS course_price,
                COALESCE(e.total_course_paid, 0) AS total_course_paid,
                e.enrolled_at,
                e.completed_at,
                (SELECT COUNT(*)::int FROM modules m WHERE m.course_id = e.course_id) AS total_modules,
                (SELECT COUNT(*)::int FROM lessons l
                    JOIN modules m ON m.id = l.module_id
                    WHERE m.course_id = e.course_id) AS total_lessons,
                (SELECT COUNT(*)::int FROM lesson_progress lp
                    WHERE lp.user_id = e.user_id AND lp.course_id = e.course_id) AS completed_lessons
         FROM enrollments e
         JOIN courses c ON c.id = e.course_id
         WHERE e.user_id = $1
         ORDER BY e.enrolled_at DESC NULLS LAST`,
        [id]
    );
    const enrollments = enr.rows.map(e => ({
        ...e,
        payment_pct: parseFloat(e.course_price) > 0
            ? Math.min(100, Math.round((parseFloat(e.total_course_paid) / parseFloat(e.course_price)) * 100))
            : 100,
        progress_pct: e.total_lessons > 0
            ? Math.round((e.completed_lessons / e.total_lessons) * 100)
            : 0,
        remaining_balance: Math.max(0, parseFloat(e.course_price || 0) - parseFloat(e.total_course_paid || 0)),
    }));

    let results = [];
    try {
        const r = await db.query(
            `SELECT aa.course_id,
                    c.title AS course_title,
                    aa.assessment_type,
                    aa.score, aa.total_marks, aa.percentage, aa.passed, aa.submitted_at
             FROM assessment_attempts aa
             LEFT JOIN courses c ON c.id = aa.course_id
             WHERE aa.user_id = $1
             ORDER BY aa.submitted_at DESC NULLS LAST
             LIMIT 20`,
            [id]
        );
        results = r.rows;
    } catch (e) {
        console.warn('[audit] assessment_attempts query failed:', e.message);
    }

    const grp = await db.query(
        `SELECT g.id, g.name, g.category,
                (SELECT COUNT(*)::int FROM group_messages gm
                    WHERE gm.group_id = g.id AND gm.user_id = $1) AS my_messages
         FROM group_members m
         JOIN groups g ON g.id = m.group_id
         WHERE m.user_id = $1`,
        [id]
    );

    const pay = await db.query(
        `SELECT COALESCE(SUM(amount), 0) AS total_paid,
                COUNT(*)::int AS tx_count
         FROM transactions
         WHERE user_id = $1 AND status = 'completed'`,
        [id]
    );

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
    } catch (e) {
        console.warn('[audit] assignment_submissions query failed:', e.message);
    }

    const cert = await db.query(
        `SELECT certificate_id, course_name, issued_date, revoked
         FROM certificates
         WHERE user_id = $1
         ORDER BY issued_date DESC`,
        [id]
    );

    const reasons = [];
    let score = 0;

    if (student.activation_fee_paid) { score += 30; }
    else reasons.push('Admission fee NOT paid');

    const fullyPaidCourses = enrollments.filter(e => e.payment_pct >= 100);
    if (fullyPaidCourses.length > 0) { score += 25; }
    else reasons.push('No fully-paid course');

    const completedCourses = enrollments.filter(e => e.progress_pct >= 100);
    if (completedCourses.length > 0) { score += 25; }
    else if (enrollments.some(e => e.progress_pct > 0)) reasons.push('Courses started but not completed');
    else reasons.push('No course started');

    const failedExams = results.filter(r => r.assessment_type === 'exam' && !r.passed);
    if (failedExams.length === 0) { score += 10; }
    else reasons.push(`${failedExams.length} failed exam(s)`);

    const totalMsgs = grp.rows.reduce((s, g) => s + (g.my_messages || 0), 0);
    if (totalMsgs > 0) { score += 10; }
    else if (grp.rows.length === 0) reasons.push('Not in any group');
    else reasons.push('No group messages');

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
             SET role = 'student', status = 'active', updated_at = NOW()
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
             SET admission_status='rejected', approval_status='rejected', rejection_reason=$1
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
             SET role = 'student', status = 'active', updated_at = NOW()
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

router.post('/manuals/upload', requireAdmin, uploadManual.single('file'), asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const safeName = sanitizeFilename(req.file.originalname);
    const uniqueName = `${Date.now()}_${safeName}`;

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
                path: urlData.publicUrl,
                filename: uniqueName,
                originalname: req.file.originalname,
                storage: 'supabase',
            });
        } catch (err) {
            console.error('[manuals/upload] Supabase failed:', err.message);
        }
    }

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

// ═════════════════════════════════════════════
// PUBLIC WEBHOOK — Google Form contributor decisions
// ═════════════════════════════════════════════
router.post('/contributor-applications/decide', asyncHandler(async (req, res) => {
    const secret = req.headers['x-webhook-secret'];
    if (!process.env.FORM_WEBHOOK_SECRET) {
        return res.status(500).json({ error: 'Webhook secret not configured on server' });
    }
    if (secret !== process.env.FORM_WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { full_name, email, phone, country, status, reason } = req.body || {};

    if (!email || !status) {
        return res.status(400).json({ error: 'email and status are required' });
    }
    if (!['Approved', 'Rejected'].includes(status)) {
        return res.status(400).json({ error: 'status must be "Approved" or "Rejected"' });
    }

    const emailLower = String(email).toLowerCase().trim();

    // ══════════ REJECTION PATH ══════════
    if (status === 'Rejected') {
        sendContributorDecisionEmail({
            to: emailLower,
            name: full_name || 'Applicant',
            approved: false,
            reason: reason || null,
        }).catch(e => console.error('[form] reject email failed:', e.message));

        return res.json({ ok: true, action: 'rejected', email });
    }

    // ══════════ APPROVAL PATH ══════════
    // ❌ NO AUTO-GENERATION OF ACCOUNTS.
    // The applicant creates their own account on the portal signup page.
    // We only send them an email telling them they're approved.

    sendContributorDecisionEmail({
        to: emailLower,
        name: full_name || 'Contributor',
        approved: true,
        username: null,
        tempPassword: null,
        portalUrl: BRAND.portalUrl,
    }).catch(e => console.error('[form] approve email failed:', e.message));

    return res.json({ ok: true, action: 'approved', email });
}));

// ═══════════════════════════════════════════════════════════
// SHARED EMAIL LAYOUT BUILDER
// ═══════════════════════════════════════════════════════════
function buildEmailShell({ headerText, bodyHtml, preheader }) {
    return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nexora Academy</title>
</head>
<body style="margin:0;padding:0;background:#F0F2F5;font-family:Arial,Helvetica,sans-serif">

  <div style="display:none;font-size:1px;color:#F0F2F5;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">
    ${preheader || ''}
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0F2F5;padding:24px 12px">
    <tr>
      <td align="center">

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#FFFFFF;border-radius:14px;overflow:hidden;box-shadow:0 6px 20px rgba(11,31,58,0.08)">

          <tr>
            <td style="background:linear-gradient(135deg,#0B1F3A 0%,#172B4D 100%);padding:34px 24px 28px;text-align:center;border-bottom:3px solid #D4A63A">

              <img src="${BRAND.logoUrl}"
                   alt="Nexora Academy"
                   width="88"
                   height="88"
                   style="display:block;margin:0 auto 14px;border-radius:14px;background:#0B1F3A">

              <div style="color:#D4A63A;font-size:20px;font-weight:800;letter-spacing:4px;margin:0">
                NEXORA ACADEMY
              </div>
              <div style="color:rgba(255,255,255,0.7);font-size:11px;letter-spacing:3px;margin-top:6px">
                ${headerText || 'CONTRIBUTOR PROGRAM'}
              </div>
            </td>
          </tr>

          <tr>
            <td style="padding:32px 28px 8px">
              ${bodyHtml}
            </td>
          </tr>

          <tr>
            <td style="padding:24px 28px 8px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td width="50%" style="padding-right:6px">
                    <a href="${BRAND.whatsappUrl}"
                       style="display:block;background:#25D366;color:#FFFFFF;text-decoration:none;text-align:center;padding:13px 12px;border-radius:50px;font-weight:700;font-size:13px">
                      💬 Join WhatsApp
                    </a>
                  </td>
                  <td width="50%" style="padding-left:6px">
                    <a href="mailto:${BRAND.supportEmail}"
                       style="display:block;background:#EEF7FF;color:#0B1F3A;text-decoration:none;text-align:center;padding:13px 12px;border-radius:50px;font-weight:700;font-size:13px;border:2px solid #0B1F3A">
                      ✉️ Email Support
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:16px 28px 24px">
              <div style="border-top:1px solid #E2E8F0;padding-top:20px;color:#0B1F3A;font-size:14px">
                Warm regards,
                <div style="font-family:Georgia,serif;font-style:italic;font-size:22px;color:#0B1F3A;margin:8px 0 4px">
                  Brian Ondieki
                </div>
                <div style="font-weight:700;font-size:13px">${BRAND.principalName}</div>
                <div style="color:#64748B;font-size:12px">${BRAND.principalTitle}</div>
              </div>
            </td>
          </tr>

          <tr>
            <td style="background:#0B1F3A;padding:22px 28px;text-align:center;color:rgba(255,255,255,0.65);font-size:12px;line-height:1.7">
              <div style="color:#D4A63A;font-weight:700;letter-spacing:2px;font-size:13px;margin-bottom:8px">
                NEXORA ACADEMY
              </div>
              <div style="margin-bottom:12px">
                Empowering minds, building futures.
              </div>
              <div style="margin-bottom:12px">
                <a href="${BRAND.academyUrl}" style="color:#7CB8FF;text-decoration:none;margin:0 8px">Website</a>
                <span style="color:rgba(255,255,255,0.3)">•</span>
                <a href="${BRAND.privacyUrl}" style="color:#7CB8FF;text-decoration:none;margin:0 8px">Privacy Policy</a>
                <span style="color:rgba(255,255,255,0.3)">•</span>
                <a href="${BRAND.termsUrl}" style="color:#7CB8FF;text-decoration:none;margin:0 8px">Terms &amp; Conditions</a>
              </div>
              <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:10px">
                Questions? Reach us at
                <a href="mailto:${BRAND.supportEmail}" style="color:#D4A63A;text-decoration:none">${BRAND.supportEmail}</a>
              </div>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════
// CONTRIBUTOR DECISION EMAIL (approve or reject)
// ═══════════════════════════════════════════════════════════
async function sendContributorDecisionEmail({ to, name, approved, reason, portalUrl }) {
    if (!approved) {
        // ── REJECTION EMAIL ──
        const bodyHtml = `
          <h2 style="color:#0B1F3A;margin:0 0 14px;font-size:22px">Hello ${name},</h2>

          <p style="color:#475569;line-height:1.75;font-size:15px;margin:0 0 18px">
            Thank you for applying to the <strong>Nexora Academy Contributor Program</strong>. After careful review, we are unable to approve your application at this time.
          </p>

          ${reason ? `
            <div style="background:#FEF3C7;border-left:4px solid #D4A63A;padding:16px;border-radius:10px;margin:20px 0">
              <div style="color:#92400E;font-weight:700;font-size:13px;margin-bottom:6px">Reason</div>
              <div style="color:#78350F;font-size:14px;line-height:1.6">${reason}</div>
            </div>
          ` : ''}

          <p style="color:#475569;line-height:1.75;font-size:14px;margin:18px 0">
            You are welcome to <strong>reapply in the future</strong> with additional qualifications or experience.
          </p>

          <p style="color:#475569;line-height:1.75;font-size:14px;margin:18px 0">
            We appreciate your interest in Nexora Academy and wish you the very best.
          </p>
        `;

        return sendEmail({
            to,
            toName: name,
            subject: 'Nexora Academy — Contributor Application Update',
            html: buildEmailShell({
                headerText: 'CONTRIBUTOR PROGRAM',
                bodyHtml,
                preheader: 'An update on your Nexora Academy Contributor Program application.',
            }),
        });
    }

    // ── APPROVAL EMAIL ──
    const credBlock = `
        <div style="background:#EEF7FF;border-left:4px solid #29A9E8;padding:20px 18px;border-radius:10px;margin:22px 0">
          <div style="color:#0B1F3A;font-weight:700;font-size:15px;margin-bottom:8px">
            👉 Create your account using the link below
          </div>
          <div style="color:#475569;font-size:14px;line-height:1.6">
            Click the <strong>Open Contributor Portal</strong> button below to create your own account.
            Choose your own password when you sign up — for your security, we never send passwords by email.
          </div>
        </div>
    `;

    const bodyHtml = `
      <h2 style="color:#0B1F3A;margin:0 0 14px;font-size:22px">🎉 Welcome aboard, ${name}!</h2>

      <p style="color:#475569;line-height:1.75;font-size:15px;margin:0 0 8px">
        Your application to become a <strong>Nexora Academy Contributor</strong> has been
        <strong style="color:#16A34A">approved</strong>. You can now create your contributor account and start building courses.
      </p>

      ${credBlock}

      <!-- Big CTA button -->
      <div style="text-align:center;margin:28px 0">
        <a href="${portalUrl}"
           style="background:#29A9E8;color:#FFFFFF;padding:15px 36px;border-radius:50px;text-decoration:none;font-weight:700;display:inline-block;font-size:15px">
          Open Contributor Portal →
        </a>
      </div>

      <!-- Numbered next steps -->
      <div style="background:#F5F7FA;border-radius:12px;padding:20px;margin:24px 0">
        <div style="font-weight:700;color:#0B1F3A;font-size:15px;margin-bottom:16px">
          📋 Your Next Steps
        </div>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="30" valign="top" style="padding-bottom:14px">
              <div style="width:26px;height:26px;border-radius:50%;background:#29A9E8;color:#FFFFFF;text-align:center;line-height:26px;font-weight:700;font-size:13px">1</div>
            </td>
            <td valign="top" style="padding-bottom:14px;color:#334155;font-size:14px;line-height:1.6">
              <strong>Create your account</strong> — click the button above and set your own password.
            </td>
          </tr>
          <tr>
            <td width="30" valign="top" style="padding-bottom:14px">
              <div style="width:26px;height:26px;border-radius:50%;background:#29A9E8;color:#FFFFFF;text-align:center;line-height:26px;font-weight:700;font-size:13px">2</div>
            </td>
            <td valign="top" style="padding-bottom:14px;color:#334155;font-size:14px;line-height:1.6">
              <strong>Read the Contributor Manual</strong> — found in the portal under "Manuals".
            </td>
          </tr>
          <tr>
            <td width="30" valign="top" style="padding-bottom:14px">
              <div style="width:26px;height:26px;border-radius:50%;background:#29A9E8;color:#FFFFFF;text-align:center;line-height:26px;font-weight:700;font-size:13px">3</div>
            </td>
            <td valign="top" style="padding-bottom:14px;color:#334155;font-size:14px;line-height:1.6">
              <strong>Build your first course</strong> — follow the manual step by step and submit it for review.
            </td>
          </tr>
          <tr>
            <td width="30" valign="top">
              <div style="width:26px;height:26px;border-radius:50%;background:#29A9E8;color:#FFFFFF;text-align:center;line-height:26px;font-weight:700;font-size:13px">4</div>
            </td>
            <td valign="top" style="color:#334155;font-size:14px;line-height:1.6">
              <strong>Get it published</strong> — our team will carefully review your work and get back to you with feedback. <strong>UPDATES WILL BE SHARED</strong>.
            </td>
          </tr>
        </table>
      </div>

      <p style="color:#475569;line-height:1.75;font-size:14px;margin:22px 0 0">
        Read the Contributor Manual carefully before submitting your first course. If you have any questions, reach us using the buttons below.
      </p>
    `;

    return sendEmail({
        to,
        toName: name,
        subject: '🎉 Your Nexora Academy Contributor application is approved',
        html: buildEmailShell({
            headerText: 'CONTRIBUTOR PROGRAM',
            bodyHtml,
            preheader: `🎉 You're approved! Create your contributor account using the link in this email.`,
        }),
    });
}

module.exports = router;
