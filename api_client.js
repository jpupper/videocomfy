#!/usr/bin/env node
/**
 * VideoComfy API Client
 * 
 * Generates images (FLUX), videos (LTX-2, I2V, WAN2.2),
 * manages the timeline, and exports final videos.
 * 
 * Usage:
 *   node api_client.js <command> [options]
 * 
 * Commands:
 *   generate-image <prompt>          Generate image with FLUX
 *   generate-video <prompt>          Generate video with LTX-2 T2V
 *   generate-i2v <prompt> <image>    Generate video from image with LTX-2 I2V
 *   generate-wan <prompt> [start_img] [end_img]  WAN2.2 video
 *   export-timeline <clips-json>     Export timeline with blending
 *   full-workflow <steps-json>       Full pipeline: images→videos→timeline→export
 * 
 * Requires videocomfy server running on http://localhost:5634
 */

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SERVER_URL = process.env.VIDEOCOMFY_URL || 'http://localhost:5634';
const WS_URL = SERVER_URL.replace('http', 'ws');
const SERVER_HOST = new URL(SERVER_URL).hostname;
const SERVER_PORT = parseInt(new URL(SERVER_URL).port) || 5634;

class VideoComfyClient {
  constructor() {
    this.ws = null;
    this.pendingPromises = {};
    this.generatedAssets = { images: [], videos: [] };
  }

  /**
   * Connect to the videocomfy WebSocket server
   */
  connect() {
    return new Promise((resolve, reject) => {
      console.log(`[CLIENT] Connecting to ${WS_URL}...`);
      this.ws = new WebSocket(WS_URL);

      this.ws.on('open', () => {
        console.log('[CLIENT] ✅ Connected to VideoComfy server');
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(msg);
        } catch (e) {
          // ignore binary messages
        }
      });

      this.ws.on('error', (err) => {
        console.error('[CLIENT] ❌ WebSocket error:', err.message);
        reject(err);
      });

      this.ws.on('close', () => {
        console.log('[CLIENT] Connection closed');
      });

      // Timeout
      setTimeout(() => reject(new Error('Connection timeout')), 10000);
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  _handleMessage(msg) {
    // Route messages to listeners
    if (msg.type === 'storyboard_generated') {
      console.log(`[CLIENT] 🖼️ Image generated: ${msg.url}`);
      this.generatedAssets.images.push({
        url: msg.url,
        filename: msg.filename,
        prompt: msg.prompt,
        index: msg.storyboardIndex
      });
      if (this.pendingPromises.image) {
        this.pendingPromises.image.resolve(msg);
        delete this.pendingPromises.image;
      }
    } 
    else if (msg.type === 'video_generated') {
      console.log(`[CLIENT] 🎬 Video generated: ${msg.url}`);
      this.generatedAssets.videos.push({
        url: msg.url,
        filename: msg.filename,
        prompt: msg.prompt
      });
      if (this.pendingPromises.video) {
        this.pendingPromises.video.resolve(msg);
        delete this.pendingPromises.video;
      }
    }
    else if (msg.type === 'progress') {
      const pct = Math.round((msg.value / msg.max) * 100);
      process.stdout.write(`\r[CLIENT] ⏳ Progress: ${pct}% (${msg.value}/${msg.max})`);
    }
    else if (msg.type === 'generation_error') {
      console.error(`\n[CLIENT] ❌ Generation error: ${msg.error}`);
      if (this.pendingPromises.video) {
        this.pendingPromises.video.reject(new Error(msg.error));
        delete this.pendingPromises.video;
      }
      if (this.pendingPromises.image) {
        this.pendingPromises.image.reject(new Error(msg.error));
        delete this.pendingPromises.image;
      }
    }
    else if (msg.type === 'comfy_status') {
      console.log(`[CLIENT] ComfyUI status: ${msg.status}`);
    }
    else if (msg.type === 'executing') {
      // ignore node execution logs
    }
  }

  /**
   * Wait for a specific message type with timeout
   */
  _waitForMessage(type, timeout = 300000) {
    return new Promise((resolve, reject) => {
      this.pendingPromises[type] = { resolve, reject };
      setTimeout(() => {
        if (this.pendingPromises[type]) {
          this.pendingPromises[type].reject(new Error(`Timeout waiting for ${type}`));
          delete this.pendingPromises[type];
        }
      }, timeout);
    });
  }

  /**
   * Send a message to the server
   */
  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    console.error('[CLIENT] ❌ WebSocket not connected');
    return false;
  }

  /**
   * Generate an image using FLUX (Text-to-Image)
   */
  async generateImage(prompt, params = {}) {
    console.log(`\n[CLIENT] 🖼️ Generating image...`);
    console.log(`  Prompt: ${prompt.substring(0, 100)}...`);

    const msg = {
      type: 'generarStoryboard',
      prompt: prompt,
      params: {
        videoWidth: params.width || 1280,
        videoHeight: params.height || 720,
        storyboardSteps: params.steps || 25,
        ...params
      },
      storyboardIndex: params.index || 0,
      batchId: params.batchId || `batch_${Date.now()}`
    };

    const promise = this._waitForMessage('image');
    this._send(msg);
    return await promise;
  }

  /**
   * Generate a video using LTX-2 (Text-to-Video)
   */
  async generateVideo(prompt, params = {}) {
    console.log(`\n[CLIENT] 🎬 Generating video (T2V)...`);
    console.log(`  Prompt: ${prompt.substring(0, 100)}...`);

    const msg = {
      type: 'generarImagen',
      prompt: prompt,
      params: {
        videoWidth: params.width || 1280,
        videoHeight: params.height || 720,
        videoLength: params.frames || 121,
        samplerSteps: params.steps || 20,
        cfgScale: params.cfg || 4.0,
        ...params
      },
      batchId: params.batchId || `batch_${Date.now()}`
    };

    const promise = this._waitForMessage('video');
    this._send(msg);
    return await promise;
  }

  /**
   * Generate a video from an image using LTX-2 (Image-to-Video)
   */
  async generateImageToVideo(prompt, imageFilename, params = {}) {
    console.log(`\n[CLIENT] 🎬 Generating video from image (I2V)...`);
    console.log(`  Prompt: ${prompt.substring(0, 100)}...`);
    console.log(`  Image: ${imageFilename}`);

    const msg = {
      type: 'generarImagen',
      prompt: prompt,
      imageFilename: imageFilename,
      params: {
        videoWidth: params.width || 1280,
        videoHeight: params.height || 720,
        videoLength: params.frames || 121,
        samplerSteps: params.steps || 20,
        cfgScale: params.cfg || 4.0,
        refStrength: params.refStrength || 1.0,
        ...params
      },
      batchId: params.batchId || `batch_${Date.now()}`
    };

    const promise = this._waitForMessage('video');
    this._send(msg);
    return await promise;
  }

  /**
   * Generate a video using WAN2.2 (First-last-frame to video)
   */
  async generateWanVideo(prompt, startImageFilename, endImageFilename, params = {}) {
    console.log(`\n[CLIENT] 🔥 Generating WAN2.2 video...`);
    console.log(`  Prompt: ${prompt.substring(0, 100)}...`);
    console.log(`  Start: ${startImageFilename}, End: ${endImageFilename}`);

    const msg = {
      type: 'generarWan22',
      prompt: prompt,
      startImageFilename: startImageFilename,
      endImageFilename: endImageFilename,
      params: {
        videoWidth: params.width || 640,
        videoHeight: params.height || 640,
        videoLength: params.frames || 81,
        samplerSteps: params.steps || 20,
        cfgScale: params.cfg || 4.0,
        ...params
      },
      batchId: params.batchId || `batch_${Date.now()}`
    };

    const promise = this._waitForMessage('video');
    this._send(msg);
    return await promise;
  }

  /**
   * Export timeline via HTTP endpoint
   */
  async exportTimeline(clips, outputName = null) {
    console.log(`\n[CLIENT] 🎬 Exporting timeline...`);
    console.log(`  Clips: ${clips.length}`);

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        clips: clips.map(c => ({
          filename: c.filename,
          prompt: c.prompt || '',
          startTime: c.startTime || 0,
          duration: c.duration || 5,
          muted: c.muted || false,
          track: c.track || 'V1'
        })),
        batchId: `export_${Date.now()}`,
        outputName: outputName
      });

      const options = {
        hostname: SERVER_HOST,
        port: SERVER_PORT,
        path: '/api/export-timeline',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            console.log(`[CLIENT] ✅ Timeline exported: ${result.url}`);
            resolve(result);
          } catch (e) {
            reject(new Error(`Parse error: ${e.message}. Data: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  /**
   * Full workflow: generate multiple scenes as images, then videos, 
   * assemble timeline, export final video
   */
  async runFullWorkflow(steps) {
    console.log('\n========================================');
    console.log('🎬 VIDEOCOMFY FULL WORKFLOW');
    console.log(`   Steps: ${steps.length}`);
    console.log('========================================\n');

    const clips = [];
    const batchId = `workflow_${Date.now()}`;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      console.log(`\n━━━ STEP ${i + 1}/${steps.length}: ${step.title || ''} ━━━`);

      // 1. Generate image with FLUX
      console.log(`\n--- Phase 1: Generating image ---`);
      const imageResult = await this.generateImage(step.imagePrompt, {
        ...(step.imageParams || {}),
        index: i,
        batchId
      });
      
      if (!imageResult || !imageResult.filename) {
        console.error(`[CLIENT] ❌ Failed to generate image for step ${i + 1}`);
        continue;
      }

      console.log(`[CLIENT] ✅ Image ready: ${imageResult.filename}`);

      // Small delay to ensure ComfyUI processes the new image
      await new Promise(r => setTimeout(r, 2000));

      // 2. Generate video from image
      console.log(`\n--- Phase 2: Generating video from image ---`);
      const videoResult = await this.generateImageToVideo(
        step.videoPrompt,
        imageResult.filename,
        {
          width: step.params?.videoWidth || 1280,
          height: step.params?.videoHeight || 720,
          frames: step.params?.videoLength || 121,
          steps: step.params?.samplerSteps || 20,
          cfg: step.params?.cfgScale || 4.0,
          refStrength: step.params?.refStrength || 1.0,
          batchId
        }
      );

      if (!videoResult || !videoResult.filename) {
        console.error(`[CLIENT] ❌ Failed to generate video for step ${i + 1}`);
        continue;
      }

      console.log(`[CLIENT] ✅ Video ready: ${videoResult.filename}`);

      clips.push({
        filename: videoResult.filename,
        prompt: step.title || step.videoPrompt,
        startTime: i * (step.duration || 5),
        duration: step.duration || 5
      });
    }

    // 3. Assemble and export timeline
    if (clips.length > 0) {
      console.log(`\n━━━ ASSEMBLING TIMELINE ━━━`);
      console.log(`  Total clips: ${clips.length}`);
      
      const exportResult = await this.exportTimeline(clips);
      
      console.log('\n========================================');
      console.log('✅ WORKFLOW COMPLETE');
      console.log(`   Final video: http://localhost:5634${exportResult.url}`);
      console.log('========================================\n');
      
      return exportResult;
    } else {
      console.error('\n❌ No clips generated, nothing to export');
      return null;
    }
  }

  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

// ============================================
// COMMAND LINE INTERFACE
// ============================================

async function main() {
  const command = process.argv[2];
  if (!command) {
    console.log(`
Usage:
  node api_client.js generate-image <prompt>
  node api_client.js generate-video <prompt>
  node api_client.js generate-i2v <prompt> <image_filename>
  node api_client.js generate-wan <prompt> [start_image] [end_image]
  node api_client.js export-timeline <clips_json>
  node api_client.js full-workflow <steps_json_file>

Examples:
  node api_client.js generate-image "A beautiful sunset over mountains"
  node api_client.js generate-video "Cinematic drone shot of a forest"
`);
    process.exit(1);
  }

  const client = new VideoComfyClient();
  
  try {
    await client.connect();

    switch (command) {
      case 'generate-image': {
        const prompt = process.argv[3];
        if (!prompt) throw new Error('Prompt required');
        await client.generateImage(prompt);
        break;
      }

      case 'generate-video': {
        const prompt = process.argv[3];
        if (!prompt) throw new Error('Prompt required');
        await client.generateVideo(prompt);
        break;
      }

      case 'generate-i2v': {
        const prompt = process.argv[3];
        const image = process.argv[4];
        if (!prompt || !image) throw new Error('Prompt and image filename required');
        await client.generateImageToVideo(prompt, image);
        break;
      }

      case 'generate-wan': {
        const prompt = process.argv[3];
        const startImg = process.argv[4];
        const endImg = process.argv[5];
        if (!prompt) throw new Error('Prompt required');
        await client.generateWanVideo(prompt, startImg, endImg);
        break;
      }

      case 'export-timeline': {
        const clipsJson = process.argv[3];
        if (!clipsJson) throw new Error('Clips JSON required');
        const clips = JSON.parse(clipsJson);
        await client.exportTimeline(clips);
        break;
      }

      case 'full-workflow': {
        const stepsFile = process.argv[3];
        if (!stepsFile) throw new Error('Steps JSON file required');
        const steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8'));
        if (!steps.steps) throw new Error('JSON must have a "steps" array');
        await client.runFullWorkflow(steps.steps);
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } catch (err) {
    console.error(`\n[CLIENT] ❌ Error: ${err.message}`);
    process.exit(1);
  } finally {
    client.close();
    // Give time for final messages
    setTimeout(() => process.exit(0), 2000);
  }
}

// Also export for programmatic use
module.exports = { VideoComfyClient };

if (require.main === module) {
  main();
}
