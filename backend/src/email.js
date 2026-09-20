// backend/src/email.js
const nodemailer = require('nodemailer');

const PROVIDER = process.env.EMAIL_PROVIDER || 'gmail';
const FROM = process.env.EMAIL_FROM || 'Nexora Academy <nexo27716@gmail.com>';
const DRY_RUN = process.env.EMAIL_DRY_RUN === 'true';

let transporter = null;

function initTransport() {
    if (transporter) return transporter;
    if (PROVIDER === 'gmail') {
        transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
        });
    } else if (PROVIDER === 'sendgrid') {
        transporter = nodemailer.createTransport({
            host: 'smtp.sendgrid.net', port: 587,
            auth: { user: 'apikey', pass: process.env.SENDGRID_API_KEY },
        });
    } else if (PROVIDER === 'resend') {
        transporter = nodemailer.createTransport({
            host: 'smtp.resend.com', port: 465, secure: true,
            auth: { user: 'resend', pass: process.env.RESEND_API_KEY },
        });
    } else {
        console.warn('[email] Unknown provider:', PROVIDER);
    }
    return transporter;
}

async function sendEmail({ to, subject, html }) {
    if (DRY_RUN) {
        console.log('[email:DRY-RUN] Would send to', to, '|', subject);
        return { ok: true, dryRun: true };
    }
    const t = initTransport();
    if (!t) return { skipped: true };
    try {
        const info = await t.sendMail({
            from: FROM, to, subject,
            text: html.replace(/<[^>]+>/g, '').slice(0, 800),
            html,
        });
        console.log('[email] ✓', to, '-', subject);
        return { ok: true, messageId: info.messageId };
    } catch (err) {
        console.error('[email] ✗', to, '-', err.message);
        return { ok: false, error: err.message };
    }
}

function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function emailTemplate({ title, greeting, body, ctaText, ctaUrl, footer }) {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F5F7FA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#172B4D;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F7FA;padding:24px 0;"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFF;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(11,31,58,0.12);">
<tr><td style="background:#0B1F3A;padding:24px;border-bottom:3px solid #D4A63A;text-align:center;">
<div style="font-size:26px;font-weight:800;letter-spacing:1px;"><span style="color:#29A9E8;">NEXORA</span> <span style="color:#FFF;">ACADEMY</span></div>
<div style="font-size:10px;color:#D4A63A;letter-spacing:3px;margin-top:4px;">LEARN · GROW · ACHIEVE</div>
</td></tr>
<tr><td style="padding:32px 32px 24px;">
<h1 style="margin:0 0 16px;font-size:22px;color:#0B1F3A;">${title}</h1>
<p style="margin:0 0 16px;font-size:16px;line-height:1.6;">${greeting}</p>
<div style="font-size:15px;line-height:1.7;color:#334155;">${body}</div>
${ctaUrl ? `<div style="margin:28px 0 16px;text-align:center;"><a href="${ctaUrl}" style="display:inline-block;background:#29A9E8;color:#FFF;padding:14px 32px;border-radius:50px;text-decoration:none;font-weight:700;font-size:15px;">${ctaText}</a></div>` : ''}
</td></tr>
<tr><td style="background:#F5F7FA;padding:20px 32px;border-top:1px solid #E2E8F0;font-size:12px;color:#64748B;text-align:center;line-height:1.6;">
${footer || ''}
<div style="margin-top:8px;"><a href="https://nexora-e-academy.vercel.app" style="color:#29A9E8;text-decoration:none;">Visit Nexora Academy</a> &nbsp;·&nbsp; <a href="https://nexora-e-academy.vercel.app/#notifications" style="color:#94A3B8;">Manage notifications</a></div>
<div style="margin-top:8px;color:#94A3B8;">© 2026 Nexora Academy. All rights reserved.</div>
</td></tr>
</table></td></tr></table></body></html>`;
}

/* ---------- Ready-made notification templates ---------- */

async function sendGroupMessage({ to, recipientName, senderName, groupName, groupId, messagePreview }) {
    return sendEmail({
        to,
        subject: `💬 New message in "${groupName}" from ${senderName}`,
        html: emailTemplate({
            title: `New message in ${groupName}`,
            greeting: `Hi ${esc(recipientName || 'there')},`,
            body: `<p style="margin:0 0 12px;"><strong>${esc(senderName)}</strong> posted in <strong>${esc(groupName)}</strong>:</p>
                   <blockquote style="margin:12px 0;padding:12px 16px;background:#F5F7FA;border-left:4px solid #29A9E8;border-radius:8px;color:#334155;font-style:italic;">${esc(messagePreview.slice(0, 300))}${messagePreview.length > 300 ? '…' : ''}</blockquote>`,
            ctaText: 'Open Group Chat',
            ctaUrl: `https://nexora-e-academy.vercel.app/#group-${groupId}`,
            footer: `You're receiving this because you're a member of "${esc(groupName)}".`,
        }),
    });
}

async function sendNewGroupAnnouncement({ to, recipientName, groupName, groupId, category, description }) {
    return sendEmail({
        to,
        subject: `📢 New group: "${groupName}"`,
        html: emailTemplate({
            title: 'New group on Nexora Academy',
            greeting: `Hi ${esc(recipientName || 'there')},`,
            body: `<p style="margin:0 0 12px;">A new group has been created:</p>
                   <div style="background:#F5F7FA;padding:16px;border-radius:12px;border-left:4px solid #D4A63A;">
                     <div style="font-weight:700;color:#0B1F3A;font-size:17px;">${esc(groupName)}</div>
                     <div style="font-size:13px;color:#64748B;margin-top:4px;">Category: ${esc(category || 'General')}</div>
                     ${description ? `<div style="font-size:14px;color:#334155;margin-top:8px;">${esc(description.slice(0, 200))}</div>` : ''}
                   </div>`,
            ctaText: 'Join Group',
            ctaUrl: `https://nexora-e-academy.vercel.app/#group-${groupId}`,
        }),
    });
}

async function sendApplicationStatus({ to, recipientName, status, reason }) {
    const isApproved = status === 'approved';
    return sendEmail({
        to,
        subject: isApproved ? '🎉 Your Nexora Academy application is approved!' : '📋 Update on your Nexora Academy application',
        html: emailTemplate({
            title: isApproved ? 'Congratulations — you\'re in!' : 'Application update',
            greeting: `Hi ${esc(recipientName || 'there')},`,
            body: isApproved
                ? `<p style="margin:0 0 12px;">Your application has been <strong style="color:#16A34A;">approved</strong>. Welcome to Nexora Academy!</p>
                   <p style="margin:0;">You can now enroll in courses and start learning immediately.</p>`
                : `<p style="margin:0 0 12px;">Unfortunately your application was <strong style="color:#DC2626;">not approved</strong>.</p>
                   ${reason ? `<div style="background:#FEF2F2;padding:12px;border-radius:8px;border-left:4px solid #DC2626;color:#7F1D1D;">Reason: ${esc(reason)}</div>` : ''}`,
            ctaText: isApproved ? 'Go to Dashboard' : 'Contact Support',
            ctaUrl: isApproved ? 'https://nexora-e-academy.vercel.app' : 'mailto:nexo27716@gmail.com',
        }),
    });
}

async function sendPaymentConfirmation({ to, recipientName, amount, transactionId, description }) {
    return sendEmail({
        to,
        subject: `✅ Payment received: $${parseFloat(amount).toFixed(2)}`,
        html: emailTemplate({
            title: 'Payment confirmed',
            greeting: `Hi ${esc(recipientName || 'there')},`,
            body: `<p style="margin:0 0 12px;">We received your payment.</p>
                   <div style="background:#F0FDF4;padding:16px;border-radius:12px;border-left:4px solid #16A34A;">
                     <div style="font-size:26px;font-weight:800;color:#16A34A;">$${parseFloat(amount).toFixed(2)}</div>
                     <div style="font-size:13px;color:#334155;margin-top:4px;">${esc(description || 'Course payment')}</div>
                     <div style="font-size:12px;color:#64748B;margin-top:8px;">Transaction: ${esc(transactionId || '—')}</div>
                   </div>`,
            ctaText: 'View Wallet',
            ctaUrl: 'https://nexora-e-academy.vercel.app/#wallet',
        }),
    });
}

async function sendCertificateIssued({ to, recipientName, courseName, certificateId }) {
    return sendEmail({
        to,
        subject: `🎓 Certificate issued for "${courseName}"`,
        html: emailTemplate({
            title: 'Your certificate is ready!',
            greeting: `Hi ${esc(recipientName || 'there')},`,
            body: `<p style="margin:0 0 12px;">Congratulations on completing <strong>${esc(courseName)}</strong>!</p>
                   <div style="background:#FFFBEB;padding:16px;border-radius:12px;border-left:4px solid #D4A63A;">
                     <div style="font-weight:700;color:#0B1F3A;">Certificate ID</div>
                     <div style="font-size:15px;color:#334155;margin-top:4px;font-family:monospace;">${esc(certificateId)}</div>
                   </div>`,
            ctaText: 'View Certificate',
            ctaUrl: 'https://nexora-e-academy.vercel.app/#certificates',
        }),
    });
}

module.exports = {
    sendEmail,
    sendGroupMessage,
    sendNewGroupAnnouncement,
    sendApplicationStatus,
    sendPaymentConfirmation,
    sendCertificateIssued,
};
