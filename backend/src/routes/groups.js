const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../utils');
const { requireAuth, requireAdmin } = require('../middleware');

/* ---------------- GET /api/groups ---------------- */
router.get('/', requireAuth, asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const r = await db.query(`
        SELECT
            g.id, g.name, g.description, g.category, g.visibility, g.created_at,
            (SELECT COUNT(*)::int FROM group_members gm WHERE gm.group_id = g.id) AS member_count,
            (SELECT COUNT(*)::int FROM group_messages m WHERE m.group_id = g.id) AS message_count,
            (SELECT MAX(created_at) FROM group_messages m WHERE m.group_id = g.id) AS last_activity,
            EXISTS(SELECT 1 FROM group_members gm WHERE gm.group_id = g.id AND gm.user_id = $1) AS is_member
        FROM groups g
        ORDER BY g.created_at DESC
    `, [userId]);
    res.json({ groups: r.rows });
}));

/* ---------------- POST /api/groups (admin) ---------------- */
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { name, description, category, visibility } = req.body;
    if (!name) return res.status(400).json({ error: 'Group name required' });

    const r = await db.query(`
        INSERT INTO groups (name, description, category, visibility, created_by)
        VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [name, description || null, category || 'General', visibility || 'public', req.user.id]);

    await db.query(
        `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'admin')`,
        [r.rows[0].id, req.user.id]
    );

    res.status(201).json({ group: r.rows[0] });
}));

/* ---------------- GET /api/groups/:id ---------------- */
router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
    const gr = await db.query(`SELECT * FROM groups WHERE id = $1`, [req.params.id]);
    if (!gr.rows.length) return res.status(404).json({ error: 'Group not found' });

    const members = await db.query(`
        SELECT u.id, u.full_name, u.username, u.email, gm.role, gm.joined_at
        FROM group_members gm JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = $1 ORDER BY gm.joined_at ASC
    `, [req.params.id]);

    res.json({ group: gr.rows[0], members: members.rows });
}));

/* ---------------- PUT /api/groups/:id (admin) ---------------- */
router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const { name, description, category, visibility } = req.body;
    const r = await db.query(`
        UPDATE groups SET
            name = COALESCE($1, name),
            description = COALESCE($2, description),
            category = COALESCE($3, category),
            visibility = COALESCE($4, visibility)
        WHERE id = $5 RETURNING *
    `, [name, description, category, visibility, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Group not found' });
    res.json({ group: r.rows[0] });
}));

/* ---------------- DELETE /api/groups/:id (admin) ---------------- */
router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await db.query(`DELETE FROM groups WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
}));

/* ---------------- POST /api/groups/:id/join ---------------- */
router.post('/:id/join', requireAuth, asyncHandler(async (req, res) => {
    const gr = await db.query(`SELECT visibility FROM groups WHERE id = $1`, [req.params.id]);
    if (!gr.rows.length) return res.status(404).json({ error: 'Group not found' });
    if (gr.rows[0].visibility === 'private') return res.status(403).json({ error: 'Private group' });

    await db.query(`
        INSERT INTO group_members (group_id, user_id, role)
        VALUES ($1, $2, 'member')
        ON CONFLICT (group_id, user_id) DO NOTHING
    `, [req.params.id, req.user.id]);

    res.json({ success: true });
}));

/* ---------------- POST /api/groups/:id/leave ---------------- */
router.post('/:id/leave', requireAuth, asyncHandler(async (req, res) => {
    await db.query(
        `DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`,
        [req.params.id, req.user.id]
    );
    res.json({ success: true });
}));

/* ---------------- GET /api/groups/:id/messages ---------------- */
router.get('/:id/messages', requireAuth, asyncHandler(async (req, res) => {
    const r = await db.query(`
        SELECT m.id, m.user_id, m.content, m.created_at,
               u.full_name, u.username, u.role
        FROM group_messages m JOIN users u ON u.id = m.user_id
        WHERE m.group_id = $1 ORDER BY m.created_at ASC LIMIT 500
    `, [req.params.id]);
    res.json({ messages: r.rows });
}));

/* ---------------- POST /api/groups/:id/messages ---------------- */
router.post('/:id/messages', requireAuth, asyncHandler(async (req, res) => {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Message required' });
    if (content.length > 5000) return res.status(400).json({ error: 'Too long' });

    const m = await db.query(
        `SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2`,
        [req.params.id, req.user.id]
    );
    if (!m.rows.length) return res.status(403).json({ error: 'Join the group first' });

    const r = await db.query(`
        INSERT INTO group_messages (group_id, user_id, content)
        VALUES ($1, $2, $3) RETURNING *
    `, [req.params.id, req.user.id, content]);

    res.status(201).json({ message: r.rows[0] });
}));

module.exports = router;
