#!/usr/bin/env node
/**
 * generate_full_video.js
 * 
 * Generates a complete video from an idea using Ollama for prompt generation,
 * FLUX for images, LTX-2 I2V for videos, and FFmpeg for timeline assembly.
 * 
 * Usage: node generate_full_video.js "your idea" [duration_seconds]
 * 
 * Requires: videocomfy:5634, ComfyUI:8188
 */

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SERVER_URL = process.env.VIDEOCOMFY_URL || 'http://localhost:5634';
const WS_URL = SERVER_URL.replace('http', 'ws');
const SERVER_HOST = new URL(SERVER_URL).hostname;
const SERVER_PORT = parseInt(new URL(SERVER_URL).port) || 5634;

const TARGET_DURATION = parseInt(process.argv[3]) || 60;
const CLIP_DURATION = 5;
const MIN_CLIPS = Math.ceil(TARGET_DURATION / CLIP_DURATION);
const NUM_CLIPS = Math.max(MIN_CLIPS, 3);

class FullVideoGenerator {
  constructor() {
    this.ws = null;
    this.pendingPromises = {};
    this.generatedAssets = { images: [], videos: [] };
    this.batchId = `fullvideo_${Date.now()}`;
  }

  connect() {
    return new Promise((resolve, reject) => {
      console.log(`[GENERATOR] 🔌 Conectando a ${WS_URL}...`);
      this.ws = new WebSocket(WS_URL);
      this.ws.on('open', () => { console.log('[GENERATOR] ✅ Conectado a VideoComfy server'); resolve(); });
      this.ws.on('message', (data) => {
        try { this._handleMessage(JSON.parse(data.toString())); } catch (e) { /* binary */ }
      });
      this.ws.on('error', (err) => { console.error('[GENERATOR] ❌ WebSocket error:', err.message); reject(err); });
      this.ws.on('close', () => { console.log('[GENERATOR] Conexión cerrada'); });
      setTimeout(() => reject(new Error('Connection timeout')), 10000);
    });
  }

  _handleMessage(msg) {
    if (msg.type === 'storyboard_generated') {
      console.log(`[GENERATOR] 🖼️ Imagen: ${msg.filename}`);
      this.generatedAssets.images.push({ url: msg.url, filename: msg.filename, prompt: msg.prompt, index: msg.storyboardIndex });
      if (this.pendingPromises.image) { this.pendingPromises.image.resolve(msg); delete this.pendingPromises.image; }
    } else if (msg.type === 'video_generated') {
      console.log(`[GENERATOR] 🎬 Video: ${msg.filename}`);
      this.generatedAssets.videos.push({ url: msg.url, filename: msg.filename, prompt: msg.prompt });
      if (this.pendingPromises.video) { this.pendingPromises.video.resolve(msg); delete this.pendingPromises.video; }
    } else if (msg.type === 'progress') {
      const pct = Math.round((msg.value / msg.max) * 100);
      console.log(`[GENERATOR] ⏳ ${pct}% (${msg.value}/${msg.max})`);
    } else if (msg.type === 'generation_error') {
      console.error(`\n[GENERATOR] ❌ Error: ${msg.error}`);
      if (this.pendingPromises.video) { this.pendingPromises.video.reject(new Error(msg.error)); delete this.pendingPromises.video; }
      if (this.pendingPromises.image) { this.pendingPromises.image.reject(new Error(msg.error)); delete this.pendingPromises.image; }
    } else if (msg.type === 'comfy_status') {
      console.log(`[GENERATOR] ComfyUI: ${msg.status}`);
    }
  }

  _waitForMessage(type, timeout = 1800000) {
    return new Promise((resolve, reject) => {
      this.pendingPromises[type] = { resolve, reject };
      setTimeout(() => {
        if (this.pendingPromises[type]) { this.pendingPromises[type].reject(new Error(`Timeout ${type} (${timeout/1000}s)`)); delete this.pendingPromises[type]; }
      }, timeout);
    });
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) { this.ws.send(JSON.stringify(msg)); return true; }
    console.error('[GENERATOR] ❌ WebSocket no conectado');
    return false;
  }

  async enhancePrompt(idea) {
    console.log(`\n========================================`);
    console.log(`🔮 STEP 1: Generando prompts con Ollama`);
    console.log(`   Idea: "${idea.substring(0, 100)}..."`);
    console.log(`   Clips: ${NUM_CLIPS} (${TARGET_DURATION}s)`);
    console.log(`========================================\n`);

    return new Promise((resolve) => {
      const fallbackScenes = [
        { img: `${idea}, wide shot of a sunny beach with waves`, vid: `${idea}, slow pan across the sandy beach` },
        { img: `${idea}, a Teletubbie character on the beach`, vid: `${idea}, the Teletubbie walks along the shore` },
        { img: `${idea}, close up Teletubbie smoking relaxed`, vid: `${idea}, the Teletubbie takes a long drag, blows smoke` },
        { img: `${idea}, the Teletubbie notices something shiny in sand`, vid: `${idea}, the Teletubbie crouches to investigate` },
        { img: `${idea}, close up of a treasure chest in the sand`, vid: `${idea}, camera zooms in on the treasure chest` },
        { img: `${idea}, the Teletubbie starts digging excitedly`, vid: `${idea}, the Teletubbie digs frantically in sand` },
        { img: `${idea}, treasure chest uncovered, ornate details`, vid: `${idea}, the Teletubbie brushes sand off the chest` },
        { img: `${idea}, the Teletubbie struggles to open the chest`, vid: `${idea}, the lid creaks open, golden light spills` },
        { img: `${idea}, chest filled with gold coins and jewels`, vid: `${idea}, camera pans over treasure, gems glinting` },
        { img: `${idea}, Teletubbie holds up gold coins triumphantly`, vid: `${idea}, the Teletubbie laughs, coins falling` },
        { img: `${idea}, Teletubbie puts on a golden crown`, vid: `${idea}, the Teletubbie poses proudly with crown` },
        { img: `${idea}, golden sunset, Teletubbie smokes contentedly`, vid: `${idea}, final shot pulling back to the scene` }
      ];

      const postData = JSON.stringify({ text: idea, modelName: 'llama3.2:latest' });
      const req = http.request({
        hostname: SERVER_HOST, port: SERVER_PORT,
        path: '/api/enhance-prompt', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            let result;
            try { result = JSON.parse(data); }
            catch (e) {
              const match = data.match(/\{[\s\S]*\}/);
              if (match) {
                const fixed = match[0].replace(/([{,]\s*)([A-Za-z][A-Za-z\s]*?)(\s*:)/g, '$1"$2"$3').replace(/,\s*}/g, '}');
                result = JSON.parse(fixed);
              } else throw new Error('No JSON');
            }
            if (!result.error && result.steps && result.steps.length > 0) {
              console.log(`[GENERATOR] ✅ Ollama: ${result.steps.length} pasos`);
              resolve({
                globalImage: result.globalImage || idea,
                globalVideo: result.globalVideo || idea,
                steps: result.steps
              });
              return;
            }
          } catch (e) { /* fall through */ }
          console.log(`[GENERATOR] ⚠️ Usando plan local (sin Ollama)`);
          resolve({ globalImage: idea, globalVideo: idea, steps: fallbackScenes });
        });
      });
      req.on('error', () => {
        console.log(`[GENERATOR] ⚠️ Ollama no disponible, plan local`);
        resolve({ globalImage: idea, globalVideo: idea, steps: fallbackScenes });
      });
      req.write(postData);
      req.end();
      setTimeout(() => { req.destroy(); resolve({ globalImage: idea, globalVideo: idea, steps: fallbackScenes }); }, 20000);
    });
  }

  async generateImage(prompt, index) {
    console.log(`\n[GENERATOR] 🖼️ Imagen FLUX #${index + 1}...`);
    const promise = this._waitForMessage('image', 600000);
    this._send({ type: 'generarStoryboard', prompt, params: { videoWidth: 768, videoHeight: 768, storyboardSteps: 20 }, storyboardIndex: index, batchId: this.batchId });
    const result = await promise;
    console.log(`[GENERATOR] ✅ Imagen #${index + 1}: ${result.filename}`);
    return result;
  }

  async generateVideoFromImage(prompt, imageFilename, index) {
    console.log(`\n[GENERATOR] 🎬 Video I2V #${index + 1}...`);
    const promise = this._waitForMessage('video', 600000);
    this._send({ type: 'generarImagen', prompt, imageFilename, params: { videoWidth: 768, videoHeight: 768, videoLength: 97, samplerSteps: 20, cfgScale: 4.0, refStrength: 1.0 }, batchId: this.batchId });
    const result = await promise;
    console.log(`[GENERATOR] ✅ Video #${index + 1}: ${result.filename}`);
    return result;
  }

  async exportTimeline(clips) {
    console.log(`\n========================================`);
    console.log(`🎬 STEP 4: Exportando timeline`);
    console.log(`   Clips: ${clips.length}, Duración: ~${TARGET_DURATION}s`);
    console.log(`========================================\n`);
    const spacing = TARGET_DURATION / clips.length;
    const timelineClips = clips.map((c, i) => ({ filename: c.filename, prompt: c.prompt || '', startTime: Math.round(i * spacing * 10) / 10, duration: Math.round(CLIP_DURATION * 10) / 10, muted: false, track: 'V1' }));
    console.log(`\n📋 Timeline:`);
    timelineClips.forEach((c, i) => console.log(`   ${i+1}. ${c.filename} @ ${c.startTime}s`));
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({ clips: timelineClips, batchId: this.batchId, outputName: `fullvideo_${Date.now()}.mp4` });
      const req = http.request({ hostname: SERVER_HOST, port: SERVER_PORT, path: '/api/export-timeline', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.error) { reject(new Error(`Export: ${result.error}`)); return; }
            console.log(`\n[GENERATOR] ✅ Timeline: ${result.url}`);
            resolve(result);
          } catch (e) { reject(new Error(`Parse: ${e.message}`)); }
        });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  async run(idea) {
    console.log(`\n╔════════════════════════════════════╗`);
    console.log(`║  🎬 VIDEOCOMFY GENERACIÓN COMPLETA ║`);
    console.log(`║  Idea: "${idea.substring(0, 50)}..."`);
    console.log(`║  Target: ${TARGET_DURATION}s (${NUM_CLIPS} clips)`);
    console.log(`╚════════════════════════════════════╝\n`);

    const startTime = Date.now();
    const { globalImage, globalVideo, steps: rawSteps } = await this.enhancePrompt(idea);

    // Normalize steps to {PROMPT IMAGE, VIDEO IMAGE} format
    let steps = rawSteps.map(s => ({
      'PROMPT IMAGE': s['PROMPT IMAGE'] || s.promptImage || s.img || idea,
      'VIDEO IMAGE': s['VIDEO IMAGE'] || s.videoImage || s.vid || s.img || idea
    }));

    while (steps.length < NUM_CLIPS) { steps.push(steps[steps.length % steps.length]); }
    steps = steps.slice(0, NUM_CLIPS);

    console.log(`\n📋 Plan:`);
    steps.forEach((s, i) => console.log(`   ${i+1}. 🖼️ ${(s['PROMPT IMAGE']+'').substring(0, 60)}...`));

    const clips = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const imgPrompt = globalImage ? `${globalImage}, ${step['PROMPT IMAGE']}` : step['PROMPT IMAGE'];
      const vidPrompt = globalVideo ? `${globalVideo}, ${step['VIDEO IMAGE']}` : step['VIDEO IMAGE'];

      console.log(`\n━━━ [PASO ${i+1}/${steps.length}] ━━━`);

      // Generate FLUX image
      const imageResult = await this.generateImage(imgPrompt, i).catch(e => { console.error(`[GENERATOR] ❌ Imagen ${i+1}: ${e.message}`); return null; });
      if (!imageResult || !imageResult.filename) continue;
      await new Promise(r => setTimeout(r, 3000));

      // Generate I2V video
      const videoResult = await this.generateVideoFromImage(vidPrompt, imageResult.filename, i).catch(e => { console.error(`[GENERATOR] ❌ Video ${i+1}: ${e.message}`); return null; });
      if (!videoResult || !videoResult.filename) continue;

      clips.push({ filename: videoResult.filename, prompt: vidPrompt });
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      console.log(`[GENERATOR] ✅ Paso ${i+1}/${steps.length} (${elapsed} min)`);
    }

    if (clips.length === 0) throw new Error('No se generó ningún clip');

    const exportResult = await this.exportTimeline(clips);
    const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

    console.log(`\n╔════════════════════════════════════╗`);
    console.log(`║     ✅ GENERACIÓN COMPLETA         ║`);
    console.log(`╠════════════════════════════════════╣`);
    console.log(`║  Tiempo: ${totalTime} min`);
    console.log(`║  Clips: ${clips.length}`);
    console.log(`║  Video: ${exportResult.filename}`);
    const localPath = `D:\\Programacion\\videocomfy\\public\\videos\\${exportResult.filename}`;
    console.log(`║  Ruta: ${localPath}`);
    console.log(`╚════════════════════════════════════╝\n`);

    // Output JSON result
    console.log('\n---RESULT_JSON---');
    console.log(JSON.stringify({ success: true, filename: exportResult.filename, localPath, localUrl: `http://localhost:5634/videos/${exportResult.filename}`, clips: clips.length }));
    console.log('---END_RESULT_JSON---');
    return exportResult;
  }

  close() { if (this.ws) this.ws.close(); }
}

async function main() {
  const idea = process.argv[2];
  if (!idea) { console.error('Uso: node generate_full_video.js "tu idea" [segundos]'); process.exit(1); }

  const gen = new FullVideoGenerator();
  try {
    // Check server
    await new Promise((resolve, reject) => {
      const r = http.get(`${SERVER_URL}/api/images`, (res) => res.statusCode === 200 ? resolve() : reject(new Error(`Status ${res.statusCode}`)));
      r.on('error', (e) => reject(new Error(`Server: ${e.message}`)));
      r.setTimeout(5000);
    });
    await gen.connect();
    await gen.run(idea);
  } catch (e) {
    console.error(`\n[GENERATOR] ❌ ${e.message}`);
    console.log('\n---RESULT_JSON---');
    console.log(JSON.stringify({ success: false, error: e.message }));
    console.log('---END_RESULT_JSON---');
    process.exit(1);
  } finally { gen.close(); setTimeout(() => process.exit(0), 2000); }
}

main();
