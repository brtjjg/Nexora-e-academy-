const express = require('express');
const router = express.Router();
const supabase = require('../db'); // Adjust this if your db connection is named differently

// 1. Get Dashboard Stats
router.get('/dashboard', async (req, res) => {
    try {
        // You can replace this with real Supabase queries later
        res.json({ 
            productions: { queued: 0, rendering: 0, ready: 0, failed: 0 } 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Get Productions List
router.get('/productions', async (req, res) => {
    try {
        // Replace with: const { data } = await supabase.from('studio_productions').select('*')
        res.json({ items: [] }); // Returns empty list for now
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Trigger Video Generation
router.post('/generate/:lessonId', async (req, res) => {
    try {
        const { lessonId } = req.params;
        const { voice } = req.body;

        // 1. Fetch the lesson from Supabase: 
        // const { data: lesson } = await supabase.from('lessons').select('*').eq('id', lessonId).single();
        
        // 2. Add a record to a 'productions' table indicating it is 'queued'
        
        // 3. Call your AI Video API here

        res.json({ success: true, message: "Generation started" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Approve Video (Makes it go live for students)
router.post('/approve/:productionId', async (req, res) => {
    try {
        const { productionId } = req.params;

        // 1. Get the production record from DB
        // 2. Update status to 'approved'
        // 3. Update the `lessons` table with the new `video_url`

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
