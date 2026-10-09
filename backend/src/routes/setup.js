// routes/setup.js
// ONE-TIME BOOTSTRAP — delete this file after setup is complete.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../utils');

const SETUP_SECRET = process.env.SETUP_SECRET || 'nexora-bootstrap-2026';

router.get('/bootstrap', asyncHandler(async (req, res) => {
  const { secret, email, name } = req.query;

  if (secret !== SETUP_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!email) {
    return res.status(400).json({ error: 'email is required' });
  }

  const emailLower = String(email).toLowerCase().trim();
  const baseUsername = emailLower.split('@')[0].replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'admin';

  const r = await db.query(`
    INSERT INTO users (username, email, password_hash, full_name, role, status)
    VALUES ($1, $2, NULL, $3, 'super_admin', 'active')
    ON CONFLICT (email) DO UPDATE SET
      role = 'super_admin',
      status = 'active',
      updated_at = NOW()
    RETURNING id, email, username, role, status
  `, [baseUsername, emailLower, name || 'Super Admin']);

  res.json({
    ok: true,
    user: r.rows[0],
    next: 'Log in with Google using this email. Then delete this route.'
  });
}));

module.exports = router;
