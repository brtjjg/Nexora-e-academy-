require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const app = express();

app.set('trust proxy', 1);

// Log every incoming request
app.use((req, res, next) => {
    console.log(`[REQ] ${req.method} ${req.originalUrl}`);
    next();
});

app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false,
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(cookieParser());

const ALLOWED_ORIGINS = (process.env.FRONTEND_URL || '')
    .split(',').map(s => s.trim()).filter(Boolean);
console.log('[CORS] Allowed origins:', ALLOWED_ORIGINS);

app.use(cors({
    origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        console.warn('[CORS] Blocked origin:', origin);
        cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
    maxAge: 86400,
}));

function loadRoute(name) {
    const filePath = `./routes/${name}`;
    try {
        const mod = require(filePath);
        const router = mod.router || mod; // Handle { router } exports
        if (typeof router !== 'function') {
            console.error(`[route-loader] BROKEN: ${name}.js exports ${typeof router}`);
            return (req, res) => res.status(503).json({ error: `Route "${name}" is misconfigured` });
        }
        console.log(`[route-loader] OK: ${name}.js`);
        return router;
    } catch (err) {
        console.error(`[route-loader] FAILED: ${name}.js - ${err.message}`);
        return (req, res) => res.status(503).json({ error: `Route "${name}" failed to load: ${err.message}` });
    }
}

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(path.resolve(UPLOAD_DIR), { maxAge: '7d' }));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500 });
app.use('/api', apiLimiter);

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many attempts' } });
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// ─────────────────────────────────────────────
// Mounting all routes safely
// ─────────────────────────────────────────────
app.use('/api/setup',         loadRoute('setup'));
app.use('/api',               loadRoute('security-gate'));
app.use('/api/security',      loadRoute('security'));
app.use('/api/auth',          loadRoute('auth'));
app.use('/api/auth',          loadRoute('auth-google'));
app.use('/api/courses',       loadRoute('courses'));
app.use('/api/enrollments',   loadRoute('enrollments'));
app.use('/api/progress',      loadRoute('progress'));
app.use('/api/applications',  loadRoute('applications'));
app.use('/api/payments',      loadRoute('payments'));
app.use('/api/certificates',  loadRoute('certificates'));
app.use('/api/admin',         loadRoute('admin'));
app.use('/api/groups',        loadRoute('groups'));
app.use('/api/notifications', loadRoute('notifications')); // Uses the file you already have
app.use('/api/uploads',       loadRoute('uploads'));
app.use('/api/assignments',   loadRoute('assignments'));
app.use('/api/public',        loadRoute('public'));
app.use('/api/paypal',        loadRoute('paypal'));
app.use('/api/pesapal',       loadRoute('pesapal'));
app.use('/api/contributor',   loadRoute('contributor'));
app.use('/api/financials',    loadRoute('financials'));
app.use('/api/studio',        loadRoute('studio'));

// Root and Health Checks
app.get('/', (req, res) => res.json({ ok: true, service: 'Nexora Academy API' }));
app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.originalUrl }));

// Global Error Handler
app.use((err, req, res, next) => {
    console.error('[ERROR]', err.message);
    res.status(err.status || 500).json({ error: process.env.NODE_ENV === 'production' ? 'Server error' : err.message });
});

// ─────────────────────────────────────────────
// Auto-Generate Studio Videos (Cron)
// ─────────────────────────────────────────────
if (process.env.STUDIO_AUTO === 'true') {
  setInterval(async () => {
    try {
      // Use the correct relative path to db from inside src/
      const db = require('./db'); 
      const { spawn } = require('child_process');
      const r = await db.query(`
        SELECT id FROM lessons l JOIN modules m ON m.id = l.module_id JOIN courses c ON c.id = m.course_id
        WHERE (l.video_status IS NULL OR l.video_status = 'none') AND c.status = 'published' AND l.published = true AND LENGTH(l.notes) >= 200
        ORDER BY l.created_at ASC LIMIT 2
      `);
      for (const row of r.rows) {
        const script = path.join(__dirname, 'studio', 'generate.js');
        spawn('node', [script, row.id], { detached: true, stdio: 'ignore', env: process.env }).unref();
        await db.query(`UPDATE lessons SET video_status='queued' WHERE id=$1`, [row.id]);
      }
    } catch (e) { console.error('[studio-auto]', e.message); }
  }, 60 * 60 * 1000);
}

// Session cleanup
setInterval(() => {
    try { require('./auth').cleanupExpiredSessions().catch(() => {}); } catch (e) {}
}, 60 * 60 * 1000);

const PORT = parseInt(process.env.PORT, 10) || 3000;

async function start() {
    try {
        const { runMigrations } = require('./migrate');
        await runMigrations();
    } catch (err) { console.error('[start] Migration skipped:', err.message); }

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`[Nexora API] listening on port ${PORT}`);
    });
}

start();
