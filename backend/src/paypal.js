const express = require('express');
const router = express.Router();
const { Client, Environment, LogLevel, OrdersController } = require('@paypal/paypal-server-sdk');
const { asyncHandler } = require('../utils');
const { requireAuth } = require('../middleware');
const db = require('../db');

// Initialize PayPal Client
const paypalClient = new Client({
    clientCredentialsAuthCredentials: {
        oAuthClientId: process.env.PAYPAL_CLIENT_ID,
        oAuthClientSecret: process.env.PAYPAL_CLIENT_SECRET,
    },
    environment: process.env.PAYPAL_ENV === 'production' ? Environment.Production : Environment.Sandbox,
    logging: { logLevel: LogLevel.Info },
});

const ordersController = new OrdersController(paypalClient);

// 1. CREATE ORDER (Called by your frontend)
router.post('/create-order', requireAuth, asyncHandler(async (req, res) => {
    const { course_id, amount } = req.body; // Amount should ideally be fetched from DB based on course_id

    const collect = {
        body: {
            intent: 'CAPTURE',
            purchase_units: [{
                amount: {
                    currency_code: 'USD',
                    value: parseFloat(amount).toFixed(2), // Ensure correct format
                },
                custom_id: `${req.user.id}|${course_id}`, // Store user and course reference
            }],
        },
        prefer: 'return=minimal',
    };

    const { result } = await ordersController.createOrder(collect);
    res.json({ id: result.id });
}));

// 2. CAPTURE ORDER (Called after buyer approves)
router.post('/capture-order/:orderId', requireAuth, asyncHandler(async (req, res) => {
    const { orderId } = req.params;

    const collect = {
        id: orderId,
        prefer: 'return=minimal',
    };

    const { result } = await ordersController.captureOrder(collect);

    if (result.status === 'COMPLETED') {
        // Payment successful. Update your database here.
        // Extract custom_id (e.g., "user_id|course_id") to credit the correct course
        const customId = result.purchase_units[0].payments.captures[0].custom_id;
        console.log('Payment completed for:', customId);
        
        // TODO: Call your existing logic to add the transaction to your DB
        // await db.query(...) 
        
        res.json({ status: 'COMPLETED', details: result });
    } else {
        res.status(400).json({ error: 'Payment not completed', status: result.status });
    }
}));

module.exports = router;
