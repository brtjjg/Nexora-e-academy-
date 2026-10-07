// backend/src/routes/certificates.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../utils');
const { requireAuth, requireAdmin } = require('../middleware');
const nodemailer = require('nodemailer');

// ─── Email setup ──────────────────────────────────────
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    mailer = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });
    console.log('[email] SMTP configured:', process.env.SMTP_HOST);
} else {
    console.warn('[email] SMTP not configured — certificate emails will be skipped');
}

async function sendCertificateEmail({ to, studentName, certificateId, courseName, certificateType, issuedDate, verifyUrl }) {
    if (!mailer) {
        console.log('[email] Skipped (no SMTP) →', to);
        return { skipped: true };
    }
    const typeLabel = (certificateType || 'Completion').toUpperCase();
    const dateStr = new Date(issuedDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });

    const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#F5F7FA;padding:20px">
      <div style="background:linear-gradient(135deg,#0B1F3A,#172B4D);padding:30px;text-align:center;border-bottom:3px solid #D4A63A">
        <h1 style="color:#D4A63A;margin:0;letter-spacing:3px;font-size:22px">NEXORA ACADEMY</h1>
        <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:13px;letter-spacing:2px">CERTIFICATE PORTAL</p>
      </div>
      <div style="background:#fff;padding:30px;border-radius:0 0 12px 12px">
        <h2 style="color:#0B1F3A;margin:0 0 12px">🎓 Congratulations, ${studentName}!</h2>
        <p style="color:#64748B;line-height:1.7;font-size:15px">
          Your <strong>Certificate of ${typeLabel}</strong> for <strong>${courseName}</strong> has been issued.
        </p>
        <div style="background:#F5F7FA;padding:16px;border-radius:10px;margin:20px 0;border-left:4px solid #D4A63A">
          <div style="font-size:13px;color:#64748B;margin-bottom:6px;text-transform:uppercase;letter-spacing:1px;font-weight:700">Certificate ID</div>
          <div style="font-size:20px;color:#0B1F3A;font-weight:800;font-family:monospace">${certificateId}</div>
          <div style="font-size:13px;color:#64748B;margin-top:12px">Issued on <strong>${dateStr}</strong></div>
        </div>
        <p style="color:#64748B;font-size:14px;line-height:1.7">
          You can view and download your certificate anytime using the link below:
        </p>
        <div style="text-align:center;margin:24px 0">
          <a href="${verifyUrl}" style="background:#29A9E8;color:#fff;padding:12px 28px;border-radius:50px;text-decoration:none;font-weight:700;display:inline-block;font-size:14px">
            View My Certificate
          </a>
        </div>
        <p style="color:#94A3B8;font-size:12px;line-height:1.6;margin-top:24px;padding-top:20px;border-top:1px solid #E2E8F0">
          Anyone can verify this certificate at <a href="${verifyUrl}" style="color:#29A9E8">${verifyUrl}</a>.<br>
          If you didn't expect this email, contact nexoraacademyhelpdesk@gmail.com.
        </p>
      </div>
    </div>`;

    await mailer.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to,
        subject: `🎓 Your ${typeLabel} Certificate — ${courseName}`,
        html,
    });
    console.log('[email] Sent certificate to', to);
    return { sent: true };
}

/* ═══════════════════════════════════════════════════════════
   PUBLIC: GET /api/certificates/verify/:id
   Verifies a certificate by certificate_id OR verification_token
   ═══════════════════════════════════════════════════════════ */
router.get('/verify/:id', asyncHandler(async (req, res) => {
    const r = await db.query(`
        SELECT
            c.certificate_id,
            c.verification_token,
            c.issued_date,
            c.revoked,
            c.student_name,
            c.course_name,
            c.course_duration,
            c.grade,
            u.id AS student_id,
            u.email AS student_email
        FROM certificates c
        LEFT JOIN users u ON u.id = c.user_id
        WHERE c.certificate_id = $1 OR c.verification_token = $1
        LIMIT 1
    `, [req.params.id]);

    if (!r.rows.length) {
        return res.status(200).json({ valid: false, error: 'Not found' });
    }

    const cert = r.rows[0];

    if (cert.revoked) {
        return res.status(200).json({ valid: false, error: 'Revoked', certificate: cert });
    }

    res.json({
        valid: true,
        certificate: {
            certificate_id: cert.certificate_id,
            student_name: cert.student_name,
            student_id: cert.student_id,
            course_name: cert.course_name,
            course_duration: cert.course_duration,
            grade: cert.grade,
            issued_date: cert.issued_date,
        },
    });
}));

/* ═══════════════════════════════════════════════════════════
   STUDENT: GET /api/certificates/me
   ═══════════════════════════════════════════════════════════ */
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
    const userId = req.user.user_id || req.user.id;
    const r = await db.query(`
        SELECT
            id, certificate_id, user_id, course_id,
            student_name, course_name, course_duration, grade,
            issued_date, revoked
        FROM certificates
        WHERE user_id = $1 AND revoked = FALSE
        ORDER BY issued_date DESC
    `, [userId]);
    res.json({ certificates: r.rows });
}));

/* ═══════════════════════════════════════════════════════════
   ADMIN: GET /api/certificates
   ═══════════════════════════════════════════════════════════ */
router.get('/', requireAdmin, asyncHandler(async (req, res) => {
    const r = await db.query(`
        SELECT
            c.id, c.certificate_id, c.student_name, c.course_name,
            c.course_duration, c.grade, c.issued_date, c.revoked,
            u.email AS student_email
        FROM certificates c
        LEFT JOIN users u ON u.id = c.user_id
        ORDER BY c.issued_date DESC
        LIMIT 500
    `);
    res.json({ certificates: r.rows });
}));

/* ═══════════════════════════════════════════════════════════
   ADMIN: POST /api/certificates
   Issue a new certificate manually
   Body: { user_id, course_id, grade? }
   ═══════════════════════════════════════════════════════════ */
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { user_id, course_id, grade } = req.body || {};
    if (!user_id || !course_id) {
        return res.status(400).json({ error: 'user_id and course_id are required' });
    }

    // 1) Load student
    const stu = await db.query(
        `SELECT id, full_name, email FROM users WHERE id = $1`,
        [user_id]
    );
    if (!stu.rows.length) {
        return res.status(404).json({ error: 'Student not found' });
    }
    const student = stu.rows[0];

    // 2) Load course
    const crs = await db.query(
        `SELECT id, title, code, duration FROM courses WHERE id = $1`,
        [course_id]
    );
    if (!crs.rows.length) {
        return res.status(404).json({ error: 'Course not found' });
    }
    const course = crs.rows[0];

    // 3) Prevent duplicates (same student + same course, not revoked)
    const dup = await db.query(
        `SELECT id, certificate_id FROM certificates
         WHERE user_id = $1 AND course_id = $2 AND revoked = FALSE
         LIMIT 1`,
        [user_id, course_id]
    );
    if (dup.rows.length) {
        return res.status(409).json({
            error: 'Certificate already issued for this student and course',
            certificate_id: dup.rows[0].certificate_id,
        });
    }

    // 4) Generate a unique certificate_id
    //    Format: NXA-CP-2026-000001  (CP = course prefix, or "GEN")
    const prefix = (course.code || 'GEN').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 6) || 'GEN';
    const year = new Date().getFullYear();
    const seqRow = await db.query(
        `SELECT COUNT(*)::int AS c FROM certificates
         WHERE certificate_id LIKE $1`,
        [`NXA-${prefix}-${year}-%`]
    );
    const nextNum = String(seqRow.rows[0].c + 1).padStart(6, '0');
    const certificate_id = `NXA-${prefix}-${year}-${nextNum}`;

    // 5) Generate a random verification token (32 hex chars)
    const crypto = require('crypto');
    const verification_token = crypto.randomBytes(16).toString('hex');

    // 6) Insert
    const ins = await db.query(
        `INSERT INTO certificates
            (certificate_id, verification_token, user_id, course_id,
             student_name, course_name, course_duration, grade, issued_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
            certificate_id,
            verification_token,
            user_id,
            course_id,
            student.full_name || 'Student',
            course.title || 'Course',
            course.duration || null,
            grade || 'Pass',
            req.user.user_id || req.user.id,
        ]
    );

    const cert = ins.rows[0];
const verifyUrl = `https://nexora-certificates.vercel.app/#verify/${certificate_id}`;

// Send email to student (non-blocking — errors are logged, not thrown)
try {
    await sendCertificateEmail({
        to: student.email,
        studentName: student.full_name,
        certificateId: certificate_id,
        courseName: course.title,
        certificateType: cert.certificate_type,
        issuedDate: cert.issued_date,
        verifyUrl,
    });
} catch (mailErr) {
    console.error('[email] Failed:', mailErr.message);
}

res.status(201).json({
    certificate: cert,
    verify_url: verifyUrl,
    email_sent: mailer ? true : false,
    });
}));

/* ═══════════════════════════════════════════════════════════
   ADMIN: POST /api/certificates/:id/revoke
   ═══════════════════════════════════════════════════════════ */
router.post('/:id/revoke', requireAdmin, asyncHandler(async (req, res) => {
    const { reason } = req.body;
    const r = await db.query(`
        UPDATE certificates
        SET revoked = TRUE, revoked_at = NOW(), revoke_reason = $1
        WHERE id = $2
        RETURNING *
    `, [reason || 'Revoked by admin', req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Certificate not found' });
    res.json({ certificate: r.rows[0] });
}));

/* ═══════════════════════════════════════════════════════════
   ADMIN: POST /api/certificates/:id/restore
   Un-revoke a certificate (flip revoked = FALSE)
   ═══════════════════════════════════════════════════════════ */
router.post('/:id/restore', requireAdmin, asyncHandler(async (req, res) => {
    const r = await db.query(
        `UPDATE certificates
         SET revoked = FALSE, revoked_at = NULL, revoke_reason = NULL
         WHERE id = $1
         RETURNING *`,
        [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Certificate not found' });
    res.json({ certificate: r.rows[0] });
}));

/* ═══════════════════════════════════════════════════════════
   ADMIN: POST /api/certificates/:id/reissue
   Creates a NEW certificate for the same student+course
   (old one stays revoked for history)
   ═══════════════════════════════════════════════════════════ */
router.post('/:id/reissue', requireAdmin, asyncHandler(async (req, res) => {
    // Find the old certificate to copy student + course from
    const old = await db.query(
        `SELECT * FROM certificates WHERE id = $1`,
        [req.params.id]
    );
    if (!old.rows.length) return res.status(404).json({ error: 'Certificate not found' });
    const o = old.rows[0];

    // Reuse the issue endpoint's logic — generate new ID + token
    const prefix = 'RE';  // "Reissue" prefix
    const year = new Date().getFullYear();
    const seqRow = await db.query(
        `SELECT COUNT(*)::int AS c FROM certificates
         WHERE certificate_id LIKE $1`,
        [`NXA-${prefix}-${year}-%`]
    );
    const nextNum = String(seqRow.rows[0].c + 1).padStart(6, '0');
    const certificate_id = `NXA-${prefix}-${year}-${nextNum}`;

    const crypto = require('crypto');
    const verification_token = crypto.randomBytes(16).toString('hex');

    const ins = await db.query(
        `INSERT INTO certificates
            (certificate_id, verification_token, user_id, course_id,
             student_name, course_name, course_duration, grade, issued_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
            certificate_id,
            verification_token,
            o.user_id,
            o.course_id,
            o.student_name,
            o.course_name,
            o.course_duration,
            o.grade || 'Pass',
            req.user.user_id || req.user.id,
        ]
    );

    const cert = ins.rows[0];
const verifyUrl = `https://nexora-certificates.vercel.app/#verify/${certificate_id}`;

// Look up the student's email (the old cert doesn't carry it)
try {
    const stu = await db.query(`SELECT email, full_name FROM users WHERE id = $1`, [o.user_id]);
    if (stu.rows.length) {
        await sendCertificateEmail({
            to: stu.rows[0].email,
            studentName: stu.rows[0].full_name,
            certificateId: certificate_id,
            courseName: o.course_name,
            certificateType: cert.certificate_type,
            issuedDate: cert.issued_date,
            verifyUrl,
        });
    }
} catch (mailErr) {
    console.error('[email] Reissue email failed:', mailErr.message);
}

res.status(201).json({
    certificate: cert,
    replaces: o.certificate_id,
    verify_url: verifyUrl,
    email_sent: mailer ? true : false,
});
}));

module.exports = router;
