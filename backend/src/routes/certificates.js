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

module.exports = router;
