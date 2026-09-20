const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../utils');
const { requireAuth, requireAdmin } = require('../middleware');
const { sendGroupMessage, sendNewGroupAnnouncement } = require('../email');
const notifications = require('../notifications');

/* ============================================================
   HELPERS
   ============================================================ */

function getUserId(req) {
    const u = req.user;
    if (!u) return null;
    return u.id || u.userId || u.user_id || null;
}

/**
 * Ensure the current user is a member of the given group.
 * Auto-joins:
 *   - Admins (any group) → role = 'admin'
 *   - Group creator       → role = 'admin'
 *   - Public groups       → role = 'member'
 * Returns { ok, role?, reason? }
 */
async function ensureMembership(req, groupId) {
    const userId = getUserId(req);
    if (!userId) return { ok: false, reason: 'no_user' };

    // Already a member?
    const existing = await db.query(
        `SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2`,
        [groupId, userId]
    );
    if (existing.rows.length) {
        return { ok: true, role: existing.rows[0].role, alreadyMember: true };
    }

    // Look up the group
    const gr = await db.query(
        `SELECT created_by, visibility FROM groups WHERE id = $1`,
        [groupId]
    );
    if (!gr.rows.length) return { ok: false, reason: 'group_not_found' };

    const { created_by, visibility } = gr.rows[0];
    const isAdmin   = req.user.role === 'admin';
    const isCreator = created_by && created_by === userId;

    // Auto-join rules
    let role = null;
    if (isCreator || isAdmin)         role = 'admin';
    else if (visibility === 'public') role = 'member';

    if (!role) return { ok: false, reason: 'private_not_member' };

    await db.query(
        `INSERT INTO group_members (group_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (group_id, user_id) DO NOTHING`,
        [groupId, userId, role]
    );

    return { ok: true, role, autoJoined: true };
}

/* ============================================================
   NOTIFICATION HELPERS
   ============================================================ */

const NOTIFY_THROTTLE_MINUTES = 10;

async function shouldNotify(userId, groupId) {
    const r = await db.query(
        `SELECT last_notified_at FROM email_notification_log
         WHERE user_id = $1 AND group_id = $2`,
        [userId, groupId]
    );
    if (!r.rows.length) return true;
    return (Date.now() - new Date(r.rows[0].last_notified_at).getTime())
           > NOTIFY_THROTTLE_MINUTES * 60 * 1000;
}

async function markNotified(userId, groupId) {
    await db.query(
        `INSERT INTO email_notification_log (user_id, group_id, last_notified_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id, group_id)
         DO UPDATE SET last_notified_at = NOW()`,
        [userId, groupId]
    );
}

/**
 * Fire-and-forget: notify all group members (except sender)
 * about a new message.
 */
async function notifyGroupMembers({ groupId, groupName, senderId, senderName, messageContent }) {
    try {
        const members = await db.query(
            `SELECT u.id, u.email, u.full_name
             FROM group_members gm
             JOIN users u ON u.id = gm.user_id
             WHERE gm.group_id = $1 AND gm.user_id <> $2`,
            [groupId, senderId]
        );

        console.log(`[notify:group] "${groupName}" — ${members.rows.length} potential recipients`);

        for (const m of members.rows) {
            if (!m.email) continue;

            // Check user preference
            const enabled = await notifications.isEnabled(m.id, 'email_group_messages');
            if (!enabled) {
                console.log(`[notify:group] Skipping ${m.email} (pref off)`);
                continue;
            }

            // Throttle check
            if (!(await shouldNotify(m.id, groupId))) {
                console.log(`[notify:group] Skipping ${m.email} (throttled)`);
                continue;
            }

            await sendGroupMessage({
                to: m.email,
                recipientName: m.full_name,
                senderName,
                groupName,
                groupId,
                messagePreview: messageContent,
            });

            await markNotified(m.id, groupId);
        }
    } catch (err) {
        console.error('[notify:group] Failed:', err.message);
    }
}

/**
 * Fire-and-forget: notify all students about a new group.
 */
async function notifyNewGroupAnnouncement({ groupId, groupName, category, description, createdBy }) {
    try {
        const students = await db.query(
            `SELECT id, email, full_name FROM users
             WHERE role = 'student' AND email IS NOT NULL AND id <> $1`,
            [createdBy]
        );

        console.log(`[notify:announcement] "${groupName}" — ${students.rows.length} students`);

        for (const s of students.rows) {
            const enabled = await notifications.isEnabled(s.id, 'email_group_announcements');
            if (!enabled) continue;

            await sendNewGroupAnnouncement({
                to: s.email,
                recipientName: s.full_name,
                groupName,
                groupId,
                category,
                description,
            });
        }
    } catch (err) {
        console.error('[notify:announcement] Failed:', err.message);
    }
}

/* ============================================================
   GET /api/groups — list all
   ============================================================ */
router.get('/', requireAuth, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
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

/* ============================================================
   POST /api/groups — create (admin)
   Auto-adds creator as ADMIN member
   Sends announcement emails to all students
   ============================================================ */
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    console.log('[groups:create] req.user:', JSON.stringify(req.user));
    console.log('[groups:create] resolved userId:', userId);

    if (!userId) {
        console.error('[groups:create] No user id found on req.user');
        return res.status(401).json({ error: 'User context missing — check middleware' });
    }

    const { name, description, category, visibility } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Group name required' });
    }

    // 1. Create the group
    const r = await db.query(
        `INSERT INTO groups (name, description, category, visibility, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [
            name.trim(),
            description || null,
            category || 'General',
            visibility || 'public',
            userId
        ]
    );

    const groupId = r.rows[0].id;
    console.log('[groups:create] Created group', groupId, 'by', userId);

    // 2. Add creator as ADMIN member
    await db.query(
        `INSERT INTO group_members (group_id, user_id, role)
         VALUES ($1, $2, 'admin')
         ON CONFLICT (group_id, user_id) DO NOTHING`,
        [groupId, userId]
    );

    // 3. Verify
    const check = await db.query(
        `SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2`,
        [groupId, userId]
    );
    if (!check.rows.length) {
        console.error('[groups:create] Creator NOT added to group_members!');
        try {
            await db.query(
                `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'admin')`,
                [groupId, userId]
            );
        } catch (e) {
            console.error('[groups:create] Retry failed:', e.message);
            return res.status(500).json({ error: 'Group created but membership could not be saved' });
        }
    } else {
        console.log('[groups:create] Creator confirmed as', check.rows[0].role);
    }

    // 4. 🔔 Fire-and-forget announcement to all students
    (async () => {
        try {
            await notifyNewGroupAnnouncement({
                groupId,
                groupName: name.trim(),
                category: category || 'General',
                description: description || '',
                createdBy: userId,
            });
        } catch (e) {
            console.error('[groups:create] announce failed:', e.message);
        }
    })();

    res.status(201).json({ group: r.rows[0] });
}));

/* ============================================================
   GET /api/groups/:id — details + members
   ============================================================ */
router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
    const mem = await ensureMembership(req, req.params.id);
    if (!mem.ok && mem.reason === 'group_not_found') {
        return res.status(404).json({ error: 'Group not found' });
    }

    const gr = await db.query(`SELECT * FROM groups WHERE id = $1`, [req.params.id]);
    if (!gr.rows.length) return res.status(404).json({ error: 'Group not found' });

    const members = await db.query(`
        SELECT u.id, u.full_name, u.username, u.email, gm.role, gm.joined_at
        FROM group_members gm
        JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = $1
        ORDER BY gm.joined_at ASC
    `, [req.params.id]);

    res.json({ group: gr.rows[0], members: members.rows });
}));

/* ============================================================
   PUT /api/groups/:id (admin)
   ============================================================ */
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

/* ============================================================
   DELETE /api/groups/:id (admin)
   ============================================================ */
router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await db.query(`DELETE FROM groups WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
}));

/* ============================================================
   POST /api/groups/:id/join
   ============================================================ */
router.post('/:id/join', requireAuth, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const gr = await db.query(`SELECT visibility FROM groups WHERE id = $1`, [req.params.id]);
    if (!gr.rows.length) return res.status(404).json({ error: 'Group not found' });

    const isAdmin = req.user.role === 'admin';
    if (gr.rows[0].visibility === 'private' && !isAdmin) {
        return res.status(403).json({ error: 'Private group — invite only' });
    }

    await db.query(`
        INSERT INTO group_members (group_id, user_id, role)
        VALUES ($1, $2, $3)
        ON CONFLICT (group_id, user_id) DO NOTHING
    `, [req.params.id, userId, isAdmin ? 'admin' : 'member']);

    res.json({ success: true });
}));

/* ============================================================
   POST /api/groups/:id/leave
   ============================================================ */
router.post('/:id/leave', requireAuth, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    await db.query(
        `DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`,
        [req.params.id, userId]
    );
    res.json({ success: true });
}));

/* ============================================================
   GET /api/groups/:id/messages
   ============================================================ */
router.get('/:id/messages', requireAuth, asyncHandler(async (req, res) => {
    const mem = await ensureMembership(req, req.params.id);
    if (!mem.ok && mem.reason === 'group_not_found') {
        return res.status(404).json({ error: 'Group not found' });
    }

    const r = await db.query(`
        SELECT m.id, m.user_id, m.content, m.created_at,
               u.full_name, u.username, u.role
        FROM group_messages m
        JOIN users u ON u.id = m.user_id
        WHERE m.group_id = $1
        ORDER BY m.created_at ASC
        LIMIT 500
    `, [req.params.id]);
    res.json({ messages: r.rows });
}));

/* ============================================================
   POST /api/groups/:id/messages
   Auto-joins admin/creator BEFORE membership check
   Triggers email notifications to group members
   ============================================================ */
router.post('/:id/messages', requireAuth, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'User context missing' });

    const { content } = req.body;
    if (!content || !content.trim()) {
        return res.status(400).json({ error: 'Message required' });
    }
    if (content.length > 5000) {
        return res.status(400).json({ error: 'Message too long (max 5000 chars)' });
    }

    // Auto-join BEFORE membership check
    const mem = await ensureMembership(req, req.params.id);
    if (!mem.ok) {
        if (mem.reason === 'group_not_found') {
            return res.status(404).json({ error: 'Group not found' });
        }
        return res.status(403).json({ error: 'You must join the group first' });
    }

    // Save the message
    const r = await db.query(`
        INSERT INTO group_messages (group_id, user_id, content)
        VALUES ($1, $2, $3) RETURNING *
    `, [req.params.id, userId, content.trim()]);

    // 🔔 Fire-and-forget email notification
    (async () => {
        try {
            const gr = await db.query(`SELECT name FROM groups WHERE id = $1`, [req.params.id]);
            await notifyGroupMembers({
                groupId: req.params.id,
                groupName: gr.rows[0]?.name || 'Group',
                senderId: userId,
                senderName: req.user.full_name || req.user.username || 'A member',
                messageContent: content.trim(),
            });
        } catch (e) {
            console.error('[notify:bg]', e.message);
        }
    })();

    res.status(201).json({ message: r.rows[0] });
}));

module.exports = router;
