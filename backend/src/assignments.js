const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler, money } = require('../utils');
const { requireAuth, requireAdmin } = require('../middleware');

// ============================================================
// HELPERS
// ============================================================
async function notify(client, userId, type, title, body, link) {
    await client.query(
        `INSERT INTO notifications (user_id, type, title, body, link)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, type, title, body || null, link || null]
    );
}

async function logAssignmentHistory(client, submissionId, action, note, userId) {
    await client.query(
        `INSERT INTO assignment_history (submission_id, action, note, performed_by)
         VALUES ($1, $2, $3, $4)`,
        [submissionId, action, note || null, userId || null]
    );
}

// ============================================================
// ADMIN: CREATE ASSIGNMENT
// POST /api/assignments
// ============================================================
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const {
        course_id, module_id, lesson_id, title, instructions,
        max_marks, allow_text, allow_file, allowed_file_types,
        max_file_mb, due_date, allow_resubmission, max_attempts,
        status, weight_percent, position,
    } = req.body;

    if (!course_id || !title) {
        return res.status(400).json({ error: 'course_id and title required' });
    }

    const r = await db.query(
        `INSERT INTO assignments
            (course_id, module_id, lesson_id, title, instructions,
             max_marks, allow_text, allow_file, allowed_file_types,
             max_file_mb, due_date, allow_resubmission, max_attempts,
             status, weight_percent, position, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
             COALESCE($16, (SELECT COALESCE(MAX(position),0)+1 FROM assignments WHERE course_id=$1)),
             $17)
         RETURNING *`,
        [
            course_id, module_id || null, lesson_id || null,
            title, instructions || null,
            max_marks || 20,
            allow_text !== false,
            allow_file !== false,
            allowed_file_types || 'pdf,docx,jpg,png',
            max_file_mb || 10,
            due_date || null,
            allow_resubmission !== false,
            max_attempts || 2,
            status || 'draft',
            weight_percent || 0,
            position || null,
            req.user.user_id,
        ]
    );

    res.status(201).json({ assignment: r.rows[0] });
}));

// ============================================================
// ADMIN: UPDATE ASSIGNMENT
// PUT /api/assignments/:id
// ============================================================
router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const fields = [
        'title', 'instructions', 'max_marks', 'allow_text', 'allow_file',
        'allowed_file_types', 'max_file_mb', 'due_date', 'allow_resubmission',
        'max_attempts', 'status', 'weight_percent', 'position', 'module_id', 'lesson_id',
    ];
    const updates = [];
    const values = [];
    fields.forEach(f => {
        if (f in req.body) {
            values.push(req.body[f]);
            updates.push(`${f} = $${values.length}`);
        }
    });
    if (!updates.length) return res.status(400).json({ error: 'No fields' });
    values.push(req.params.id);
    const r = await db.query(
        `UPDATE assignments SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
        values
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ assignment: r.rows[0] });
}));

// ============================================================
// ADMIN: DELETE ASSIGNMENT
// ============================================================
router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await db.query('DELETE FROM assignments WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
}));

// ============================================================
// ADMIN: LIST ALL ASSIGNMENTS
// GET /api/assignments?course_id=...
// ============================================================
router.get('/', requireAuth, asyncHandler(async (req, res) => {
    const { course_id, module_id, status } = req.query;
    const conditions = [];
    const values = [];
    if (course_id) { values.push(course_id); conditions.push(`a.course_id = $${values.length}`); }
    if (module_id) { values.push(module_id); conditions.push(`a.module_id = $${values.length}`); }
    if (status) { values.push(status); conditions.push(`a.status = $${values.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const r = await db.query(
        `SELECT a.*, c.title AS course_title, m.title AS module_title,
                (SELECT COUNT(*)::int FROM assignment_submissions s WHERE s.assignment_id = a.id) AS submission_count,
                (SELECT COUNT(*)::int FROM assignment_submissions s WHERE s.assignment_id = a.id AND s.status = 'marked') AS marked_count
         FROM assignments a
         LEFT JOIN courses c ON c.id = a.course_id
         LEFT JOIN modules m ON m.id = a.module_id
         ${where}
         ORDER BY a.created_at DESC`,
        values
    );
    res.json({ assignments: r.rows });
}));

// ============================================================
// STUDENT: GET ASSIGNMENTS FOR A COURSE
// GET /api/assignments/course/:courseId
// ============================================================
router.get('/course/:courseId', requireAuth, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT a.*, m.title AS module_title,
                s.id AS submission_id, s.status AS submission_status,
                s.marks, s.percentage, s.feedback, s.marked_at,
                s.submitted_at, s.attempt_number, s.return_reason,
                (SELECT COUNT(*)::int FROM assignment_submissions s2
                 WHERE s2.assignment_id = a.id AND s2.student_id = $2) AS attempts_used
         FROM assignments a
         LEFT JOIN modules m ON m.id = a.module_id
         LEFT JOIN assignment_submissions s
            ON s.assignment_id = a.id AND s.student_id = $2
            AND s.attempt_number = (
                SELECT MAX(attempt_number) FROM assignment_submissions s3
                WHERE s3.assignment_id = a.id AND s3.student_id = $2
            )
         WHERE a.course_id = $1 AND a.status = 'published'
         ORDER BY m.position, a.position`,
        [req.params.courseId, req.user.user_id]
    );
    res.json({ assignments: r.rows });
}));

// ============================================================
// GET SINGLE ASSIGNMENT (with all my attempts)
// GET /api/assignments/:id
// ============================================================
router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
    const a = await db.query(
        `SELECT a.*, c.title AS course_title, m.title AS module_title
         FROM assignments a
         LEFT JOIN courses c ON c.id = a.course_id
         LEFT JOIN modules m ON m.id = a.module_id
         WHERE a.id = $1`,
        [req.params.id]
    );
    if (!a.rows.length) return res.status(404).json({ error: 'Not found' });

    const subs = await db.query(
        `SELECT s.*, u.full_name AS marked_by_name
         FROM assignment_submissions s
         LEFT JOIN users u ON u.id = s.marked_by
         WHERE s.assignment_id = $1 AND s.student_id = $2
         ORDER BY s.attempt_number DESC`,
        [req.params.id, req.user.user_id]
    );

    res.json({ assignment: a.rows[0], submissions: subs.rows });
}));

// ============================================================
// STUDENT: SUBMIT ASSIGNMENT
// POST /api/assignments/:id/submit
// Body: { text_answer, file_path, file_name, file_type, file_size }
// ============================================================
router.post('/:id/submit', requireAuth, asyncHandler(async (req, res) => {
    const { text_answer, file_path, file_name, file_type, file_size } = req.body;
    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const a = await client.query(`SELECT * FROM assignments WHERE id = $1 FOR UPDATE`, [req.params.id]);
        if (!a.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Assignment not found' }); }
        const assignment = a.rows[0];

        if (assignment.status !== 'published') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Assignment is not open for submissions' });
        }
        if (assignment.allow_text && !assignment.allow_file && !text_answer) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Text answer required' });
        }
        if (assignment.allow_file && !assignment.allow_text && !file_path) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'File required' });
        }
        if (!text_answer && !file_path) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Provide a text answer or upload a file' });
        }

        // Check attempts
        const used = await client.query(
            `SELECT COUNT(*)::int AS c FROM assignment_submissions
             WHERE assignment_id = $1 AND student_id = $2`,
            [req.params.id, req.user.user_id]
        );
        const attemptsUsed = used.rows[0].c;
        if (attemptsUsed >= assignment.max_attempts) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `Maximum attempts reached (${assignment.max_attempts})` });
        }

        // Due date check (soft warning, not blocking)
        const pastDue = assignment.due_date && new Date(assignment.due_date) < new Date();

        const attemptNumber = attemptsUsed + 1;

        const s = await client.query(
            `INSERT INTO assignment_submissions
                (assignment_id, student_id, attempt_number, text_answer,
                 file_path, file_name, file_type, file_size, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'submitted')
             RETURNING *`,
            [req.params.id, req.user.user_id, attemptNumber,
             text_answer || null, file_path || null, file_name || null,
             file_type || null, file_size || null]
        );

        await logAssignmentHistory(client, s.rows[0].id, 'submitted',
            `Attempt ${attemptNumber}${pastDue ? ' (late)' : ''}`, req.user.user_id);

        // Notify admins
        const admins = await client.query(`SELECT id FROM users WHERE role = 'admin'`);
        for (const adm of admins.rows) {
            await notify(client, adm.id, 'assignment_submitted',
                'New assignment submitted',
                `${req.user.full_name} submitted ${assignment.title}`,
                `/admin/assignments/${req.params.id}`);
        }

        await client.query('COMMIT');
        res.status(201).json({ submission: s.rows[0], late: pastDue });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

// ============================================================
// ADMIN: LIST ALL SUBMISSIONS
// GET /api/assignments/submissions?status=pending|marked|returned
// ============================================================
router.get('/submissions/list', requireAdmin, asyncHandler(async (req, res) => {
    const { status, assignment_id } = req.query;
    const conditions = [];
    const values = [];
    if (status === 'pending') conditions.push(`s.status IN ('submitted','resubmitted')`);
    else if (status === 'marked') conditions.push(`s.status = 'marked'`);
    else if (status === 'returned') conditions.push(`s.status = 'returned'`);
    if (assignment_id) { values.push(assignment_id); conditions.push(`s.assignment_id = $${values.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const r = await db.query(
        `SELECT s.*, a.title AS assignment_title, a.max_marks,
                a.course_id, a.module_id,
                u.full_name AS student_name, u.email AS student_email,
                sp.admission_number,
                c.title AS course_title, m.title AS module_title
         FROM assignment_submissions s
         JOIN assignments a ON a.id = s.assignment_id
         JOIN users u ON u.id = s.student_id
         LEFT JOIN student_profiles sp ON sp.user_id = u.id
         LEFT JOIN courses c ON c.id = a.course_id
         LEFT JOIN modules m ON m.id = a.module_id
         ${where}
         ORDER BY s.submitted_at DESC`,
        values
    );
    res.json({ submissions: r.rows });
}));

// ============================================================
// ADMIN: GET SINGLE SUBMISSION
// ============================================================
router.get('/submissions/:id', requireAdmin, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT s.*, a.title AS assignment_title, a.max_marks,
                a.instructions, a.course_id, a.module_id,
                u.full_name AS student_name, u.email AS student_email,
                sp.admission_number,
                c.title AS course_title, m.title AS module_title,
                marker.full_name AS marked_by_name
         FROM assignment_submissions s
         JOIN assignments a ON a.id = s.assignment_id
         JOIN users u ON u.id = s.student_id
         LEFT JOIN student_profiles sp ON sp.user_id = u.id
         LEFT JOIN courses c ON c.id = a.course_id
         LEFT JOIN modules m ON m.id = a.module_id
         LEFT JOIN users marker ON marker.id = s.marked_by
         WHERE s.id = $1`,
        [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });

    const history = await db.query(
        `SELECT h.*, u.full_name AS performed_by_name
         FROM assignment_history h
         LEFT JOIN users u ON u.id = h.performed_by
         WHERE h.submission_id = $1
         ORDER BY h.created_at DESC`,
        [req.params.id]
    );
    res.json({ submission: r.rows[0], history: history.rows });
}));

// ============================================================
// ADMIN: MARK SUBMISSION
// POST /api/assignments/submissions/:id/mark
// Body: { marks, feedback, release }
// ============================================================
router.post('/submissions/:id/mark', requireAdmin, asyncHandler(async (req, res) => {
    const { marks, feedback, release } = req.body;
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        const s = await client.query(
            `SELECT s.*, a.max_marks, a.title AS assignment_title
             FROM assignment_submissions s
             JOIN assignments a ON a.id = s.assignment_id
             WHERE s.id = $1 FOR UPDATE`,
            [req.params.id]
        );
        if (!s.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }

        const sub = s.rows[0];
        const m = parseFloat(marks);
        if (isNaN(m) || m < 0 || m > sub.max_marks) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `Marks must be between 0 and ${sub.max_marks}` });
        }
        const percentage = money((m / sub.max_marks) * 100);
        const newStatus = release ? 'marked' : 'submitted';

        await client.query(
            `UPDATE assignment_submissions
             SET marks = $1, percentage = $2, feedback = $3,
                 status = $4, marked_at = NOW(), marked_by = $5
             WHERE id = $6`,
            [m, percentage, feedback || null, newStatus, req.user.user_id, req.params.id]
        );

        await logAssignmentHistory(client, req.params.id, newStatus === 'marked' ? 'marked' : 'graded',
            `Marks: ${m}/${sub.max_marks}${release ? ' (released)' : ' (held)'}`, req.user.user_id);

        if (release) {
            await notify(client, sub.student_id, 'assignment_marked',
                'Your assignment has been marked',
                `${sub.assignment_title}: ${m}/${sub.max_marks} (${percentage.toFixed(1)}%)`,
                `/student/assignments/${sub.assignment_id}`);
        }

        await client.query('COMMIT');
        res.json({ ok: true, marks: m, percentage, released: !!release });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

// ============================================================
// ADMIN: RETURN FOR RESUBMISSION
// POST /api/assignments/submissions/:id/return
// Body: { reason }
// ============================================================
router.post('/submissions/:id/return', requireAdmin, asyncHandler(async (req, res) => {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Reason required' });

    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        const s = await client.query(
            `SELECT s.*, a.title AS assignment_title
             FROM assignment_submissions s
             JOIN assignments a ON a.id = s.assignment_id
             WHERE s.id = $1`,
            [req.params.id]
        );
        if (!s.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
        const sub = s.rows[0];

        await client.query(
            `UPDATE assignment_submissions
             SET status = 'returned', return_reason = $1, returned_at = NOW()
             WHERE id = $2`,
            [reason, req.params.id]
        );

        await logAssignmentHistory(client, req.params.id, 'returned', reason, req.user.user_id);
        await notify(client, sub.student_id, 'assignment_returned',
            'Your assignment requires correction',
            `${sub.assignment_title}: ${reason}`,
            `/student/assignments/${sub.assignment_id}`);

        await client.query('COMMIT');
        res.json({ ok: true });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

// ============================================================
// STUDENT: GET MY ASSIGNMENTS SUMMARY (dashboard)
// ============================================================
router.get('/me/summary', requireAuth, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT a.id, a.title, a.max_marks, a.due_date,
                c.title AS course_title,
                s.marks, s.percentage, s.status AS submission_status,
                s.feedback, s.submitted_at, s.marked_at,
                s.attempt_number
         FROM assignments a
         JOIN courses c ON c.id = a.course_id
         JOIN enrollments e ON e.course_id = a.course_id AND e.user_id = $1
         LEFT JOIN assignment_submissions s
            ON s.assignment_id = a.id AND s.student_id = $1
            AND s.attempt_number = (
                SELECT MAX(attempt_number) FROM assignment_submissions s3
                WHERE s3.assignment_id = a.id AND s3.student_id = $1
            )
         WHERE a.status = 'published'
         ORDER BY c.title, a.position`,
        [req.user.user_id]
    );

    const assignments = r.rows;
    const total = assignments.length;
    const submitted = assignments.filter(a => a.submission_status).length;
    const marked = assignments.filter(a => a.submission_status === 'marked').length;
    const pending = submitted - marked;
    const markedList = assignments.filter(a => a.submission_status === 'marked' && a.percentage != null);
    const average = markedList.length
        ? markedList.reduce((s, a) => s + parseFloat(a.percentage), 0) / markedList.length
        : 0;

    res.json({
        summary: {
            total,
            submitted,
            marked,
            pending,
            average_percentage: parseFloat(average.toFixed(2)),
        },
        assignments,
    });
}));

module.exports = router;
