const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler, genCertificateId } = require('../utils');
const { requireAuth, requireAdmin } = require('../middleware');

// GET /api/certificates/verify/:token — public
router.get('/verify/:token', asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT certificate_id, student_name, course_name, course_duration,
                grade, issued_date, revoked
         FROM certificates
         WHERE certificate_id = $1 OR verification_token = $1`,
        [req.params.token]
    );
    if (!r.rows.length) {
        return res.status(404).json({ valid: false, error: 'Not found' });
    }
    const cert = r.rows[0];
    if (cert.revoked) {
        return res.json({ valid: false, revoked: true, certificate: cert });
    }
    res.json({ valid: true, certificate: cert });
}));

// GET /api/certificates/me
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT c.* FROM certificates c
         WHERE c.user_id = $1 AND c.revoked = FALSE
         ORDER BY c.issued_date DESC`,
        [req.user.user_id]
    );
    res.json({ certificates: r.rows });
}));

// POST /api/certificates/issue — admin issues certificate
router.post('/issue', requireAdmin, asyncHandler(async (req, res) => {
    const { user_id, course_id, grade } = req.body;
    if (!user_id || !course_id) {
        return res.status(400).json({ error: 'user_id and course_id required' });
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const u = await client.query(
            `SELECT full_name FROM users WHERE id = $1`,
            [user_id]
        );
        const c = await client.query(
            `SELECT title, code, duration FROM courses WHERE id = $1`,
            [course_id]
        );
        if (!u.rows.length || !c.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User or course not found' });
        }

        const certId = await genCertificateId(client, c.rows[0].code || 'CRS');
        const token = require('crypto').randomBytes(24).toString('hex');

        const r = await client.query(
            `INSERT INTO certificates
                (certificate_id, verification_token, user_id, course_id,
                 student_name, course_name, course_duration, grade, issued_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (user_id, course_id) DO NOTHING
             RETURNING *`,
            [certId, token, user_id, course_id, u.rows[0].full_name,
             c.rows[0].title, c.rows[0].duration, grade || 'Competent',
             req.user.user_id]
        );

        if (!r.rows.length) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Certificate already issued' });
        }

        await client.query('COMMIT');
        res.status(201).json({ certificate: r.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

// POST /api/certificates/:id/revoke
router.post('/:id/revoke', requireAdmin, asyncHandler(async (req, res) => {
    const { reason } = req.body;
    const r = await db.query(
        `UPDATE certificates
         SET revoked = TRUE, revoked_at = NOW(), revoke_reason = $1
         WHERE id = $2 RETURNING *`,
        [reason || null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ certificate: r.rows[0] });
}));

// GET /api/certificates — admin list
router.get('/', requireAdmin, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT c.*, u.email AS student_email
         FROM certificates c
         JOIN users u ON u.id = c.user_id
         ORDER BY c.issued_date DESC`
    );
    res.json({ certificates: r.rows });
}));

module.exports = router;
