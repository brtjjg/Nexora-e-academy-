const db = require('./db');

function asyncHandler(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isStrongPassword(pw) {
    return typeof pw === 'string' &&
        pw.length >= 8 &&
        /[A-Z]/.test(pw) &&
        /\d/.test(pw);
}

function money(n) {
    return Math.round(parseFloat(n) * 100) / 100;
}

async function genApplicationId(client) {
    const year = new Date().getFullYear();
    const result = await client.query(
        `SELECT COUNT(*)::int AS c FROM applications WHERE application_id LIKE $1`,
        [`NXA-APP-${year}-%`]
    );
    const n = result.rows[0].c + 1;
    return `NXA-APP-${year}-${String(n).padStart(5, '0')}`;
}

async function genAdmissionNumber(client) {
    const year = new Date().getFullYear();
    const result = await client.query(
        `INSERT INTO admission_counters (year, counter)
         VALUES ($1, 1)
         ON CONFLICT (year) DO UPDATE
         SET counter = admission_counters.counter + 1
         RETURNING counter`,
        [year]
    );
    const n = result.rows[0].counter;
    return `NXA-ADM-${year}-${String(n).padStart(6, '0')}`;
}

async function genTransactionId(client) {
    const year = new Date().getFullYear();
    const result = await client.query(
        `SELECT COUNT(*)::int AS c FROM transactions WHERE transaction_id LIKE $1`,
        [`NXA-TXN-${year}-%`]
    );
    const n = result.rows[0].c + 1;
    return `NXA-TXN-${year}-${String(n).padStart(5, '0')}`;
}

async function genWalletTxId(client) {
    const year = new Date().getFullYear();
    const result = await client.query(
        `SELECT COUNT(*)::int AS c FROM wallet_transactions WHERE wallet_tx_id LIKE $1`,
        [`NXA-WLT-${year}-%`]
    );
    const n = result.rows[0].c + 1;
    return `NXA-WLT-${year}-${String(n).padStart(5, '0')}`;
}

async function genCertificateId(client, code) {
    const year = new Date().getFullYear();
    const prefix = `NXA-${(code || 'CRS').toUpperCase()}-${year}-`;
    const result = await client.query(
        `SELECT COUNT(*)::int AS c FROM certificates WHERE certificate_id LIKE $1`,
        [`${prefix}%`]
    );
    const n = result.rows[0].c + 1;
    return `${prefix}${String(n).padStart(6, '0')}`;
}

async function logActivity(client, userId, type, title, description = '', metadata = null) {
    await client.query(
        `INSERT INTO activities (user_id, activity_type, title, description, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, type, title, description, metadata]
    );
}

module.exports = {
    asyncHandler,
    isValidEmail,
    isStrongPassword,
    money,
    genApplicationId,
    genAdmissionNumber,
    genTransactionId,
    genWalletTxId,
    genCertificateId,
    logActivity,
};
