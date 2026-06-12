#!/usr/bin/env node
/**
 * pipeline_final.js
 * 
 * Pipeline completo: FLUX image -> minimal I2V video -> loop 12 clips
 * Usa HTTP polling directo a ComfyUI. Sin audio, workflow minimal.
 * 
 * Uso: node pipeline_final.js "tu idea" [duración_segundos]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1', PORT = 8188;
const BASE = `http://${HOST}:${PORT}`;
const PROJ = __dirname;
const UPLOADS = path.join(PROJ, 'public', 'uploads');
const VIDEOS = path.join(PROJ, 'public', 'videos');

const IDEA = process.argv[2] || 'a teletubbie smoking in the beach founds a treasure';
const TARGET = parseInt(process.argv[3]) || 60;
const CLIPS = Math.max(Math.ceil(TARGET / 5), 3);

// ============================================
// HTTP HELPERS
// ============================================

function req(opts, data) {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(b); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function queuePrompt(wf) {
  const d = JSON.stringify({ prompt: wf, client_id: `pipe_${Date.now()}` });
  return req({
    hostname: HOST, port: PORT, path: '/prompt', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) }
  }, d);
}

function pollHistory(pid, timeout = 1800000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (Date.now() - start > timeout) return reject(new Error(`Timeout ${timeout / 1000}s`));
      req({ hostname: HOST, port: PORT, path: `/history/${pid}`, method: 'GET' })
        .then(h => {
          if (h[pid]) {
            if (h[pid].status.completed) return resolve(h[pid]);
            if (h[pid].status.error) return reject(new Error(JSON.stringify(h[pid].status.error)));
          }
          setTimeout(poll, 2000);
        }).catch(() => setTimeout(poll, 2000));
    };
    poll();
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const f = fs.createWriteStream(dest);
    http.get(url, res => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      res.pipe(f);
      f.on('finish', () => f.close(resolve));
    }).on('error', reject);
  });
}

function uploadToComfy(localPath, filename) {
  return new Promise((resolve, reject) => {
    const { execSync } = require('child_process');
    const cmd = `curl -s -X POST "http://${HOST}:${PORT}/upload/image" -F "image=@${localPath.replace(/\\/g, '/')}"`;
    try { resolve(execSync(cmd, { encoding: 'utf8', timeout: 30000 })); }
    catch (e) { reject(e); }
  });
}

// ============================================
// WORKFLOWS
// ============================================

function getFluxWorkflow(prompt) {
  const wf = JSON.parse(fs.readFileSync(path.join(PROJ, 'flux_dev_full_text_to_image_api.json'), 'utf8'));
  for (const node of Object.values(wf)) {
    if (node.class_type === 'CLIPTextEncodeFlux') { node.inputs.clip_l = prompt; node.inputs.t5xxl = prompt; }
    if (node.class_type === 'EmptySD3LatentImage' || node.class_type === 'EmptyLatentImage') { node.inputs.width = 768; node.inputs.height = 768; }
    if (node.class_type === 'KSampler') { node.inputs.steps = 20; }
  }
  return wf;
}

function getI2VWorkflow(prompt, imageName) {
  // Use the ltx_i2v_minimal_api.json workflow
  const wf = JSON.parse(fs.readFileSync(path.join(PROJ, 'ltx_i2v_minimal_api.json'), 'utf8'));
  for (const node of Object.values(wf)) {
    if (node.class_type === 'CLIPTextEncode' && node.inputs.text && node.inputs.text.length > 20) {
      node.inputs.text = prompt;
    }
    if (node.class_type === 'LoadImage') { node.inputs.image = imageName; }
  }
  return wf;
}

// ============================================
// SCENES
// ============================================

function getScenes(idea) {
  return [
    { img: `${idea}, wide shot of a sunny beach with waves crashing, cinematic`, vid: `${idea}, slow pan across the sandy beach, gentle waves rolling in, cinematic` },
    { img: `${idea}, a Teletubbie character standing on the beach, smoking a cigarette`, vid: `${idea}, the Teletubbie walks slowly along the shoreline, gentle motion` },
    { img: `${idea}, close up Teletubbie smoking, looking relaxed and happy`, vid: `${idea}, the Teletubbie takes a long drag and blows smoke rings, slow motion` },
    { img: `${idea}, the Teletubbie notices something shiny in the sand`, vid: `${idea}, the Teletubbie crouches down to investigate the shiny object` },
    { img: `${idea}, close up of a treasure chest half buried in golden sand`, vid: `${idea}, camera zooms in on the treasure chest glinting in sunlight` },
    { img: `${idea}, the Teletubbie starts digging excitedly in the sand`, vid: `${idea}, the Teletubbie digs enthusiastically, sand flying` },
    { img: `${idea}, treasure chest fully uncovered with ornate carvings`, vid: `${idea}, the Teletubbie brushes sand off the ornate chest slowly` },
    { img: `${idea}, the Teletubbie struggles to open the heavy treasure chest`, vid: `${idea}, the lid creaks open slowly, golden light spills out` },
    { img: `${idea}, chest filled with gold coins and sparkling jewels`, vid: `${idea}, camera pans over the treasure, gems glinting in sunlight` },
    { img: `${idea}, Teletubbie holds up gold coins triumphantly, laughing`, vid: `${idea}, the Teletubbie laughs joyfully holding coins up` },
    { img: `${idea}, Teletubbie puts on a golden crown and admires it`, vid: `${idea}, the Teletubbie poses proudly wearing the golden crown` },
    { img: `${idea}, golden sunset, Teletubbie sits contentedly by treasure`, vid: `${idea}, final shot pulling back, Teletubbie with treasure in golden light` }
  ].slice(0, CLIPS);
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  🎬 FINAL PIPELINE                     ║`);
  console.log(`║  ${IDEA.substring(0, 45)}`);
  console.log(`║  ${CLIPS} clips (target ${TARGET}s)`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });
  if (!fs.existsSync(VIDEOS)) fs.mkdirSync(VIDEOS, { recursive: true });

  const scenes = getScenes(IDEA);
  const clips = [];
  const startTime = Date.now();

  for (let i = 0; i < scenes.length; i++) {
    console.log(`\n━━━ [PASO ${i + 1}/${scenes.length}] ───────────────────`);
    
    try {
      // PHASE 1: FLUX Image
      console.log(`[${i + 1}] 🖼️ FLUX...`);
      const fluxWf = getFluxWorkflow(scenes[i].img);
      const fluxResult = await queuePrompt(fluxWf);
      if (fluxResult.error) throw new Error(`FLUX: ${JSON.stringify(fluxResult.error)}`);
      console.log(`[${i + 1}] ⏳ FLUX (${fluxResult.prompt_id.slice(0, 10)}...)`);
      
      const fluxHist = await pollHistory(fluxResult.prompt_id, 900000); // 15 min for FLUX
      
      // Find and download FLUX image
      let fluxFile = null;
      for (const nodeId of Object.keys(fluxHist.outputs)) {
        const out = fluxHist.outputs[nodeId];
        for (const key of ['images', 'gifs']) {
          if (out[key]) {
            const items = Array.isArray(out[key]) ? out[key] : [out[key]];
            for (const item of items) {
              fluxFile = item.filename;
              const subfolder = item.subfolder || '';
              const type = item.type || 'output';
              const url = `${BASE}/view?filename=${encodeURIComponent(fluxFile)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
              const dest = path.join(UPLOADS, fluxFile);
              await downloadFile(url, dest);
              console.log(`[${i + 1}] ✅ FLUX: ${fluxFile}`);
              // Upload to ComfyUI input
              await uploadToComfy(dest, fluxFile);
              break;
            }
          }
          if (fluxFile) break;
        }
        if (fluxFile) break;
      }
      if (!fluxFile) throw new Error('No FLUX output found');

      // PHASE 2: I2V Video
      console.log(`[${i + 1}] 🎬 I2V...`);
      const i2vWf = getI2VWorkflow(scenes[i].vid, fluxFile);
      const i2vResult = await queuePrompt(i2vWf);
      if (i2vResult.error) throw new Error(`I2V: ${JSON.stringify(i2vResult.error)}`);
      console.log(`[${i + 1}] ⏳ I2V (${i2vResult.prompt_id.slice(0, 10)}...)`);

      const i2vHist = await pollHistory(i2vResult.prompt_id, 1800000); // 30 min for I2V video

      // Find output video
      let vidFile = null;
      for (const nodeId of Object.keys(i2vHist.outputs)) {
        const out = i2vHist.outputs[nodeId];
        for (const key of ['video', 'gifs', 'images']) {
          if (out[key]) {
            const items = Array.isArray(out[key]) ? out[key] : [out[key]];
            for (const item of items) {
              const fn = item.filename;
              if (fn.endsWith('.mp4') || fn.endsWith('.webm')) {
                vidFile = fn;
                const subfolder = item.subfolder || '';
                const type = item.type || 'output';
                const url = `${BASE}/view?filename=${encodeURIComponent(fn)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
                const dest = path.join(VIDEOS, fn);
                await downloadFile(url, dest);
                console.log(`[${i + 1}] ✅ I2V: ${fn} (${((fs.statSync(dest).size) / 1024).toFixed(0)} KB)`);
                clips.push({ filename: fn, localPath: dest });
                break;
              }
            }
          }
          if (vidFile) break;
        }
        if (vidFile) break;
      }
      if (!vidFile) throw new Error('No video output found');

      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      console.log(`[${i + 1}] ✅ Paso ${i + 1} completo (${elapsed} min)`);

    } catch (err) {
      console.error(`[${i + 1}] ❌ Error: ${err.message}`);
      continue;
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  
  console.log(`\n━━━ [RESUMEN FINAL] ───────────────────`);
  console.log(`Clips: ${clips.length}/${scenes.length}`);
  console.log(`Tiempo: ${totalTime} min`);
  clips.forEach((c, i) => console.log(`  ${i + 1}. ${c.filename}`));

  console.log('\n---RESULT_JSON---');
  console.log(JSON.stringify({ success: true, clips: clips.map(c => c.filename), totalTime }));
  console.log('---END_RESULT_JSON---');
}

main().catch(err => {
  console.error(`\n❌ FATAL: ${err.message}`);
  console.log('\n---RESULT_JSON---');
  console.log(JSON.stringify({ success: false, error: err.message }));
  console.log('---END_RESULT_JSON---');
  process.exit(1);
});
