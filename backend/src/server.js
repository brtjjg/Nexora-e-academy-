require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { runMigrations } = require('./migrate');

const app = express();

app.set('trust proxy', 1);

app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false,
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(cookieParser());

const ALLOWED_ORIGINS = (process.env.FRONTEND_URL || '')
    .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
    origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
}));

function loadRoute(name) {
    const filePath = `./routes/${name}`;
    try {
        const mod = require(filePath);
        if (typeof mod !== 'function') {
            console.error(`[route-loader] BROKEN: ${name}.js exports ${typeof mod}`);
            const placeholder = express.Router();
            placeholder.use((req, res) => res.status(503).json({
                error: `Route "${name}" is misconfigured`,
            }));
            return placeholder;
        }
        console.log(`[route-loader] OK: ${name}.js`);
        return mod;
    } catch (err) {
        console.error(`[route-loader] FAILED: ${name}.js - ${err.message}`);
        const placeholder = express.Router();
        placeholder.use((req, res) => res.status(503).json({
            error: `Route "${name}" failed to load: ${err.message}`,
        }));
        return placeholder;
    }
}

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(path.resolve(UPLOAD_DIR), { maxAge: '7d' }));

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api', apiLimiter);

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: { error: 'Too many attempts, try again later' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

app.use('/api/auth',         loadRoute('auth'));
app.use('/api/courses',      loadRoute('courses'));
app.use('/api/enrollments',  loadRoute('enrollments'));
app.use('/api/progress',     loadRoute('progress'));
app.use('/api/applications', loadRoute('applications'));
app.use('/api/payments',     loadRoute('payments'));
app.use('/api/certificates', loadRoute('certificates'));
app.use('/api/admin',        loadRoute('admin'));
app.use('/api/uploads',      loadRoute('uploads'));

app.get('/api/health', (req, res) => {
    const routeStatus = {};
    ['auth','courses','enrollments','progress','applications','payments','certificates','admin','uploads']
        .forEach(name => {
            try {
                const mod = require(`./routes/${name}`);
                routeStatus[name] = typeof mod === 'function' ? 'OK' : `BROKEN (${typeof mod})`;
            } catch (err) {
                routeStatus[name] = `FAILED: ${err.message}`;
            }
        });
    res.json({ ok: true, ts: new Date().toISOString(), routes: routeStatus });
});

app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
    console.error('[ERROR]', err.message);
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large' });
    }
    if (err.message === 'File type not allowed') {
        return res.status(415).json({ error: err.message });
    }
    const status = err.status || 500;
    res.status(status).json({
        error: process.env.NODE_ENV === 'production' ? 'Server error' : err.message,
    });
});

setInterval(() => {
    try {
        require('./auth').cleanupExpiredSessions().catch(console.error);
    } catch (e) {}
}, 60 * 60 * 1000);

const PORT = parseInt(process.env.PORT, 10) || 3000;

runMigrations().then(() => {
    app.listen(PORT, () => {
        console.log(`[Nexora API] listening on port ${PORT}`);
    });
});
