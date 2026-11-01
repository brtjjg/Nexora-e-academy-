const express = require('express');
const router = express.Router();
const db = require('../db'); // Your raw SQL pool
const fetch = require('node-fetch');

// 1. Dashboard Stats
router.get('/dashboard', async (req, res) => {
    try {
        const result = await db.query('SELECT status, COUNT(*) FROM studio_productions GROUP BY status');
        const counts = { queued: 0, rendering: 0, ready: 0, failed: 0 };
        result.rows.forEach(row => {
            const stat = row.status;
            if (counts[stat] !== undefined) counts[stat] = parseInt(row.count);
        });
        res.json({ productions: counts });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. Get Productions (With Auto-Status Check)
router.get('/productions', async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM studio_productions ORDER BY created_at DESC');
        let items = result.rows;

        for (let item of items) {
            if (item.status === 'rendering' && item.external_id) {
                const statusCheck = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${item.external_id}`, {
                    headers: { 'X-Api-Key': process.env.VIDEO_API_KEY }
                });
                const statusData = await statusCheck.json();

                if (statusData.data && statusData.data.status === 'completed') {
                    await db.query('UPDATE studio_productions SET status = $1, video_url = $2 WHERE id = $3', ['ready', statusData.data.video_url, item.id]);
                    item.status = 'ready';
                    item.video_url = statusData.data.video_url;
                } else if (statusData.data && statusData.data.status === 'failed') {
                    await db.query('UPDATE studio_productions SET status = $1 WHERE id = $2', ['failed', item.id]);
                    item.status = 'failed';
                }
            }
        }
        res.json({ items });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. Get Video Status for Lesson
router.get('/status/:lessonId', async (req, res) => {
    try {
        const result = await db.query('SELECT status FROM studio_productions WHERE lesson_id = $1 ORDER BY created_at DESC LIMIT 1', [req.params.lessonId]);
        if (result.rows.length === 0) return res.json({ status: 'none' });
        res.json({ status: result.rows[0].status });
    } catch (err) { res.json({ status: 'none' }); }
});

// 4. Generate Video
router.post('/generate/:lessonId', async (req, res) => {
    try {
        const { lessonId } = req.params;
        const { voice } = req.body;

        const lessonRes = await db.query('SELECT title, notes FROM lessons WHERE id = $1', [lessonId]);
        if (lessonRes.rows.length === 0) throw new Error("Lesson not found");
        const lesson = lessonRes.rows[0];

        const prodRes = await db.query(
            'INSERT INTO studio_productions (lesson_id, title, status) VALUES ($1, $2, $3) RETURNING id', 
            [lessonId, lesson.title, 'rendering']
        );
        const productionId = prodRes.rows[0].id;

        const apiResponse = await fetch('https://api.heygen.com/v2/video/generate', {
            method: 'POST',
            headers: { 'X-Api-Key': process.env.VIDEO_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                video_inputs: [{
                    character: { type: "avatar", avatar_id: "Angela-inTshirt-20220820", avatar_style: "normal" },
                    voice: { type: "text", input_text: `${lesson.title}. ${lesson.notes}`, voice_id: voice }
                }],
                dimension: { width: 1280, height: 720 }
            })
        });

        const apiData = await apiResponse.json();
        
        if (apiData.data && apiData.data.video_id) {
            await db.query('UPDATE studio_productions SET external_id = $1 WHERE id = $2', [apiData.data.video_id, productionId]);
        }

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. Approve Video
router.post('/approve/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const prodRes = await db.query('SELECT * FROM studio_productions WHERE id = $1', [id]);
        if (prodRes.rows.length === 0) throw new Error("Production not found");
        const production = prodRes.rows[0];

        await db.query('UPDATE studio_productions SET status = $1 WHERE id = $2', ['approved', id]);
        await db.query('UPDATE lessons SET video_url = $1 WHERE id = $2', [production.video_url, production.lesson_id]);

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
