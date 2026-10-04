// routes/paypal.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../utils');

// ─────────────────────────────────────────────────────────────
// PAYPAL CONFIG
// ─────────────────────────────────────────────────────────────
const PAYPAL_API_BASE = process.env.PAYPAL_API_BASE || 'https://api-m.paypal.com';
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;

const ACTIVATION_FEE = 0.75;

// Get a PayPal access token
async function getPayPalAccessToken() {
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

// ─────────────────────────────────────────────────────────────
// COURSE PAYMENT ROUTES (existing)
// ─────────────────────────────────────────────────────────────

// POST /api/paypal/create-order
// Body: { course_id, amount }
router.post('/create-order', asyncHandler(async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

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
                    description: `Nexora Academy - Course Payment`,
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
        res.status(500).json({ error: 'Could not create PayPal order' });
    }
}));

// POST /api/paypal/capture-order/:orderId
// Captures the order and records the payment against the course
router.post('/capture-order/:orderId', asyncHandler(async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const { orderId } = req.params;

    try {
        const accessToken = await getPayPalAccessToken();

        // Capture
        const captureRes = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
        });
        const captureData = await captureRes.json();
        if (!captureRes.ok) {
            console.error('[paypal capture-order]', captureData);
            throw new Error(captureData.message || 'Capture failed');
        }
        if (captureData.status !== 'COMPLETED') {
            throw new Error('Payment not completed');
        }

        // Extract custom_id: "course:COURSE_ID:USER_ID"
        const customId = captureData.purchase_units?.[0]?.payments?.captures?.[0]?.custom_id
            || captureData.purchase_units?.[0]?.custom_id
            || '';
        const parts = customId.split(':');
        const courseId = parts[0] === 'course' ? parts[1] : null;
        const paidAmount = parseFloat(captureData.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value || '0');

        if (!courseId || !paidAmount) {
            throw new Error('Could not determine course or amount');
        }

        // Record the payment
        await db.query(
            `INSERT INTO payments
               (user_id, course_id, amount, payment_type, payment_method, status, transaction_id, created_at)
             VALUES ($1, $2, $3, 'COURSE_PAYMENT', 'paypal', 'completed', $4, NOW())`,
            [req.user.id, courseId, paidAmount, orderId]
        );

        // Update enrollment's paid amount
        await db.query(
            `UPDATE enrollments
             SET total_course_paid = COALESCE(total_course_paid, 0) + $1
             WHERE user_id = $2 AND course_id = $3`,
            [paidAmount, req.user.id, courseId]
        );

        // Calculate new balances
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
            balances: {
                remaining_balance: remaining,
                payment_percentage: pct,
                total_paid: totalPaid,
            },
        });
    } catch (err) {
        console.error('[paypal capture-order]', err.message);
        res.status(500).json({ error: 'Could not capture PayPal payment' });
    }
}));

// ─────────────────────────────────────────────────────────────
// ADMISSION FEE ROUTES (new)
// ─────────────────────────────────────────────────────────────

// POST /api/paypal/create-activation-order
// Creates a PayPal order for the $0.75 admission fee
router.post('/create-activation-order', asyncHandler(async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
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
                    amount: { currency_code: 'USD', value: ACTIVATION_FEE.toFixed(2) },
                    description: 'Nexora Academy - Admission Fee',
                    custom_id: `activation:${req.user.id}`,
                }],
            }),
        });
        const orderData = await orderRes.json();
        if (!orderRes.ok) {
            console.error('[paypal create-activation-order]', orderData);
            throw new Error(orderData.message || 'Order creation failed');
        }

        res.json({ id: orderData.id });
    } catch (err) {
        console.error('[paypal create-activation-order]', err.message);
        res.status(500).json({ error: 'Could not create PayPal order' });
    }
}));

// POST /api/paypal/capture-activation-order/:orderId
// Captures the admission fee payment and marks the user as paid
router.post('/capture-activation-order/:orderId', asyncHandler(async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

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
        if (!captureRes.ok) {
            console.error('[paypal capture-activation-order]', captureData);
            throw new Error(captureData.message || 'Capture failed');
        }
        if (captureData.status !== 'COMPLETED') {
            throw new Error('Payment not completed');
        }

        // Record the activation fee payment
        await db.query(
            `INSERT INTO payments
               (user_id, amount, payment_type, payment_method, status, transaction_id, created_at)
             VALUES ($1, $2, 'ACTIVATION_FEE', 'paypal', 'completed', $3, NOW())`,
            [req.user.id, ACTIVATION_FEE, orderId]
        );

        // Mark user as paid
        await db.query(
            `UPDATE users SET activation_fee_paid = TRUE WHERE id = $1`,
            [req.user.id]
        );

        // Update any pending application for this user
        await db.query(
            `UPDATE applications
             SET payment_status = 'paid', status = 'paid'
             WHERE user_id = $1 AND payment_status = 'unpaid'`,
            [req.user.id]
        );

        res.json({ ok: true, amount: ACTIVATION_FEE });
    } catch (err) {
        console.error('[paypal capture-activation-order]', err.message);
        res.status(500).json({ error: 'Could not capture PayPal payment' });
    }
}));

module.exports = router;
