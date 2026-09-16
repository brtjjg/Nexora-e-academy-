const { validateSession } = require('./auth');

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

async function requireApprovedStudent(req, res, next) {
    await requireAuth(req, res, async () => {
        if (req.user.role === 'admin') return next();
        const db = require('./db');
        const r = await db.query(
            `SELECT admission_status FROM student_profiles WHERE user_id = $1`,
            [req.user.user_id]
        );
        if (!r.rows.length || r.rows[0].admission_status !== 'approved') {
            return res.status(403).json({ error: 'Student not approved yet' });
        }
        next();
    });
}

module.exports = {
    requireAuth,
    requireAdmin,
    requireApprovedStudent,
};
