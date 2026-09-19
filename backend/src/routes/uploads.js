const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const { asyncHandler } = require('../utils');
const { requireAuth, requireAdmin } = require('../middleware');

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const MAX_MB = parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 500;
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://nexora-api-sskg.onrender.com';

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const sub = req.query.scope || 'misc';
        const dir = path.join(UPLOAD_DIR, sub);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const id = crypto.randomBytes(16).toString('hex');
        cb(null, `${Date.now()}-${id}${ext}`);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: MAX_MB * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = [
            'image/jpeg', 'image/png', 'image/webp', 'image/gif',
            'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo',
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ];
        if (allowed.includes(file.mimetype)) return cb(null, true);
        console.warn('[upload] Rejected file type:', file.mimetype, file.originalname);
        cb(new Error('File type not allowed: ' + file.mimetype));
    },
});

function buildUrl(storagePath) {
    return PUBLIC_URL + '/uploads/' + storagePath.split(path.sep).join('/');
}

// ============================================================
// Application documents (student registration)
// ============================================================
router.post('/application-document',
    requireAuth,
    upload.single('file'),
    asyncHandler(async (req, res) => {
        const { application_id, document_type } = req.query;
        if (!req.file) return res.status(400).json({ error: 'No file' });
        if (!['national_front','national_back','certificate','passport'].includes(document_type)) {
            return res.status(400).json({ error: 'Invalid document_type' });
        }
        const a = await db.query(
            `SELECT id FROM applications WHERE id = $1 AND user_id = $2`,
            [application_id, req.user.user_id]
        );
        if (!a.rows.length) return res.status(403).json({ error: 'Application not found' });

        const storagePath = path.relative(UPLOAD_DIR, req.file.path);
        const r = await db.query(
            `INSERT INTO application_documents
                (application_id, document_type, file_name, storage_path,
                 mime_type, file_size, status)
             VALUES ($1,$2,$3,$4,$5,$6,'pending')
             RETURNING id, document_type, file_name, storage_path, status, uploaded_at`,
            [application_id, document_type, req.file.originalname,
             storagePath, req.file.mimetype, req.file.size]
        );
        res.status(201).json({
            document: r.rows[0],
            url: buildUrl(storagePath),
        });
    })
);

// ============================================================
// Lesson video (course builder)
// ============================================================
router.post('/lesson-video',
    requireAdmin,
    upload.single('file'),
    asyncHandler(async (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const storagePath = path.relative(UPLOAD_DIR, req.file.path);
        const url = buildUrl(storagePath);
        console.log('[upload] lesson-video saved:', url, req.file.size, 'bytes');
        res.status(201).json({ path: url, storage_path: storagePath });
    })
);

// ============================================================
// Lesson attachment (PDF / image)
// ============================================================
router.post('/lesson-attachment',
    requireAdmin,
    upload.single('file'),
    asyncHandler(async (req, res) => {
        const { attachment_type } = req.query;
        if (!req.file) return res.status(400).json({ error: 'No file' });
        if (!['pdf','image'].includes(attachment_type)) {
            return res.status(400).json({ error: 'Invalid attachment_type' });
        }
        const storagePath = path.relative(UPLOAD_DIR, req.file.path);
        res.status(201).json({ path: buildUrl(storagePath), storage_path: storagePath });
    })
);

// ============================================================
// Assignment submission file
// ============================================================
router.post('/assignment-file',
    requireAuth,
    upload.single('file'),
    asyncHandler(async (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const storagePath = path.relative(UPLOAD_DIR, req.file.path);
        res.status(201).json({
            path: buildUrl(storagePath),
            storage_path: storagePath,
            file_name: req.file.originalname,
            file_type: req.file.mimetype,
            file_size: req.file.size,
        });
    })
);

// ============================================================
// Course cover image
// ============================================================
router.post('/course-cover',
    requireAdmin,
    upload.single('file'),
    asyncHandler(async (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const storagePath = path.relative(UPLOAD_DIR, req.file.path);
        res.status(201).json({ path: buildUrl(storagePath), storage_path: storagePath });
    })
);

// ============================================================
// Generic
// ============================================================
router.post('/generic',
    requireAdmin,
    upload.single('file'),
    asyncHandler(async (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const storagePath = path.relative(UPLOAD_DIR, req.file.path);
        res.status(201).json({ path: buildUrl(storagePath), storage_path: storagePath });
    })
);

module.exports = router;
