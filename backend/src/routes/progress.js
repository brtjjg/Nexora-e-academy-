const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../utils');
const { requireAuth } = require('../middleware');

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
    res.json({ ok: true });
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
    const { answers } = req.body; // { question_id: selected_index }
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
        res.json({ attempt: r.rows[0] });
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

module.exports = router;
