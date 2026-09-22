// backend/src/routes/assignments.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const { asyncHandler } = require('../utils');
const { requireAuth, requireAdmin } = require('../middleware');
const { uploadBuffer } = require('../cloudinary');

// Multer — memory storage (we stream to Cloudinary)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
    fileFilter: (req, file, cb) => {
        const allowed = [
            'image/jpeg', 'image/png', 'image/webp', 'image/gif',
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'text/plain',
        ];
        if (allowed.includes(file.mimetype)) return cb(null, true);
        cb(new Error('File type not allowed: ' + file.mimetype));
    },
});

/* ============================================================
   STUDENT: GET assignment for a lesson (+ own submission)
   ============================================================ */
router.get('/lesson/:lessonId', requireAuth, asyncHandler(async (req, res) => {
    const userId = req.user.user_id || req.user.id;
    const { lessonId } = req.params;

    const aRes = await db.query(
        `SELECT * FROM assignments
         WHERE lesson_id = $1 AND status = 'published'
         ORDER BY created_at DESC LIMIT 1`,
        [lessonId]
    );
    if (!aRes.rows.length) return res.json({ assignment: null, submission: null });

    const assignment = aRes.rows[0];

    // Get student's latest submission
    const sRes = await db.query(
        `SELECT id, attempt_number, text_answer, file_path, file_name, file_type, file_size,
                status, marks, percentage, feedback, marked_at, return_reason, returned_at,
                (SELECT COUNT(*)::int FROM assignment_submissions
                 WHERE assignment_id = $1 AND student_id = $2) AS attempt_count,
                (SELECT COALESCE(MAX(attempt_number), 0) FROM assignment_submissions
                 WHERE assignment_id = $1 AND student_id = $2) AS max_attempt
         FROM assignment_submissions
         WHERE assignment_id = $1 AND student_id = $2
         ORDER BY attempt_number DESC LIMIT 1`,
        [assignment.id, userId]
    );

    res.json({
        assignment,
        submission: sRes.rows[0] || null,
    });
}));

/* ============================================================
   STUDENT: Submit assignment (file + optional text)
   ============================================================ */
router.post('/:id/submit', requireAuth, upload.single('file'), asyncHandler(async (req, res) => {
    const userId = req.user.user_id || req.user.id;
    const { id: assignmentId } = req.params;
    const { text_answer } = req.body;

    // 1. Verify assignment exists + is published
    const aRes = await db.query(
        `SELECT * FROM assignments WHERE id = $1 AND status = 'published'`,
        [assignmentId]
    );
    if (!aRes.rows.length) return res.status(404).json({ error: 'Assignment not found or not published' });
    const assignment = aRes.rows[0];

    // 2. Check if student already has a submission
    const existing = await db.query(
        `SELECT id, attempt_number, status FROM assignment_submissions
         WHERE assignment_id = $1 AND student_id = $2
         ORDER BY attempt_number DESC LIMIT 1`,
        [assignmentId, userId]
    );

    const hasExisting = existing.rows.length > 0;
    const lastAttempt = hasExisting ? existing.rows[0].attempt_number : 0;

    // Enforce max_attempts
    if (hasExisting && lastAttempt >= (assignment.max_attempts || 2)) {
        return res.status(400).json({
            error: `Maximum attempts reached (${assignment.max_attempts})`
        });
    }

    // If existing is pending, don't allow new submit unless allow_resubmission
    if (hasExisting && existing.rows[0].status === 'submitted' && !assignment.allow_resubmission) {
        return res.status(400).json({ error: 'Submission already pending review' });
    }

    // 3. Require at least one of: file or text
    const hasFile = !!req.file;
    const hasText = text_answer && text_answer.trim().length > 0;
    if (!hasFile && !hasText) {
        return res.status(400).json({ error: 'Provide a file or text answer' });
    }
    if (!assignment.allow_file && hasFile) {
        return res.status(400).json({ error: 'File upload not allowed for this assignment' });
    }
    if (!assignment.allow_text && hasText) {
        return res.status(400).json({ error: 'Text answer not allowed for this assignment' });
    }

    // 4. Upload file to Cloudinary (if provided)
    let fileInfo = { path: null, name: null, type: null, size: null };
    if (hasFile) {
        try {
            const result = await uploadBuffer(req.file.buffer, {
                folder: `nexora/assignments/${assignmentId}`,
                resource_type: 'auto',
            });
            fileInfo = {
                path: result.secure_url,
                name: req.file.originalname,
                type: req.file.mimetype,
                size: req.file.size,
            };
        } catch (err) {
            console.error('[assignment:upload]', err.message);
            return res.status(500).json({ error: 'File upload failed: ' + err.message });
        }
    }

    // 5. Insert submission
    const nextAttempt = lastAttempt + 1;
    const ins = await db.query(`
        INSERT INTO assignment_submissions
            (assignment_id, student_id, attempt_number,
             text_answer, file_path, file_name, file_type, file_size, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'submitted')
        RETURNING *
    `, [
        assignmentId, userId, nextAttempt,
        hasText ? text_answer.trim() : null,
        fileInfo.path, fileInfo.name, fileInfo.type, fileInfo.size,
    ]);

    // 6. Log history
    await db.query(`
        INSERT INTO assignment_history (submission_id, action, note, performed_by, created_at)
        VALUES ($1, 'submitted', $2, $3, NOW())
    `, [ins.rows[0].id, `Attempt ${nextAttempt}`, userId]).catch(() => {});

    res.status(201).json({
        ok: true,
        message: 'Assignment submitted. Awaiting review.',
        submission: ins.rows[0],
    });
}));

/* ============================================================
   ADMIN: List all submissions (with filters)
   ============================================================ */
router.get('/admin/list', requireAdmin, asyncHandler(async (req, res) => {
    const status = req.query.status || 'all';
    const params = [];
    let where = '';
    if (status !== 'all') {
        where = 'WHERE s.status = $1';
        params.push(status);
    }

    const r = await db.query(`
        SELECT
            s.id, s.assignment_id, s.student_id, s.attempt_number,
            s.text_answer, s.file_path, s.file_name, s.file_type, s.file_size,
            s.status, s.marks, s.percentage, s.feedback,
            s.marked_at, s.return_reason, s.returned_at,
            u.full_name AS student_name, u.email AS student_email, u.username,
            a.title AS assignment_title, a.max_marks, a.lesson_id,
            c.title AS course_title, c.code AS course_code,
            l.title AS lesson_title
        FROM assignment_submissions s
        JOIN users u ON u.id = s.student_id
        JOIN assignments a ON a.id = s.assignment_id
        JOIN courses c ON c.id = a.course_id
        LEFT JOIN lessons l ON l.id = a.lesson_id
        ${where}
        ORDER BY s.attempt_number DESC, s.id DESC
        LIMIT 500
    `, params);

    res.json({ submissions: r.rows });
}));

/* ============================================================
   ADMIN: Get one submission with history
   ============================================================ */
router.get('/admin/submissions/:id', requireAdmin, asyncHandler(async (req, res) => {
    const r = await db.query(`
        SELECT
            s.*,
            u.full_name AS student_name, u.email AS student_email,
            a.title AS assignment_title, a.max_marks, a.instructions,
            c.title AS course_title, c.code AS course_code
        FROM assignment_submissions s
        JOIN users u ON u.id = s.student_id
        JOIN assignments a ON a.id = s.assignment_id
        JOIN courses c ON c.id = a.course_id
        WHERE s.id = $1
    `, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });

    const hRes = await db.query(
        `SELECT * FROM assignment_history WHERE submission_id = $1 ORDER BY created_at ASC`,
        [req.params.id]
    );

    res.json({ submission: r.rows[0], history: hRes.rows });
}));

/* ============================================================
   ADMIN: Review (mark + feedback)
   ============================================================ */
router.post('/admin/submissions/:id/review', requireAdmin, asyncHandler(async (req, res) => {
    const adminId = req.user.user_id || req.user.id;
    const { marks, feedback } = req.body;

    const m = parseFloat(marks);
    if (isNaN(m) || m < 0) return res.status(400).json({ error: 'Valid marks required' });

    // Get submission + max_marks
    const sRes = await db.query(`
        SELECT s.id, s.student_id, s.assignment_id, a.max_marks
        FROM assignment_submissions s
        JOIN assignments a ON a.id = s.assignment_id
        WHERE s.id = $1
    `, [req.params.id]);
    if (!sRes.rows.length) return res.status(404).json({ error: 'Submission not found' });

    const s = sRes.rows[0];
    if (m > s.max_marks) return res.status(400).json({ error: `Marks cannot exceed ${s.max_marks}` });

    const pct = (m / s.max_marks) * 100;

    await db.query(`
        UPDATE assignment_submissions
        SET status = 'reviewed',
            marks = $1,
            percentage = $2,
            feedback = $3,
            marked_at = NOW(),
            marked_by = $4
        WHERE id = $5
    `, [m, pct.toFixed(2), feedback || null, adminId, req.params.id]);

    await db.query(`
        INSERT INTO assignment_history (submission_id, action, note, performed_by, created_at)
        VALUES ($1, 'reviewed', $2, $3, NOW())
    `, [req.params.id, `Marks: ${m}/${s.max_marks}`, adminId]).catch(() => {});

    res.json({ ok: true, marks: m, percentage: pct.toFixed(2) });
}));

/* ============================================================
   ADMIN: Return for correction
   ============================================================ */
router.post('/admin/submissions/:id/return', requireAdmin, asyncHandler(async (req, res) => {
    const adminId = req.user.user_id || req.user.id;
    const { reason } = req.body;
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason required' });

    await db.query(`
        UPDATE assignment_submissions
        SET status = 'returned',
            return_reason = $1,
            returned_at = NOW(),
            marked_by = $2
        WHERE id = $3
    `, [reason.trim(), adminId, req.params.id]);

    await db.query(`
        INSERT INTO assignment_history (submission_id, action, note, performed_by, created_at)
        VALUES ($1, 'returned', $2, $3, NOW())
    `, [req.params.id, reason.trim(), adminId]).catch(() => {});

    res.json({ ok: true });
}));

/* ============================================================
   ADMIN: Stats
   ============================================================ */
router.get('/admin/stats', requireAdmin, asyncHandler(async (req, res) => {
    const r = await db.query(`
        SELECT
            COUNT(*) FILTER (WHERE status = 'submitted') AS pending,
            COUNT(*) FILTER (WHERE status = 'reviewed') AS reviewed,
            COUNT(*) FILTER (WHERE status = 'returned') AS returned,
            COUNT(*) AS total
        FROM assignment_submissions
    `);
    res.json(r.rows[0] || { pending: 0, reviewed: 0, returned: 0, total: 0 });
}));

module.exports = router;
