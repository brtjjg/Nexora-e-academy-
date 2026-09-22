const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler, money, genTransactionId, genWalletTxId } = require('../utils');
const { requireAuth, requireAdmin } = require('../middleware');
const { sendPaymentConfirmation } = require('../email');

const ACTIVATION_FEE = parseFloat(process.env.ACTIVATION_FEE) || 0.50;

/* ============================================================
   POST /api/payments/activation
   Pays admission fee → auto-creates application if missing → approves student
   ============================================================ */
router.post('/activation', requireAuth, asyncHandler(async (req, res) => {
    const userId = req.user.user_id;
    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        // 1. Get user info
        const userRes = await client.query(
            `SELECT id, full_name, email, phone, course_interest FROM users WHERE id = $1`,
            [userId]
        );
        if (!userRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
        }
        const user = userRes.rows[0];

        // 2. Check if already paid
        const existing = await client.query(
            `SELECT id, payment_status FROM applications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
            [userId]
        );
        if (existing.rows.length && existing.rows[0].payment_status === 'paid') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Already paid' });
        }

        // 3. ✅ AUTO-CREATE application if it doesn't exist
        let applicationId;
        if (!existing.rows.length) {
            // Generate app ID like NXA-APP-2026-000123
            const countRes = await client.query(
                `SELECT COUNT(*)::int + 1 AS next FROM applications WHERE application_id LIKE $1`,
                [`NXA-APP-${new Date().getFullYear()}-%`]
            );
            const nextNum = countRes.rows[0]?.next || 1;
            const appId = `NXA-APP-${new Date().getFullYear()}-${String(nextNum).padStart(6, '0')}`;

            const newApp = await client.query(`
                INSERT INTO applications (
                    application_id, user_id, full_name, email, phone, course_interest,
                    status, payment_status, created_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, 'paid', 'paid', NOW())
                RETURNING id
            `, [
                appId,
                user.id,
                user.full_name,
                user.email,
                user.phone || '+254700000000',
                user.course_interest || 'Microsoft word'
            ]);
            applicationId = newApp.rows[0].id;
        } else {
            applicationId = existing.rows[0].id;
        }

        // 4. Record the transaction
        const txId = await genTransactionId(client);
        const tx = await client.query(
            `INSERT INTO transactions
                (transaction_id, user_id, application_id, payment_type, amount, currency, payment_method, status)
             VALUES ($1, $2, $3, 'ACTIVATION_FEE', $4, 'USD', 'internal', 'pending')
             RETURNING *`,
            [txId, userId, applicationId, ACTIVATION_FEE]
        );
        await client.query(
            `UPDATE transactions SET status='completed', verified_at=NOW() WHERE id=$1`,
            [tx.rows[0].id]
        );

        // 5. Mark application as paid
        await client.query(
            `UPDATE applications
             SET status='paid', payment_status='paid',
                 payment_reference=$1, paid_at=NOW()
             WHERE id=$2`,
            [txId, applicationId]
        );

        // 6. ✅ Auto-approve student profile
        const profileUpdate = await client.query(
            `UPDATE student_profiles
             SET activation_fee_paid=TRUE,
                 admission_status='approved'
             WHERE user_id=$1
             RETURNING *`,
            [userId]
        );

        // If no profile row exists, create one
        if (!profileUpdate.rows.length) {
            await client.query(`
                INSERT INTO student_profiles (user_id, activation_fee_paid, admission_status)
                VALUES ($1, TRUE, 'approved')
                ON CONFLICT (user_id) DO UPDATE
                    SET activation_fee_paid = TRUE,
                        admission_status = 'approved'
            `, [userId]);
        }

        // 7. Wallet transaction
        const wId = await genWalletTxId(client);
        await client.query(
            `INSERT INTO wallet_transactions
                (wallet_tx_id, user_id, transaction_id, type, amount, description, status)
             VALUES ($1, $2, $3, 'debit', $4, 'Activation fee', 'completed')`,
            [wId, userId, tx.rows[0].id, ACTIVATION_FEE]
        );

        await client.query('COMMIT');

        // 8. Send confirmation email (fire-and-forget)
        (async () => {
            try {
                await sendPaymentConfirmation({
                    to: user.email,
                    recipientName: user.full_name,
                    amount: ACTIVATION_FEE,
                    transactionId: txId,
                    description: 'Admission fee',
                });
            } catch (e) { console.error('[email:activation]', e.message); }
        })();

        res.json({
            ok: true,
            transaction_id: txId,
            admission_status: 'approved',
            message: 'Admission fee paid. You now have full access.',
        });

    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

/* ============================================================
   POST /api/payments/course — course payments (unchanged)
   ============================================================ */
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
        if (!c.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Course not found' });
        }
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

        if (remaining <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Course already fully paid' });
        }
        if (payAmount > remaining + 0.01) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `Amount exceeds remaining ($${remaining.toFixed(2)})` });
        }

        const txId = await genTransactionId(client);
        const tx = await client.query(
            `INSERT INTO transactions (transaction_id, user_id, course_id, payment_type, amount, currency, payment_method, status, price_at_purchase)
             VALUES ($1,$2,$3,'COURSE_PAYMENT',$4,'USD',$5,'pending',$6)
             RETURNING *`,
            [txId, req.user.user_id, course_id, payAmount, payment_method || 'internal', effectivePrice]
        );
        await client.query(
            `UPDATE transactions SET status='completed', verified_at=NOW() WHERE id=$1`,
            [tx.rows[0].id]
        );

        const wId = await genWalletTxId(client);
        await client.query(
            `INSERT INTO wallet_transactions (wallet_tx_id, user_id, transaction_id, type, amount, description, status)
             VALUES ($1,$2,$3,'debit',$4,$5,'completed')`,
            [wId, req.user.user_id, tx.rows[0].id, payAmount, `Course payment: ${course_id}`]
        );
        await client.query('COMMIT');

        // Send email confirmation
        (async () => {
            try {
                const u = await db.query(`SELECT email, full_name FROM users WHERE id = $1`, [req.user.user_id]);
                if (u.rows[0]) {
                    await sendPaymentConfirmation({
                        to: u.rows[0].email,
                        recipientName: u.rows[0].full_name,
                        amount: payAmount,
                        transactionId: txId,
                        description: 'Course payment',
                    });
                }
            } catch (e) { console.error('[email:course]', e.message); }
        })();

        res.json({ ok: true, transaction_id: txId, amount: payAmount });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

/* ============================================================
   GET /api/payments/me — transaction history (unchanged)
   ============================================================ */
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
    const r = await db.query(
        `SELECT t.*, c.title AS course_title FROM transactions t
         LEFT JOIN courses c ON c.id = t.course_id
         WHERE t.user_id = $1 ORDER BY t.created_at DESC`,
        [req.user.user_id]
    );
    res.json({ transactions: r.rows });
}));

/* ============================================================
   GET /api/payments — admin list (unchanged)
   ============================================================ */
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

/* ============================================================
   GET /api/payments/me/summary — wallet summary (NEW)
   ============================================================ */
router.get('/me/summary', requireAuth, asyncHandler(async (req, res) => {
    const userId = req.user.user_id;

    // Activation fee
    const actRes = await db.query(
        `SELECT COALESCE(SUM(amount),0)::numeric AS paid FROM transactions
         WHERE user_id=$1 AND payment_type='ACTIVATION_FEE' AND status='completed'`,
        [userId]
    );
    const activationFeePaid = parseFloat(actRes.rows[0]?.paid || 0);

    // Course balances
    const courseRes = await db.query(`
        SELECT
            e.course_id,
            c.title,
            c.price::numeric AS course_price,
            ROUND(c.price * 0.25, 2)::numeric AS initial_payment,
            COALESCE(SUM(t.amount), 0)::numeric AS total_course_paid,
            GREATEST(c.price - COALESCE(SUM(t.amount), 0), 0)::numeric AS remaining_balance,
            CASE
                WHEN c.price <= 0 THEN 100
                WHEN COALESCE(SUM(t.amount), 0) >= c.price - 0.01 THEN 100
                ELSE ROUND((COALESCE(SUM(t.amount), 0) / c.price) * 100, 2)
            END AS payment_percentage
        FROM enrollments e
        JOIN courses c ON c.id = e.course_id
        LEFT JOIN transactions t
            ON t.user_id = e.user_id
            AND t.course_id = e.course_id
            AND t.payment_type = 'COURSE_PAYMENT'
            AND t.status = 'completed'
        WHERE e.user_id = $1
        GROUP BY e.course_id, c.title, c.price
        ORDER BY e.enrolled_at DESC
    `, [userId]);

    const courses = courseRes.rows.map(c => ({
        ...c,
        course_price: parseFloat(c.course_price),
        initial_payment: parseFloat(c.initial_payment),
        total_course_paid: parseFloat(c.total_course_paid),
        remaining_balance: parseFloat(c.remaining_balance),
        payment_percentage: parseFloat(c.payment_percentage),
    }));

    const totalCoursePrice = courses.reduce((s, c) => s + c.course_price, 0);
    const totalCoursePaid = courses.reduce((s, c) => s + c.total_course_paid, 0);
    const totalRemaining = courses.reduce((s, c) => s + c.remaining_balance, 0);

    res.json({
        activation_fee_paid: activationFeePaid,
        total_money_paid: activationFeePaid + totalCoursePaid,
        courses,
        totals: {
            course_price: totalCoursePrice,
            course_paid: totalCoursePaid,
            remaining_balance: totalRemaining,
        },
    });
}));

module.exports = router;
