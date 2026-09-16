const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler, logActivity } = require('../utils');
const { requireAuth, requireApprovedStudent } = require('../middleware');

// GET /api/enrollments — current user's enrollments
router.get('/', requireAuth, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT e.id, e.enrolled_at, e.completed_at,
                c.id AS course_id, c.title, c.code, c.instructor_name,
                c.duration, c.price, c.cover_image_url,
                COALESCE(paid.total, 0) AS paid,
                (SELECT COUNT(*)::int FROM lessons l
                  JOIN modules m ON m.id = l.module_id
                  WHERE m.course_id = c.id AND l.published = TRUE) AS total_lessons,
                (SELECT COUNT(*)::int FROM lesson_progress lp
                  WHERE lp.user_id = e.user_id AND lp.course_id = c.id) AS completed_lessons
         FROM enrollments e
         JOIN courses c ON c.id = e.course_id
         LEFT JOIN (
            SELECT course_id, SUM(amount) AS total
            FROM transactions
            WHERE user_id = $1 AND payment_type = 'COURSE_PAYMENT'
              AND status = 'completed'
            GROUP BY course_id
         ) paid ON paid.course_id = c.id
         WHERE e.user_id = $1
         ORDER BY e.enrolled_at DESC`,
        [req.user.user_id]
    );
    res.json({ enrollments: r.rows });
}));

// POST /api/enrollments
router.post('/', requireAuth, requireApprovedStudent, asyncHandler(async (req, res) => {
    const { course_id } = req.body;
    if (!course_id) return res.status(400).json({ error: 'course_id required' });

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const c = await client.query(
            `SELECT id FROM courses WHERE id = $1 AND status = 'published'`,
            [course_id]
        );
        if (!c.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Course not available' });
        }

        const r = await client.query(
            `INSERT INTO enrollments (user_id, course_id)
             VALUES ($1, $2)
             ON CONFLICT (user_id, course_id) DO NOTHING
             RETURNING *`,
            [req.user.user_id, course_id]
        );

        await logActivity(client, req.user.user_id, 'enrollment',
            'Enrolled in course', `Course ID: ${course_id}`);
        await client.query('COMMIT');

        if (!r.rows.length) {
            return res.json({ ok: true, message: 'Already enrolled' });
        }
        res.status(201).json({ enrollment: r.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

module.exports = router;
