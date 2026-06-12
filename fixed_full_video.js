#!/usr/bin/env node
/**
 * fixed_full_video.js
 * 
 * Genera video completo usando HTTP polling directo a ComfyUI.
 * CORREGIDA: la normalización de sg_XX_YYYY actualiza también las conexiones.
 * 
 * Uso: node fixed_full_video.js "tu idea" [duración_segundos]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const COMFY_HOST = '127.0.0.1';
const COMFY_PORT = 8188;
const COMFY_BASE = `http://${COMFY_HOST}:${COMFY_PORT}`;

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
// WORKFLOW LOADER - CORREGIDO
// ============================================

function loadWorkflow(file) {
  const raw = fs.readFileSync(path.join(PROJECT_DIR, file), 'utf8');
  const data = JSON.parse(raw);

  // Paso 1: Identificar y renombrar sg_XX_YYYY -> YYYY
  const renameMap = {};
  for (const key of Object.keys(data)) {
    const m = key.match(/^sg_\d+_(.+)$/);
    if (m) {
      renameMap[key] = m[1];
    }
  }

  // Paso 2: Renombrar claves
  for (const [oldKey, newKey] of Object.entries(renameMap)) {
    data[newKey] = data[oldKey];
    delete data[oldKey];
  }

  // Paso 3: Actualizar TODAS las referencias en inputs
  for (const key of Object.keys(data)) {
    const node = data[key];
    if (!node.inputs) continue;
    fixConnections(node.inputs, renameMap);
  }

  return data;
}

function fixConnections(obj, renameMap) {
  if (typeof obj !== 'object' || obj === null) return;
  
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (i === 0 && typeof obj[0] === 'string' && renameMap[obj[0]]) {
        obj[0] = renameMap[obj[0]];
      } else if (Array.isArray(obj[i])) {
        fixConnections(obj[i], renameMap);
      }
    }
  } else {
    for (const val of Object.values(obj)) {
      if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'string') {
        // ComfyUI connection format: [node_id, output_index]
        if (renameMap[val[0]]) {
          val[0] = renameMap[val[0]];
        }
      } else if (Array.isArray(val)) {
        fixConnections(val, renameMap);
      } else if (typeof val === 'object' && val !== null) {
        fixConnections(val, renameMap);
      }
    }
  }
}

// ============================================
// GENERATION FUNCTIONS
// ============================================

async function generateFluxImage(prompt, index) {
  console.log(`\n[FIX] 🖼️ FLUX #${index + 1}...`);
  const wf = loadWorkflow('flux_dev_full_text_to_image_api.json');
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
  console.log(`[FIX] ⏳ Esperando imagen... (prompt_id: ${result.prompt_id.slice(0, 12)}...)`);
  
  const history = await pollHistory(result.prompt_id, 600000);
  
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
          console.log(`[FIX] ✅ Imagen #${index + 1}: ${filename}`);
          await uploadToComfy(dest, filename);
          return { filename, localPath: dest };
        }
      }
    }
  }
  throw new Error('No output image found in history');
}

async function generateI2VVideo(prompt, imageFilename, index) {
  console.log(`\n[FIX] 🎬 I2V #${index + 1}...`);
  const wf = loadWorkflow('video_ltx2_i2v_api.json');
  
  // Set prompt and image
  for (const key of Object.keys(wf)) {
    const node = wf[key];
    if (node.class_type === 'CLIPTextEncode') {
      node.inputs.text = prompt;
    }
    if (node.class_type === 'KSampler') {
      node.inputs.steps = 20;
      node.inputs.cfg = 4.0;
    }
    if (node.class_type === 'LoadImage') {
      node.inputs.image = imageFilename;
    }
    if (node.class_type === 'EmptyLTXVLatentVideo') {
      node.inputs.batch_size = 768;
    }
  }
  
  const result = await queuePrompt(wf);
  if (result.error) throw new Error(`I2V queue error: ${JSON.stringify(result.error)}`);
  console.log(`[FIX] ⏳ Esperando video... (prompt_id: ${result.prompt_id.slice(0, 12)}...)`);
  
  const history = await pollHistory(result.prompt_id, 600000);
  
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
            console.log(`[FIX] ✅ Video #${index + 1}: ${fn}`);
            return { filename: fn, localPath: dest };
          }
        }
      }
    }
  }
  throw new Error('No output video found in history');
}

// ============================================
// SCENE GENERATION
// ============================================

function generateScenes(idea) {
  return [
    { img: `${idea}, wide shot of a sunny beach with waves crashing`, vid: `${idea}, slow pan across the sandy beach, gentle waves rolling in` },
    { img: `${idea}, a Teletubbie character standing on the beach with a cigarette`, vid: `${idea}, the Teletubbie walks slowly along the shoreline` },
    { img: `${idea}, close up Teletubbie smoking, looking relaxed and happy`, vid: `${idea}, the Teletubbie takes a long drag and blows smoke rings` },
    { img: `${idea}, the Teletubbie notices something shiny in the sand`, vid: `${idea}, the Teletubbie crouches down to investigate the shiny object` },
    { img: `${idea}, close up of a treasure chest half buried in golden sand`, vid: `${idea}, camera zooms in on the treasure chest glinting in sunlight` },
    { img: `${idea}, the Teletubbie starts digging excitedly in the sand`, vid: `${idea}, the Teletubbie digs frantically, sand flying everywhere` },
    { img: `${idea}, treasure chest fully uncovered with ornate carvings`, vid: `${idea}, the Teletubbie carefully brushes sand off the ornate chest` },
    { img: `${idea}, the Teletubbie struggles to open the heavy treasure chest`, vid: `${idea}, the lid creaks open slowly, golden light spills out` },
    { img: `${idea}, chest filled with gold coins and sparkling jewels`, vid: `${idea}, camera pans over the treasure, gems glinting` },
    { img: `${idea}, Teletubbie holds up gold coins triumphantly laughing`, vid: `${idea}, the Teletubbie laughs joyfully holding coins` },
    { img: `${idea}, Teletubbie puts on a golden crown and admires it`, vid: `${idea}, the Teletubbie poses proudly wearing the golden crown` },
    { img: `${idea}, golden sunset, Teletubbie smokes contentedly by treasure`, vid: `${idea}, final shot pulling back, Teletubbie and treasure in golden light` }
  ].slice(0, NUM_CLIPS);
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  🎬 FIXED VIDEO - HTTP POLLING         ║`);
  console.log(`║  Idea: "${IDEA.substring(0, 50)}..."`);
  console.log(`║  Target: ${TARGET_DURATION}s (${NUM_CLIPS} clips)`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

  const startTime = Date.now();
  const scenes = generateScenes(IDEA);
  const clips = [];

  for (let i = 0; i < scenes.length; i++) {
    const step = scenes[i];
    console.log(`\n━━━ [PASO ${i + 1}/${scenes.length}] ───────────────────`);

    try {
      const img = await generateFluxImage(step.img, i);
      const vid = await generateI2VVideo(step.vid, img.filename, i);
      clips.push({ filename: vid.filename, prompt: step.vid });
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      console.log(`[FIX] ✅ Paso ${i + 1}/${scenes.length} OK (${elapsed} min)`);
    } catch (err) {
      console.error(`[FIX] ❌ Paso ${i + 1} falló: ${err.message}`);
      continue;
    }
  }

  if (clips.length === 0) {
    throw new Error('No se generó ningún clip');
  }

  console.log(`\n━━━ [RESUMEN] ───────────────────`);
  console.log(`Clips generados: ${clips.length}/${scenes.length}`);
  clips.forEach((c, i) => console.log(`  Clip ${i+1}: ${c.filename}`));

  const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\nTiempo total: ${totalTime} min`);

  console.log('\n---RESULT_JSON---');
  console.log(JSON.stringify({
    success: true,
    clips: clips.map(c => c.filename),
    totalTime: totalTime + ' min'
  }));
  console.log('---END_RESULT_JSON---');

  return clips;
}

main().catch(err => {
  console.error(`\n[FIX] ❌ FATAL: ${err.message}`);
  console.log('\n---RESULT_JSON---');
  console.log(JSON.stringify({ success: false, error: err.message }));
  console.log('---END_RESULT_JSON---');
  process.exit(1);
});
