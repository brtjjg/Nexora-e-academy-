const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../utils');
const { requireAuth } = require('../middleware');

// Get all my notifications
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const r = await db.query(
    `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [req.user.user_id]
  );
  res.json({ notifications: r.rows });
}));

// Mark one as read
router.put('/:id/read', requireAuth, asyncHandler(async (req, res) => {
  await db.query(
    `UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.user_id]
  );
  res.json({ ok: true });
}));

// Mark all as read
router.put('/read-all', requireAuth, asyncHandler(async (req, res) => {
  await db.query(
    `UPDATE notifications SET is_read = true WHERE user_id = $1`,
    [req.user.user_id]
  );
  res.json({ ok: true });
}));

// Helper function to create a notification (use this in other files!)
async function createNotification(userId, title, message, type, link = null) {
  await db.query(
    `INSERT INTO notifications (user_id, title, message, type, link) VALUES ($1, $2, $3, $4, $5)`,
    [userId, title, message, type, link]
  );
}

module.exports = { router, createNotification };
