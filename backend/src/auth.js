const bcrypt = require('bcrypt');
const crypto = require('crypto');
const db = require('./db');

const ROUNDS = parseInt(process.env.BCRYPT_ROUNDS, 10) || 10;

async function hashPassword(password) {
    return bcrypt.hash(password, ROUNDS);
}

async function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}

function generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

async function createSession(userId, ip, userAgent) {
    const token = generateSessionToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await db.query(
        `INSERT INTO sessions (user_id, token_hash, ip_address, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, tokenHash, ip || null, userAgent || null, expiresAt]
    );

    return { token, expiresAt };
}

async function validateSession(token) {
    if (!token) return null;
    const tokenHash = hashToken(token);
    const result = await db.query(
        `SELECT s.user_id, u.username, u.email, u.full_name, u.role, u.status
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
        [tokenHash]
    );
    return result.rows[0] || null;
}

async function deleteSession(token) {
    if (!token) return;
    const tokenHash = hashToken(token);
    await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}

async function cleanupExpiredSessions() {
    await db.query('DELETE FROM sessions WHERE expires_at < NOW()');
}

module.exports = {
    hashPassword,
    verifyPassword,
    createSession,
    validateSession,
    deleteSession,
    cleanupExpiredSessions,
};
