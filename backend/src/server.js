require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

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

// Static uploads
app.use('/uploads', express.static(
    path.resolve(process.env.UPLOAD_DIR || './uploads'),
    { maxAge: '7d' }
));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/courses', require('./routes/courses'));
app.use('/api/enrollments', require('./routes/enrollments'));
app.use('/api/progress', require('./routes/progress'));
app.use('/api/applications', require('./routes/applications'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/certificates', require('./routes/certificates'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/uploads', require('./routes/uploads'));

app.get('/api/health', (req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
});

// 404
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Error handler
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
        error: process.env.NODE_ENV === 'production'
            ? 'Server error'
            : err.message,
    });
});

// Session cleanup every hour
setInterval(() => {
    require('./auth').cleanupExpiredSessions().catch(console.error);
}, 60 * 60 * 1000);

const PORT = parseInt(process.env.PORT, 10) || 3000;
app.listen(PORT, () => {
    console.log(`[Nexora API] listening on port ${PORT}`);
});
