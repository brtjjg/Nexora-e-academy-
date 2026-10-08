// middleware/requireFinance.js
// Role gate for the Nexora Financials portal.
//
// Roles (highest → lowest):
//   super_admin      — full access, can run system jobs, override anything
//   finance_manager  — approve/reject payouts, edit revenue configs, mark paid
//   finance_admin    — read-only dashboard, ledger, reports (no state changes)
//
// requireAuth must run before these.

function requireFinance(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    const allowed = ['finance_admin', 'finance_manager', 'super_admin'];
    if (!allowed.includes(req.user.role)) {
        return res.status(403).json({ error: 'Finance access required' });
    }
    next();
}

function requireFinanceManager(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    const allowed = ['finance_manager', 'super_admin'];
    if (!allowed.includes(req.user.role)) {
        return res.status(403).json({ error: 'Finance Manager access required' });
    }
    next();
}

function requireSuperAdmin(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    if (req.user.role !== 'super_admin') {
        return res.status(403).json({ error: 'Super Admin access required' });
    }
    next();
}

module.exports = {
    requireFinance,
    requireFinanceManager,
    requireSuperAdmin,
};
