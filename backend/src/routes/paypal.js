// routes/paypal.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../utils');
const { requireAuth } = require('../middleware');

// ─────────────────────────────────────────────
// PAYPAL CONFIG
// ─────────────────────────────────────────────
const PAYPAL_API_BASE = process.env.PAYPAL_API_BASE || 'https://api-m.paypal.com';
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const ACTIVATION_FEE = 0.75;

async function getPayPalAccessToken() {
    if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
        throw new Error('PayPal credentials not configured');
    }
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
    const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || 'PayPal auth failed');
    return data.access_token;
}

// ─────────────────────────────────────────────
// COURSE PAYMENT
// ─────────────────────────────────────────────

router.post('/create-order', requireAuth, asyncHandler(async (req, res) => {
    const { course_id, amount } = req.body || {};
    if (!course_id || !amount) {
        return res.status(400).json({ error: 'Missing course_id or amount' });
    }

    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) {
        return res.status(400).json({ error: 'Invalid amount' });
    }

    try {
        const accessToken = await getPayPalAccessToken();
        const orderRes = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                intent: 'CAPTURE',
                purchase_units: [{
                    amount: { currency_code: 'USD', value: amt.toFixed(2) },
                    description: 'Nexora Academy - Course Payment',
                    custom_id: `course:${course_id}:${req.user.id}`,
                }],
            }),
        });
        const orderData = await orderRes.json();
        if (!orderRes.ok) {
            console.error('[paypal create-order]', orderData);
            throw new Error(orderData.message || 'Order creation failed');
        }
        res.json({ id: orderData.id });
    } catch (err) {
        console.error('[paypal create-order]', err.message);
        res.status(500).json({ error: 'Could not create PayPal order: ' + err.message });
    }
}));

router.post('/capture-order/:orderId', requireAuth, asyncHandler(async (req, res) => {
    const { orderId } = req.params;

    try {
        const accessToken = await getPayPalAccessToken();
        const captureRes = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
        });
        const captureData = await captureRes.json();
        if (!captureRes.ok) throw new Error(captureData.message || 'Capture failed');
        if (captureData.status !== 'COMPLETED') throw new Error('Payment not completed');

        const customId = captureData.purchase_units?.[0]?.payments?.captures?.[0]?.custom_id
            || captureData.purchase_units?.[0]?.custom_id || '';
        const parts = String(customId).split(':');
        const courseId = parts[0] === 'course' ? parts[1] : null;
        const paidAmount = parseFloat(captureData.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value || '0');

        if (!courseId || !paidAmount) throw new Error('Could not determine course or amount');

        await db.query(
            `INSERT INTO payments
               (user_id, course_id, amount, payment_type, payment_method, status, transaction_id, created_at)
             VALUES ($1, $2, $3, 'COURSE_PAYMENT', 'paypal', 'completed', $4, NOW())`,
            [req.user.id, courseId, paidAmount, orderId]
        );

        await db.query(
            `UPDATE enrollments SET total_course_paid = COALESCE(total_course_paid, 0) + $1
             WHERE user_id = $2 AND course_id = $3`,
            [paidAmount, req.user.id, courseId]
        );

        const courseRes = await db.query('SELECT price FROM courses WHERE id = $1', [courseId]);
        const coursePrice = parseFloat(courseRes.rows[0]?.price || 0);
        const enrollRes = await db.query(
            `SELECT total_course_paid FROM enrollments WHERE user_id = $1 AND course_id = $2`,
            [req.user.id, courseId]
        );
        const totalPaid = parseFloat(enrollRes.rows[0]?.total_course_paid || 0);
        const remaining = Math.max(coursePrice - totalPaid, 0);
        const pct = coursePrice > 0 ? Math.min((totalPaid / coursePrice) * 100, 100) : 100;

        res.json({
            ok: true,
            amount: paidAmount,
            balances: { remaining_balance: remaining, payment_percentage: pct, total_paid: totalPaid },
        });
    } catch (err) {
        console.error('[paypal capture-order]', err.message);
        res.status(500).json({ error: 'Could not capture PayPal payment: ' + err.message });
    }
}));

// ─────────────────────────────────────────────
// ADMISSION FEE
// ─────────────────────────────────────────────

router.post('/create-activation-order', requireAuth, asyncHandler(async (req, res) => {
    try {
        const accessToken = await getPayPalAccessToken();
        const orderRes = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                intent: 'CAPTURE',
                purchase_units: [{
                    amount: { currency_code: 'USD', value: ACTIVATION_FEE.toFixed(2) },
                    description: 'Nexora Academy - Admission Fee',
                    custom_id: `activation:${req.user.id}`,
                }],
            }),
        });
        const orderData = await orderRes.json();
        if (!orderRes.ok) throw new Error(orderData.message || 'Order creation failed');
        res.json({ id: orderData.id });
    } catch (err) {
        console.error('[paypal create-activation-order]', err.message);
        res.status(500).json({ error: 'Could not create PayPal order: ' + err.message });
    }
}));

router.post('/capture-activation-order/:orderId', requireAuth, asyncHandler(async (req, res) => {
    const { orderId } = req.params;

    try {
        const accessToken = await getPayPalAccessToken();
        const captureRes = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
        });
        const captureData = await captureRes.json();
        if (!captureRes.ok) throw new Error(captureData.message || 'Capture failed');
        if (captureData.status !== 'COMPLETED') throw new Error('Payment not completed');

        await db.query(
            `INSERT INTO payments
               (user_id, amount, payment_type, payment_method, status, transaction_id, created_at)
             VALUES ($1, $2, 'ACTIVATION_FEE', 'paypal', 'completed', $3, NOW())`,
            [req.user.id, ACTIVATION_FEE, orderId]
        );
        await db.query(`UPDATE users SET activation_fee_paid = TRUE WHERE id = $1`, [req.user.id]);
        await db.query(
            `UPDATE applications SET payment_status = 'paid', status = 'paid'
             WHERE user_id = $1 AND payment_status = 'unpaid'`,
            [req.user.id]
        );

        res.json({ ok: true, amount: ACTIVATION_FEE });
    } catch (err) {
        console.error('[paypal capture-activation-order]', err.message);
        res.status(500).json({ error: 'Could not capture PayPal payment: ' + err.message });
    }
}));

// ─────────────────────────────────────────────
// WEBHOOK (no auth — PayPal calls this directly)
// ─────────────────────────────────────────────

router.post('/webhook', asyncHandler(async (req, res) => {
    res.status(200).send('OK');
    try {
        let event = req.body;
        if (Buffer.isBuffer(event)) event = JSON.parse(event.toString('utf8'));
        else if (typeof event === 'string') event = JSON.parse(event);

        const eventType = event.event_type;
        console.log('[paypal-webhook] Event:', eventType);

        if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
            const resource = event.resource || {};
            const captureId = resource.id;
            const amount = parseFloat(resource.amount?.value || '0');
            const parts = String(resource.custom_id || '').split(':');

            if (parts[0] === 'activation' && parts[1]) {
                const userId = parts[1];
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
                    await db.query(`UPDATE users SET activation_fee_paid = TRUE WHERE id = $1`, [userId]);
                    await db.query(
                        `UPDATE applications SET payment_status = 'paid', status = 'paid'
                         WHERE user_id = $1 AND payment_status = 'unpaid'`,
                        [userId]
                    );
                    console.log('[paypal-webhook] ✅ Activation fee recorded');
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
                        `UPDATE enrollments SET total_course_paid = COALESCE(total_course_paid, 0) + $1
                         WHERE user_id = $2 AND course_id = $3`,
                        [amount, userId, courseId]
                    );
                    console.log('[paypal-webhook] ✅ Course payment recorded');
                }
            }
        }
    } catch (err) {
        console.error('[paypal-webhook]', err.message);
    }
}));

module.exports = router;
