// middleware/securityGate.js
// Runs on every request:
//   1. Checks if IP is blocked → 403 immediately
//   2. Detects suspicious patterns → logs + auto-blocks if threshold exceeded
//   3. Rate-limits per IP per minute
//   4. Detects failed logins and blocks after threshold
//
// Everything here is READ-then-DECIDE on your own server.
// No external requests. No retaliation. Just defense.

const {
    getThresholds,
    getClientIp,
    logEvent,
    blockIp,
    isIpBlocked,
    countRecentEvents,
    detectSuspiciousRequest,
} = require('../utils/security');

// In-memory sliding window for per-IP request counts
// structure: Map<ip, { count, windowStart }>
const _rateBuckets = new Map();
const RATE_WINDOW_MS = 60 * 1000;

function _touchRateBucket(ip) {
    const now = Date.now();
    const bucket = _rateBuckets.get(ip);
    if (!bucket || now - bucket.windowStart > RATE_WINDOW_MS) {
        _rateBuckets.set(ip, { count: 1, windowStart: now });
        return 1;
    }
    bucket.count += 1;
    return bucket.count;
}

// Periodic cleanup of old buckets (every 5 minutes)
setInterval(() => {
    const cutoff = Date.now() - RATE_WINDOW_MS * 2;
    for (const [ip, bucket] of _rateBuckets.entries()) {
        if (bucket.windowStart < cutoff) _rateBuckets.delete(ip);
    }
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────
// The middleware itself
// ─────────────────────────────────────────────
async function securityGate(req, res, next) {
    const ip = getClientIp(req);
    const ua = String(req.headers['user-agent'] || '');
    const method = req.method;
    const path = req.originalUrl || req.url;

    try {
        // ── 1. Is the IP already blocked? ──
        if (await isIpBlocked(ip)) {
            return res.status(403).json({
                error: 'Access denied',
                code: 'IP_BLOCKED',
            });
        }

        // ── 2. Suspicious pattern check ──
        const suspicious = detectSuspiciousRequest(req);
        if (suspicious) {
            await logEvent({
                event_type: 'suspicious_request',
                severity: suspicious.severity || 'medium',
                ip_address: ip,
                user_agent: ua,
                method,
                path,
                details: { reason: suspicious.reason },
            });

            // Count recent suspicious events from this IP
            const count = await countRecentEvents({
                ip,
                event_type: 'suspicious_request',
                minutes: 10,
            });
            const thresholds = await getThresholds();

            if (count >= (thresholds.suspicious_paths_per_10min || 5)) {
                await blockIp({
                    ip_address: ip,
                    reason: `Too many suspicious requests (${count} in 10 min)`,
                    severity: 'high',
                    blocked_by: 'auto',
                    duration_hours: thresholds.block_duration_hours || 24,
                });
            }

            // For critical severity (SQL injection / XSS), block immediately
            if (suspicious.severity === 'critical') {
                await blockIp({
                    ip_address: ip,
                    reason: suspicious.reason,
                    severity: 'critical',
                    blocked_by: 'auto',
                    duration_hours: (thresholds.block_duration_hours || 24) * 7,
                });
            }

            // Respond with 400 to suspicious request (don't process it)
            return res.status(400).json({ error: 'Bad request' });
        }

        // ── 3. Rate limit ──
        const hits = _touchRateBucket(ip);
        const thresholds = await getThresholds();
        const maxPerMin = thresholds.requests_per_min || 120;

        if (hits > maxPerMin) {
            await logEvent({
                event_type: 'rate_limited',
                severity: 'medium',
                ip_address: ip,
                user_agent: ua,
                method,
                path,
                details: { hits, limit: maxPerMin },
            });

            // Auto-block after 3 rate-limit violations in 10 min
            const violations = await countRecentEvents({
                ip,
                event_type: 'rate_limited',
                minutes: 10,
            });
            if (violations >= 3) {
                await blockIp({
                    ip_address: ip,
                    reason: `Repeated rate limit violations (${violations} in 10 min)`,
                    severity: 'medium',
                    blocked_by: 'auto',
                    duration_hours: thresholds.block_duration_hours || 24,
                });
            }

            return res.status(429).json({
                error: 'Too many requests — slow down',
                retry_after_seconds: 60,
            });
        }

        // All checks passed — continue
        next();

    } catch (err) {
        // Never block the app because the gate failed
        console.error('[securityGate] error:', err.message);
        next();
    }
}

// ─────────────────────────────────────────────
// Failed-login tracker
// Call this from /api/auth/login when password fails.
// ─────────────────────────────────────────────
async function trackFailedLogin(req) {
    const ip = getClientIp(req);
    const ua = String(req.headers['user-agent'] || '');
    const email = (req.body && req.body.email) || null;

    await logEvent({
        event_type: 'login_failed',
        severity: 'low',
        ip_address: ip,
        user_agent: ua,
        method: 'POST',
        path: '/api/auth/login',
        details: { email },
    });

    const thresholds = await getThresholds();
    const count = await countRecentEvents({
        ip,
        event_type: 'login_failed',
        minutes: 10,
    });

    if (count >= (thresholds.failed_logins_per_10min || 10)) {
        await blockIp({
            ip_address: ip,
            reason: `Too many failed logins (${count} in 10 min)`,
            severity: 'high',
            blocked_by: 'auto',
            duration_hours: thresholds.block_duration_hours || 24,
        });
    }
}

module.exports = securityGate;
module.exports.trackFailedLogin = trackFailedLogin;
