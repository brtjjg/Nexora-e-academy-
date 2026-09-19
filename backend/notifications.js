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

module.exports = router;
