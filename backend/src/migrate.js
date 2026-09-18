const fs = require('fs');
const path = require('path');
const db = require('./db');

async function runMigrations() {
    try {
        const check = await db.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'users'
            ) AS exists
        `);

        if (check.rows[0].exists) {
            console.log('[migrate] Schema already loaded, skipping');
            return;
        }

        console.log('[migrate] Loading schema.sql...');
        const schemaPath = path.join(__dirname, '..', '..', 'database', 'schema.sql');
        if (!fs.existsSync(schemaPath)) {
            console.error('[migrate] schema.sql not found at', schemaPath);
            return;
        }
        const schema = fs.readFileSync(schemaPath, 'utf8');
        await db.query(schema);
        console.log('[migrate] Schema loaded');

        console.log('[migrate] Loading seed.sql...');
        const seedPath = path.join(__dirname, '..', '..', 'database', 'seed.sql');
        if (fs.existsSync(seedPath)) {
            const seed = fs.readFileSync(seedPath, 'utf8');
            await db.query(seed);
            console.log('[migrate] Seed loaded');
        } else {
            console.log('[migrate] seed.sql not found, skipping');
        }
    } catch (err) {
        console.error('[migrate] Error:', err.message);
    }
}

module.exports = { runMigrations };
