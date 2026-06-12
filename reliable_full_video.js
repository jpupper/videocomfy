#!/usr/bin/env node
/**
 * reliable_full_video.js
 * 
 * Genera video completo usando HTTP polling directo a ComfyUI.
 * No depende de WebSocket de videocomfy - más confiable.
 * 
 * Uso: node reliable_full_video.js "tu idea" [duración_segundos]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const COMFY_HOST = '127.0.0.1';
const COMFY_PORT = 8188;
const COMFY_BASE = `http://${COMFY_HOST}:${COMFY_PORT}`;
const VIDEOCOMFY_URL = 'http://localhost:5634';

const PROJECT_DIR = __dirname;
const UPLOADS_DIR = path.join(PROJECT_DIR, 'public', 'uploads');
const VIDEOS_DIR = path.join(PROJECT_DIR, 'public', 'videos');

const IDEA = process.argv[2] || 'a teletubbie smoking in the beach founds a treasure';
const TARGET_DURATION = parseInt(process.argv[3]) || 60;
const CLIP_DURATION = 5;
const NUM_CLIPS = Math.max(Math.ceil(TARGET_DURATION / CLIP_DURATION), 3);

// ============================================
// COMFYUI HTTP HELPERS
// ============================================

function httpRequest(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { resolve(body); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function queuePrompt(workflow) {
  const data = JSON.stringify({ prompt: workflow, client_id: `client_${Date.now()}` });
  return httpRequest({
    hostname: COMFY_HOST, port: COMFY_PORT,
    path: '/prompt', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
  }, data);
}

function pollHistory(promptId, timeout = 1800000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (Date.now() - start > timeout) return reject(new Error(`Timeout ${timeout/1000}s`));
      httpRequest({ hostname: COMFY_HOST, port: COMFY_PORT, path: `/history/${promptId}`, method: 'GET' })
        .then(hist => {
          if (hist[promptId]) {
            const h = hist[promptId];
            if (h.status.completed) return resolve(h);
            if (h.status.error) return reject(new Error(`ComfyUI error: ${h.status.error}`));
          }
          setTimeout(poll, 2000);
        })
        .catch(() => setTimeout(poll, 2000));
    };
    poll();
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    http.get(url, res => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

function uploadToComfy(localPath, filename) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('image', fs.createReadStream(localPath), { filename });
    const headers = form.getHeaders();
    const req = http.request({
      hostname: COMFY_HOST, port: COMFY_PORT,
      path: '/upload/image', method: 'POST',
      headers
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('error', reject);
    form.pipe(req);
  });
}

// ============================================
// WORKFLOW LOADERS
// ============================================

function loadWorkflow(file) {
  const data = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, file), 'utf8'));
  // Normalize sg_XX_ prefixed node IDs
  for (const key of Object.keys(data)) {
    const m = key.match(/^sg_\d+_(.+)$/);
    if (m) { data[m[1]] = data[key]; delete data[key]; }
  }
  return data;
}

// ============================================
// GENERATION FUNCTIONS
// ============================================

async function generateFluxImage(prompt, index) {
  console.log(`\n[REL] 🖼️ FLUX #${index + 1}...`);
  const wf = loadWorkflow('flux_dev_full_text_to_image_api.json');
  // Set prompt - CLIPTextEncodeFlux uses clip_l and t5xxl
  for (const key of Object.keys(wf)) {
    const node = wf[key];
    if (node.class_type === 'CLIPTextEncodeFlux') {
      node.inputs.clip_l = prompt;
      node.inputs.t5xxl = prompt;
    }
    if (node.class_type === 'EmptySD3LatentImage' || node.class_type === 'EmptyLatentImage') {
      node.inputs.width = 768;
      node.inputs.height = 768;
    }
    if (node.class_type === 'KSampler') {
      node.inputs.steps = 20;
    }
  }
  
  const result = await queuePrompt(wf);
  if (result.error) throw new Error(`FLUX queue error: ${JSON.stringify(result.error)}`);
  console.log(`[REL] ⏳ Esperando imagen... (prompt_id: ${result.prompt_id.slice(0, 12)}...)`);
  
  const history = await pollHistory(result.prompt_id, 600000);
  
  // Find output file
  let filename = null;
  for (const nodeId of Object.keys(history.outputs)) {
    const out = history.outputs[nodeId];
    for (const key of ['images', 'gifs']) {
      if (out[key]) {
        const items = Array.isArray(out[key]) ? out[key] : [out[key]];
        for (const item of items) {
          filename = item.filename;
          const subfolder = item.subfolder || '';
          const type = item.type || 'output';
          const url = `${COMFY_BASE}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
          const dest = path.join(UPLOADS_DIR, filename);
          await downloadFile(url, dest);
          console.log(`[REL] ✅ Imagen #${index + 1}: ${filename}`);
          // Upload to ComfyUI input for I2V
          await uploadToComfy(dest, filename);
          return { filename, localPath: dest };
        }
      }
    }
  }
  throw new Error('No output image found in history');
}

async function generateI2VVideo(prompt, imageFilename, index) {
  console.log(`\n[REL] 🎬 I2V #${index + 1}...`);
  const wf = loadWorkflow('video_ltx2_i2v_api.json');
  
  // Set prompt
  for (const key of Object.keys(wf)) {
    const node = wf[key];
    if (node.class_type === 'CLIPTextEncode') {
      node.inputs.text = prompt;
    }
    if (node.class_type === 'KSampler') {
      node.inputs.steps = 20;
      node.inputs.cfg = 4.0;
    }
    // Set image input
    if (node.inputs && node.inputs.image === "input_image.png") {
      node.inputs.image = imageFilename;
    }
    // Set dimensions
    if (node.class_type === 'EmptyLatentImage' || node.class_type === 'EmptySD3LatentImage') {
      node.inputs.width = 768;
      node.inputs.height = 768;
    }
    // Set frame count
    if (node.inputs && node.inputs.frames !== undefined) {
      node.inputs.frames = 97;
    }
  }
  
  const result = await queuePrompt(wf);
  if (result.error) throw new Error(`I2V queue error: ${JSON.stringify(result.error)}`);
  console.log(`[REL] ⏳ Esperando video... (prompt_id: ${result.prompt_id.slice(0, 12)}...)`);
  
  const history = await pollHistory(result.prompt_id, 600000);
  
  // Find output file (video might be in 'images', 'gifs', or 'video' key)
  let filename = null;
  for (const nodeId of Object.keys(history.outputs)) {
    const out = history.outputs[nodeId];
    for (const key of ['video', 'gifs', 'images']) {
      if (out[key]) {
        const items = Array.isArray(out[key]) ? out[key] : [out[key]];
        for (const item of items) {
          const fn = item.filename;
          if (fn.endsWith('.mp4') || fn.endsWith('.webm')) {
            filename = fn;
            const subfolder = item.subfolder || '';
            const type = item.type || 'output';
            const url = `${COMFY_BASE}/view?filename=${encodeURIComponent(fn)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
            const dest = path.join(VIDEOS_DIR, fn);
            await downloadFile(url, dest);
            console.log(`[REL] ✅ Video #${index + 1}: ${fn}`);
            return { filename: fn, localPath: dest };
          }
        }
      }
    }
  }
  throw new Error('No output video found in history');
}

function callVideocomfyExport(clips) {
  return new Promise((resolve, reject) => {
    const spacing = TARGET_DURATION / clips.length;
    const timelineClips = clips.map((c, i) => ({
      filename: c.filename, prompt: c.prompt || '',
      startTime: Math.round(i * spacing * 10) / 10,
      duration: Math.round(CLIP_DURATION * 10) / 10,
      muted: false, track: 'V1'
    }));
    
    const data = JSON.stringify({ clips: timelineClips, batchId: `batch_${Date.now()}` });
    const options = {
      hostname: 'localhost', port: 5634,
      path: '/api/export-timeline', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = http.request(options, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (result.error) reject(new Error(`Export: ${result.error}`));
          else resolve(result);
        } catch(e) { reject(new Error(`Parse: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ============================================
// SCENE GENERATION
// ============================================

function generateScenes(idea) {
  const scenes = [
    { img: `${idea}, wide shot of a sunny beach with waves crashing`, vid: `${idea}, slow pan across the sandy beach` },
    { img: `${idea}, a Teletubbie character standing on the beach`, vid: `${idea}, the Teletubbie walks along the shoreline` },
    { img: `${idea}, close up Teletubbie smoking, looking relaxed`, vid: `${idea}, the Teletubbie takes a long drag, blows smoke` },
    { img: `${idea}, the Teletubbie notices something shiny in sand`, vid: `${idea}, the Teletubbie crouches down to investigate` },
    { img: `${idea}, close up of treasure chest in golden sand`, vid: `${idea}, camera zooms in on the treasure chest` },
    { img: `${idea}, the Teletubbie starts digging excitedly`, vid: `${idea}, the Teletubbie digs frantically, sand flying` },
    { img: `${idea}, treasure chest uncovered, ornate details`, vid: `${idea}, the Teletubbie brushes sand off the chest` },
    { img: `${idea}, the Teletubbie struggles to open the chest`, vid: `${idea}, the lid creaks open, golden light spills` },
    { img: `${idea}, chest filled with gold coins and jewels`, vid: `${idea}, camera pans over treasure, gems glinting` },
    { img: `${idea}, Teletubbie holds up gold coins triumphantly`, vid: `${idea}, the Teletubbie laughs joyfully` },
    { img: `${idea}, Teletubbie puts on a golden crown`, vid: `${idea}, the Teletubbie poses proudly with crown` },
    { img: `${idea}, golden sunset, Teletubbie smokes contentedly`, vid: `${idea}, final shot pulling back to the scene` }
  ];
  return scenes.slice(0, NUM_CLIPS);
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  🎬 VIDEO RELIABLE - HTTP POLLING      ║`);
  console.log(`║  Idea: "${IDEA.substring(0, 50)}..."`);
  console.log(`║  Target: ${TARGET_DURATION}s (${NUM_CLIPS} clips)`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  // Ensure directories exist
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

  const startTime = Date.now();
  const scenes = generateScenes(IDEA);
  const clips = [];

  for (let i = 0; i < scenes.length; i++) {
    const step = scenes[i];
    console.log(`\n━━━ [PASO ${i + 1}/${scenes.length}] ───────────────────`);

    // PHASE 1: Generate FLUX image
    try {
      const img = await generateFluxImage(step.img, i);
      // PHASE 2: Generate I2V video
      const vid = await generateI2VVideo(step.vid, img.filename, i);
      clips.push({ filename: vid.filename, prompt: step.vid });
      
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      console.log(`[REL] ✅ Paso ${i + 1}/${scenes.length} OK (${elapsed} min)`);
    } catch (err) {
      console.error(`[REL] ❌ Paso ${i + 1} falló: ${err.message}`);
      continue;
    }
  }

  if (clips.length === 0) {
    throw new Error('No se generó ningún clip');
  }

  console.log(`\n━━━ [EXPORT] Ensamblando timeline...`);
  const exportResult = await callVideocomfyExport(clips);
  const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  const localPath = path.join(VIDEOS_DIR, exportResult.filename);

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║     ✅ GENERACIÓN COMPLETA              ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  Tiempo: ${totalTime} min`);
  console.log(`║  Clips: ${clips.length}/${scenes.length}`);
  console.log(`║  Video: ${exportResult.filename}`);
  console.log(`║  Ruta: ${localPath}`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  // Output result JSON
  console.log('\n---RESULT_JSON---');
  console.log(JSON.stringify({
    success: true,
    filename: exportResult.filename,
    localPath: localPath,
    localUrl: `http://localhost:5634/videos/${exportResult.filename}`,
    clips: clips.length
  }));
  console.log('---END_RESULT_JSON---');
  
  // Save to temp file for agent access
  fs.writeFileSync(path.join(PROJECT_DIR, 'temp_video_result.json'), JSON.stringify({
    success: true,
    filename: exportResult.filename,
    localPath: localPath
  }, null, 2));

  return exportResult;
}

main().catch(err => {
  console.error(`\n[REL] ❌ FATAL: ${err.message}`);
  console.log('\n---RESULT_JSON---');
  console.log(JSON.stringify({ success: false, error: err.message }));
  console.log('---END_RESULT_JSON---');
  process.exit(1);
});
