#!/usr/bin/env node
/**
 * Generate images/videos via videocomfy WebSocket
 *
 * Usage:
 *   node generate_videocomfy.js storyboard "a cat, cinematic" [params.json]
 *   node generate_videocomfy.js t2v "a cat walking" '{"samplerSteps":30,"cfgScale":5}'
 *   node generate_videocomfy.js i2v "waves at camera" '{"imageFilename":"img.png"}'
 *   node generate_videocomfy.js wan22 "lake at dawn" '{"startImageFilename":"start.png"}'
 *
 * Output: JSON on stdout with { status, filename, type }
 * Progress: stderr
 * Exit: 0 = done, 1 = error, 2 = timeout
 */

const WebSocket = require('ws');
const [,, type, prompt, ...rest] = process.argv;

if (!type || !prompt) {
  console.error('Usage: node generate_videocomfy.js <type> <prompt> [params.json]');
  console.error('  type: storyboard | t2v | i2v | wan22');
  console.error('  params.json: optional JSON with generation parameters');
  process.exit(1);
}

const params = rest.length ? JSON.parse(rest[0]) : {};

const TYPE_MAP = {
  storyboard: 'generarStoryboard',
  t2v:        'generarImagen',
  i2v:        'generarImagen',
  wan22:      'generarWan22',
};

const wsType = TYPE_MAP[type];
if (!wsType) {
  console.error(`Unknown type "${type}". Use: storyboard, t2v, i2v, wan22`);
  process.exit(1);
}

// Build payload
const payload = {
  type: wsType,
  prompt,
  params,
  batchId: params.batchId || `cli-${type}-${Date.now()}`
};

if (params.imageFilename) {
  payload.imageFilename = params.imageFilename;
}
if (params.startImageFilename) {
  payload.startImageFilename = params.startImageFilename;
}
if (params.endImageFilename) {
  payload.endImageFilename = params.endImageFilename;
}
if (params.storyboardIndex !== undefined) {
  payload.storyboardIndex = params.storyboardIndex;
}

// Connect to videocomfy
const ws = new WebSocket('ws://localhost:5634');
const TIMEOUT_MS = 900000; // 15 min
const timeout = setTimeout(() => {
  ws.close();
  console.error('\nTIMEOUT after 15 minutes');
  process.exit(2);
}, TIMEOUT_MS);

let resolved = false;

ws.on('open', () => {
  ws.send(JSON.stringify(payload));
  console.error(`[videocomfy] Sent ${type} request: "${prompt.substring(0, 60)}..."`);
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());

    // Progress
    if (msg.type === 'progress') {
      const pct = msg.value !== undefined && msg.max
        ? Math.round((msg.value / msg.max) * 100)
        : msg.percent || '?';
      process.stderr.write(`\r[videocomfy] Progress: ${pct}%`);
      return;
    }

    // Executing node
    if (msg.type === 'executing') {
      if (msg.node) {
        process.stderr.write(`\r[videocomfy] Executing node: ${msg.node}`);
      }
      return;
    }

    // Result: video generated
    if (msg.type === 'video_generated' || msg.type === 'storyboard_generated') {
      clearTimeout(timeout);
      resolved = true;
      ws.close();
      const isVideo = msg.type === 'video_generated';
      const result = {
        status: 'done',
        filename: msg.filename,
        url: msg.url,
        type: isVideo ? 'video' : 'image',
        prompt: msg.prompt
      };
      console.log(JSON.stringify(result));
      process.exit(0);
    }

    // Error
    if (msg.type === 'generation_error' || msg.type === 'error') {
      clearTimeout(timeout);
      resolved = true;
      ws.close();
      console.error(`\n[videocomfy] ERROR: ${msg.error || msg.message || JSON.stringify(msg)}`);
      process.exit(1);
    }

    // ComfyUI status
    if (msg.type === 'comfy_status') {
      console.error(`[videocomfy] ComfyUI: ${msg.status}`);
      return;
    }

    // Downloading
    if (msg.type === 'video_downloading' || msg.type === 'image_downloading') {
      console.error(`\n[videocomfy] Downloading ${msg.type.split('_')[0]}...`);
      return;
    }

  } catch (e) {
    // Ignore parse errors on non-JSON messages
  }
});

ws.on('error', (err) => {
  clearTimeout(timeout);
  if (!resolved) {
    console.error(`\n[videocomfy] WebSocket error: ${err.message}`);
    process.exit(1);
  }
});

ws.on('close', () => {
  clearTimeout(timeout);
  if (!resolved) {
    // If it closes without resolution, check if it was quick (connection refused)
    console.error('\n[videocomfy] Connection closed unexpectedly');
    process.exit(1);
  }
});
