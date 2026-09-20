const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../utils');
const { requireAuth } = require('../middleware');

router.get('/', requireAuth, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT * FROM notifications
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [req.user.user_id]
    );
    res.json({ notifications: r.rows });
}));

router.post('/:id/read', requireAuth, asyncHandler(async (req, res) => {
    await db.query(
        `UPDATE notifications SET read = TRUE WHERE id = $1 AND user_id = $2`,
        [req.params.id, req.user.user_id]
    );
    res.json({ ok: true });
}));
// backend/src/notifications.js
const db = require('./db');

/**
 * Check if a user has a specific notification type enabled.
 * Returns true by default if no preferences row exists (opt-out model).
 */
async function isEnabled(userId, preferenceKey) {
    try {
        const r = await db.query(
            `SELECT ${preferenceKey} AS enabled, email_enabled
             FROM notification_preferences WHERE user_id = $1`,
            [userId]
        );
        if (!r.rows.length) return true; // default on
        const row = r.rows[0];
        if (row.email_enabled === false) return false; // master toggle
        return row.enabled !== false;
    } catch (err) {
        console.error('[notifications:isEnabled]', err.message);
        return true; // fail open — better to notify than miss
    }
}

/**
 * Get full preferences for a user (with defaults if missing)
 */
async function getPreferences(userId) {
    const r = await db.query(
        `SELECT * FROM notification_preferences WHERE user_id = $1`,
        [userId]
    );
    if (r.rows.length) return r.rows[0];
    // Return defaults
    return {
        email_group_messages: true,
        email_group_announcements: true,
        email_application_status: true,
        email_payment_confirmations: true,
        email_payment_reminders: true,
        email_course_completion: true,
        email_certificate_issued: true,
        email_exam_reminders: true,
        email_weekly_digest: false,
        email_enabled: true,
    };
}

/**
 * Update preferences (only the fields provided)
 */
async function updatePreferences(userId, updates) {
    const allowed = [
        'email_group_messages',
        'email_group_announcements',
        'email_application_status',
        'email_payment_confirmations',
        'email_payment_reminders',
        'email_course_completion',
        'email_certificate_issued',
        'email_exam_reminders',
        'email_weekly_digest',
        'email_enabled',
    ];

    const fields = [];
    const values = [userId];
    let idx = 2;

    for (const key of allowed) {
        if (updates[key] !== undefined) {
            fields.push(`${key} = $${idx}`);
            values.push(!!updates[key]);
            idx++;
        }
    }

    if (!fields.length) return getPreferences(userId);

    const sql = `
        INSERT INTO notification_preferences (user_id, ${allowed.filter(k => updates[k] !== undefined).join(', ')})
        VALUES ($1, ${allowed.filter(k => updates[k] !== undefined).map((_, i) => `$${i + 2}`).join(', ')})
        ON CONFLICT (user_id)
        DO UPDATE SET ${fields.join(', ')}, updated_at = NOW()
        RETURNING *
    `;

    const r = await db.query(sql, values);
    return r.rows[0];
}

module.exports = { isEnabled, getPreferences, updatePreferences };

module.exports = router;
