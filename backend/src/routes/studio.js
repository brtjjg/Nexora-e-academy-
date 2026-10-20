const express = require('express');
const router = express.Router();
const path = require('path');
const { spawn } = require('child_process');
const db = require('../db');
const { asyncHandler } = require('../utils');
const { requireAuth } = require('../middleware');

function requireStudioAccess(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (!['admin', 'super_admin'].includes(req.user.role)) return res.status(403).json({ error: 'Access required' });
  next();
}
router.use(requireAuth, requireStudioAccess);

router.get('/stats', asyncHandler(async (req, res) => {
  const r = await db.query(`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE video_status='done')::int AS done,
      COUNT(*) FILTER (WHERE video_status='queued')::int AS queued,
      COUNT(*) FILTER (WHERE video_status='rendering')::int AS rendering,
      COUNT(*) FILTER (WHERE video_status='failed')::int AS failed,
      COUNT(*) FILTER (WHERE video_status='none' OR video_status IS NULL)::int AS pending
    FROM lessons l JOIN modules m ON m.id = l.module_id JOIN courses c ON c.id = m.course_id WHERE c.status = 'published'
  `);
  res.json(r.rows[0]);
}));

router.get('/lessons', asyncHandler(async (req, res) => {
  const status = req.query.status;
  const params = [];
  let where = `WHERE c.status = 'published'`;
  if (status && status !== 'all') {
    params.push(status);
    where += ` AND (l.video_status = $1 OR ($1 = 'none' AND (l.video_status IS NULL OR l.video_status = 'none')))`;
  }
  const r = await db.query(`
    SELECT l.id, l.title, l.notes, l.video_url, l.video_status, l.video_error, l.video_generated_at, l.published, m.title AS module_title, c.title AS course_title
    FROM lessons l JOIN modules m ON m.id = l.module_id JOIN courses c ON c.id = m.course_id ${where} ORDER BY l.created_at DESC
  `, params);
  res.json({ lessons: r.rows });
}));

router.post('/lessons/:id/generate', asyncHandler(async (req, res) => {
  const lessonId = req.params.id;
  const check = await db.query(`SELECT video_status FROM lessons WHERE id=$1`, [lessonId]);
  if (!check.rows.length) return res.status(404).json({ error: 'Not found' });
  if (check.rows[0].video_status === 'rendering') return res.status(409).json({ error: 'Already rendering' });

  await db.query(`UPDATE lessons SET video_status='queued', video_error=NULL WHERE id=$1`, [lessonId]);
  const scriptPath = path.join(__dirname, '..', 'studio', 'generate.js');
  const child = spawn('node', [scriptPath, lessonId], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  res.json({ ok: true });
}));

router.post('/lessons/:id/regenerate', asyncHandler(async (req, res) => {
  const lessonId = req.params.id;
  await db.query(`UPDATE lessons SET video_url=NULL, video_status='queued', video_error=NULL WHERE id=$1`, [lessonId]);
  const scriptPath = path.join(__dirname, '..', 'studio', 'generate.js');
  const child = spawn('node', [scriptPath, lessonId], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  res.json({ ok: true });
}));

module.exports = router;
