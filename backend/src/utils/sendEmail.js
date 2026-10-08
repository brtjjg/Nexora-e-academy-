// src/utils/sendEmail.js
// ═══════════════════════════════════════════════════════════
// Brevo REST API email sender
// Uses HTTPS (port 443) — never blocked by cloud providers
// No IP whitelisting needed
// ═══════════════════════════════════════════════════════════

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

/**
 * Send a transactional email via Brevo API
 * @param {Object} opts
 * @param {string} opts.to        - Recipient email (e.g., student@example.com)
 * @param {string} [opts.toName]  - Recipient name
 * @param {string} opts.subject   - Email subject
 * @param {string} opts.html      - HTML body
 * @param {string} [opts.text]    - Plain-text fallback (optional)
 */
async function sendEmail({ to, toName, subject, html, text }) {
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.BREVO_SENDER_EMAIL || 'nexoraacademyhelpdesk@gmail.com';
    const senderName = process.env.BREVO_SENDER_NAME || 'Nexora Academy';

    if (!apiKey) {
        console.warn('[sendEmail] BREVO_API_KEY not set — email skipped →', to);
        return { skipped: true };
    }
    if (!to || !subject || !html) {
        console.warn('[sendEmail] Missing required fields — skipped');
        return { skipped: true };
    }

    const payload = {
        sender: { name: senderName, email: senderEmail },
        to: [{ email: to, name: toName || to }],
        subject,
        htmlContent: html,
    };
    if (text) payload.textContent = text;

    try {
        const res = await fetch(BREVO_API_URL, {
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'api-key': apiKey,
                'content-type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
            console.error('[sendEmail] Brevo API error:', res.status, data);
            throw new Error(data.message || `Brevo API HTTP ${res.status}`);
        }

        console.log('[sendEmail] ✅ Sent to', to, '— messageId:', data.messageId || '(none)');
        return { sent: true, messageId: data.messageId, response: data };
    } catch (err) {
        console.error('[sendEmail] Failed:', err.message);
        throw err;
    }
}

module.exports = { sendEmail };
