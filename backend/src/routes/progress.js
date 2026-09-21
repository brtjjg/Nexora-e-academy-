const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../utils');
const { requireAuth } = require('../middleware');
const { sendCertificateIssued } = require('../email');

// GET /api/progress/:courseId — completed lesson IDs
router.get('/:courseId', requireAuth, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT lesson_id FROM lesson_progress
         WHERE user_id = $1 AND course_id = $2`,
        [req.user.user_id, req.params.courseId]
    );
    res.json({ completed: r.rows.map(x => x.lesson_id) });
}));

// POST /api/progress/:courseId/lessons/:lessonId — mark complete
router.post('/:courseId/lessons/:lessonId', requireAuth, asyncHandler(async (req, res) => {
    const { courseId, lessonId } = req.params;
    await db.query(
        `INSERT INTO lesson_progress (user_id, course_id, lesson_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, lesson_id) DO NOTHING`,
        [req.user.user_id, courseId, lessonId]
    );

    // 🎯 Check if the entire course is now complete → auto-issue certificate
    const certificate = await maybeIssueCertificate(req.user.user_id, courseId);

    res.json({ ok: true, certificateIssued: !!certificate, certificate });
}));

// DELETE /api/progress/:courseId/lessons/:lessonId — unmark
router.delete('/:courseId/lessons/:lessonId', requireAuth, asyncHandler(async (req, res) => {
    const { courseId, lessonId } = req.params;
    await db.query(
        `DELETE FROM lesson_progress
         WHERE user_id = $1 AND course_id = $2 AND lesson_id = $3`,
        [req.user.user_id, courseId, lessonId]
    );
    res.json({ ok: true });
}));

// POST /api/progress/:courseId/assessments/:type/submit
router.post('/:courseId/assessments/:type/submit', requireAuth, asyncHandler(async (req, res) => {
    const { courseId, type } = req.params;
    const { answers } = req.body;
    if (!['exam','cat'].includes(type)) {
        return res.status(400).json({ error: 'Invalid assessment type' });
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const qRes = await client.query(
            `SELECT id, correct_index, marks FROM questions
             WHERE course_id = $1 AND question_type = $2`,
            [courseId, type]
        );
        if (!qRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'No questions for this assessment' });
        }

        let score = 0;
        let totalMarks = 0;
        for (const q of qRes.rows) {
            totalMarks += q.marks;
            const selected = answers && answers[q.id];
            if (selected !== undefined && parseInt(selected, 10) === q.correct_index) {
                score += q.marks;
            }
        }

        const percentage = totalMarks ? (score / totalMarks) * 100 : 0;
        const courseRes = await client.query(
            `SELECT ${type === 'exam' ? 'exam_pass_mark' : 'cat_pass_mark'} AS pass_mark
             FROM courses WHERE id = $1`,
            [courseId]
        );
        const passMark = courseRes.rows[0]?.pass_mark || 50;
        const passed = percentage >= passMark;

        const r = await client.query(
            `INSERT INTO assessment_attempts
                (user_id, course_id, assessment_type, score, total_marks,
                 percentage, passed, answers, submitted_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,NOW())
             ON CONFLICT (user_id, course_id, assessment_type)
             DO UPDATE SET score = EXCLUDED.score,
                           total_marks = EXCLUDED.total_marks,
                           percentage = EXCLUDED.percentage,
                           passed = EXCLUDED.passed,
                           answers = EXCLUDED.answers,
                           submitted_at = NOW()
             RETURNING *`,
            [req.user.user_id, courseId, type, score, totalMarks,
             percentage.toFixed(2), passed, JSON.stringify(answers || {})]
        );

        await client.query('COMMIT');

        // 🎯 If this was the exam and student passed AND all lessons done AND fully paid → issue cert
        let certificate = null;
        if (type === 'exam' && passed) {
            certificate = await maybeIssueCertificate(req.user.user_id, courseId);
        }

        res.json({ attempt: r.rows[0], certificateIssued: !!certificate, certificate });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

// GET /api/progress/results — all results for current user
router.get('/results/all', requireAuth, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT a.*, c.title AS course_title, c.code AS course_code
         FROM assessment_attempts a
         JOIN courses c ON c.id = a.course_id
         WHERE a.user_id = $1
         ORDER BY a.submitted_at DESC`,
        [req.user.user_id]
    );
    res.json({ results: r.rows });
}));

/* ============================================================
   🎓 CERTIFICATE AUTO-ISSUE LOGIC
   ============================================================ */

/**
 * Checks if a student qualifies for a certificate and issues it if so.
 * Requirements:
 *   1. All published lessons completed
 *   2. Course fully paid (or user is admin)
 *   3. Certificate doesn't already exist
 *
 * Returns the certificate row if issued, or null.
 */
async function maybeIssueCertificate(userId, courseId) {
    try {
        // 1. Get course info
        const courseRes = await db.query(
            `SELECT id, title, code, price FROM courses WHERE id = $1`,
            [courseId]
        );
        if (!courseRes.rows.length) return null;
        const course = courseRes.rows[0];

        // 2. Check if user is admin (admins bypass payment requirement)
        const userRes = await db.query(
            `SELECT role FROM users WHERE id = $1`,
            [userId]
        );
        const isAdmin = userRes.rows[0]?.role === 'admin';

        // 3. Count lessons
        const lessonRes = await db.query(
            `SELECT COUNT(*)::int AS total
             FROM lessons l
             JOIN modules m ON m.id = l.module_id
             WHERE m.course_id = $1 AND l.published = TRUE`,
            [courseId]
        );
        const totalLessons = lessonRes.rows[0]?.total || 0;
        if (totalLessons === 0) return null;

        const progressRes = await db.query(
            `SELECT COUNT(*)::int AS completed
             FROM lesson_progress
             WHERE user_id = $1 AND course_id = $2`,
            [userId, courseId]
        );
        const completedLessons = progressRes.rows[0]?.completed || 0;

        // Requirement 1: all lessons must be complete
        if (completedLessons < totalLessons) {
            console.log(`[cert] Not issuing — lessons: ${completedLessons}/${totalLessons}`);
            return null;
        }

        // 4. Check payment (skip for admin)
        if (!isAdmin) {
            const paidRes = await db.query(
                `SELECT COALESCE(SUM(amount), 0)::numeric AS paid
                 FROM transactions
                 WHERE user_id = $1 AND course_id = $2
                   AND payment_type = 'COURSE_PAYMENT'
                   AND status = 'completed'`,
                [userId, courseId]
            );
            const paid = parseFloat(paidRes.rows[0]?.paid || 0);
            const price = parseFloat(course.price || 0);
            // Requirement 2: fully paid (with floating-point tolerance)
            if (price > 0 && paid < price - 0.01) {
                console.log(`[cert] Not issuing — payment: ${paid}/${price}`);
                return null;
            }
        }

        // 5. Check if certificate already exists
        const existing = await db.query(
            `SELECT id FROM certificates WHERE user_id = $1 AND course_id = $2`,
            [userId, courseId]
        );
        if (existing.rows.length) {
            console.log(`[cert] Already issued`);
            return null;
        }

        // 6. Generate certificate ID
        const certId = await generateCertificateId(course.code);
        const verifyToken = require('crypto').randomBytes(16).toString('hex');

        // 7. Insert certificate
        const insert = await db.query(
            `INSERT INTO certificates
                (user_id, course_id, certificate_id, verification_token, issued_date)
             VALUES ($1, $2, $3, $4, NOW())
             RETURNING *`,
            [userId, courseId, certId, verifyToken]
        );

        const certificate = insert.rows[0];
        console.log(`[cert] 🎓 Issued certificate ${certId} to user ${userId}`);

        // 8. Send email notification (fire-and-forget)
        (async () => {
            try {
                const userRow = await db.query(
                    `SELECT full_name, email FROM users WHERE id = $1`, [userId]
                );
                const u = userRow.rows[0];
                if (u && u.email) {
                    await sendCertificateIssued({
                        to: u.email,
                        recipientName: u.full_name,
                        courseName: course.title,
                        certificateId: certId,
                    });
                }
            } catch (e) {
                console.error('[cert:email]', e.message);
            }
        })();

        return certificate;
    } catch (err) {
        console.error('[maybeIssueCertificate]', err.message);
        return null;
    }
}

/**
 * Generates a unique certificate ID like:
 *   NXA-CP-2026-000001
 */
async function generateCertificateId(courseCode) {
    const code = (courseCode || 'COURSE').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const year = new Date().getFullYear();
    const prefix = `NXA-${code}-${year}-`;

    const seq = await db.query(
        `SELECT COUNT(*)::int + 1 AS next FROM certificates
         WHERE certificate_id LIKE $1`,
        [`${prefix}%`]
    );
    const next = seq.rows[0]?.next || 1;
    const suffix = String(next).padStart(6, '0');
    return `${prefix}${suffix}`;
}

module.exports = router;
