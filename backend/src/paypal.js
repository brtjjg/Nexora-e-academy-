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
   Helper: get OAuth access token from PayPal
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

    // Verify course + remaining balance server-side
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

    // Create PayPal order
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

/* ═══════════════════════════════════════════════════════════
   POST /api/paypal/capture-order/:orderId
   ═══════════════════════════════════════════════════════════ */
router.post('/capture-order/:orderId', requireAuth, asyncHandler(async (req, res) => {
    const userId = req.user.user_id || req.user.id;
    const { orderId } = req.params;

    const accessToken = await getPayPalAccessToken();
    const captureRes = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
    });

    if (!captureRes.ok) {
        const err = await captureRes.text();
        console.error('[paypal:capture]', err);
        return res.status(500).json({ error: 'Failed to capture payment' });
    }

    const captureData = await captureRes.json();
    if (captureData.status !== 'COMPLETED') {
        return res.status(400).json({ error: 'Payment not completed', status: captureData.status });
    }

    const purchaseUnit = captureData.purchase_units[0];
    const capture = purchaseUnit.payments.captures[0];
    const customId = purchaseUnit.custom_id || capture.custom_id || '';
    const [storedUserId, courseId] = customId.split('|');

    if (storedUserId !== userId) {
        return res.status(403).json({ error: 'Order does not belong to this user' });
    }

    const amount = parseFloat(capture.amount.value);
    const paypalTxId = capture.id;
    const txId = 'PP-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    await db.query(
        `INSERT INTO transactions
            (transaction_id, user_id, course_id, payment_type,
             amount, currency, payment_method, status,
             provider, provider_reference, verified_at)
         VALUES ($1, $2, $3, 'COURSE_PAYMENT', $4, 'USD', 'paypal', 'completed',
                 'paypal', $5, NOW())`,
        [txId, userId, courseId, amount, paypalTxId]
    );

    console.log(`[paypal] ✓ Captured: ${txId} $${amount} for user ${userId}`);

    const balRes = await db.query(`
        SELECT
            c.price::numeric AS course_price,
            COALESCE(SUM(t.amount), 0)::numeric AS total_paid
        FROM enrollments e
        JOIN courses c ON c.id = e.course_id
        LEFT JOIN transactions t
            ON t.user_id = e.user_id
            AND t.course_id = e.course_id
            AND t.payment_type = 'COURSE_PAYMENT'
            AND t.status = 'completed'
        WHERE e.user_id = $1 AND e.course_id = $2
        GROUP BY c.price
    `, [userId, courseId]);

    const price = parseFloat(balRes.rows[0]?.course_price || 0);
    const paid = parseFloat(balRes.rows[0]?.total_paid || 0);
    const remaining = Math.max(price - paid, 0);
    const pct = price > 0 ? Math.min((paid / price) * 100, 100) : 100;

    res.json({
        ok: true,
        transaction_id: txId,
        paypal_tx_id: paypalTxId,
        amount,
        balances: { course_price: price, total_course_paid: paid, remaining_balance: remaining, payment_percentage: pct },
    });
}));

module.exports = router;
