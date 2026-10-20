// backend/src/studio/generate.js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const FFMPEG  = require('ffmpeg-static');
const FFPROBE = require('@ffprobe-installer/ffprobe').path;

const CONFIG = {
  DATABASE_URL:         process.env.DATABASE_URL,
  SUPABASE_URL:         process.env.SUPABASE_URL,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
  SUPABASE_BUCKET:      process.env.SUPABASE_BUCKET || 'nexora-videos',
  WIDTH:                1280,
  HEIGHT:               720,
  FPS:                  30,
  FONT:                 'C\\:/Windows/Fonts/arialbd.ttf', // Use '/System/Library/Fonts/Supplemental/Arial Bold.ttf' if on Mac
  ASSETS_DIR:           path.join(__dirname, 'assets'),
  
  // AI VOICES (Free Microsoft Neural Voices)
  INTRO_VOICE:          'en-US-AriaNeural',
  SECTION_VOICE:        'en-US-AriaNeural',
  OUTRO_VOICE:          'en-US-AriaNeural',
  INTRO_TEXT:           "Welcome to Nexora Academy. Let's begin this lesson.",
  OUTRO_TEXT:           'Thank you for watching. See you in the next lesson.',
  
  WORDS_PER_SECTION:    70, 
  MAX_SECTIONS:         6,
  MIN_SECTIONS:         3,
};

function assetsPath(name) { return path.join(CONFIG.ASSETS_DIR, name); }

function validateAssets() {
  const required = [
    'images/intro.png', 'images/outro.png',
    'images/bg-1.png', 'images/bg-2.png', 'images/bg-3.png',
    'images/bg-4.png', 'images/bg-5.png',
    'audio/music.mp3',
  ];
  const missing = required.filter(f => !fs.existsSync(assetsPath(f)));
  if (missing.length) throw new Error('Missing assets: ' + missing.join(', '));
}

function wrap(text, maxChars) {
  const words = String(text).split(/\s+/);
  const lines = []; let line = '';
  for (const w of words) {
    if (!line) { line = w; continue; }
    if ((line + ' ' + w).length > maxChars) { lines.push(line); line = w; }
    else { line += ' ' + w; }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

function probeDuration(file) {
  const out = execSync(`"${FFPROBE}" -v quiet -print_format json -show_format "${file}"`).toString();
  return parseFloat(JSON.parse(out).format.duration);
}

async function synthesize(text, voice, outPath) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (!clean) throw new Error('Empty text for TTS');
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(clean);
  await pipeline(audioStream, fs.createWriteStream(outPath));
  return outPath;
}

function splitIntoSections(text) {
  const clean = String(text || '').trim();
  if (!clean) return [{ title: 'Overview', body: 'This lesson covers the topic.' }];
  let chunks = clean.split(/\n{2,}/).map(s => s.trim()).filter(s => s.length > 20);
  if (chunks.length < 3) chunks = clean.replace(/\n+/g, ' ').split(/(?<=[.!?])\s+/).filter(s => s.length > 25);
  const targetCount = Math.min(CONFIG.MAX_SECTIONS, Math.max(CONFIG.MIN_SECTIONS, Math.ceil(chunks.length / 2)));
  const wordsPerSection = Math.max(CONFIG.WORDS_PER_SECTION, Math.ceil(clean.split(/\s+/).length / targetCount));
  
  const sections = []; let buffer = []; let wc = 0;
  for (const c of chunks) {
    buffer.push(c); wc += c.split(/\s+/).length;
    if (wc >= wordsPerSection && sections.length < CONFIG.MAX_SECTIONS - 1) {
      const body = buffer.join(' ').trim();
      const title = body.split(/\s+/).slice(0, 8).join(' ').replace(/[.,;:!?]+$/, '');
      sections.push({ title, body }); buffer = []; wc = 0;
    }
  }
  if (buffer.length && sections.length < CONFIG.MAX_SECTIONS) {
    const body = buffer.join(' ').trim();
    sections.push({ title: body.split(/\s+/).slice(0, 8).join(' '), body });
  }
  return sections;
}

function renderImageClip({ image, audio, out }) {
  const dur = probeDuration(audio);
  execSync(`"${FFMPEG}" -y -loop 1 -t ${dur} -i "${image}" -i "${audio}" -c:v libx264 -preset veryfast -pix_fmt yuv420p -r ${CONFIG.FPS} -c:a aac -b:a 128k -ar 44100 -t ${dur} "${out}"`, { stdio: 'ignore' });
  return dur;
}

function renderSectionClip({ image, audio, title, body, out }) {
  const dur = probeDuration(audio);
  const titleTxt = out.replace('.mp4', '-t.txt'); const bodyTxt = out.replace('.mp4', '-b.txt');
  fs.writeFileSync(titleTxt, wrap(title, 28)); fs.writeFileSync(bodyTxt, wrap(body.slice(0, 400), 52));
  const titleSize = Math.round(CONFIG.HEIGHT / 15); const bodySize = Math.round(CONFIG.HEIGHT / 30);
  const safe = p => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  
  const filter = `scale=${CONFIG.WIDTH}:${CONFIG.HEIGHT},` +
    `drawtext=fontfile='${CONFIG.FONT}':textfile='${safe(titleTxt)}':fontcolor=white:fontsize=${titleSize}:x=(w-text_w)/2:y=h*0.26:line_spacing=8,` +
    `drawtext=fontfile='${CONFIG.FONT}':textfile='${safe(bodyTxt)}':fontcolor=white@0.9:fontsize=${bodySize}:x=(w-text_w)/2:y=h*0.46:line_spacing=6`;

  execSync(`"${FFMPEG}" -y -loop 1 -t ${dur} -i "${image}" -i "${audio}" -vf "${filter}" -c:v libx264 -preset veryfast -pix_fmt yuv420p -r ${CONFIG.FPS} -c:a aac -b:a 128k -t ${dur} "${out}"`, { stdio: 'ignore' });
  fs.unlinkSync(titleTxt); fs.unlinkSync(bodyTxt);
  return dur;
}

async function main() {
  const lessonId = process.argv[2];
  if (!lessonId) throw new Error('No lesson ID');
  validateAssets();

  const db = new Client({ connectionString: CONFIG.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const r = await db.query(`SELECT l.id, l.title, l.description, l.notes, c.title AS course_title FROM lessons l JOIN modules m ON m.id = l.module_id JOIN courses c ON c.id = m.course_id WHERE l.id = $1`, [lessonId]);
  if (!r.rows.length) throw new Error('Lesson not found');
  const lesson = r.rows[0];

  await db.query(`UPDATE lessons SET video_status='rendering', video_error=NULL WHERE id=$1`, [lessonId]);

  const work = path.join(__dirname, 'work', lessonId);
  fs.mkdirSync(work, { recursive: true });
  const clips = [];

  try {
    const sections = splitIntoSections(lesson.notes || lesson.description);
    
    // Intro
    const introAudio = path.join(work, 'intro.mp3'); await synthesize(CONFIG.INTRO_TEXT, CONFIG.INTRO_VOICE, introAudio);
    const introClip = path.join(work, '00.mp4'); renderImageClip({ image: assetsPath('images/intro.png'), audio: introAudio, out: introClip }); clips.push(introClip);

    // Sections
    const bgs = [1,2,3,4,5].map(i => assetsPath(`images/bg-${i}.png`));
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const audio = path.join(work, `sec-${i+1}.mp3`); await synthesize(s.body, CONFIG.SECTION_VOICE, audio);
      const clip = path.join(work, `${String(i+1).padStart(2,'0')}.mp4`); renderSectionClip({ image: bgs[i % bgs.length], audio, title: s.title, body: s.body, out: clip }); clips.push(clip);
    }

    // Outro
    const outroAudio = path.join(work, 'outro.mp3'); await synthesize(CONFIG.OUTRO_TEXT, CONFIG.OUTRO_VOICE, outroAudio);
    const outroClip = path.join(work, '99.mp4'); renderImageClip({ image: assetsPath('images/outro.png'), audio: outroAudio, out: outroClip }); clips.push(outroClip);

    // Concat
    const concatTxt = path.join(work, 'concat.txt');
    fs.writeFileSync(concatTxt, clips.map(f => `file '${f.replace(/\\/g,'/').replace(/'/g,"'\\''")}'`).join('\n'));
    const silent = path.join(work, 'silent.mp4');
    execSync(`"${FFMPEG}" -y -f concat -safe 0 -i "${concatTxt}" -c copy "${silent}"`, { stdio: 'ignore' });

    // Mix Music
    const totalDur = probeDuration(silent);
    const final = path.join(work, 'final.mp4');
    execSync(`"${FFMPEG}" -y -i "${silent}" -stream_loop -1 -i "${assetsPath('audio/music.mp3')}" -filter_complex "[1:a]volume=0.12,afade=t=out:st=${Math.max(0, totalDur-3)}:d=3[m];[0:a][m]amix=inputs=2:duration=first[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 128k -shortest "${final}"`, { stdio: 'ignore' });

    // Upload
    const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_SERVICE_KEY);
    const uploadName = `lessons/${lessonId}-${Date.now()}.mp4`;
    const { error } = await supabase.storage.from(CONFIG.SUPABASE_BUCKET).upload(uploadName, fs.readFileSync(final), { contentType: 'video/mp4', upsert: true });
    if (error) throw new Error(error.message);

    const { data: pub } = supabase.storage.from(CONFIG.SUPABASE_BUCKET).getPublicUrl(uploadName);

    await db.query(`UPDATE lessons SET video_url=$1, video_status='done', video_generated_at=NOW() WHERE id=$2`, [pub.publicUrl, lessonId]);
    fs.rmSync(work, { recursive: true, force: true });
    console.log('✅ Done:', pub.publicUrl);

  } catch (err) {
    await db.query(`UPDATE lessons SET video_status='failed', video_error=$1 WHERE id=$2`, [err.message.slice(0,500), lessonId]);
    throw err;
  } finally {
    await db.end();
  }
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
