const express = require('express');
const router = express.Router();
const supabase = require('../db'); 
const fetch = require('node-fetch');

// 1. Get Dashboard Stats (Real Numbers)
router.get('/dashboard', async (req, res) => {
    try {
        const { data, error } = await supabase.from('studio_productions').select('status');
        if (error) throw error;

        const counts = { queued: 0, rendering: 0, ready: 0, failed: 0 };
        data.forEach(item => {
            if (counts[item.status] !== undefined) counts[item.status]++;
        });

        res.json({ productions: counts });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// 2. Get Productions List & Auto-Check Rendering Status
router.get('/productions', async (req, res) => {
    try {
        const { data: items, error } = await supabase
            .from('studio_productions')
            .select('*')
            .order('created_at', { ascending: false });
            
        if (error) throw error;

        // Loop through and check if any "rendering" videos are done on HeyGen
        for (let item of items) {
            if (item.status === 'rendering' && item.external_id) {
                try {
                    const statusCheck = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${item.external_id}`, {
                        headers: { 'X-Api-Key': process.env.VIDEO_API_KEY }
                    });
                    const statusData = await statusCheck.json();

                    if (statusData.data && statusData.data.status === 'completed') {
                        await supabase.from('studio_productions')
                            .update({ status: 'ready', video_url: statusData.data.video_url })
                            .eq('id', item.id);
                        item.status = 'ready';
                        item.video_url = statusData.data.video_url;
                    } else if (statusData.data && statusData.data.status === 'failed') {
                        await supabase.from('studio_productions').update({ status: 'failed' }).eq('id', item.id);
                        item.status = 'failed';
                    }
                } catch (e) {
                    console.error("API Check Error:", e.message);
                }
            }
        }

        res.json({ items });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// 3. Get Video Status for a specific lesson (used by Academy Admin)
router.get('/status/:lessonId', async (req, res) => {
    try {
        const { lessonId } = req.params;
        const { data, error } = await supabase
            .from('studio_productions')
            .select('status')
            .eq('lesson_id', lessonId)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        if (error || !data) return res.json({ status: 'none' });
        res.json({ status: data.status });
    } catch (err) {
        res.json({ status: 'none' });
    }
});

// 4. Trigger Real Video Generation
router.post('/generate/:lessonId', async (req, res) => {
    try {
        const { lessonId } = req.params;
        const { voice } = req.body;

        const { data: lesson, error: lessonError } = await supabase
            .from('lessons').select('title, notes').eq('id', lessonId).single();
        if (lessonError) throw new Error("Lesson not found");

        const { data: production, error: dbError } = await supabase
            .from('studio_productions')
            .insert([{ lesson_id: lessonId, title: lesson.title, status: 'rendering', video_url: null }])
            .select().single();
        if (dbError) throw dbError;

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
            await supabase.from('studio_productions')
                .update({ external_id: apiData.data.video_id })
                .eq('id', production.id);
        }

        res.json({ success: true, message: "AI is generating the video..." });
    } catch (err) { 
        console.error(err);
        res.status(500).json({ error: err.message }); 
    }
});

// 5. Approve Video & Push to Academy
router.post('/approve/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Get the video details
        const { data: production, error: prodErr } = await supabase
            .from('studio_productions').select('*').eq('id', id).single();
        if (prodErr) throw prodErr;

        // Update production status
        await supabase.from('studio_productions').update({ status: 'approved' }).eq('id', id);

        // Update the actual lesson in the Academy database
        await supabase.from('lessons').update({ video_url: production.video_url }).eq('id', production.lesson_id);

        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

module.exports = router;
