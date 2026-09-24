const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../utils');
const { requireAdmin } = require('../middleware');

// GET /api/courses — list all (published only unless include_drafts=true)
router.get('/', asyncHandler(async (req, res) => {
    const includeDrafts = req.query.include_drafts === 'true';
    const r = await db.query(
        `SELECT c.*,
                d.enabled AS discount_enabled,
                d.original_price, d.discount_price,
                d.label AS discount_label,
                d.ends_at AS discount_ends_at,
                (SELECT COUNT(*)::int FROM modules m WHERE m.course_id = c.id) AS module_count,
                (SELECT COUNT(*)::int FROM lessons l
                  JOIN modules m ON m.id = l.module_id
                  WHERE m.course_id = c.id AND l.published = TRUE) AS lesson_count
         FROM courses c
         LEFT JOIN course_discounts d ON d.course_id = c.id
         WHERE c.status = 'published' OR $1 = TRUE
         ORDER BY c.created_at DESC`,
        [includeDrafts]
    );
    res.json({ courses: r.rows });
}));

// GET /api/courses/:id — single course with modules + lessons
router.get('/:id', asyncHandler(async (req, res) => {
    const course = await db.query(
        `SELECT c.*,
                d.enabled AS discount_enabled,
                d.original_price, d.discount_price,
                d.label AS discount_label,
                d.ends_at AS discount_ends_at
         FROM courses c
         LEFT JOIN course_discounts d ON d.course_id = c.id
         WHERE c.id = $1`,
        [req.params.id]
    );
    if (!course.rows.length) return res.status(404).json({ error: 'Course not found' });

    const modules = await db.query(
        `SELECT id, title, position FROM modules
         WHERE course_id = $1 ORDER BY position`,
        [req.params.id]
    );
    const lessons = await db.query(
        `SELECT l.* FROM lessons l
         JOIN modules m ON m.id = l.module_id
         WHERE m.course_id = $1
         ORDER BY m.position, l.position`,
        [req.params.id]
    );

    res.json({ course: course.rows[0], modules: modules.rows, lessons: lessons.rows });
}));

// POST /api/courses — create
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const {
        title, code, category, level, description,
        duration, cover_image_url, price, initial_payment_percent,
        cat_pass_mark, exam_pass_mark, cat_unlock_hours, exam_unlock_hours,
        status
    } = req.body;
    if (!title) return res.status(400).json({ error: 'Title required' });

    const r = await db.query(
        `INSERT INTO courses (title, code, category, level, description,
            duration, cover_image_url, price,
            initial_payment_percent, cat_pass_mark, exam_pass_mark,
            cat_unlock_hours, exam_unlock_hours, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING *`,
        [title, code || null, category || null, level || null,
         description || null, duration || null,
         cover_image_url || null, price || 0, initial_payment_percent || 25,
         cat_pass_mark || 50, exam_pass_mark || 50,
         cat_unlock_hours || 24, exam_unlock_hours || 72,
         status || 'draft', req.user.user_id]
    );
    res.status(201).json({ course: r.rows[0] });
}));

// PUT /api/courses/:id — update
router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const fields = ['title','code','category','level','description',
        'duration','cover_image_url','price',
        'initial_payment_percent','cat_pass_mark','exam_pass_mark',
        'cat_unlock_hours','exam_unlock_hours','status'];
    const updates = [];
    const values = [];
    fields.forEach(f => {
        if (f in req.body) {
            values.push(req.body[f]);
            updates.push(`${f} = $${values.length}`);
        }
    });
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    values.push(req.params.id);
    const r = await db.query(
        `UPDATE courses SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
        values
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Course not found' });
    res.json({ course: r.rows[0] });
}));

// DELETE /api/courses/:id
router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const r = await db.query('DELETE FROM courses WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Course not found' });
    res.json({ ok: true });
}));

// POST /api/courses/:id/modules — add module
router.post('/:id/modules', requireAdmin, asyncHandler(async (req, res) => {
    const { title, position } = req.body;
    if (!title) return res.status(400).json({ error: 'Title required' });
    const r = await db.query(
        `INSERT INTO modules (course_id, title, position)
         VALUES ($1, $2,
            COALESCE($3, (SELECT COALESCE(MAX(position),0)+1 FROM modules WHERE course_id=$1)))
         RETURNING *`,
        [req.params.id, title, position || null]
    );
    res.status(201).json({ module: r.rows[0] });
}));

// POST /api/courses/:id/lessons — add lesson (+ auto assignment)
router.post('/:id/lessons', requireAdmin, asyncHandler(async (req, res) => {
    const { module_id, title, description, position, notes, assignment,
            video_url, published } = req.body;
    if (!module_id || !title) {
        return res.status(400).json({ error: 'module_id and title required' });
    }

    const adminId = req.user.user_id || req.user.id;

    const r = await db.query(
        `INSERT INTO lessons (module_id, title, description, position, notes,
            assignment, video_url, published)
         VALUES ($1,$2,$3,
            COALESCE($4, (SELECT COALESCE(MAX(position),0)+1 FROM lessons WHERE module_id=$1)),
            $5,$6,$7,COALESCE($8,TRUE))
         RETURNING *`,
        [module_id, title, description || null, position || null,
         notes || null, assignment || null, video_url || null, published]
    );

    const lesson = r.rows[0];

    // Auto-create assignment if text is provided
    if (assignment && assignment.trim().length > 0) {
        try {
            const mod = await db.query(
                `SELECT course_id FROM modules WHERE id = $1`,
                [module_id]
            );
            const courseId = mod.rows[0] && mod.rows[0].course_id;
            if (courseId) {
                await db.query(
                    `INSERT INTO assignments (
                        course_id, module_id, lesson_id,
                        title, instructions, max_marks,
                        allow_text, allow_file, allowed_file_types, max_file_mb,
                        allow_resubmission, max_attempts,
                        status, created_by
                    )
                    VALUES ($1, $2, $3, $4, $5, 20, TRUE, TRUE, 'pdf,docx,jpg,png', 10, TRUE, 2, 'published', $6)
                    ON CONFLICT DO NOTHING`,
                    [courseId, module_id, lesson.id, title, assignment, adminId]
                );
                console.log('[lesson:create] Auto-created assignment for lesson', lesson.id);
            }
        } catch (err) {
            console.error('[lesson:create] Assignment creation failed:', err.message);
        }
    }

    res.status(201).json({ lesson });
}));

// PUT /api/courses/:id/lessons/:lessonId — update lesson (+ sync assignment)
router.put('/:id/lessons/:lessonId', requireAdmin, asyncHandler(async (req, res) => {
    const { lessonId } = req.params;
    const adminId = req.user.user_id || req.user.id;
    const fields = ['title','description','position','notes','assignment','video_url','published'];
    const updates = [];
    const values = [];
    fields.forEach(f => {
        if (f in req.body) {
            values.push(req.body[f]);
            updates.push(`${f} = $${values.length}`);
        }
    });
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    values.push(lessonId);

    const r = await db.query(
        `UPDATE lessons SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
        values
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Lesson not found' });
    const lesson = r.rows[0];

    if ('assignment' in req.body) {
        try {
            const existing = await db.query(
                `SELECT id FROM assignments WHERE lesson_id = $1`,
                [lessonId]
            );

            if (existing.rows.length) {
                if (req.body.assignment && req.body.assignment.trim().length > 0) {
                    await db.query(
                        `UPDATE assignments
                         SET instructions = $1, title = $2, updated_at = NOW()
                         WHERE lesson_id = $3`,
                        [req.body.assignment, lesson.title, lessonId]
                    );
                }
            } else if (req.body.assignment && req.body.assignment.trim().length > 0) {
                const mod = await db.query(
                    `SELECT course_id FROM modules WHERE id = $1`,
                    [lesson.module_id]
                );
                const courseId = mod.rows[0] && mod.rows[0].course_id;
                if (courseId) {
                    await db.query(
                        `INSERT INTO assignments (
                            course_id, module_id, lesson_id,
                            title, instructions, max_marks,
                            allow_text, allow_file, allowed_file_types, max_file_mb,
                            allow_resubmission, max_attempts,
                            status, created_by
                        )
                        VALUES ($1, $2, $3, $4, $5, 20, TRUE, TRUE, 'pdf,docx,jpg,png', 10, TRUE, 2, 'published', $6)`,
                        [courseId, lesson.module_id, lesson.id, lesson.title, req.body.assignment, adminId]
                    );
                    console.log('[lesson:update] Auto-created assignment for lesson', lesson.id);
                }
            }
        } catch (err) {
            console.error('[lesson:update] Assignment sync failed:', err.message);
        }
    }

    res.json({ lesson });
}));

// DELETE /api/courses/:id/lessons/:lessonId — delete lesson (+ assignment)
router.delete('/:id/lessons/:lessonId', requireAdmin, asyncHandler(async (req, res) => {
    const { lessonId } = req.params;
    await db.query(`DELETE FROM assignments WHERE lesson_id = $1`, [lessonId]).catch(() => {});
    const r = await db.query(`DELETE FROM lessons WHERE id = $1 RETURNING id`, [lessonId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Lesson not found' });
    res.json({ ok: true });
}));

// PUT /api/courses/:id/assignments/:lessonId — update assignment settings
router.put('/:id/assignments/:lessonId', requireAdmin, asyncHandler(async (req, res) => {
    const { lessonId } = req.params;
    const {
        title, instructions, max_marks,
        allow_text, allow_file, allowed_file_types, max_file_mb,
        due_date, allow_resubmission, max_attempts, status
    } = req.body;

    const updates = [];
    const values = [];
    const map = {
        title, instructions, max_marks, allow_text, allow_file,
        allowed_file_types, max_file_mb, due_date,
        allow_resubmission, max_attempts, status
    };
    Object.keys(map).forEach(key => {
        if (map[key] !== undefined) {
            values.push(map[key]);
            updates.push(`${key} = $${values.length}`);
        }
    });

    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    values.push(lessonId);

    const r = await db.query(
        `UPDATE assignments SET ${updates.join(', ')}, updated_at = NOW()
         WHERE lesson_id = $${values.length}
         RETURNING *`,
        values
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Assignment not found for this lesson' });
    res.json({ assignment: r.rows[0] });
}));

// GET /api/courses/:id/assignments/:lessonId — get assignment settings
router.get('/:id/assignments/:lessonId', requireAdmin, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT * FROM assignments WHERE lesson_id = $1`,
        [req.params.lessonId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'No assignment for this lesson' });
    res.json({ assignment: r.rows[0] });
}));

// POST /api/courses/:id/questions — add exam or CAT question
router.post('/:id/questions', requireAdmin, asyncHandler(async (req, res) => {
    const { question_type, question_text, options, correct_index, marks, position } = req.body;
    if (!['exam','cat'].includes(question_type)) {
        return res.status(400).json({ error: 'Invalid question_type' });
    }
    if (!Array.isArray(options) || options.length !== 4) {
        return res.status(400).json({ error: 'Options must be an array of 4 strings' });
    }
    const r = await db.query(
        `INSERT INTO questions (course_id, question_type, question_text, options,
            correct_index, marks, position)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,
            COALESCE($7, (SELECT COALESCE(MAX(position),0)+1 FROM questions
                          WHERE course_id=$1 AND question_type=$2)))
         RETURNING *`,
        [req.params.id, question_type, question_text,
         JSON.stringify(options), correct_index, marks || 1, position || null]
    );
    res.status(201).json({ question: r.rows[0] });
}));

// PUT /api/courses/:id/discount — create or update discount
router.put('/:id/discount', requireAdmin, asyncHandler(async (req, res) => {
    const { enabled, original_price, discount_price, label, ends_at } = req.body;
    if (enabled && (!discount_price || discount_price >= original_price)) {
        return res.status(400).json({ error: 'Invalid discount price' });
    }
    const existing = await db.query(
        `SELECT id FROM course_discounts WHERE course_id = $1`,
        [req.params.id]
    );
    if (existing.rows.length) {
        await db.query(
            `UPDATE course_discounts
             SET enabled = $1, original_price = $2, discount_price = $3,
                 label = $4, ends_at = $5, updated_at = NOW()
             WHERE course_id = $6`,
            [enabled, original_price, discount_price, label, ends_at, req.params.id]
        );
    } else {
        await db.query(
            `INSERT INTO course_discounts
                (course_id, enabled, original_price, discount_price, label, ends_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [req.params.id, enabled, original_price, discount_price, label, ends_at]
        );
    }
    res.json({ ok: true });
}));

module.exports = router;
