const express = require('express');
const router = express.Router();
const supabase = require('../db'); // Ensure this path matches your setup

// 1. Get Dashboard Stats
router.get('/dashboard', async (req, res) => {
    try {
        // In a real app, you'd count from Supabase. For now, send dummy data.
        res.json({ productions: { queued: 0, rendering: 0, ready: 1, failed: 0 } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. Get Productions List
router.get('/productions', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('studio_productions')
            .select('*')
            .order('created_at', { ascending: false });
            
        if (error) throw error;
        res.json({ items: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. Trigger Video Generation
router.post('/generate/:lessonId', async (req, res) => {
    try {
        const { lessonId } = req.params;
        const { voice } = req.body;

        // 1. Fetch lesson info
        const { data: lesson } = await supabase.from('lessons').select('title').eq('id', lessonId).single();

        // 2. Add to queue in database
        const { data, error } = await supabase.from('studio_productions').insert([{
            lesson_id: lessonId,
            title: lesson.title,
            status: 'ready', // Simulate instantly ready for testing!
            video_url: 'https://www.w3schools.com/html/mov_bbb.mp4' // Dummy video
        }]).select();

        if (error) throw error;
        res.json({ success: true, message: "Generation started" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. Approve Video (Publishes to Academy)
router.post('/approve/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // 1. Find the production record
        const { data: production } = await supabase.from('studio_productions').select('*').eq('id', id).single();
        
        // 2. Update status to approved
        await supabase.from('studio_productions').update({ status: 'approved' }).eq('id', id);

        // 3. Inject the video URL into the Academy lessons table
        await supabase.from('lessons').update({ video_url: production.video_url }).eq('id', production.lesson_id);

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
