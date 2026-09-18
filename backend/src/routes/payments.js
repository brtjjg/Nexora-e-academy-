const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler, money, genTransactionId, genWalletTxId, logActivity } = require('../utils');
const { requireAuth, requireAdmin } = require('../middleware');

const ACTIVATION_FEE = parseFloat(process.env.ACTIVATION_FEE) || 0.50;

router.post('/activation', requireAuth, asyncHandler(async (req, res) => {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        const existing = await client.query(
            `SELECT payment_status FROM applications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
            [req.user.user_id]
        );
        if (!existing.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No application found' }); }
        if (existing.rows[0].payment_status === 'paid') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Already paid' }); }

        const txId = await genTransactionId(client);
        const tx = await client.query(
            `INSERT INTO transactions (transaction_id, user_id, application_id, payment_type, amount, currency, payment_method, status)
             VALUES ($1, $2,
                (SELECT id FROM applications WHERE user_id=$2 ORDER BY created_at DESC LIMIT 1),
                'ACTIVATION_FEE', $3, 'USD', 'internal', 'pending')
             RETURNING *`,
            [txId, req.user.user_id, ACTIVATION_FEE]
        );
        await client.query(`UPDATE transactions SET status='completed', verified_at=NOW() WHERE id=$1`, [tx.rows[0].id]);
        await client.query(
            `UPDATE applications SET status='paid', payment_status='paid', payment_reference=$1, paid_at=NOW()
             WHERE user_id=$2 AND status='payment_due'`,
            [txId, req.user.user_id]
        );
        await client.query(
            `UPDATE student_profiles SET activation_fee_paid=TRUE, admission_status='paid_pending_verification' WHERE user_id=$1`,
            [req.user.user_id]
        );
        const wId = await genWalletTxId(client);
        await client.query(
            `INSERT INTO wallet_transactions (wallet_tx_id, user_id, transaction_id, type, amount, description, status)
             VALUES ($1, $2, $3, 'debit', $4, 'Activation fee', 'completed')`,
            [wId, req.user.user_id, tx.rows[0].id, ACTIVATION_FEE]
        );
        await client.query('COMMIT');
        res.json({ ok: true, transaction_id: txId });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

router.post('/course', requireAuth, asyncHandler(async (req, res) => {
    const { course_id, amount, payment_method } = req.body;
    if (!course_id || !amount) return res.status(400).json({ error: 'course_id and amount required' });
    const payAmount = money(amount);
    if (payAmount < 0.50) return res.status(400).json({ error: 'Minimum payment is $0.50' });

    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        const c = await client.query(
            `SELECT c.id, c.price, d.enabled AS discount_enabled, d.discount_price, d.ends_at
             FROM courses c LEFT JOIN course_discounts d ON d.course_id = c.id WHERE c.id = $1`,
            [course_id]
        );
        if (!c.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Course not found' }); }
        const course = c.rows[0];
        const activeDiscount = course.discount_enabled && course.ends_at && new Date(course.ends_at) > new Date();
        const effectivePrice = activeDiscount ? parseFloat(course.discount_price) : parseFloat(course.price);

        const paidRes = await client.query(
            `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
             WHERE user_id=$1 AND course_id=$2 AND payment_type='COURSE_PAYMENT' AND status='completed'`,
            [req.user.user_id, course_id]
        );
        const paid = parseFloat(paidRes.rows[0].total);
        const remaining = Math.max(0, effectivePrice - paid);

        if (remaining <= 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Course already fully paid' }); }
        if (payAmount > remaining + 0.01) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Amount exceeds remaining ($${remaining.toFixed(2)})` }); }

        const txId = await genTransactionId(client);
        const tx = await client.query(
            `INSERT INTO transactions (transaction_id, user_id, course_id, payment_type, amount, currency, payment_method, status, price_at_purchase)
             VALUES ($1,$2,$3,'COURSE_PAYMENT',$4,'USD',$5,'pending',$6)
             RETURNING *`,
            [txId, req.user.user_id, course_id, payAmount, payment_method || 'internal', effectivePrice]
        );
        await client.query(`UPDATE transactions SET status='completed', verified_at=NOW() WHERE id=$1`, [tx.rows[0].id]);

        const wId = await genWalletTxId(client);
        await client.query(
            `INSERT INTO wallet_transactions (wallet_tx_id, user_id, transaction_id, type, amount, description, status)
             VALUES ($1,$2,$3,'debit',$4,$5,'completed')`,
            [wId, req.user.user_id, tx.rows[0].id, payAmount, `Course payment: ${course_id}`]
        );
        await client.query('COMMIT');
        res.json({ ok: true, transaction_id: txId, amount: payAmount });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT t.*, c.title AS course_title FROM transactions t
         LEFT JOIN courses c ON c.id = t.course_id
         WHERE t.user_id = $1 ORDER BY t.created_at DESC`,
        [req.user.user_id]
    );
    res.json({ transactions: r.rows });
}));

router.get('/', requireAdmin, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT t.*, u.full_name AS student_name, u.email AS student_email, c.title AS course_title
         FROM transactions t
         JOIN users u ON u.id = t.user_id
         LEFT JOIN courses c ON c.id = t.course_id
         ORDER BY t.created_at DESC LIMIT 500`
    );
    res.json({ transactions: r.rows });
}));

module.exports = router;
