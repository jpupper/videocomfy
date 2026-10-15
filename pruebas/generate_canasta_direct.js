#!/usr/bin/env node
/**
 * Generate Canasta game images directly via ComfyUI REST API.
 * Avoids WebSocket issues by using HTTP polling.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const COMFY_HOST = '127.0.0.1';
const COMFY_PORT = 8188;
const PROJECT_DIR = __dirname;
const OUTPUT_DIR = path.join(PROJECT_DIR, 'public', 'uploads');

const WORKFLOW_PATH = path.join(PROJECT_DIR, 'flux_dev_full_text_to_image_api.json');

const PRODUCTS = [
  // Correctos (suman punto)
  { id: 'vinos',           prompt: 'A premium wine bottle and a glass of red wine on a rustic wooden table, warm ambient lighting, product photography, centered composition, clean white background' },
  { id: 'aceite-oliva',    prompt: 'A glass bottle of extra virgin olive oil with golden liquid, olives next to it, rustic style, product photography, centered on clean white background, soft studio lighting' },
  { id: 'miel-dulces',     prompt: 'A jar of golden honey with honeycomb, and traditional Argentine sweets (dulces) on a rustic wooden surface, warm lighting, product photography, centered composition' },
  { id: 'tomate-triturado', prompt: 'A glass jar of crushed tomatoes (tomate triturado), fresh tomatoes and basil leaves around it, Italian style, product photography, centered on clean background' },
  { id: 'frutos-secos',    prompt: 'A wooden bowl filled with mixed nuts and dried fruits: almonds, walnuts, raisins, hazelnuts, rustic style, product photography, centered on warm background' },
  { id: 'conservas',       prompt: 'Assorted canned preserves in glass jars: pickles, vegetables in oil, arranged on a wooden shelf, rustic Argentine style, product photography, centered composition' },
  { id: 'gin',             prompt: 'A premium gin bottle with juniper berries and a slice of lime, crystal clear liquid, elegant style, product photography, centered on white background' },
  { id: 'licor',           prompt: 'A bottle of Argentine liquor like licor de menta or crema de whiskey, with a small glass, warm lighting, product photography, centered composition' },
  // Incorrectos (restan punto)
  { id: 'yerba-mate',      prompt: 'A bag of yerba mate with a traditional mate gourd (mate) and bombilla, Argentine tradition, product photography, centered on clean background' },
  { id: 'banana',          prompt: 'A bunch of fresh yellow bananas on a wooden surface, tropical fruit, product photography, centered on white background, studio lighting' },
  { id: 'cafe',            prompt: 'A bag of roasted coffee beans with a cup of black coffee, steam rising, warm tones, product photography, centered composition' },
  { id: 'cacao',           prompt: 'Cacao beans and cocoa powder on a rustic surface, dark chocolate pieces, product photography, centered on warm background' },
  { id: 'coco',            prompt: 'A whole coconut cut in half showing white flesh and milk, tropical, on a wooden surface, product photography, centered composition' },
  { id: 'anana',           prompt: 'A whole fresh pineapple with green leaves, tropical fruit, bright studio lighting, product photography, centered on white background' },
  { id: 'palta',           prompt: 'A ripe avocado cut in half showing the pit, green flesh, on a wooden surface, product photography, centered composition' }
];

function httpJson(method, urlPath, data) {
  return new Promise((resolve, reject) => {
    const payload = data ? JSON.stringify(data) : '';
    const opts = {
      hostname: COMFY_HOST, port: COMFY_PORT,
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

async function clearQueue() {
  try { await httpJson('POST', '/interrupt', {}); } catch(e) {}
  await sleep(1000);
  try { await httpJson('POST', '/queue', { clear: true }); } catch(e) {}
  console.log('  Queue cleared.');
}

async function queuePrompt(workflow) {
  const result = await httpJson('POST', '/prompt', {
    prompt: workflow,
    client_id: `canasta_${Date.now()}`
  });
  return result.prompt_id;
}

async function getHistory(promptId) {
  try {
    return await httpJson('GET', `/history/${promptId}`);
  } catch(e) {
    return null;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function generateOne(product, index, total) {
  const workflow = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
  
  workflow["41"]["inputs"]["clip_l"] = product.prompt;
  workflow["41"]["inputs"]["t5xxl"] = product.prompt;
  workflow["31"]["inputs"]["seed"] = Math.floor(Math.random() * 1000000000000000);
  workflow["31"]["inputs"]["steps"] = 30;
  workflow["27"]["inputs"]["width"] = 1024;
  workflow["27"]["inputs"]["height"] = 1024;
  
  process.stdout.write(`\n[${index}/${total}] ${product.id}: Queuing... `);
  const promptId = await queuePrompt(workflow);
  console.log(`ID: ${promptId.substring(0,12)}...`);
  
  // Poll for completion
  const start = Date.now();
  const timeout = 600000; // 10 min
  
  while (Date.now() - start < timeout) {
    const history = await getHistory(promptId);
    if (history && history[promptId]) {
      const h = history[promptId];
      if (h.status && h.status.completed) {
        const elapsed = Math.round((Date.now() - start) / 1000);
        console.log(`  Complete! (${elapsed}s)`);
        
        // Get output image
        const outputs = h.outputs || {};
        let imageFile = null;
        for (const nodeId in outputs) {
          if (outputs[nodeId].images) {
            imageFile = outputs[nodeId].images[0];
            break;
          }
        }
        
        if (!imageFile) {
          console.log('  No output image found');
          return null;
        }
        
        // Download
        const sub = imageFile.subfolder || '';
        const type = imageFile.type || 'output';
        const url = `http://${COMFY_HOST}:${COMFY_PORT}/view?filename=${encodeURIComponent(imageFile.filename)}${sub ? '&subfolder=' + encodeURIComponent(sub) : ''}&type=${encodeURIComponent(type)}`;
        const newName = `canasta_${product.id}.png`;
        
        const buffer = await httpGetBuffer(url);
        if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        const savePath = path.join(OUTPUT_DIR, newName);
        fs.writeFileSync(savePath, buffer);
        console.log(`  Saved: ${newName} (${(buffer.length/1024).toFixed(0)} KB)`);
        
        return newName;
      }
      if (h.status && h.status.error) {
        console.log(`  Error: ${JSON.stringify(h.status.error)}`);
        return null;
      }
    }
    await sleep(3000);
    process.stdout.write('.');
  }
  
  console.log(`\n  Timeout after ${timeout/1000}s`);
  return null;
}

async function main() {
  console.log('========================================');
  console.log('  CANASTA GAME - Image Generation');
  console.log(`  Total: ${PRODUCTS.length} images`);
  console.log('========================================');
  
  await clearQueue();
  await sleep(2000);
  
  const results = [];
  
  for (let i = 0; i < PRODUCTS.length; i++) {
    try {
      const filename = await generateOne(PRODUCTS[i], i + 1, PRODUCTS.length);
      results.push({ product: PRODUCTS[i].id, filename, status: filename ? 'ok' : 'failed' });
    } catch (err) {
      console.log(`\n  FAIL: ${err.message}`);
      results.push({ product: PRODUCTS[i].id, status: 'error', error: err.message });
    }
    await sleep(1000);
  }
  
  // Save results
  const resultPath = path.join(PROJECT_DIR, 'canasta_results.json');
  fs.writeFileSync(resultPath, JSON.stringify(results, null, 2));
  
  console.log('\n' + '='.repeat(60));
  console.log('RESULTS:');
  results.forEach(r => {
    const icon = r.status === 'ok' ? '✅' : '❌';
    console.log(`  ${icon} ${r.product}: ${r.filename || r.error || 'failed'}`);
  });
  console.log(`\nResults saved to: ${resultPath}`);
  console.log('ALL DONE');
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
