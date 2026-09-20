// backend/src/notifications.js
const db = require('./db');

async function isEnabled(userId, preferenceKey) {
    try {
        const r = await db.query(
            `SELECT ${preferenceKey} AS enabled, email_enabled
             FROM notification_preferences WHERE user_id = $1`,
            [userId]
        );
        if (!r.rows.length) return true;
        const row = r.rows[0];
        if (row.email_enabled === false) return false;
        return row.enabled !== false;
    } catch (err) {
        console.error('[notifications:isEnabled]', err.message);
        return true;
    }
}

async function getPreferences(userId) {
    const r = await db.query(
        `SELECT * FROM notification_preferences WHERE user_id = $1`,
        [userId]
    );
    if (r.rows.length) return r.rows[0];
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

    const cols = allowed.filter(k => updates[k] !== undefined);
    const placeholders = cols.map((_, i) => `$${i + 2}`);

    const sql = `
        INSERT INTO notification_preferences (user_id, ${cols.join(', ')})
        VALUES ($1, ${placeholders.join(', ')})
        ON CONFLICT (user_id)
        DO UPDATE SET ${fields.join(', ')}, updated_at = NOW()
        RETURNING *
    `;

    const r = await db.query(sql, values);
    return r.rows[0];
}

module.exports = { isEnabled, getPreferences, updatePreferences };
