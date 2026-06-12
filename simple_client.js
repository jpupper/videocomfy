#!/usr/bin/env node
/**
 * Simple ComfyUI Direct Client
 * Queues prompts directly to ComfyUI and polls for completion.
 * Works better when WS client_id assignment is tricky.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const COMFY_HOST = '127.0.0.1';
const COMFY_PORT = 8188;
const PROJECT_DIR = path.resolve(__dirname);

const FLUX_WORKFLOW = path.join(PROJECT_DIR, 'flux_dev_full_text_to_image_api.json');
const LTX_I2V_WORKFLOW = path.join(PROJECT_DIR, 'video_ltx2_i2v_api.json');

// Helper: HTTP POST/POST with JSON
function httpJson(method, host, port, urlPath, data) {
  return new Promise((resolve, reject) => {
    const payload = data ? JSON.stringify(data) : '';
    const opts = {
      hostname: host, port,
      path: urlPath, method,
      headers: data ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      } : {}
    };
    const req = http.request(opts, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error(`Parse error: ${e.message}. Body: ${body.substring(0,200)}`)); }
      });
    });
    req.on('error', reject);
    if (data) req.write(payload);
    req.end();
  });
}

function httpGetBuffer(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function uploadImage(filePath, customName) {
  const formData = new FormData();
  formData.append('image', fs.createReadStream(filePath), { filename: customName || path.basename(filePath) });
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: COMFY_HOST, port: COMFY_PORT,
      path: '/upload/image', method: 'POST',
      headers: formData.getHeaders()
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error(`Upload parse: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    formData.pipe(req);
  });
}

async function queuePrompt(workflow) {
  const result = await httpJson('POST', COMFY_HOST, COMFY_PORT, '/prompt', {
    prompt: workflow,
    client_id: `client_${Date.now()}`
  });
  console.log(`  ✅ Queued! Prompt ID: ${result.prompt_id}`);
  return result.prompt_id;
}

async function getHistory(promptId) {
  try {
    return await httpJson('GET', COMFY_HOST, COMFY_PORT, `/history/${promptId}`);
  } catch(e) {
    return null;
  }
}

async function waitForPromptComplete(promptId, timeoutMs = 1800000) {
  console.log(`  ⏳ Waiting for completion...`);
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    const history = await getHistory(promptId);
    if (history && history[promptId]) {
      const h = history[promptId];
      if (h.status && h.status.completed) {
        console.log(`  ✅ Complete! (${Math.round((Date.now()-startTime)/1000)}s)`);
        return h.outputs || {};
      }
      if (h.status && h.status.error) {
        throw new Error(`Execution error: ${JSON.stringify(h.status.error)}`);
      }
    }
    // Also check queue status
    await sleep(3000);
    process.stdout.write('.');
  }
  throw new Error(`Timeout after ${timeoutMs/1000}s`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getFilesFromOutput(outputs) {
  const files = [];
  for (const nodeId in outputs) {
    const node = outputs[nodeId];
    if (node.images) files.push(...node.images);
    if (node.gifs) files.push(...node.gifs.map(g => ({...g, type: g.type || 'output'})));
    if (node.video) {
      const v = Array.isArray(node.video) ? node.video : [node.video];
      files.push(...v);
    }
  }
  return files;
}

async function downloadFile(filename, subfolder, fileType, saveDir, newName) {
  const ext = path.extname(filename);
  const localName = newName || `download_${Date.now()}${ext}`;
  const dir = path.join(PROJECT_DIR, saveDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const targetPath = path.join(dir, localName);
  
  // Build URL carefully — some ComfyUI versions need empty subfolder as empty string
  const sub = subfolder || '';
  const type = fileType || 'output';
  const url = `http://${COMFY_HOST}:${COMFY_PORT}/view?filename=${encodeURIComponent(filename)}${sub ? '&subfolder=' + encodeURIComponent(sub) : ''}&type=${encodeURIComponent(type)}`;
  
  console.log(`  📥 Downloading: ${url.substring(0, 150)}...`);
  
  const buffer = await httpGetBuffer(url);
  fs.writeFileSync(targetPath, buffer);
  console.log(`  💾 Saved: ${targetPath} (${(buffer.length/1024/1024).toFixed(1)} MB)`);
  return localName;
}

// ====== MAIN WORKFLOW ======

async function generateImage(prompt, index, batchId) {
  console.log(`\n🖼️ [${batchId}] Step ${index}: Generating image...`);
  
  const workflow = JSON.parse(fs.readFileSync(FLUX_WORKFLOW, 'utf8'));
  workflow["41"]["inputs"]["clip_l"] = prompt;
  workflow["41"]["inputs"]["t5xxl"] = prompt;
  workflow["31"]["inputs"]["seed"] = Math.floor(Math.random() * 1000000000000000);
  workflow["27"]["inputs"]["width"] = 1280;
  workflow["27"]["inputs"]["height"] = 720;
  workflow["31"]["inputs"]["steps"] = 25;
  
  const promptId = await queuePrompt(workflow);
  const outputs = await waitForPromptComplete(promptId);
  
  const files = getFilesFromOutput(outputs);
  if (files.length === 0) {
    console.log(`  ⚠️ No output files found`);
    return null;
  }
  
  const imgFile = files[0];
  const localName = await downloadFile(imgFile.filename, imgFile.subfolder, imgFile.type || 'output', 'public/uploads', `storyboard_${batchId}_${index}.png`);
  
  // Upload to ComfyUI input for I2V
  const localPath = path.join(PROJECT_DIR, 'public', 'uploads', localName);
  await uploadImage(localPath, localName);
  console.log(`  ✅ Image ready: ${localName}`);
  
  return localName;
}

async function generateVideoFromImage(prompt, imageFilename, index, batchId, params = {}) {
  console.log(`\n🎬 [${batchId}] Step ${index}: Generating video from image...`);
  
  const workflow = JSON.parse(fs.readFileSync(LTX_I2V_WORKFLOW, 'utf8'));
  
  // Normalize sg_XX_ prefixed node IDs (exported from ComfyUI)
  const keys = Object.keys(workflow);
  for (const key of keys) {
    const match = key.match(/^sg_\d+_(.+)$/);
    if (match) {
      workflow[match[1]] = workflow[key];
      delete workflow[key];
    }
  }
  
  // Normalize internal references (e.g. ["sg_92_107", 0] -> ["107", 0])
  for (const [, node] of Object.entries(workflow)) {
    if (!node || !node.inputs) continue;
    for (const [inputKey, inputVal] of Object.entries(node.inputs)) {
      if (Array.isArray(inputVal) && typeof inputVal[0] === 'string' && inputVal[0].match(/^sg_\d+_\d+$/)) {
        const m = inputVal[0].match(/^sg_\d+_(\d+)$/);
        if (m) node.inputs[inputKey][0] = m[1];
      }
    }
  }
  
  workflow["3"]["inputs"]["text"] = prompt;
  workflow["98"]["inputs"]["image"] = imageFilename;
  workflow["102"]["inputs"]["resize_type.width"] = params.width || 1280;
  workflow["102"]["inputs"]["resize_type.height"] = params.height || 720;
  workflow["62"]["inputs"]["value"] = params.frames || 121;
  workflow["47"]["inputs"]["cfg"] = params.cfg || 4.0;
  workflow["9"]["inputs"]["steps"] = params.steps || 20;
  
  const seed = Math.floor(Math.random() * 1000000000);
  workflow["11"]["inputs"]["noise_seed"] = seed;
  workflow["67"]["inputs"]["noise_seed"] = seed;
  if (params.refStrength !== undefined) {
    workflow["107"]["inputs"]["strength"] = params.refStrength;
    workflow["108"]["inputs"]["strength"] = params.refStrength;
  }
  
  const promptId = await queuePrompt(workflow);
  const outputs = await waitForPromptComplete(promptId);
  
  const files = getFilesFromOutput(outputs);
  if (files.length === 0) {
    console.log(`  ⚠️ No output video found`);
    return null;
  }
  
  // Find the largest file (likely the video)
  const vidFile = files.reduce((a, b) => (a.size || 0) > (b.size || 0) ? a : b);
  
  // The output format from LTX I2V is mp4
  const localName = await downloadFile(vidFile.filename, vidFile.subfolder, vidFile.type || 'output', 'public/videos', `crystal_${batchId}_${index}.mp4`);
  console.log(`  ✅ Video ready: ${localName}`);
  
  return localName;
}

async function runCrystalDemons() {
  const batchId = `cd_${Date.now().toString(36)}`;
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🔮 CRYSTAL DEMONS VIDEO WORKFLOW`);
  console.log(`   Batch: ${batchId}`);
  console.log(`   Using ComfyUI at ${COMFY_HOST}:${COMFY_PORT}`);
  console.log(`${'='.repeat(70)}`);
  
  // Load workflow steps
  const config = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'crystal_demons_workflow.json'), 'utf8'));
  const steps = config.steps;
  const clips = [];
  
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepNum = i + 1;
    
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`📌 STEP ${stepNum}/${steps.length}: ${step.title}`);
    console.log(`${'─'.repeat(60)}`);
    
    // Phase 1: Generate image
    let imageFile = null;
    try {
      imageFile = await generateImage(step.imagePrompt, i, batchId);
    } catch (err) {
      console.error(`  ❌ Image failed: ${err.message}`);
      continue;
    }
    if (!imageFile) continue;
    
    // Small pause for ComfyUI to process upload
    await sleep(2000);
    
    // Phase 2: Generate video from image
    let videoFile = null;
    try {
      videoFile = await generateVideoFromImage(step.videoPrompt, imageFile, i, batchId, step.params || {});
    } catch (err) {
      console.error(`  ❌ Video failed: ${err.message}`);
      continue;
    }
    if (!videoFile) continue;
    
    clips.push({
      filename: videoFile,
      prompt: step.title,
      duration: step.duration || 5
    });
    
    console.log(`\n  ✅ Step ${stepNum} COMPLETE`);
  }
  
  // Summary
  console.log(`\n${'='.repeat(70)}`);
  console.log(`📊 RESULTS`);
  console.log(`${'='.repeat(70)}`);
  console.log(`   Generated ${clips.length}/${steps.length} clips`);
  
  for (const clip of clips) {
    const p = path.join(PROJECT_DIR, 'public', 'videos', clip.filename);
    const exists = fs.existsSync(p);
    const size = exists ? (fs.statSync(p).size / 1024 / 1024).toFixed(1) : 'N/A';
    console.log(`   🎬 ${clip.filename} (${size} MB) — "${clip.prompt.substring(0, 60)}..."`);
  }
  
  // Save clips list
  const resultPath = path.join(PROJECT_DIR, `crystal_demons_result_${batchId}.json`);
  fs.writeFileSync(resultPath, JSON.stringify({ clips, batchId }, null, 2));
  console.log(`\n   📄 Clips saved to: ${resultPath}`);
  
  return clips;
}

// MAIN
runCrystalDemons().then(clips => {
  console.log(`\n✅ Workflow finished with ${clips.length} clips!`);
  console.log(`   Videos in: ${PROJECT_DIR}/public/videos/`);
}).catch(err => {
  console.error(`\n❌ Fatal: ${err.message}`);
  process.exit(1);
});
