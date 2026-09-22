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

        req.user = user;
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
 * ✅ AUTO-APPROVE: Payment is the only requirement.
 * Any logged-in user can enroll in courses and view their dashboard.
 * The admission gate is enforced separately by the frontend + payment route.
 */
async function requireApprovedStudent(req, res, next) {
    await requireAuth(req, res, () => {
        if (req.user.role === 'admin') return next();
        // Auto-approve: no manual approval gate. Just require login.
        // If you later want to gate on something else (e.g. course payment),
        // add that check here.
        next();
    });
}

module.exports = {
    requireAuth,
    requireAdmin,
    requireApprovedStudent,
};
