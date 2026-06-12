#!/usr/bin/env node
/**
 * generate_reliable.js
 * 
 * FLUX via HTTP polling directo a ComfyUI ✓
 * I2V via WebSocket a videocomfy, polling HTTP a ComfyUI ✓
 * Export timeline via videocomfy HTTP ✓
 * 
 * Uso: node generate_reliable.js "tu idea" [duración_segundos]
 */

const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const COMFY_URI = 'http://127.0.0.1:8188';
const VCOMFY_WS = 'ws://localhost:5634';
const VCOMFY_HTTP = 'http://localhost:5634';

const PROJ = __dirname;
const UPLOADS = path.join(PROJ, 'public', 'uploads');
const VIDEOS = path.join(PROJ, 'public', 'videos');
[UPLOADS, VIDEOS].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const IDEA = process.argv[2] || 'a teletubbie smoking in the beach founds a treasure';
const DUR = parseInt(process.argv[3]) || 60;
const CLIP_LEN = 5;
const N = Math.max(Math.ceil(DUR / CLIP_LEN), 3);

// Scenes
const SCENES = [
  {img:`${IDEA}, wide shot of a sunny beach with waves`, vid:`${IDEA}, slow pan across the sandy beach`},
  {img:`${IDEA}, a Teletubbie character standing on the beach`, vid:`${IDEA}, the Teletubbie walks along the shoreline`},
  {img:`${IDEA}, close up Teletubbie smoking, looking relaxed`, vid:`${IDEA}, the Teletubbie takes a long drag, blows smoke`},
  {img:`${IDEA}, the Teletubbie notices something shiny in sand`, vid:`${IDEA}, the Teletubbie crouches down to investigate`},
  {img:`${IDEA}, close up of treasure chest in golden sand`, vid:`${IDEA}, camera zooms in on the treasure chest`},
  {img:`${IDEA}, the Teletubbie starts digging excitedly`, vid:`${IDEA}, the Teletubbie digs frantically, sand flying`},
  {img:`${IDEA}, treasure chest uncovered, ornate details`, vid:`${IDEA}, the Teletubbie brushes sand off the chest`},
  {img:`${IDEA}, the Teletubbie struggles to open the chest`, vid:`${IDEA}, the lid creaks open, golden light spills`},
  {img:`${IDEA}, chest filled with gold coins and jewels`, vid:`${IDEA}, camera pans over treasure, gems glinting`},
  {img:`${IDEA}, Teletubbie holds up gold coins triumphantly`, vid:`${IDEA}, the Teletubbie laughs joyfully`},
  {img:`${IDEA}, Teletubbie puts on a golden crown`, vid:`${IDEA}, the Teletubbie poses proudly with crown`},
  {img:`${IDEA}, golden sunset, Teletubbie smokes contentedly`, vid:`${IDEA}, final shot pulling back to the scene`}
].slice(0, N);

// HTTP helper
function req(opts, data) {
  return new Promise((res, rej) => {
    const r = http.request(opts, r2 => { let b=''; r2.on('data',c=>b+=c); r2.on('end',()=>{ try { res(JSON.parse(b)); } catch(e) { res(b); } }); });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}

function download(url, dest) {
  return new Promise((res, rej) => {
    const f = fs.createWriteStream(dest);
    http.get(url, r => { if(r.statusCode!==200) return rej(new Error(`HTTP ${r.statusCode}`)); r.pipe(f); f.on('finish',()=>f.close(res)); }).on('error', rej);
  });
}

function uploadImage(path, fn) {
  return new Promise((res, rej) => {
    const f = new FormData(); f.append('image', fs.createReadStream(path), {filename: fn});
    const h = f.getHeaders();
    const r = http.request({hostname:'127.0.0.1',port:8188,path:'/upload/image',method:'POST',headers:h}, r2 => { let b=''; r2.on('data',c=>b+=c); r2.on('end',()=>res(b)); });
    r.on('error', rej); f.pipe(r);
  });
}

function pollHistory(pid, timeout=1800000) {
  const start = Date.now();
  return new Promise((res, rej) => {
    const poll = () => {
      if (Date.now()-start > timeout) return rej(new Error(`Timeout ${timeout/1000}s`));
      req({hostname:'127.0.0.1',port:8188,path:`/history/${pid}`,method:'GET'}).then(h => {
        if (h[pid]) { 
          if (h[pid].status.completed) return res(h[pid]);
          if (h[pid].status.error) return rej(new Error(`Comfy error: ${JSON.stringify(h[pid].status.error)}`));
        }
        setTimeout(poll, 2000);
      }).catch(() => setTimeout(poll, 2000));
    };
    poll();
  });
}

function extractFile(history) {
  for (const nid of Object.keys(history.outputs)) {
    const o = history.outputs[nid];
    for (const key of ['video','gifs','images']) {
      if (o[key]) {
        const items = Array.isArray(o[key]) ? o[key] : [o[key]];
        for (const item of items) {
          const fn = item.filename;
          const sf = item.subfolder||'';
          const t = item.type||'output';
          const url = `${COMFY_URI}/view?filename=${encodeURIComponent(fn)}&subfolder=${encodeURIComponent(sf)}&type=${encodeURIComponent(t)}`;
          return { filename: fn, url, item };
        }
      }
    }
  }
  return null;
}

// STEP 1: FLUX image via HTTP polling
async function genImage(prompt, idx) {
  console.log(`[GEN] 🖼️ FLUX #${idx+1}...`);
  const wf = JSON.parse(fs.readFileSync(path.join(PROJ, 'flux_dev_full_text_to_image_api.json')));
  wf['41'].inputs.clip_l = prompt;
  wf['41'].inputs.t5xxl = prompt;
  wf['27'].inputs.width = 768;
  wf['27'].inputs.height = 768;
  wf['31'].inputs.steps = 20;
  
  const r = await req({hostname:'127.0.0.1',port:8188,path:'/prompt',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(JSON.stringify({prompt:wf,client_id:`img_${Date.now()}`}))}}, JSON.stringify({prompt:wf,client_id:`img_${Date.now()}`}));
  if (r.error) throw new Error(`FLUX: ${JSON.stringify(r.error)}`);
  console.log(`[GEN] ⏳ Imagen #${idx+1} encolada (${r.prompt_id.slice(0,12)}...)`);
  
  const hist = await pollHistory(r.prompt_id);
  const f = extractFile(hist);
  if (!f) throw new Error('No output image');
  
  const dest = path.join(UPLOADS, f.filename);
  console.log(`[GEN] ⏳ Descargando ${f.filename}...`);
  await download(f.url, dest);
  console.log(`[GEN] ✅ Imagen #${idx+1}: ${f.filename}`);
  
  // Upload to ComfyUI input for I2V
  await uploadImage(dest, f.filename);
  console.log(`[GEN] 📤 Subida a ComfyUI input`);
  return { filename: f.filename, localPath: dest };
}

// STEP 2: I2V video via videocomfy WS + HTTP polling
async function genVideo(prompt, imageFile, idx) {
  console.log(`[GEN] 🎬 I2V #${idx+1}...`);
  
  // Use videocomfy WS to send the request (it handles workflow correctly)
  const ws = new WebSocket(VCOMFY_WS);
  const result = await new Promise((res, rej) => {
    const timeout = setTimeout(() => { ws.close(); rej(new Error('WS timeout')); }, 30000);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'generarImagen',
        prompt: prompt,
        imageFilename: imageFile,
        params: { videoWidth: 768, videoHeight: 768, videoLength: 97, samplerSteps: 20, cfgScale: 4.0, refStrength: 1.0, seed: -1 },
        batchId: `batch_${Date.now()}`
      }));
      console.log(`[GEN] ⏳ Video #${idx+1} enviado a videocomfy`);
      clearTimeout(timeout);
      
      // Now instead of waiting for WS, poll ComfyUI history
      // We need to find the prompt_id - check queue for latest entry
      const pollForVideo = () => {
        setTimeout(async () => {
          try {
            // Check queue to get the prompt_id
            const q = await req({hostname:'127.0.0.1',port:8188,path:'/queue',method:'GET'});
            const running = q.queue_running || [];
            const pending = q.queue_pending || [];
            
            // Look for our prompt - check the most recent one
            const allItems = [...running, ...pending];
            // Get the newest item's prompt_id
            let latestPid = null;
            for (const item of allItems) {
              if (item[1]) latestPid = item[1];
            }
            
            if (latestPid) {
              try {
                const hist = await pollHistory(latestPid);
                const f = extractFile(hist);
                if (f) {
                  const dest = path.join(VIDEOS, f.filename);
                  await download(f.url, dest);
                  console.log(`[GEN] ✅ Video #${idx+1}: ${f.filename}`);
                  ws.close();
                  res({ filename: f.filename, localPath: dest });
                  return;
                }
              } catch(e) {
                // History poll failed - might be different PID
              }
            }
            pollForVideo();
          } catch(e) {
            pollForVideo();
          }
        }, 5000);
      };
      pollForVideo();
    });
    ws.on('error', (e) => { clearTimeout(timeout); rej(new Error(`WS: ${e.message}`)); });
  });
  return result;
}

// STEP 3: Export timeline
async function exportTimeline(clips) {
  console.log(`[GEN] 🎬 Exportando timeline (${clips.length} clips)...`);
  const spacing = DUR / clips.length;
  const tc = clips.map((c,i) => ({filename:c.filename, prompt:c.prompt||'', startTime:Math.round(i*spacing*10)/10, duration:Math.round(CLIP_LEN*10)/10, muted:false, track:'V1'}));
  
  const r = await req({hostname:'localhost',port:5634,path:'/api/export-timeline',method:'POST',headers:{'Content-Type':'application/json'}}, JSON.stringify({clips:tc, batchId:`batch_${Date.now()}`}));
  if (r.error) throw new Error(`Export: ${r.error}`);
  console.log(`[GEN] ✅ Timeline: ${r.filename}`);
  return r;
}

// MAIN
async function main() {
  console.log(`\n╔══════════════════════════════════╗`);
  console.log(`║  🎬 GENERACIÓN CONFIABLE        ║`);
  console.log(`║  "${IDEA.substring(0,45)}..."`);
  console.log(`║  ${N} clips × ${CLIP_LEN}s = ${DUR}s`);
  console.log(`╚══════════════════════════════════╝\n`);

  const start = Date.now();
  const clips = [];

  for (let i = 0; i < SCENES.length; i++) {
    console.log(`\n━━━ PASO ${i+1}/${SCENES.length} ━━━`);
    try {
      const img = await genImage(SCENES[i].img, i);
      const vid = await genVideo(SCENES[i].vid, img.filename, i);
      clips.push({filename: vid.filename, prompt: SCENES[i].vid});
      console.log(`[GEN] ✅ Paso ${i+1} OK (${((Date.now()-start)/60000).toFixed(1)} min)`);
    } catch(e) {
      console.error(`[GEN] ❌ Paso ${i+1}: ${e.message}`);
    }
  }

  if (clips.length === 0) throw new Error('No clips generated');
  
  const exp = await exportTimeline(clips);
  const t = ((Date.now()-start)/60000).toFixed(1);
  const lp = path.join(VIDEOS, exp.filename);
  
  console.log(`\n╔══════════════════════════════════╗`);
  console.log(`║  ✅ COMPLETADO (${t} min)       ║`);
  console.log(`║  ${clips.length}/${SCENES.length} clips`);
  console.log(`║  ${exp.filename}`);
  console.log(`╚══════════════════════════════════╝\n`);
  
  const res = { success: true, filename: exp.filename, localPath: lp, localUrl: `http://localhost:5634/videos/${exp.filename}`, clips: clips.length };
  console.log('\n---RESULT_JSON---\n' + JSON.stringify(res) + '\n---END_RESULT_JSON---');
  fs.writeFileSync(path.join(PROJ, 'temp_video_result.json'), JSON.stringify(res, null, 2));
  return exp;
}

main().catch(e => {
  console.error(`\n[GEN] ❌ ${e.message}`);
  console.log('\n---RESULT_JSON---\n' + JSON.stringify({success:false,error:e.message}) + '\n---END_RESULT_JSON---');
  process.exit(1);
});
