const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler, isValidEmail, isStrongPassword, logActivity } = require('../utils');
const {
    hashPassword, verifyPassword,
    createSession, deleteSession,
} = require('../auth');
const { requireAuth } = require('../middleware');

const COOKIE_OPTS = {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
};

// POST /api/auth/register
router.post('/register', asyncHandler(async (req, res) => {
    const { username, email, password, full_name, phone, country,
            date_of_birth, course_interest } = req.body;

    if (!username || !email || !password || !full_name) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email' });
    if (!isStrongPassword(password)) {
        return res.status(400).json({
            error: 'Password must be 8+ chars, contain an uppercase letter and a number'
        });
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        const hash = await hashPassword(password);
        const u = await client.query(
            `INSERT INTO users (username, email, password_hash, full_name, phone,
                                country, date_of_birth, role)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'student')
             RETURNING id, username, email, full_name, role`,
            [username, email, hash, full_name, phone || null,
             country || null, date_of_birth || null]
        );
        await client.query(
            `INSERT INTO student_profiles (user_id, course_interest)
             VALUES ($1, $2)`,
            [u.rows[0].id, course_interest || null]
        );
        await logActivity(client, u.rows[0].id, 'account', 'Account Created', course_interest || '');
        await client.query('COMMIT');
        res.status(201).json({ user: u.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(409).json({ error: 'Email or username already taken' });
        }
        throw err;
    } finally {
        client.release();
    }
}));

// POST /api/auth/login
router.post('/login', asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }

    const r = await db.query(
        `SELECT id, password_hash, role, status FROM users WHERE email = $1`,
        [email]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = r.rows[0];
    if (user.status !== 'active') return res.status(403).json({ error: 'Account not active' });

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const { token, expiresAt } = await createSession(user.id, req.ip, req.headers['user-agent']);
    res.cookie('session', token, { ...COOKIE_OPTS, expires: expiresAt });
    res.json({ ok: true, role: user.role });
}));

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

// POST /api/auth/logout
router.post('/logout', asyncHandler(async (req, res) => {
    const token = req.cookies.session;
    if (token) await deleteSession(token);
    res.clearCookie('session', { path: '/' });
    res.json({ ok: true });
}));

// ============================================================
// TEMPORARY EMERGENCY PASSWORD RESET
// Remove this endpoint after resetting the passwords.
// ============================================================
router.post('/emergency-reset', asyncHandler(async (req, res) => {
    const { email, newPassword, secret } = req.body;
    if (secret !== 'nexora-reset-2026') {
        return res.status(403).json({ error: 'Forbidden' });
    }
    if (!email || !newPassword || newPassword.length < 8) {
        return res.status(400).json({ error: 'Email and password (8+ chars) required' });
    }
    const hash = await hashPassword(newPassword);
    const r = await db.query(
        'UPDATE users SET password_hash = $1 WHERE email = $2 RETURNING id, email',
        [hash, email]
    );
    if (!r.rows.length) {
        return res.status(404).json({ error: 'User not found' });
    }
    res.json({ ok: true, message: 'Password reset successful', user: r.rows[0] });
}));

module.exports = router;
