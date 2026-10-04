// backend/src/routes/paypal.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../utils');
const { requireAuth } = require('../middleware');

const PAYPAL_API = process.env.PAYPAL_ENV === 'production'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

/* ═══════════════════════════════════════════════════════════
   Helper: get PayPal OAuth access token
   ═══════════════════════════════════════════════════════════ */
async function getPayPalAccessToken() {
    const auth = Buffer.from(
        `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
    ).toString('base64');

    const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`PayPal auth failed: ${err}`);
    }
    const data = await res.json();
    return data.access_token;
}

/* ═══════════════════════════════════════════════════════════
   POST /api/paypal/create-order
   ═══════════════════════════════════════════════════════════ */
router.post('/create-order', requireAuth, asyncHandler(async (req, res) => {
    const userId = req.user.user_id || req.user.id;
    const { course_id, amount } = req.body;

    if (!course_id) return res.status(400).json({ error: 'course_id required' });

    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const courseRes = await db.query(
        `SELECT c.id, c.title, c.price FROM courses c WHERE c.id = $1`,
        [course_id]
    );
    if (!courseRes.rows.length) return res.status(404).json({ error: 'Course not found' });
    const course = courseRes.rows[0];

    const paidRes = await db.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS paid
         FROM transactions
         WHERE user_id = $1 AND course_id = $2
           AND payment_type = 'COURSE_PAYMENT'
           AND status = 'completed'`,
        [userId, course_id]
    );
    const alreadyPaid = parseFloat(paidRes.rows[0].paid || 0);
    const remaining = Math.max(0, parseFloat(course.price) - alreadyPaid);

    if (remaining <= 0) return res.status(400).json({ error: 'Course already fully paid' });
    if (amt > remaining + 0.01) return res.status(400).json({ error: `Amount exceeds remaining ($${remaining.toFixed(2)})` });

    const accessToken = await getPayPalAccessToken();
    const orderRes = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            intent: 'CAPTURE',
            purchase_units: [{
                amount: { currency_code: 'USD', value: amt.toFixed(2) },
                description: `Nexora Academy — ${course.title}`,
                custom_id: `${userId}|${course_id}`,
            }],
            application_context: {
                brand_name: 'Nexora Academy',
                landing_page: 'NO_PREFERENCE',
                user_action: 'PAY_NOW',
                return_url: 'https://nexora-e-academy.vercel.app/#payment-success',
                cancel_url: 'https://nexora-e-academy.vercel.app/#payment-cancelled',
            },
        }),
    });

    if (!orderRes.ok) {
        const err = await orderRes.text();
        console.error('[paypal:create-order]', err);
        return res.status(500).json({ error: 'Failed to create PayPal order' });
    }

    const order = await orderRes.json();
    res.json({ id: order.id, amount: amt, remaining });
}));

// ─────────────────────────────────────────────
// POST /api/paypal/webhook
// PayPal sends payment events here.
// ─────────────────────────────────────────────
router.post('/webhook', express.raw({ type: 'application/json' }), asyncHandler(async (req, res) => {
    // Respond 200 immediately so PayPal doesn't retry
    res.status(200).send('OK');

    try {
        // Parse the body — comes as a Buffer because we used express.raw
        let event;
        try {
            event = JSON.parse(req.body.toString('utf8'));
        } catch (e) {
            console.warn('[paypal-webhook] Invalid JSON body');
            return;
        }

        const eventType = event.event_type;
        console.log('[paypal-webhook] Received event:', eventType);

        // Handle the events you care about
        if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
            const resource = event.resource || {};
            const captureId = resource.id;
            const amount = parseFloat(resource.amount?.value || '0');
            const customId = resource.custom_id || '';
            const orderId = resource.supplementary_data?.related_ids?.order_id || null;

            console.log(`[paypal-webhook] Payment captured: ${captureId} · $${amount} · custom=${customId}`);

            // Parse custom_id: "activation:USER_ID" or "course:COURSE_ID:USER_ID"
            const parts = String(customId).split(':');

            if (parts[0] === 'activation' && parts[1]) {
                const userId = parts[1];
                // Record activation fee payment if not already
                const existing = await db.query(
                    `SELECT id FROM payments WHERE transaction_id = $1 AND payment_type = 'ACTIVATION_FEE'`,
                    [captureId]
                );
                if (!existing.rows.length) {
                    await db.query(
                        `INSERT INTO payments
                           (user_id, amount, payment_type, payment_method, status, transaction_id, created_at)
                         VALUES ($1, $2, 'ACTIVATION_FEE', 'paypal', 'completed', $3, NOW())`,
                        [userId, amount, captureId]
                    );
                    await db.query(
                        `UPDATE users SET activation_fee_paid = TRUE WHERE id = $1`,
                        [userId]
                    );
                    await db.query(
                        `UPDATE applications
                         SET payment_status = 'paid', status = 'paid'
                         WHERE user_id = $1 AND payment_status = 'unpaid'`,
                        [userId]
                    );
                    console.log('[paypal-webhook] ✅ Activation fee recorded for user', userId);
                }
            } else if (parts[0] === 'course' && parts[1] && parts[2]) {
                const courseId = parts[1];
                const userId = parts[2];
                const existing = await db.query(
                    `SELECT id FROM payments WHERE transaction_id = $1 AND payment_type = 'COURSE_PAYMENT'`,
                    [captureId]
                );
                if (!existing.rows.length) {
                    await db.query(
                        `INSERT INTO payments
                           (user_id, course_id, amount, payment_type, payment_method, status, transaction_id, created_at)
                         VALUES ($1, $2, $3, 'COURSE_PAYMENT', 'paypal', 'completed', $4, NOW())`,
                        [userId, courseId, amount, captureId]
                    );
                    await db.query(
                        `UPDATE enrollments
                         SET total_course_paid = COALESCE(total_course_paid, 0) + $1
                         WHERE user_id = $2 AND course_id = $3`,
                        [amount, userId, courseId]
                    );
                    console.log('[paypal-webhook] ✅ Course payment recorded for user', userId, 'course', courseId);
                }
            }
        } else if (eventType === 'PAYMENT.CAPTURE.DENIED' || eventType === 'PAYMENT.CAPTURE.REFUNDED') {
            const resource = event.resource || {};
            const captureId = resource.id;
            console.log(`[paypal-webhook] Payment ${eventType}: ${captureId}`);
            await db.query(
                `UPDATE payments SET status = $1 WHERE transaction_id = $2`,
                [eventType === 'PAYMENT.CAPTURE.REFUNDED' ? 'refunded' : 'failed', captureId]
            );
        } else {
            console.log('[paypal-webhook] Unhandled event type:', eventType);
        }
    } catch (err) {
        console.error('[paypal-webhook] Handler error:', err.message);
    }
}));

module.exports = router;
