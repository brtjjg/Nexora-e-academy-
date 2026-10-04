// routes/contributor.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../utils');
const { requireAuth } = require('../middleware');
const bcrypt = require('bcrypt');

// ─────────────────────────────────────────────
// Middleware: require contributor or admin role
// ─────────────────────────────────────────────
function requireContributor(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    if (req.user.role !== 'contributor' && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Contributor access required' });
    }
    next();
}

// ─────────────────────────────────────────────
// PUBLIC — Signup (no auth required)
// ─────────────────────────────────────────────

// POST /api/contributor/signup
router.post('/signup', asyncHandler(async (req, res) => {
    const { email, password, full_name, username, phone, country } = req.body || {};

    // Validate required fields
    if (!email || !password || !full_name || !username) {
        return res.status(400).json({ error: 'Email, password, full name, and username are required' });
    }
    // Email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
    }
    // Username format
    if (!/^[a-z0-9_]{3,20}$/.test(String(username).toLowerCase())) {
        return res.status(400).json({ error: 'Username must be 3-20 chars: lowercase letters, numbers, or underscore' });
    }
    // Password strength
    if (password.length < 8 || !/[A-Z]/.test(password) || !/\d/.test(password)) {
        return res.status(400).json({
            error: 'Password must be at least 8 characters with one uppercase letter and one number',
        });
    }

    const hash = await bcrypt.hash(password, 10);

    try {
        const r = await db.query(
            `INSERT INTO users
                (username, email, password_hash, full_name, phone, country, role, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'contributor', 'pending')
             RETURNING id, username, email, full_name, role, status, created_at`,
            [
                String(username).trim().toLowerCase(),
                String(email).toLowerCase().trim(),
                hash,
                String(full_name).trim(),
                phone || null,
                country || null,
            ]
        );

        res.status(201).json({
            ok: true,
            message: 'Account created. Your account is pending admin approval.',
            user: r.rows[0],
        });
    } catch (e) {
        if (e.code === '23505') {
            return res.status(409).json({ error: 'Email or username already taken' });
        }
        throw e;
    }
}));

// ─────────────────────────────────────────────
// AUTHENTICATED — Contributor dashboard
// ─────────────────────────────────────────────

// GET /api/contributor/dashboard
router.get('/dashboard', requireAuth, requireContributor, asyncHandler(async (req, res) => {
    const stats = await db.query(
        `SELECT
            COUNT(*) FILTER (WHERE status = 'draft')             AS drafts,
            COUNT(*) FILTER (WHERE status = 'pending_review')    AS pending,
            COUNT(*) FILTER (WHERE status = 'changes_requested') AS changes_requested,
            COUNT(*) FILTER (WHERE status = 'approved')          AS approved,
            COUNT(*) FILTER (WHERE status = 'published')         AS published,
            COUNT(*) FILTER (WHERE status = 'rejected')          AS rejected,
            COUNT(*)                                             AS total
         FROM submissions
         WHERE contributor_id = $1`,
        [req.user.id]
    );
    const recent = await db.query(
        `SELECT id, title, status, updated_at
         FROM submissions
         WHERE contributor_id = $1
         ORDER BY updated_at DESC
         LIMIT 5`,
        [req.user.id]
    );
    res.json({
        stats: stats.rows[0],
        recent: recent.rows,
    });
}));

// GET /api/contributor/manuals
router.get('/manuals', requireAuth, requireContributor, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT id, title, course_code, instructions, file_path, file_name, created_at
         FROM course_manuals
         WHERE assigned_to IS NULL OR assigned_to = $1
         ORDER BY created_at DESC`,
        [req.user.id]
    );
    res.json({ manuals: r.rows });
}));

// GET /api/contributor/submissions
router.get('/submissions', requireAuth, requireContributor, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT id, title, code, category, level, status,
                admin_feedback, submitted_at, reviewed_at, published_at,
                created_at, updated_at
         FROM submissions
         WHERE contributor_id = $1
         ORDER BY updated_at DESC`,
        [req.user.id]
    );
    res.json({ submissions: r.rows });
}));

// GET /api/contributor/submissions/:id
router.get('/submissions/:id', requireAuth, requireContributor, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT * FROM submissions WHERE id = $1 AND contributor_id = $2`,
        [req.params.id, req.user.id]
    );
    if (!r.rows.length) {
        return res.status(404).json({ error: 'Submission not found' });
    }
    res.json({ submission: r.rows[0] });
}));

// POST /api/contributor/submissions  (create draft)
router.post('/submissions', requireAuth, requireContributor, asyncHandler(async (req, res) => {
    const {
        title, code, category, level, description, duration, price,
        cover_image_url, modules, questions,
        cat_pass_mark, exam_pass_mark, cat_unlock_hours, exam_unlock_hours,
    } = req.body;

    if (!title || !title.trim()) {
        return res.status(400).json({ error: 'Title is required' });
    }

    const r = await db.query(
        `INSERT INTO submissions
            (contributor_id, title, code, category, level, description, duration, price,
             cover_image_url, modules, questions,
             cat_pass_mark, exam_pass_mark, cat_unlock_hours, exam_unlock_hours,
             status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,'draft')
         RETURNING *`,
        [
            req.user.id,
            title.trim(),
            code || null,
            category || null,
            level || null,
            description || null,
            duration || null,
            price != null ? parseFloat(price) : 0,
            cover_image_url || null,
            JSON.stringify(modules || []),
            JSON.stringify(questions || []),
            parseInt(cat_pass_mark) || 50,
            parseInt(exam_pass_mark) || 50,
            parseInt(cat_unlock_hours) || 24,
            parseInt(exam_unlock_hours) || 72,
        ]
    );
    res.status(201).json({ submission: r.rows[0] });
}));

// PUT /api/contributor/submissions/:id  (update — only if draft or changes_requested)
router.put('/submissions/:id', requireAuth, requireContributor, asyncHandler(async (req, res) => {
    const existing = await db.query(
        `SELECT status FROM submissions WHERE id = $1 AND contributor_id = $2`,
        [req.params.id, req.user.id]
    );
    if (!existing.rows.length) {
        return res.status(404).json({ error: 'Submission not found' });
    }
    const st = existing.rows[0].status;
    if (st !== 'draft' && st !== 'changes_requested') {
        return res.status(409).json({ error: `Cannot edit a submission with status "${st}"` });
    }

    const {
        title, code, category, level, description, duration, price,
        cover_image_url, modules, questions,
        cat_pass_mark, exam_pass_mark, cat_unlock_hours, exam_unlock_hours,
    } = req.body;

    const r = await db.query(
        `UPDATE submissions SET
            title = COALESCE($1, title),
            code = COALESCE($2, code),
            category = COALESCE($3, category),
            level = COALESCE($4, level),
            description = COALESCE($5, description),
            duration = COALESCE($6, duration),
            price = COALESCE($7, price),
            cover_image_url = COALESCE($8, cover_image_url),
            modules = COALESCE($9::jsonb, modules),
            questions = COALESCE($10::jsonb, questions),
            cat_pass_mark = COALESCE($11, cat_pass_mark),
            exam_pass_mark = COALESCE($12, exam_pass_mark),
            cat_unlock_hours = COALESCE($13, cat_unlock_hours),
            exam_unlock_hours = COALESCE($14, exam_unlock_hours),
            updated_at = NOW()
         WHERE id = $15 AND contributor_id = $16
         RETURNING *`,
        [
            title ?? null,
            code ?? null,
            category ?? null,
            level ?? null,
            description ?? null,
            duration ?? null,
            price != null ? parseFloat(price) : null,
            cover_image_url ?? null,
            modules ? JSON.stringify(modules) : null,
            questions ? JSON.stringify(questions) : null,
            cat_pass_mark != null ? parseInt(cat_pass_mark) : null,
            exam_pass_mark != null ? parseInt(exam_pass_mark) : null,
            cat_unlock_hours != null ? parseInt(cat_unlock_hours) : null,
            exam_unlock_hours != null ? parseInt(exam_unlock_hours) : null,
            req.params.id,
            req.user.id,
        ]
    );
    res.json({ submission: r.rows[0] });
}));

// POST /api/contributor/submissions/:id/submit  (draft → pending_review)
router.post('/submissions/:id/submit', requireAuth, requireContributor, asyncHandler(async (req, res) => {
    const existing = await db.query(
        `SELECT status FROM submissions WHERE id = $1 AND contributor_id = $2`,
        [req.params.id, req.user.id]
    );
    if (!existing.rows.length) {
        return res.status(404).json({ error: 'Submission not found' });
    }
    const st = existing.rows[0].status;
    if (st !== 'draft' && st !== 'changes_requested') {
        return res.status(409).json({ error: `Cannot submit from status "${st}"` });
    }

    const r = await db.query(
        `UPDATE submissions
         SET status = 'pending_review', submitted_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND contributor_id = $2
         RETURNING *`,
        [req.params.id, req.user.id]
    );
    res.json({ submission: r.rows[0] });
}));

// DELETE /api/contributor/submissions/:id  (only drafts)
router.delete('/submissions/:id', requireAuth, requireContributor, asyncHandler(async (req, res) => {
    const r = await db.query(
        `DELETE FROM submissions
         WHERE id = $1 AND contributor_id = $2 AND status = 'draft'`,
        [req.params.id, req.user.id]
    );
    if (!r.rowCount) {
        return res.status(404).json({ error: 'Draft not found or not deletable' });
    }
    res.json({ ok: true });
}));

// GET /api/contributor/profile
router.get('/profile', requireAuth, requireContributor, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT id, username, email, full_name, phone, country, role, status, created_at
         FROM users WHERE id = $1`,
        [req.user.id]
    );
    res.json({ user: r.rows[0] });
}));
// POST /api/contributor/google  (PUBLIC — signs up OR logs in)
// Body: { credential: "<google id token>" }
router.post('/google', asyncHandler(async (req, res) => {
    const { credential } = req.body || {};
    if (!credential) {
        return res.status(400).json({ error: 'Missing Google credential' });
    }

    const { OAuth2Client } = require('google-auth-library');
    const { createSession } = require('../auth');

    const COOKIE_OPTS = {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        path: '/',
    };

    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

    let payload;
    try {
        const ticket = await client.verifyIdToken({
            idToken: credential,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        payload = ticket.getPayload();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid Google token' });
    }

    if (!payload || !payload.email_verified) {
        return res.status(401).json({ error: 'Email not verified by Google' });
    }

    const googleId = payload.sub;
    const email = String(payload.email).toLowerCase();
    const fullName = payload.name || email.split('@')[0];
    const picture = payload.picture || null;

    const dbClient = await db.getClient();
    try {
        await dbClient.query('BEGIN');

        // 1) Find by google_id
        let userRes = await dbClient.query(
            `SELECT id, username, email, full_name, role, status
             FROM users WHERE google_id = $1`,
            [googleId]
        );

        let user = userRes.rows[0];
        let isNew = false;

        if (!user) {
            // 2) Find by email
            const byEmail = await dbClient.query(
                `SELECT id, username, email, full_name, role, status, google_id
                 FROM users WHERE LOWER(email) = $1`,
                [email]
            );

            if (byEmail.rows.length) {
                user = byEmail.rows[0];

                if (user.role !== 'contributor' && user.role !== 'admin') {
                    await dbClient.query('ROLLBACK');
                    return res.status(403).json({
                        error: 'This email is registered as a student. Use the main Academy site.'
                    });
                }

                if (user.status === 'pending') {
                    await dbClient.query('ROLLBACK');
                    return res.status(403).json({
                        error: 'Your contributor account is pending admin approval.'
                    });
                }

                if (user.status !== 'active') {
                    await dbClient.query('ROLLBACK');
                    return res.status(403).json({ error: 'Account not active' });
                }

                await dbClient.query(
                    `UPDATE users SET google_id = $1, updated_at = NOW() WHERE id = $2`,
                    [googleId, user.id]
                );
            } else {
                // 3) Brand-new Google contributor signup
                isNew = true;

                let base = email.split('@')[0].replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'user';
                let username = base;
                let suffix = 0;
                // eslint-disable-next-line no-constant-condition
                while (true) {
                    const u = await dbClient.query('SELECT 1 FROM users WHERE username = $1', [username]);
                    if (!u.rows.length) break;
                    suffix += 1;
                    username = `${base}${suffix}`;
                }

                const created = await dbClient.query(
                    `INSERT INTO users
                        (username, email, password_hash, full_name, role, status, google_id, auth_provider, avatar_url)
                     VALUES ($1,$2,NULL,$3,'contributor','pending',$4,'google',$5)
                     RETURNING id, username, email, full_name, role, status`,
                    [username, email, fullName, googleId, picture]
                );
                user = created.rows[0];
            }
        } else {
            // Found by google_id
            if (user.role !== 'contributor' && user.role !== 'admin') {
                await dbClient.query('ROLLBACK');
                return res.status(403).json({ error: 'Not a contributor account' });
            }
            if (user.status === 'pending') {
                await dbClient.query('ROLLBACK');
                return res.status(403).json({ error: 'Your contributor account is pending admin approval.' });
            }
            if (user.status !== 'active') {
                await dbClient.query('ROLLBACK');
                return res.status(403).json({ error: 'Account not active' });
            }
        }

        await dbClient.query('COMMIT');

        if (isNew) {
            return res.status(201).json({
                ok: true,
                isNew: true,
                status: 'pending',
                message: 'Account created with Google. An admin will review your application.',
            });
        }

        // Create session for existing active contributor
        const { token, expiresAt } = await createSession(
            user.id,
            req.ip,
            req.headers['user-agent']
        );
        res.cookie('session', token, { ...COOKIE_OPTS, expires: expiresAt });

        res.json({ ok: true, role: user.role, isNew: false });
    } catch (err) {
        await dbClient.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(409).json({ error: 'Account already exists' });
        }
        throw err;
    } finally {
        dbClient.release();
    }
}));

module.exports = router;
