const express = require('express');
const router = express.Router();
const db = require('../db'); 
const fetch = require('node-fetch');

// ⚠️ PASTE YOUR PYTHON URL HERE
const PYTHON_BRAIN_URL = 'https://nexora-studio-brain.onrender.com';

router.post('/generate/:lessonId', async (req, res) => {
    try {
        const { lessonId } = req.params;

        // 1. Fetch the lesson notes from Node.js database
        const lessonRes = await db.query('SELECT title, notes FROM lessons WHERE id = $1', [lessonId]);
        if (lessonRes.rows.length === 0) return res.status(404).json({ error: "Lesson not found" });
        
        const lesson = lessonRes.rows[0];

        // 2. Send the lesson to the Python Brain
        console.log(`[Bridge] Sending lesson "${lesson.title}" to Python Brain...`);
        
        const pythonRes = await fetch(`${PYTHON_BRAIN_URL}/api/receive-lesson`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                lesson_id: lessonId,
                title: lesson.title,
                notes: lesson.notes || lesson.title
            })
        });

        if (!pythonRes.ok) {
            throw new Error("Python Brain failed to accept the job.");
        }

        // 3. Return success to Vercel Studio Portal
        res.json({ success: true, message: "Sent to AI Brain for rendering." });

    } catch (err) { 
        console.error("[Bridge Error]", err);
        res.status(500).json({ error: err.message }); 
    }
});

// Keep your existing /dashboard, /productions, and /approve routes exactly as they are!
module.exports = router;
