// POST /api/paypal/create-activation-order
router.post('/create-activation-order', asyncHandler(async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const ACTIVATION_FEE = 0.75;

    try {
        const auth = Buffer.from(
            `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
        ).toString('base64');

        const tokenRes = await fetch(`${process.env.PAYPAL_API_BASE}/v1/oauth2/token`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: 'grant_type=client_credentials',
        });
        const tokenData = await tokenRes.json();
        if (!tokenRes.ok) throw new Error('PayPal auth failed');

        const orderRes = await fetch(`${process.env.PAYPAL_API_BASE}/v2/checkout/orders`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
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
        console.error('[paypal-activation]', err.message);
        res.status(500).json({ error: 'Could not create PayPal order' });
    }
}));

// POST /api/paypal/capture-activation-order/:orderId
router.post('/capture-activation-order/:orderId', asyncHandler(async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const { orderId } = req.params;
    const ACTIVATION_FEE = 0.75;

    try {
        const auth = Buffer.from(
            `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
        ).toString('base64');

        const tokenRes = await fetch(`${process.env.PAYPAL_API_BASE}/v1/oauth2/token`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: 'grant_type=client_credentials',
        });
        const tokenData = await tokenRes.json();
        if (!tokenRes.ok) throw new Error('PayPal auth failed');

        const captureRes = await fetch(`${process.env.PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'Content-Type': 'application/json',
            },
        });
        const captureData = await captureRes.json();
        if (!captureRes.ok) throw new Error(captureData.message || 'Capture failed');
        if (captureData.status !== 'COMPLETED') throw new Error('Payment not completed');

        // Record the payment
        await db.query(
            `INSERT INTO payments
               (user_id, amount, payment_type, payment_method, status,
                transaction_id, created_at)
             VALUES ($1, $2, 'ACTIVATION_FEE', 'paypal', 'completed', $3, NOW())`,
            [req.user.id, ACTIVATION_FEE, orderId]
        );

        await db.query(
            `UPDATE users SET activation_fee_paid = TRUE WHERE id = $1`,
            [req.user.id]
        );

        res.json({ ok: true, amount: ACTIVATION_FEE });
    } catch (err) {
        console.error('[paypal-activation-capture]', err.message);
        res.status(500).json({ error: 'Could not capture PayPal payment' });
    }
}));
