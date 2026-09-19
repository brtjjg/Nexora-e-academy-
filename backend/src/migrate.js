const fs = require('fs');
const path = require('path');
const db = require('./db');

async function runMigrations() {
    try {
        // Check if the base schema has been loaded
        const check = await db.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'users'
            ) AS exists
        `);

        if (!check.rows[0].exists) {
            console.log('[migrate] Loading schema.sql...');
            const schemaPath = path.join(__dirname, '..', '..', 'database', 'schema.sql');
            if (fs.existsSync(schemaPath)) {
                const schema = fs.readFileSync(schemaPath, 'utf8');
                await db.query(schema);
                console.log('[migrate] Schema loaded');
            } else {
                console.error('[migrate] schema.sql not found at', schemaPath);
                return;
            }

            console.log('[migrate] Loading seed.sql...');
            const seedPath = path.join(__dirname, '..', '..', 'database', 'seed.sql');
            if (fs.existsSync(seedPath)) {
                const seed = fs.readFileSync(seedPath, 'utf8');
                await db.query(seed);
                console.log('[migrate] Seed loaded');
            } else {
                console.log('[migrate] seed.sql not found, skipping');
            }
        } else {
            console.log('[migrate] Base schema already loaded, skipping');
        }

        // ------------------------------------------------------------
        // Extensions — each wrapped in its own try/catch so a failure
        // in one never stops the server from starting.
        // ------------------------------------------------------------

        // Assignments extension
        try {
            const assignmentsPath = path.join(__dirname, '..', '..', 'database', 'assignments.sql');
            if (fs.existsSync(assignmentsPath)) {
                console.log('[migrate] Loading assignments.sql...');
                const assign = fs.readFileSync(assignmentsPath, 'utf8');
                await db.query(assign);
                console.log('[migrate] Assignments schema loaded');
            } else {
                console.log('[migrate] assignments.sql not found, skipping');
            }
        } catch (e) {
            console.error('[migrate] Assignments schema failed:', e.message);
        }

        // Discussions extension
        try {
            const discussionsPath = path.join(__dirname, '..', '..', 'database', 'discussions.sql');
            if (fs.existsSync(discussionsPath)) {
                console.log('[migrate] Loading discussions.sql...');
                const disc = fs.readFileSync(discussionsPath, 'utf8');
                await db.query(disc);
                console.log('[migrate] Discussions schema loaded');
            } else {
                console.log('[migrate] discussions.sql not found, skipping');
            }
        } catch (e) {
            console.error('[migrate] Discussions schema failed:', e.message);
        }

        // Notifications table (in case it wasn't created yet)
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS notifications (
                    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    type            TEXT NOT NULL,
                    title           TEXT NOT NULL,
                    body            TEXT,
                    link            TEXT,
                    read            BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
                CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
            `);
            console.log('[migrate] Notifications table ready');
        } catch (e) {
            console.error('[migrate] Notifications table failed:', e.message);
        }

        // Late policy columns on assignments (safe to add even if already present)
        try {
            await db.query(`
                ALTER TABLE assignments ADD COLUMN IF NOT EXISTS late_policy TEXT DEFAULT 'allow';
                ALTER TABLE assignments ADD COLUMN IF NOT EXISTS late_penalty_percent INTEGER DEFAULT 10;
                ALTER TABLE assignment_submissions ADD COLUMN IF NOT EXISTS is_late BOOLEAN DEFAULT FALSE;
                ALTER TABLE assignment_submissions ADD COLUMN IF NOT EXISTS penalty_percent INTEGER DEFAULT 0;
            `);
            console.log('[migrate] Assignment late-policy columns ready');
        } catch (e) {
            console.error('[migrate] Assignment late-policy columns failed:', e.message);
        }

        console.log('[migrate] All migrations complete');
    } catch (err) {
        console.error('[migrate] Fatal error:', err.message);
        // Don't crash the server — let it start and serve what it can
    }
}

module.exports = { runMigrations };
