const express = require('express');
const router = express.Router();
const db = require('../db');
const { EdgeTTS } = require('edge-tts');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

router.post('/generate/:lessonId', async (req, res) => {
    try {
        const { lessonId } = req.params;
        const { voice } = req.body;

        // 1. Fetch Lesson
        const lessonRes = await db.query('SELECT title, notes FROM lessons WHERE id = $1', [lessonId]);
        if (lessonRes.rows.length === 0) throw new Error("Lesson not found");
        const lesson = lessonRes.rows[0];

        // 2. Create DB Record
        const prodRes = await db.query(
            'INSERT INTO studio_productions (lesson_id, title, status) VALUES ($1, $2, $3) RETURNING id', 
            [lessonId, lesson.title, 'rendering']
        );
        const productionId = prodRes.rows[0].id;

        // Send response immediately so the frontend doesn't freeze
        res.json({ success: true, message: "Local AI is rendering the video..." });

        // --- THE HARDCODED AI BRAIN STARTS HERE ---
        
        // Generate unique file names
        const fileId = crypto.randomBytes(4).toString('hex');
        const audioPath = path.join(__dirname, `../../uploads/${fileId}.mp3`);
        const videoPath = path.join(__dirname, `../../uploads/${fileId}.mp4`);
        
        // A. Generate the Voiceover (Text to Speech)
        console.log(`[AI] Generating audio for: ${lesson.title}`);
        const tts = new EdgeTTS(lesson.notes || lesson.title, voice || 'en-US-AriaNeural');
        await tts.toFile(audioPath);

        // B. Generate the Video using FFmpeg
        console.log(`[AI] Rendering video...`);
        
        // You need a background image. Put a generic image in your backend/public folder.
        const backgroundImage = path.join(__dirname, `../../public/bg.jpg`); 

        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(backgroundImage)
                .input(audioPath)
                .inputOptions(['-loop 1']) // Loop the image
                .outputOptions([
                    '-c:v libx264',
                    '-tune stillimage',
                    '-c:a aac',
                    '-b:a 192k',
                    '-pix_fmt yuv420p',
                    '-shortest' // Finish video when audio ends
                ])
                .save(videoPath)
                .on('end', () => {
                    console.log(`[AI] Video finished: ${videoPath}`);
                    resolve();
                })
                .on('error', (err) => {
                    console.error(`[AI] FFmpeg Error:`, err);
                    reject(err);
                });
        });

        // C. Update the Database with the new local video URL
        // Assuming your server serves the /uploads folder statically
        const videoUrl = `https://nexora-api-sskg.onrender.com/uploads/${fileId}.mp4`;
        
        await db.query(
            'UPDATE studio_productions SET status = $1, video_url = $2 WHERE id = $3', 
            ['ready', videoUrl, productionId]
        );

        // Clean up the temporary audio file
        fs.unlinkSync(audioPath);
        console.log(`[AI] Job complete for: ${lesson.title}`);

    } catch (err) { 
        console.error("[AI Error]", err);
        // You might want to update the DB to 'failed' here if something crashes
    }
});

module.exports = router;
