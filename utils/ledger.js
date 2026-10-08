// utils/ledger.js
// Immutable ledger writers + contributor share resolver.
// Default: 70% contributor / 30% Nexora, 7-day hold on contributor credits.

const DEFAULT_CONTRIBUTOR_SHARE = 70.00;
const DEFAULT_NEXORA_SHARE      = 30.00;
const DEFAULT_HOLD_DAYS         = 7;

/**
 * Resolve effective split for a course.
 * Order: per-course override → default 70/30.
 * `client` can be a pool or a transactional client (both expose .query).
 */
async function resolveSplit(client, courseId) {
    const r = await client.query(
        `SELECT contributor_share_percent, nexora_share_percent
         FROM course_revenue_config
         WHERE course_id = $1`,
        [courseId]
    );
    if (r.rows.length) {
        return {
            contributor: parseFloat(r.rows[0].contributor_share_percent),
            nexora:      parseFloat(r.rows[0].nexora_share_percent),
        };
    }
    return { contributor: DEFAULT_CONTRIBUTOR_SHARE, nexora: DEFAULT_NEXORA_SHARE };
}

/**
 * Write a single ledger entry. Must be called inside a transaction.
 */
async function writeLedgerEntry(client, {
    contributor_id = null,
    course_id = null,
    transaction_id = null,
    entry_type,
    amount,
    currency = 'USD',
    is_pending = false,
    available_at = null,
    description = null,
    metadata = {},
}) {
    const refRes = await client.query(`SELECT gen_ledger_ref() AS ref`);
    const entry_ref = refRes.rows[0].ref;

    const r = await client.query(
        `INSERT INTO ledger_entries
            (entry_ref, contributor_id, course_id, transaction_id,
             entry_type, amount, currency, is_pending, available_at,
             description, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
         RETURNING *`,
        [
            entry_ref,
            contributor_id,
            course_id,
            transaction_id,
            entry_type,
            amount,
            currency,
            is_pending,
            available_at,
            description,
            JSON.stringify(metadata || {}),
        ]
    );
    return r.rows[0];
}

/**
 * Split a course payment into contributor + Nexora ledger credits.
 * Must be called inside the same transaction as the payment insert.
 *
 * Behavior:
 *  - Contributor credit is PENDING for `hold_days` (default 7), then auto-released.
 *  - Nexora credit is available immediately.
 *  - If the course has no contributor, 100% goes to Nexora.
 */
async function recordCourseSaleSplit(client, {
    contributor_id,
    course_id,
    transaction_id,
    gross_amount,
    currency = 'USD',
    hold_days = DEFAULT_HOLD_DAYS,
}) {
    const gross = round2(gross_amount);
    if (gross <= 0) return;

    // No contributor → 100% Nexora
    if (!contributor_id) {
        await writeLedgerEntry(client, {
            contributor_id: null,
            course_id,
            transaction_id,
            entry_type: 'sale_nexora_credit',
            amount: gross,
            currency,
            is_pending: false,
            description: `Nexora share (no contributor) · course ${course_id}`,
            metadata: { gross_amount: gross, contributor_share: 0, nexora_share: 100 },
        });
        return;
    }

    const split = await resolveSplit(client, course_id);

    const contributor_amt = round2(gross * (split.contributor / 100));
    const nexora_amt      = round2(gross - contributor_amt);

    const availableAt = new Date(Date.now() + hold_days * 24 * 60 * 60 * 1000);

    // Contributor credit — pending until hold matures
    await writeLedgerEntry(client, {
        contributor_id,
        course_id,
        transaction_id,
        entry_type: 'sale_contributor_credit',
        amount: contributor_amt,
        currency,
        is_pending: true,
        available_at: availableAt,
        description: `Contributor share · course ${course_id}`,
        metadata: {
            gross_amount: gross,
            contributor_share: split.contributor,
            nexora_share: split.nexora,
            hold_days,
        },
    });

    // Nexora credit — available now
    if (nexora_amt > 0) {
        await writeLedgerEntry(client, {
            contributor_id: null,
            course_id,
            transaction_id,
            entry_type: 'sale_nexora_credit',
            amount: nexora_amt,
            currency,
            is_pending: false,
            description: `Nexora share · course ${course_id}`,
            metadata: {
                gross_amount: gross,
                contributor_share: split.contributor,
                nexora_share: split.nexora,
            },
        });
    }
}

/**
 * Reverse a course payment (refund).
 * Debits the contributor's share so their balance drops accordingly.
 */
async function recordRefundReversal(client, {
    contributor_id,
    course_id,
    transaction_id,
    gross_amount,
    currency = 'USD',
}) {
    if (!contributor_id) return;
    const gross = round2(gross_amount);
    if (gross <= 0) return;

    const split = await resolveSplit(client, course_id);
    const contributor_amt = round2(gross * (split.contributor / 100));
    if (contributor_amt <= 0) return;

    await writeLedgerEntry(client, {
        contributor_id,
        course_id,
        transaction_id,
        entry_type: 'refund_debit',
        amount: contributor_amt,
        currency,
        is_pending: false,
        description: `Refund reversal · course ${course_id}`,
        metadata: { gross_amount: gross, contributor_share: split.contributor },
    });
}

function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

module.exports = {
    DEFAULT_CONTRIBUTOR_SHARE,
    DEFAULT_NEXORA_SHARE,
    DEFAULT_HOLD_DAYS,
    resolveSplit,
    writeLedgerEntry,
    recordCourseSaleSplit,
    recordRefundReversal,
    round2,
};
