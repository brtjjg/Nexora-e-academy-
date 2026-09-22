const { validateSession } = require('./auth');
const db = require('./db');

async function requireAuth(req, res, next) {
    try {
        const token = req.cookies.session;
        if (!token) return res.status(401).json({ error: 'Not logged in' });

        const user = await validateSession(token);
        if (!user) return res.status(401).json({ error: 'Session expired' });
        if (user.status !== 'active') {
            return res.status(403).json({ error: 'Account not active' });
        }

        // ⭐ Normalize: ensure BOTH id and user_id are set
        req.user = {
            ...user,
            id: user.id || user.user_id,
            user_id: user.user_id || user.id,
        };
        next();
    } catch (err) {
        next(err);
    }
}

async function requireAdmin(req, res, next) {
    await requireAuth(req, res, () => {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        next();
    });
}

/**
 * Auto-approve: any logged-in user can enroll.
 * No manual admission_status gate.
 */
async function requireApprovedStudent(req, res, next) {
    await requireAuth(req, res, () => {
        if (req.user.role === 'admin') return next();
        // Auto-approve — logged-in users can proceed
        next();
    });
}

module.exports = {
    requireAuth,
    requireAdmin,
    requireApprovedStudent,
};
