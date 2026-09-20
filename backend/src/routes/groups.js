// backend/routes/groups.js
const express = require('express');
const router = express.Router();
const { query } = require('../db');          // ⚠️ adjust path/export to match your db module
const { requireAuth, requireAdmin } = require('../auth');  // ⚠️ adjust to your auth module

/* ============================================================
   GROUPS / DISCUSSION
   ============================================================ */

// GET /api/groups — list all groups with counts + is_member
router.get('/', requireAuth, async (req, res) => {
    try {
        const { rows } = await query(`
            SELECT
                g.id, g.name, g.description, g.category, g.visibility, g.created_at,
                (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id)::int AS member_count,
                (SELECT COUNT(*) FROM group_messages m WHERE m.group_id = g.id)::int AS message_count,
                (SELECT MAX(created_at) FROM group_messages m WHERE m.group_id = g.id) AS last_activity,
                EXISTS(SELECT 1 FROM group_members gm WHERE gm.group_id = g.id AND gm.user_id = $1) AS is_member
            FROM groups g
            ORDER BY g.created_at DESC
        `, [req.user.id]);
        res.json({ groups: rows });
    } catch (err) {
        console.error('[groups:list]', err.message);
        res.status(500).json({ error: 'Failed to fetch groups' });
    }
});

// POST /api/groups — create group (admin only)
router.post('/', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { name, description, category, visibility } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'Group name required' });

        const { rows } = await query(`
            INSERT INTO groups (name, description, category, visibility, created_by)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `, [
            name.trim(),
            description || null,
            category || 'General',
            visibility || 'public',
            req.user.id
        ]);

        // Auto-add creator as admin member
        await query(
            `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'admin')`,
            [rows[0].id, req.user.id]
        );

        res.status(201).json({ group: rows[0] });
    } catch (err) {
        console.error('[groups:create]', err.message);
        res.status(500).json({ error: 'Failed to create group' });
    }
});

// GET /api/groups/:id — details + members
router.get('/:id', requireAuth, async (req, res) => {
    try {
        const { rows: gRows } = await query(`SELECT * FROM groups WHERE id = $1`, [req.params.id]);
        if (!gRows.length) return res.status(404).json({ error: 'Group not found' });

        const { rows: members } = await query(`
            SELECT u.id, u.full_name, u.username, u.email, gm.role, gm.joined_at
            FROM group_members gm
            JOIN users u ON u.id = gm.user_id
            WHERE gm.group_id = $1
            ORDER BY gm.joined_at ASC
        `, [req.params.id]);

        res.json({ group: gRows[0], members });
    } catch (err) {
        console.error('[groups:get]', err.message);
        res.status(500).json({ error: 'Failed to fetch group' });
    }
});

// PUT /api/groups/:id — update (admin only)
router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { name, description, category, visibility } = req.body;
        const { rows } = await query(`
            UPDATE groups SET
                name        = COALESCE($1, name),
                description = COALESCE($2, description),
                category    = COALESCE($3, category),
                visibility  = COALESCE($4, visibility)
            WHERE id = $5
            RETURNING *
        `, [name, description, category, visibility, req.params.id]);
        if (!rows.length) return res.status(404).json({ error: 'Group not found' });
        res.json({ group: rows[0] });
    } catch (err) {
        console.error('[groups:update]', err.message);
        res.status(500).json({ error: 'Failed to update group' });
    }
});

// DELETE /api/groups/:id (admin only)
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await query(`DELETE FROM groups WHERE id = $1`, [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('[groups:delete]', err.message);
        res.status(500).json({ error: 'Failed to delete group' });
    }
});

// POST /api/groups/:id/join
router.post('/:id/join', requireAuth, async (req, res) => {
    try {
        const { rows: g } = await query(`SELECT visibility FROM groups WHERE id = $1`, [req.params.id]);
        if (!g.length) return res.status(404).json({ error: 'Group not found' });
        if (g[0].visibility === 'private') return res.status(403).json({ error: 'Private group — invite only' });

        await query(`
            INSERT INTO group_members (group_id, user_id, role)
            VALUES ($1, $2, 'member')
            ON CONFLICT (group_id, user_id) DO NOTHING
        `, [req.params.id, req.user.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('[groups:join]', err.message);
        res.status(500).json({ error: 'Failed to join group' });
    }
});

// POST /api/groups/:id/leave
router.post('/:id/leave', requireAuth, async (req, res) => {
    try {
        await query(
            `DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`,
            [req.params.id, req.user.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('[groups:leave]', err.message);
        res.status(500).json({ error: 'Failed to leave group' });
    }
});

// GET /api/groups/:id/messages
router.get('/:id/messages', requireAuth, async (req, res) => {
    try {
        const { rows } = await query(`
            SELECT m.id, m.user_id, m.content, m.created_at,
                   u.full_name, u.username, u.role
            FROM group_messages m
            JOIN users u ON u.id = m.user_id
            WHERE m.group_id = $1
            ORDER BY m.created_at ASC
            LIMIT 500
        `, [req.params.id]);
        res.json({ messages: rows });
    } catch (err) {
        console.error('[groups:messages:list]', err.message);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

// POST /api/groups/:id/messages
router.post('/:id/messages', requireAuth, async (req, res) => {
    try {
        const { content } = req.body;
        if (!content || !content.trim()) return res.status(400).json({ error: 'Message required' });
        if (content.length > 5000) return res.status(400).json({ error: 'Message too long' });

        const { rows: m } = await query(
            `SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2`,
            [req.params.id, req.user.id]
        );
        if (!m.length) return res.status(403).json({ error: 'You must join the group first' });

        const { rows } = await query(`
            INSERT INTO group_messages (group_id, user_id, content)
            VALUES ($1, $2, $3)
            RETURNING *
        `, [req.params.id, req.user.id, content.trim()]);

        res.status(201).json({ message: rows[0] });
    } catch (err) {
        console.error('[groups:messages:create]', err.message);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

module.exports = router;
