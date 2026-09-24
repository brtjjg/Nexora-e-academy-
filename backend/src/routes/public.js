// backend/src/routes/public.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../utils');

/**
 * GET /api/public/stats — publicly available platform statistics
 * No auth required. Returns only counts (no personal data).
 */
router.get('/stats', asyncHandler(async (req, res) => {
    const r = await db.query(`
        SELECT
            (SELECT COUNT(*)::int FROM users WHERE role = 'student' AND status = 'active') AS students,
            (SELECT COUNT(*)::int FROM courses WHERE status = 'published') AS courses,
            (SELECT COUNT(*)::int FROM certificates WHERE revoked = FALSE) AS certificates,
            (SELECT COUNT(*)::int FROM groups) AS groups
    `);
    const s = r.rows[0] || {};
    res.json({
        students: s.students || 0,
        courses: s.courses || 0,
        certificates: s.certificates || 0,
        groups: s.groups || 0,
    });
}));

module.exports = router;
