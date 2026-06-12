#!/usr/bin/env node
/**
 * Direct ComfyUI API Client
 * 
 * Skips the videocomfy server intermediary and queues prompts directly 
 * to ComfyUI. More reliable for headless operation.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const COMFY_HOST = '127.0.0.1';
const COMFY_PORT = 8188;
const COMFY_BASE = `http://${COMFY_HOST}:${COMFY_PORT}`;
const PROJECT_DIR = __dirname;

// Workflow files
const FLUX_WORKFLOW = path.join(PROJECT_DIR, 'flux_dev_full_text_to_image_api.json');
const LTX_T2V_WORKFLOW = path.join(PROJECT_DIR, 'video_ltx2_t2v_api.json');
const LTX_I2V_WORKFLOW = path.join(PROJECT_DIR, 'video_ltx2_i2v_api.json');

async function queuePrompt(workflowJson) {
  const postData = JSON.stringify({ prompt: workflowJson, client_id: `client_${Date.now()}` });
  
  return new Promise((resolve, reject) => {
    const options = {
      hostname: COMFY_HOST,
      port: COMFY_PORT,
      path: '/prompt',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`ComfyUI error: ${JSON.stringify(parsed.error)}`));
          } else if (!parsed.prompt_id) {
            reject(new Error(`No prompt_id. Response: ${data.substring(0, 300)}`));
          } else {
            console.log(`  ✅ Queued! Prompt ID: ${parsed.prompt_id}`);
            resolve(parsed.prompt_id);
          }
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}. Raw: ${data.substring(0, 300)}`));
        }
      });
    });
    
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function uploadImage(filePath, filename) {
  const formData = new FormData();
  formData.append('image', fs.createReadStream(filePath), { filename: filename || path.basename(filePath) });
  
  return new Promise((resolve, reject) => {
    const options = {
      hostname: COMFY_HOST,
      port: COMFY_PORT,
      path: '/upload/image',
      method: 'POST',
      headers: formData.getHeaders()
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Upload parse error: ${e.message}`));
        }
      });
    });
    
    req.on('error', reject);
    formData.pipe(req);
  });
}

async function downloadFile(url, targetPath) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(targetPath);
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(targetPath);
      });
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForPrompt(promptId, timeoutMs = 1800000) {
  const wsUrl = `ws://${COMFY_HOST}:${COMFY_PORT}/ws?clientId=watcher_${Date.now()}`;
  const WebSocket = require('ws');
  
  console.log(`  ⏳ Waiting for execution to complete (timeout: ${Math.round(timeoutMs/1000)}s)...`);
  
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let lastProgress = 0;
    const startTime = Date.now();
    let timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout after ${timeoutMs/1000}s waiting for prompt ${promptId}`));
    }, timeoutMs);
    
    ws.on('open', () => {
      console.log('  📡 Connected to ComfyUI WebSocket for progress tracking');
    });
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        if (msg.type === 'progress') {
          const pct = Math.round((msg.data.value / msg.data.max) * 100);
          if (pct !== lastProgress) {
            lastProgress = pct;
            process.stdout.write(`\r  ⏳ Progress: ${pct}% (${msg.data.value}/${msg.data.max})     `);
          }
        }
        
        if (msg.type === 'executed' && msg.data.prompt_id === promptId) {
          // Found our execution output
          console.log(`\n  ✅ Execution completed for node ${msg.data.node}`);
          
          // Check for output
          const output = msg.data.output;
          if (output) {
            ws.output = output;
          }
        }
        
        if (msg.type === 'executing' && msg.data.prompt_id === promptId && msg.data.node === null) {
          // Null node means execution of this prompt is fully done
          clearTimeout(timeout);
          console.log(`  ✅ Prompt ${promptId} fully executed!`);
          ws.close();
          resolve(ws.output || {});
        }
        
        if (msg.type === 'execution_error' && msg.data.prompt_id === promptId) {
          clearTimeout(timeout);
          ws.close();
          const errMsg = msg.data.exception_message || 'Unknown execution error';
          reject(new Error(`ComfyUI execution error: ${errMsg}`));
        }
        
        if (msg.type === 'execution_cached' && msg.data.prompt_id === promptId) {
          console.log(`  📦 Nodes cached for prompt ${promptId}`);
        }
        
        if (msg.type === 'status') {
          // heartbeat, ignore
        }
      } catch (e) {
        // binary data or parse error
      }
    });
    
    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket error: ${err.message}`));
    });
    
    ws.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

async function getOutputFilename(output, type) {
  if (!output) return null;
  
  // Try gifs (video)
  if (output.gifs) {
    const gifs = Array.isArray(output.gifs) ? output.gifs : [output.gifs];
    if (gifs.length > 0) {
      return { filename: gifs[0].filename, type: 'video/gif', subfolder: gifs[0].subfolder || '', fileType: gifs[0].type || 'output' };
    }
  }
  
  // Try video field
  if (output.video) {
    const vids = Array.isArray(output.video) ? output.video : [output.video];
    if (vids.length > 0) {
      return { filename: vids[0].filename, type: 'video', subfolder: vids[0].subfolder || '', fileType: vids[0].type || 'output' };
    }
  }
  
  // Try images
  if (output.images) {
    const imgs = Array.isArray(output.images) ? output.images : [output.images];
    if (imgs.length > 0) {
      return { filename: imgs[0].filename, type: 'image', subfolder: imgs[0].subfolder || '', fileType: imgs[0].type || 'output' };
    }
  }
  
  return null;
}

async function generateImage(prompt, params = {}) {
  console.log(`\n🖼️ GENERATING IMAGE with FLUX`);
  console.log(`   Prompt: ${prompt.substring(0, 120)}...`);
  
  const workflow = JSON.parse(fs.readFileSync(FLUX_WORKFLOW, 'utf8'));
  
  // Set prompt text
  workflow["41"]["inputs"]["clip_l"] = prompt;
  workflow["41"]["inputs"]["t5xxl"] = prompt;
  
  // Set seed
  workflow["31"]["inputs"]["seed"] = Math.floor(Math.random() * 1000000000000000);
  
  // Set dimensions
  if (params.width) workflow["27"]["inputs"]["width"] = params.width;
  if (params.height) workflow["27"]["inputs"]["height"] = params.height;
  if (params.steps) workflow["31"]["inputs"]["steps"] = params.steps;
  
  const promptId = await queuePrompt(workflow);
  const output = await waitForPrompt(promptId);
  
  const asset = await getOutputFilename(output, 'image');
  if (asset) {
    const ext = path.extname(asset.filename);
    const localName = `storyboard_${Date.now()}${ext}`;
    const url = `http://${COMFY_HOST}:${COMFY_PORT}/view?filename=${encodeURIComponent(asset.filename)}&subfolder=${encodeURIComponent(asset.subfolder)}&type=${encodeURIComponent(asset.fileType)}`;
    const targetPath = path.join(PROJECT_DIR, 'public', 'uploads', localName);
    
    await downloadFile(url, targetPath);
    console.log(`   ✅ Image saved: ${targetPath}`);
    
    return { filename: localName, originalFilename: asset.filename, localPath: targetPath };
  }
  
  console.log(`   ⚠️ No image found in output`);
  return null;
}

async function generateVideoFromImage(prompt, imageFilenameInComfy, params = {}) {
  console.log(`\n🎬 GENERATING VIDEO FROM IMAGE (I2V)`);
  console.log(`   Prompt: ${prompt.substring(0, 120)}...`);
  console.log(`   Image: ${imageFilenameInComfy}`);
  
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
  
  // Validate required nodes
  const requiredNodes = ['3','98','102','62','11','67','47'];
  for (const n of requiredNodes) {
    if (!workflow[n]) throw new Error(`I2V workflow: node "${n}" not found after normalization`);
  }
  
  // Set prompt
  workflow["3"]["inputs"]["text"] = prompt;
  
  // Set input image
  workflow["98"]["inputs"]["image"] = imageFilenameInComfy;
  
  // Set dimensions
  const w = params.width || 1280;
  const h = params.height || 720;
  workflow["102"]["inputs"]["resize_type.width"] = w;
  workflow["102"]["inputs"]["resize_type.height"] = h;
  
  // Set frames
  if (params.frames) workflow["62"]["inputs"]["value"] = params.frames;
  
  // Set seeds
  const seed = params.seed || Math.floor(Math.random() * 1000000000);
  workflow["11"]["inputs"]["noise_seed"] = seed;
  workflow["67"]["inputs"]["noise_seed"] = seed;
  
  // Set CFG
  if (params.cfg) workflow["47"]["inputs"]["cfg"] = params.cfg;
  
  // Set ref strength
  if (params.refStrength) {
    workflow["107"]["inputs"]["strength"] = params.refStrength;
    workflow["108"]["inputs"]["strength"] = params.refStrength;
  }
  
  // Set steps
  if (params.steps) workflow["9"]["inputs"]["steps"] = params.steps;
  
  const promptId = await queuePrompt(workflow);
  const output = await waitForPrompt(promptId);
  
  const asset = await getOutputFilename(output, 'video');
  if (asset) {
    const localName = `video_${Date.now()}.webm`;
    const url = `http://${COMFY_HOST}:${COMFY_PORT}/view?filename=${encodeURIComponent(asset.filename)}&subfolder=${encodeURIComponent(asset.subfolder)}&type=${encodeURIComponent(asset.fileType)}`;
    const videosDir = path.join(PROJECT_DIR, 'public', 'videos');
    if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });
    const targetPath = path.join(videosDir, localName);
    
    await downloadFile(url, targetPath);
    console.log(`   ✅ Video saved: ${targetPath}`);
    
    return { filename: localName, originalFilename: asset.filename, localPath: targetPath };
  }
  
  console.log(`   ⚠️ No video found in output`);
  return null;
}

async function generateVideoDirect(prompt, params = {}) {
  console.log(`\n🎬 GENERATING VIDEO DIRECT (T2V)`);
  console.log(`   Prompt: ${prompt.substring(0, 120)}...`);
  
  const workflow = JSON.parse(fs.readFileSync(LTX_T2V_WORKFLOW, 'utf8'));
  
  // Set prompt
  workflow["3"]["inputs"]["text"] = prompt;
  
  // Set dimensions
  const w = params.width || 1280;
  const h = params.height || 720;
  workflow["89"]["inputs"]["width"] = w;
  workflow["89"]["inputs"]["height"] = h;
  
  // Set frames
  if (params.frames) workflow["62"]["inputs"]["value"] = params.frames;
  
  // Set seeds
  const seed = params.seed || Math.floor(Math.random() * 1000000000);
  workflow["11"]["inputs"]["noise_seed"] = seed;
  workflow["67"]["inputs"]["noise_seed"] = seed;
  
  // Set CFG
  if (params.cfg) workflow["47"]["inputs"]["cfg"] = params.cfg;
  
  // Set steps
  if (params.steps) workflow["9"]["inputs"]["steps"] = params.steps;
  
  const promptId = await queuePrompt(workflow);
  const output = await waitForPrompt(promptId, 600000);
  
  const asset = await getOutputFilename(output, 'video');
  if (asset) {
    const localName = `video_${Date.now()}.webm`;
    const url = `http://${COMFY_HOST}:${COMFY_PORT}/view?filename=${encodeURIComponent(asset.filename)}&subfolder=${encodeURIComponent(asset.subfolder)}&type=${encodeURIComponent(asset.fileType)}`;
    const videosDir = path.join(PROJECT_DIR, 'public', 'videos');
    if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });
    const targetPath = path.join(videosDir, localName);
    
    await downloadFile(url, targetPath);
    console.log(`   ✅ Video saved: ${targetPath}`);
    
    return { filename: localName, originalFilename: asset.filename, localPath: targetPath };
  }
  
  return null;
}

async function uploadImageToComfy(localPath, customName) {
  const filename = customName || path.basename(localPath);
  console.log(`   📤 Uploading image to ComfyUI/input: ${filename}`);
  const result = await uploadImage(localPath, filename);
  console.log(`   ✅ Uploaded: ${result.name || filename}`);
  return result.name || filename;
}

async function runFullWorkflow(stepsConfig) {
  console.log('\n' + '='.repeat(70));
  console.log('🎬 VIDEOCOMFY - CRYSTAL DEMONS FULL WORKFLOW');
  console.log('='.repeat(70) + '\n');
  
  const videosDir = path.join(PROJECT_DIR, 'public', 'videos');
  const uploadsDir = path.join(PROJECT_DIR, 'public', 'uploads');
  if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  
  const clips = [];
  
  for (let i = 0; i < stepsConfig.length; i++) {
    const step = stepsConfig[i];
    const stepNum = i + 1;
    const total = stepsConfig.length;
    
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`📌 STEP ${stepNum}/${total}: ${step.title}`);
    console.log(`${'─'.repeat(50)}`);
    
    // PHASE 1: Generate image with FLUX
    console.log(`\n[${stepNum}/${total}] Phase 1: Generating image with FLUX...`);
    let imageResult = null;
    try {
      imageResult = await generateImage(step.imagePrompt, { 
        ...(step.params || {}),
        steps: 25
      });
    } catch (err) {
      console.error(`   ❌ Image generation failed: ${err.message}`);
      // Don't abort - try next step
      continue;
    }
    
    if (!imageResult) {
      console.error(`   ❌ No image generated for step ${stepNum}`);
      continue;
    }
    
    // Upload the image to ComfyUI/input so it can be found by I2V workflow
    await uploadImageToComfy(imageResult.localPath, imageResult.filename);
    
    // PHASE 2: Generate video from image
    console.log(`\n[${stepNum}/${total}] Phase 2: Generating video from image (I2V)...`);
    let videoResult = null;
    try {
      videoResult = await generateVideoFromImage(
        step.videoPrompt,
        imageResult.filename,
        step.params || {}
      );
    } catch (err) {
      console.error(`   ❌ Video generation failed: ${err.message}`);
      continue;
    }
    
    if (!videoResult) {
      console.error(`   ❌ No video generated for step ${stepNum}`);
      continue;
    }
    
    clips.push({
      filename: videoResult.filename,
      prompt: step.title,
      startTime: clips.length > 0 ? clips.reduce((max, c) => Math.max(max, c.startTime + c.duration), 0) : 0,
      duration: step.duration || 5
    });
    
    console.log(`\n   ✅ Step ${stepNum} COMPLETE`);
  }
  
  // SUMMARY
  console.log(`\n${'='.repeat(70)}`);
  console.log(`📊 WORKFLOW SUMMARY`);
  console.log(`${'='.repeat(70)}`);
  console.log(`   Total clips generated: ${clips.length}`);
  
  for (const clip of clips) {
    console.log(`   - ${clip.filename}: "${clip.prompt.substring(0, 60)}..." (${clip.duration}s at ${clip.startTime}s)`);
  }
  
  // Save clips info for later assembly
  const resultPath = path.join(PROJECT_DIR, 'temp_clips_result.json');
  fs.writeFileSync(resultPath, JSON.stringify({ clips, steps: stepsConfig.length }, null, 2));
  
  console.log(`\n${clips.length > 0 ? '✅' : '❌'} Workflow progress saved to: ${resultPath}`);
  console.log(`\n📌 The videos are in: ${videosDir}`);
  console.log(`📌 The images are in: ${uploadsDir}`);
  
  return clips;
}

async function main() {
  const command = process.argv[2] || 'full-workflow';
  
  if (command === 'full-workflow') {
    // Load the crystal demons workflow
    const workflowPath = path.join(PROJECT_DIR, 'crystal_demons_workflow.json');
    const config = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
    
    console.log('\n🎬 Loading workflow: ' + config.title);
    console.log(`   Steps: ${config.steps.length}`);
    
    await runFullWorkflow(config.steps);
    
  } else if (command === 'just-image') {
    const prompt = process.argv[3] || "A cinematic shot of a crystalline demon";
    await generateImage(prompt);
    
  } else if (command === 'just-video') {
    const prompt = process.argv[3] || "Cinematic shot of a crystalline demon";
    await generateVideoDirect(prompt);
    
  } else if (command === 'upload') {
    const filePath = process.argv[3];
    if (!filePath) throw new Error('File path required');
    await uploadImageToComfy(filePath, path.basename(filePath));
    
  } else {
    console.log(`Unknown command: ${command}`);
    console.log('Available: full-workflow, just-image, just-video, upload');
  }
}

main().catch(err => {
  console.error(`\n❌ Fatal error: ${err.message}`);
  process.exit(1);
});
