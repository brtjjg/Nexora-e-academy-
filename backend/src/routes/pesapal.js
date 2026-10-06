// routes/pesapal.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../utils');
const { requireAuth } = require('../middleware');

// ─────────────────────────────────────────────
// PESAPAL CONFIG
// ─────────────────────────────────────────────
const PESAPAL_API_BASE = process.env.PESAPAL_API_BASE || 'https://pay.pesapal.com/v3';
const PESAPAL_CONSUMER_KEY = process.env.PESAPAL_CONSUMER_KEY;
const PESAPAL_CONSUMER_SECRET = process.env.PESAPAL_CONSUMER_SECRET;
const PESAPAL_IPN_ID = process.env.PESAPAL_IPN_ID;
const PESAPAL_CALLBACK_URL = process.env.PESAPAL_CALLBACK_URL || 'https://nexora-e-academy.vercel.app/';
const ACTIVATION_FEE = 0.75;

// ─────────────────────────────────────────────
// STEP 1 — Get bearer token from Pesapal
// ─────────────────────────────────────────────
async function getPesapalAccessToken() {
    if (!PESAPAL_CONSUMER_KEY || !PESAPAL_CONSUMER_SECRET) {
        throw new Error('Pesapal credentials not configured');
    }

    const res = await fetch(`${PESAPAL_API_BASE}/api/Auth/RequestToken`, {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            consumer_key: PESAPAL_CONSUMER_KEY,
            consumer_secret: PESAPAL_CONSUMER_SECRET,
        }),
    });

    const data = await res.json();
    if (!res.ok || !data.token) {
        console.error('[pesapal] Token error:', data);
        throw new Error(data.message || data.error?.message || 'Pesapal auth failed');
    }
    return data.token;
}

// ─────────────────────────────────────────────
// STEP 2 — Submit order to Pesapal
// Returns { order_tracking_id, redirect_url }
// ─────────────────────────────────────────────
async function submitPesapalOrder({ merchantRef, amount, description, currency, user }) {
    const token = await getPesapalAccessToken();

    const payload = {
        id: merchantRef,
        currency: currency || 'USD',
        amount: parseFloat(amount),
        description: String(description).substring(0, 100),
        callback_url: PESAPAL_CALLBACK_URL,
        notification_id: PESAPAL_IPN_ID,
        redirect_mode: '',
        branch: 'Nexora Academy',
        billing_address: {
            email_address: user.email || '',
            phone_number: user.phone || '',
            country_code: (user.country || 'KE').substring(0, 2).toUpperCase(),
            first_name: (user.full_name || '').split(' ')[0] || 'Student',
            middle_name: '',
            last_name: (user.full_name || '').split(' ').slice(1).join(' ') || '',
            line_1: '',
            line_2: '',
            city: '',
            state: '',
            postal_code: '',
            zip_code: '',
        },
    };

    const res = await fetch(`${PESAPAL_API_BASE}/api/Transactions/SubmitOrderRequest`, {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok || !data.redirect_url) {
        console.error('[pesapal] Submit error:', data);
        throw new Error(data.message || data.error?.message || 'Pesapal order submission failed');
    }
    return data;
}

// ─────────────────────────────────────────────
// STEP 3 — Get transaction status from Pesapal
// This is the ONLY trustworthy source of payment status
// ─────────────────────────────────────────────
async function getPesapalTransactionStatus(orderTrackingId) {
    const token = await getPesapalAccessToken();

    const res = await fetch(
        `${PESAPAL_API_BASE}/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(orderTrackingId)}`,
        {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
        }
    );

    const data = await res.json();
    if (!res.ok) {
        console.error('[pesapal] Status error:', data);
        throw new Error(data.message || 'Could not fetch transaction status');
    }
    return data;
}

// ─────────────────────────────────────────────
// Helper — generate a unique merchant reference
// Only alphanumeric, dashes, underscores, dots, colons
// Max 50 characters
// ─────────────────────────────────────────────
function generateMerchantRef(prefix) {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `${prefix}-${timestamp}-${random}`.toUpperCase().substring(0, 50);
}

// ─────────────────────────────────────────────
// POST /api/pesapal/create-activation-order
// Creates a Pesapal order for the $0.75 admission fee
// ─────────────────────────────────────────────
router.post('/create-activation-order', requireAuth, asyncHandler(async (req, res) => {
    try {
        const userRes = await db.query(
            `SELECT id, email, full_name, phone, country FROM users WHERE id = $1`,
            [req.user.id]
        );
        if (!userRes.rows.length) {
            return res.status(404).json({ error: 'User not found' });
        }
        const user = userRes.rows[0];

        const merchantRef = generateMerchantRef('NXA-ACT');

        const result = await submitPesapalOrder({
            merchantRef,
            amount: ACTIVATION_FEE,
            description: 'Nexora Academy - Admission Fee',
            currency: 'USD',
            user,
        });

        // Save pending transaction for verification
        // NOTE: $4 and $5 are used to avoid PostgreSQL "inconsistent types" error
        // when the same value goes into two columns with different types.
        await db.query(
            `INSERT INTO transactions
               (user_id, amount, currency, payment_type, payment_method, status,
                transaction_id, merchant_reference, external_reference, created_at, updated_at)
             VALUES ($1, $2, 'USD', 'ACTIVATION_FEE', 'pesapal', 'pending',
                     $3, $4, $5, NOW(), NOW())`,
            [req.user.id, ACTIVATION_FEE, result.order_tracking_id, merchantRef, merchantRef]
        );

        res.json({
            redirect_url: result.redirect_url,
            order_tracking_id: result.order_tracking_id,
            merchant_reference: merchantRef,
        });
    } catch (err) {
        console.error('[pesapal] create-activation-order:', err.message);
        res.status(500).json({ error: 'Could not create Pesapal order: ' + err.message });
    }
}));

// ─────────────────────────────────────────────
// POST /api/pesapal/create-order
// Creates a Pesapal order for a course payment
// Body: { course_id, amount }
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
        const userRes = await db.query(
            `SELECT id, email, full_name, phone, country FROM users WHERE id = $1`,
            [req.user.id]
        );
        if (!userRes.rows.length) {
            return res.status(404).json({ error: 'User not found' });
        }
        const user = userRes.rows[0];

        const merchantRef = generateMerchantRef('NXA-CRS');

        const result = await submitPesapalOrder({
            merchantRef,
            amount: amt,
            description: 'Nexora Academy - Course Payment',
            currency: 'USD',
            user,
        });

        // NOTE: $5 and $6 are separate parameters to avoid "inconsistent types" error
        await db.query(
            `INSERT INTO transactions
               (user_id, course_id, amount, currency, payment_type, payment_method, status,
                transaction_id, merchant_reference, external_reference, created_at, updated_at)
             VALUES ($1, $2, $3, 'USD', 'COURSE_PAYMENT', 'pesapal', 'pending',
                     $4, $5, $6, NOW(), NOW())`,
            [req.user.id, course_id, amt, result.order_tracking_id, merchantRef, merchantRef]
        );

        res.json({
            redirect_url: result.redirect_url,
            order_tracking_id: result.order_tracking_id,
            merchant_reference: merchantRef,
        });
    } catch (err) {
        console.error('[pesapal] create-order:', err.message);
        res.status(500).json({ error: 'Could not create Pesapal order: ' + err.message });
    }
}));

// ─────────────────────────────────────────────
// POST/GET /api/pesapal/ipn
// Pesapal notification webhook
// IMPORTANT: The IPN only sends an OrderTrackingId, never the status.
// We must call GetTransactionStatus to find the real status.
// ─────────────────────────────────────────────
router.all('/ipn', asyncHandler(async (req, res) => {
    // Respond 200 immediately so Pesapal doesn't retry
    res.status(200).json({ ok: true });

    try {
        const orderTrackingId = req.body?.OrderTrackingId || req.query?.OrderTrackingId;
        const merchantRef = req.body?.OrderMerchantReference || req.query?.OrderMerchantReference;
        const notificationType = req.body?.OrderNotificationType || req.query?.OrderNotificationType;

        console.log('[pesapal-ipn] Received:', { orderTrackingId, merchantRef, notificationType });

        if (!orderTrackingId) {
            console.warn('[pesapal-ipn] Missing OrderTrackingId');
            return;
        }

        // THE critical call — ask Pesapal what actually happened
        const statusData = await getPesapalTransactionStatus(orderTrackingId);
        const status = (statusData.payment_status_description || '').toUpperCase();

        console.log('[pesapal-ipn] Status:', status);

        // Find our transaction
        const txRes = await db.query(
            `SELECT id, user_id, course_id, payment_type, amount, status
             FROM transactions
             WHERE transaction_id = $1
             LIMIT 1`,
            [orderTrackingId]
        );

        if (!txRes.rows.length) {
            console.warn('[pesapal-ipn] Transaction not found:', orderTrackingId);
            return;
        }

        const tx = txRes.rows[0];

        if (status === 'COMPLETED') {
            // Idempotency — skip if already processed
            if (tx.status === 'completed') {
                console.log('[pesapal-ipn] Already completed, skipping');
                return;
            }

            await db.query(
                `UPDATE transactions
                 SET status = 'completed', verified_at = NOW(), updated_at = NOW()
                 WHERE id = $1`,
                [tx.id]
            );

            if (tx.payment_type === 'ACTIVATION_FEE') {
                await db.query(
                    `UPDATE users SET activation_fee_paid = TRUE WHERE id = $1`,
                    [tx.user_id]
                );
                await db.query(
                    `UPDATE applications
                     SET payment_status = 'paid', status = 'paid'
                     WHERE user_id = $1 AND payment_status = 'unpaid'`,
                    [tx.user_id]
                );
                console.log('[pesapal-ipn] ✅ Activation fee confirmed for user', tx.user_id);
            } else if (tx.payment_type === 'COURSE_PAYMENT' && tx.course_id) {
                await db.query(
                    `UPDATE enrollments
                     SET total_course_paid = COALESCE(total_course_paid, 0) + $1
                     WHERE user_id = $2 AND course_id = $3`,
                    [tx.amount, tx.user_id, tx.course_id]
                );
                console.log('[pesapal-ipn] ✅ Course payment confirmed for user', tx.user_id);
            }
        } else if (status === 'FAILED' || status === 'REVERSED' || status === 'INVALID') {
            await db.query(
                `UPDATE transactions SET status = 'failed', updated_at = NOW() WHERE id = $1`,
                [tx.id]
            );
            console.log('[pesapal-ipn] ❌ Payment failed:', status);
        } else {
            console.log('[pesapal-ipn] Pending status:', status);
        }
    } catch (err) {
        console.error('[pesapal-ipn] Handler error:', err.message);
    }
}));

// ─────────────────────────────────────────────
// GET /api/pesapal/verify/:orderTrackingId
// Frontend calls this when the student lands on the callback page
// ─────────────────────────────────────────────
router.get('/verify/:orderTrackingId', asyncHandler(async (req, res) => {
    const { orderTrackingId } = req.params;
    try {
        const statusData = await getPesapalTransactionStatus(orderTrackingId);
        res.json({
            status: statusData.payment_status_description || 'PENDING',
            status_code: statusData.status_code,
            amount: statusData.amount,
            merchant_reference: statusData.merchant_reference,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}));

module.exports = router;
