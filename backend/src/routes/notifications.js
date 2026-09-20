// backend/src/routes/notifications.js
const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../utils');
const { requireAuth } = require('../middleware');
const notifications = require('../notifications');

router.get('/preferences', requireAuth, asyncHandler(async (req, res) => {
    const prefs = await notifications.getPreferences(req.user.id);
    res.json(prefs);
}));

router.put('/preferences', requireAuth, asyncHandler(async (req, res) => {
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
    const updates = {};
    for (const key of allowed) {
        if (req.body[key] !== undefined) updates[key] = !!req.body[key];
    }
    const prefs = await notifications.updatePreferences(req.user.id, updates);
    res.json(prefs);
}));

module.exports = router;
