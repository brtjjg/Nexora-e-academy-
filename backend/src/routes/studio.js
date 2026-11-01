const express = require('express');
const router = express.Router();
const supabase = require('../db'); 
const fetch = require('node-fetch'); // Make sure you have node-fetch installed in package.json

// 3. Trigger Real Video Generation
router.post('/generate/:lessonId', async (req, res) => {
    try {
        const { lessonId } = req.params;
        const { voice } = req.body;

        // 1. Fetch the lesson text from Supabase
        const { data: lesson, error: lessonError } = await supabase
            .from('lessons')
            .select('title, notes')
            .eq('id', lessonId)
            .single();

        if (lessonError) throw new Error("Lesson not found");

        // 2. Create a record in Supabase first (Status: Rendering)
        const { data: production, error: dbError } = await supabase
            .from('studio_productions')
            .insert([{
                lesson_id: lessonId,
                title: lesson.title,
                status: 'rendering', 
                video_url: null
            }])
            .select()
            .single();

        if (dbError) throw dbError;

        // 3. Call the external AI Video API (Example using a generic HeyGen endpoint)
        // Note: Each API has slightly different payloads. Check your provider's docs.
        const apiResponse = await fetch('https://api.heygen.com/v2/video/generate', {
            method: 'POST',
            headers: {
                'X-Api-Key': process.env.VIDEO_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                video_inputs: [{
                    character: {
                        type: "avatar",
                        avatar_id: "Angela-inTshirt-20220820", // You get this ID from the API provider
                        avatar_style: "normal"
                    },
                    voice: {
                        type: "text",
                        input_text: `${lesson.title}. ${lesson.notes}`, // The script
                        voice_id: voice // e.g., "en-US-AriaNeural"
                    }
                }],
                dimension: { width: 1280, height: 720 }
            })
        });

        const apiData = await apiResponse.json();
        
        // Save the external API's video ID so we can check its progress later
        if (apiData.data && apiData.data.video_id) {
            await supabase
                .from('studio_productions')
                .update({ external_id: apiData.data.video_id })
                .eq('id', production.id);
        }

        res.json({ success: true, message: "AI is generating the video..." });
        
    } catch (err) { 
        console.error(err);
        res.status(500).json({ error: err.message }); 
    }
});
