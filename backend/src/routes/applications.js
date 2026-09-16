const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler, genApplicationId, logActivity } = require('../utils');
const { requireAuth, requireAdmin } = require('../middleware');

// POST /api/applications — create application (before payment)
router.post('/', requireAuth, asyncHandler(async (req, res) => {
    const { course_interest } = req.body;
    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const existing = await client.query(
            `SELECT id FROM applications WHERE user_id = $1
             AND status IN ('payment_due','paid') LIMIT 1`,
            [req.user.user_id]
        );
        if (existing.rows.length) {
            await client.query('COMMIT');
            return res.status(409).json({ error: 'Application already pending' });
        }

        const appId = await genApplicationId(client);
        const u = await client.query(
            `SELECT full_name, email, phone, date_of_birth, country
             FROM users WHERE id = $1`,
            [req.user.user_id]
        );
        const user = u.rows[0];

        const r = await client.query(
            `INSERT INTO applications
                (application_id, user_id, full_name, email, phone,
                 date_of_birth, country, course_interest, status, payment_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'payment_due','unpaid')
             RETURNING *`,
            [appId, req.user.user_id, user.full_name, user.email,
             user.phone, user.date_of_birth, user.country,
             course_interest || null]
        );

        await client.query(
            `INSERT INTO application_history (application_id, action, note, performed_by)
             VALUES ($1, 'created', 'Application submitted', $2)`,
            [r.rows[0].id, req.user.user_id]
        );

        await logActivity(client, req.user.user_id, 'application',
            'Application Created', appId);
        await client.query('COMMIT');
        res.status(201).json({ application: r.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

// GET /api/applications/me — current user's application
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT a.*,
                COALESCE(json_agg(json_build_object(
                    'id', d.id, 'document_type', d.document_type,
                    'file_name', d.file_name, 'storage_path', d.storage_path,
                    'status', d.status, 'uploaded_at', d.uploaded_at
                )) FILTER (WHERE d.id IS NOT NULL), '[]'::json) AS documents
         FROM applications a
         LEFT JOIN application_documents d ON d.application_id = a.id
         WHERE a.user_id = $1
         GROUP BY a.id
         ORDER BY a.created_at DESC
         LIMIT 1`,
        [req.user.user_id]
    );
    res.json({ application: r.rows[0] || null });
}));

// GET /api/applications — admin: list all
router.get('/', requireAdmin, asyncHandler(async (req, res) => {
    const { status, payment_status, search, sort } = req.query;
    const conditions = [];
    const values = [];

    if (status) { values.push(status); conditions.push(`a.status = $${values.length}`); }
    if (payment_status) { values.push(payment_status); conditions.push(`a.payment_status = $${values.length}`); }
    if (search) {
        values.push(`%${search}%`);
        conditions.push(`(a.full_name ILIKE $${values.length} OR a.email ILIKE $${values.length} OR a.application_id ILIKE $${values.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const order = sort === 'oldest' ? 'ASC' : sort === 'name' ? 'ASC' : 'DESC';
    const orderBy = sort === 'name' ? 'a.full_name ASC' : `a.created_at ${order}`;

    const r = await db.query(
        `SELECT a.*,
                (SELECT COUNT(*)::int FROM application_documents d
                 WHERE d.application_id = a.id) AS document_count
         FROM applications a ${where}
         ORDER BY ${orderBy}`,
        values
    );
    res.json({ applications: r.rows });
}));

// GET /api/applications/:id — admin: single application with docs
router.get('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT a.* FROM applications a WHERE a.id = $1`,
        [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });

    const docs = await db.query(
        `SELECT id, document_type, file_name, storage_path, mime_type,
                file_size, status, rejection_reason, verified_at, uploaded_at
         FROM application_documents WHERE application_id = $1`,
        [req.params.id]
    );
    const history = await db.query(
        `SELECT h.*, u.full_name AS performed_by_name
         FROM application_history h
         LEFT JOIN users u ON u.id = h.performed_by
         WHERE h.application_id = $1
         ORDER BY h.created_at DESC`,
        [req.params.id]
    );
    res.json({
        application: r.rows[0],
        documents: docs.rows,
        history: history.rows,
    });
}));

// POST /api/applications/:id/approve
router.post('/:id/approve', requireAdmin, asyncHandler(async (req, res) => {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        const a = await client.query(
            `SELECT * FROM applications WHERE id = $1 FOR UPDATE`,
            [req.params.id]
        );
        if (!a.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Not found' });
        }
        const app = a.rows[0];
        if (app.payment_status !== 'paid') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Payment not completed' });
        }

        const { genAdmissionNumber } = require('../utils');
        let admissionNumber = app.admission_number;
        if (!admissionNumber) {
            admissionNumber = await genAdmissionNumber(client);
        }

        await client.query(
            `UPDATE applications SET status='approved', admission_number=$1,
                reviewed_at=NOW(), reviewed_by=$2 WHERE id=$3`,
            [admissionNumber, req.user.user_id, req.params.id]
        );

        await client.query(
            `UPDATE student_profiles SET admission_status='approved',
                approval_status='approved', approved_at=NOW(),
                approved_by=$1, admission_number=$2
             WHERE user_id=$3`,
            [req.user.user_id, admissionNumber, app.user_id]
        );

        await client.query(
            `INSERT INTO application_history (application_id, action, note, performed_by)
             VALUES ($1, 'approved', $2, $3)`,
            [req.params.id, `Admission: ${admissionNumber}`, req.user.user_id]
        );

        await logActivity(client, app.user_id, 'admission',
            'Application Approved', admissionNumber);

        await client.query('COMMIT');
        res.json({ ok: true, admission_number: admissionNumber });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

// POST /api/applications/:id/reject
router.post('/:id/reject', requireAdmin, asyncHandler(async (req, res) => {
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
            return res.status(404).json({ error: 'Not found' });
        }
        await client.query(
            `UPDATE applications SET status='rejected', rejection_reason=$1,
                reviewed_at=NOW(), reviewed_by=$2 WHERE id=$3`,
            [reason, req.user.user_id, req.params.id]
        );
        await client.query(
            `UPDATE student_profiles SET admission_status='rejected',
                approval_status='rejected', rejection_reason=$1
             WHERE user_id=$2`,
            [reason, a.rows[0].user_id]
        );
        await client.query(
            `INSERT INTO application_history (application_id, action, note, performed_by)
             VALUES ($1, 'rejected', $2, $3)`,
            [req.params.id, reason, req.user.user_id]
        );
        await logActivity(client, a.rows[0].user_id, 'admission',
            'Application Rejected', reason);
        await client.query('COMMIT');
        res.json({ ok: true });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

module.exports = router;
