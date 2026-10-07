// backend/src/routes/certificates.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../utils');
const { requireAuth, requireAdmin } = require('../middleware');

/* ═══════════════════════════════════════════════════════════
   PUBLIC: GET /api/certificates/verify/:id
   Verifies a certificate by certificate_id OR verification_token
   ═══════════════════════════════════════════════════════════ */
router.get('/verify/:id', asyncHandler(async (req, res) => {
    const r = await db.query(`
        SELECT
            c.certificate_id,
            c.verification_token,
            c.issued_date,
            c.revoked,
            c.student_name,
            c.course_name,
            c.course_duration,
            c.grade,
            u.id AS student_id,
            u.email AS student_email
        FROM certificates c
        LEFT JOIN users u ON u.id = c.user_id
        WHERE c.certificate_id = $1 OR c.verification_token = $1
        LIMIT 1
    `, [req.params.id]);

    if (!r.rows.length) {
        return res.status(200).json({ valid: false, error: 'Not found' });
    }

    const cert = r.rows[0];

    if (cert.revoked) {
        return res.status(200).json({ valid: false, error: 'Revoked', certificate: cert });
    }

    res.json({
        valid: true,
        certificate: {
            certificate_id: cert.certificate_id,
            student_name: cert.student_name,
            student_id: cert.student_id,
            course_name: cert.course_name,
            course_duration: cert.course_duration,
            grade: cert.grade,
            issued_date: cert.issued_date,
        },
    });
}));

/* ═══════════════════════════════════════════════════════════
   STUDENT: GET /api/certificates/me
   ═══════════════════════════════════════════════════════════ */
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
    const userId = req.user.user_id || req.user.id;
    const r = await db.query(`
        SELECT
            id, certificate_id, user_id, course_id,
            student_name, course_name, course_duration, grade,
            issued_date, revoked
        FROM certificates
        WHERE user_id = $1 AND revoked = FALSE
        ORDER BY issued_date DESC
    `, [userId]);
    res.json({ certificates: r.rows });
}));

/* ═══════════════════════════════════════════════════════════
   ADMIN: GET /api/certificates
   ═══════════════════════════════════════════════════════════ */
router.get('/', requireAdmin, asyncHandler(async (req, res) => {
    const r = await db.query(`
        SELECT
            c.id, c.certificate_id, c.student_name, c.course_name,
            c.course_duration, c.grade, c.issued_date, c.revoked,
            u.email AS student_email
        FROM certificates c
        LEFT JOIN users u ON u.id = c.user_id
        ORDER BY c.issued_date DESC
        LIMIT 500
    `);
    res.json({ certificates: r.rows });
}));

/* ═══════════════════════════════════════════════════════════
   ADMIN: POST /api/certificates
   Issue a new certificate manually
   Body: { user_id, course_id, grade? }
   ═══════════════════════════════════════════════════════════ */
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { user_id, course_id, grade } = req.body || {};
    if (!user_id || !course_id) {
        return res.status(400).json({ error: 'user_id and course_id are required' });
    }

    // 1) Load student
    const stu = await db.query(
        `SELECT id, full_name, email FROM users WHERE id = $1`,
        [user_id]
    );
    if (!stu.rows.length) {
        return res.status(404).json({ error: 'Student not found' });
    }
    const student = stu.rows[0];

    // 2) Load course
    const crs = await db.query(
        `SELECT id, title, code, duration FROM courses WHERE id = $1`,
        [course_id]
    );
    if (!crs.rows.length) {
        return res.status(404).json({ error: 'Course not found' });
    }
    const course = crs.rows[0];

    // 3) Prevent duplicates (same student + same course, not revoked)
    const dup = await db.query(
        `SELECT id, certificate_id FROM certificates
         WHERE user_id = $1 AND course_id = $2 AND revoked = FALSE
         LIMIT 1`,
        [user_id, course_id]
    );
    if (dup.rows.length) {
        return res.status(409).json({
            error: 'Certificate already issued for this student and course',
            certificate_id: dup.rows[0].certificate_id,
        });
    }

    // 4) Generate a unique certificate_id
    //    Format: NXA-CP-2026-000001  (CP = course prefix, or "GEN")
    const prefix = (course.code || 'GEN').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 6) || 'GEN';
    const year = new Date().getFullYear();
    const seqRow = await db.query(
        `SELECT COUNT(*)::int AS c FROM certificates
         WHERE certificate_id LIKE $1`,
        [`NXA-${prefix}-${year}-%`]
    );
    const nextNum = String(seqRow.rows[0].c + 1).padStart(6, '0');
    const certificate_id = `NXA-${prefix}-${year}-${nextNum}`;

    // 5) Generate a random verification token (32 hex chars)
    const crypto = require('crypto');
    const verification_token = crypto.randomBytes(16).toString('hex');

    // 6) Insert
    const ins = await db.query(
        `INSERT INTO certificates
            (certificate_id, verification_token, user_id, course_id,
             student_name, course_name, course_duration, grade, issued_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
            certificate_id,
            verification_token,
            user_id,
            course_id,
            student.full_name || 'Student',
            course.title || 'Course',
            course.duration || null,
            grade || 'Pass',
            req.user.user_id || req.user.id,
        ]
    );

    res.status(201).json({
        certificate: ins.rows[0],
        verify_url: `https://nexora-certificates.vercel.app/#verify/${certificate_id}`,
    });
}));

/* ═══════════════════════════════════════════════════════════
   ADMIN: POST /api/certificates/:id/revoke
   ═══════════════════════════════════════════════════════════ */
router.post('/:id/revoke', requireAdmin, asyncHandler(async (req, res) => {
    const { reason } = req.body;
    const r = await db.query(`
        UPDATE certificates
        SET revoked = TRUE, revoked_at = NOW(), revoke_reason = $1
        WHERE id = $2
        RETURNING *
    `, [reason || 'Revoked by admin', req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Certificate not found' });
    res.json({ certificate: r.rows[0] });
}));

/* ═══════════════════════════════════════════════════════════
   ADMIN: POST /api/certificates/:id/restore
   Un-revoke a certificate (flip revoked = FALSE)
   ═══════════════════════════════════════════════════════════ */
router.post('/:id/restore', requireAdmin, asyncHandler(async (req, res) => {
    const r = await db.query(
        `UPDATE certificates
         SET revoked = FALSE, revoked_at = NULL, revoke_reason = NULL
         WHERE id = $1
         RETURNING *`,
        [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Certificate not found' });
    res.json({ certificate: r.rows[0] });
}));

/* ═══════════════════════════════════════════════════════════
   ADMIN: POST /api/certificates/:id/reissue
   Creates a NEW certificate for the same student+course
   (old one stays revoked for history)
   ═══════════════════════════════════════════════════════════ */
router.post('/:id/reissue', requireAdmin, asyncHandler(async (req, res) => {
    // Find the old certificate to copy student + course from
    const old = await db.query(
        `SELECT * FROM certificates WHERE id = $1`,
        [req.params.id]
    );
    if (!old.rows.length) return res.status(404).json({ error: 'Certificate not found' });
    const o = old.rows[0];

    // Reuse the issue endpoint's logic — generate new ID + token
    const prefix = 'RE';  // "Reissue" prefix
    const year = new Date().getFullYear();
    const seqRow = await db.query(
        `SELECT COUNT(*)::int AS c FROM certificates
         WHERE certificate_id LIKE $1`,
        [`NXA-${prefix}-${year}-%`]
    );
    const nextNum = String(seqRow.rows[0].c + 1).padStart(6, '0');
    const certificate_id = `NXA-${prefix}-${year}-${nextNum}`;

    const crypto = require('crypto');
    const verification_token = crypto.randomBytes(16).toString('hex');

    const ins = await db.query(
        `INSERT INTO certificates
            (certificate_id, verification_token, user_id, course_id,
             student_name, course_name, course_duration, grade, issued_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
            certificate_id,
            verification_token,
            o.user_id,
            o.course_id,
            o.student_name,
            o.course_name,
            o.course_duration,
            o.grade || 'Pass',
            req.user.user_id || req.user.id,
        ]
    );

    res.status(201).json({
        certificate: ins.rows[0],
        replaces: o.certificate_id,
        verify_url: `https://nexora-certificates.vercel.app/#verify/${certificate_id}`,
    });
}));

module.exports = router;
