const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler, isValidEmail, isStrongPassword, logActivity } = require('../utils');
const { hashPassword, verifyPassword, createSession, deleteSession } = require('../auth');
const { requireAuth } = require('../middleware');
const authGoogleRouter = require('./auth-google');

const COOKIE_OPTS = {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
};

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// POST /api/auth/google
router.post('/google', asyncHandler(async (req, res) => {
    const { credential } = req.body || {};
    if (!credential) {
        return res.status(400).json({ error: 'Missing Google credential' });
    }

    let payload;
    try {
        const ticket = await googleClient.verifyIdToken({
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

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        let userRes = await client.query(
            `SELECT id, username, email, full_name, role, status
             FROM users WHERE google_id = $1`,
            [googleId]
        );

        let user = userRes.rows[0];
        let isNewUser = false;

        if (!user) {
            const byEmail = await client.query(
                `SELECT id, username, email, full_name, role, status, google_id
                 FROM users WHERE LOWER(email) = $1`,
                [email]
            );

            if (byEmail.rows.length) {
                user = byEmail.rows[0];

                if (user.status !== 'active') {
                    await client.query('ROLLBACK');
                    return res.status(403).json({ error: 'Account not active' });
                }

                await client.query(
                    `UPDATE users
                     SET google_id = $1,
                         auth_provider = CASE
                           WHEN auth_provider IS NULL OR auth_provider = 'password'
                             THEN 'password+google'
                           ELSE auth_provider
                         END
                     WHERE id = $2`,
                    [googleId, user.id]
                );

                await logActivity(client, user.id, 'auth', 'Google account linked', email);
            } else {
                isNewUser = true;

                let base = email.split('@')[0].replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'user';
                let username = base;
                let suffix = 0;
                while (true) {
                    const u = await client.query(
                        'SELECT 1 FROM users WHERE username = $1',
                        [username]
                    );
                    if (!u.rows.length) break;
                    suffix += 1;
                    username = `${base}${suffix}`;
                }

                const created = await client.query(
                    `INSERT INTO users
                       (username, email, password_hash, full_name, role,
                        google_id, auth_provider, status, avatar_url)
                     VALUES ($1,$2,NULL,$3,'student',$4,'google','active',$5)
                     RETURNING id, username, email, full_name, role, status`,
                    [username, email, fullName, googleId, picture]
                );

                user = created.rows[0];

                await client.query(
                    `INSERT INTO student_profiles (user_id, course_interest)
                     VALUES ($1, $2)`,
                    [user.id, null]
                );

                await logActivity(client, user.id, 'account',
                    'Account created via Google', email);
            }
        } else {
            if (user.status !== 'active') {
                await client.query('ROLLBACK');
                return res.status(403).json({ error: 'Account not active' });
            }
        }

        await client.query('COMMIT');

        if (isNewUser) {
            try {
                await db.query(
                    `INSERT INTO applications
                       (user_id, application_id, full_name, email, course_interest, status, payment_status)
                     VALUES ($1, $2, $3, $4, $5, 'payment_due', 'unpaid')`,
                    [
                        user.id,
                        'NXA-APP-' + Date.now().toString(36).toUpperCase(),
                        fullName,
                        email,
                        null,
                    ]
                );
            } catch (e) {
                console.warn('Could not auto-create application for Google user:', e.message);
            }
        }

        const { token, expiresAt } = await createSession(
            user.id,
            req.ip,
            req.headers['user-agent']
        );
        res.cookie('session', token, { ...COOKIE_OPTS, expires: expiresAt });

        res.json({ ok: true, role: user.role, isNewUser });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(409).json({ error: 'Account already exists' });
        }
        throw err;
    } finally {
        client.release();
    }
}));

module.exports = router;
