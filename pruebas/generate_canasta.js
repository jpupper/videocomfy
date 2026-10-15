#!/usr/bin/env node
// Generates all 15 product images for the "Canasta" game
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PRODUCTS = [
  // Correctos (suman punto)
  { id: 'vinos', prompt: 'A premium wine bottle and a glass of red wine on a rustic wooden table, warm ambient lighting, product photography, centered composition, clean white background' },
  { id: 'aceite-oliva', prompt: 'A glass bottle of extra virgin olive oil with golden liquid, olives next to it, rustic style, product photography, centered on clean white background, soft studio lighting' },
  { id: 'miel-dulces', prompt: 'A jar of golden honey with honeycomb, and traditional Argentine sweets (dulces) on a rustic wooden surface, warm lighting, product photography, centered composition' },
  { id: 'tomate-triturado', prompt: 'A glass jar of crushed tomatoes (tomate triturado), fresh tomatoes and basil leaves around it, Italian style, product photography, centered on clean background' },
  { id: 'frutos-secos', prompt: 'A wooden bowl filled with mixed nuts and dried fruits: almonds, walnuts, raisins, hazelnuts, rustic style, product photography, centered on warm background' },
  { id: 'conservas', prompt: 'Assorted canned preserves in glass jars: pickles, vegetables in oil, arranged on a wooden shelf, rustic Argentine style, product photography, centered composition' },
  { id: 'gin', prompt: 'A premium gin bottle with juniper berries and a slice of lime, crystal clear liquid, elegant style, product photography, centered on white background' },
  { id: 'licor', prompt: 'A bottle of Argentine liquor like licor de menta or crema de whiskey, with a small glass, warm lighting, product photography, centered composition' },
  // Incorrectos (restan punto)
  { id: 'yerba-mate', prompt: 'A bag of yerba mate with a traditional mate gourd (mate) and bombilla, Argentine tradition, product photography, centered on clean background' },
  { id: 'banana', prompt: 'A bunch of fresh yellow bananas on a wooden surface, tropical fruit, product photography, centered on white background, studio lighting' },
  { id: 'cafe', prompt: 'A bag of roasted coffee beans with a cup of black coffee, steam rising, warm tones, product photography, centered composition' },
  { id: 'cacao', prompt: 'Cacao beans and cocoa powder on a rustic surface, dark chocolate pieces, product photography, centered on warm background' },
  { id: 'coco', prompt: 'A whole coconut cut in half showing white flesh and milk, tropical, on a wooden surface, product photography, centered composition' },
  { id: 'anana', prompt: 'A whole fresh pineapple with green leaves, tropical fruit, bright studio lighting, product photography, centered on white background' },
  { id: 'palta', prompt: 'A ripe avocado cut in half showing the pit, green flesh, on a wooden surface, product photography, centered composition' }
];

const WS_URL = 'ws://localhost:5634';

function generateImage(product, index) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timeout = setTimeout(() => {
      try { ws.close(); } catch(e) {}
      reject(new Error('Timeout for ' + product.id));
    }, 180000);

    ws.on('open', function() {
      console.log('[' + (index+1) + '/' + PRODUCTS.length + '] Generating: ' + product.id);
      ws.send(JSON.stringify({
        type: 'generarStoryboard',
        prompt: product.prompt,
        params: {
          storyboardSteps: 30,
          videoWidth: 1024,
          videoHeight: 1024
        },
        storyboardIndex: 0,
        batchId: 'canasta-' + product.id + '-' + Date.now()
      }));
    });

    ws.on('message', function(data) {
      var msg;
      try { msg = JSON.parse(data.toString()); } catch(e) { return; }
      if (msg.filename || msg.file) {
        clearTimeout(timeout);
        try { ws.close(); } catch(e) {}
        console.log('   OK: ' + (msg.filename || msg.file));
        resolve(msg);
      }
      if (msg.type === 'error' || msg.status === 'error') {
        clearTimeout(timeout);
        try { ws.close(); } catch(e) {}
        reject(new Error(msg.message || 'Failed'));
      }
    });

    ws.on('error', function(err) {
      clearTimeout(timeout);
      reject(err);
    });

    ws.on('close', function() {
      clearTimeout(timeout);
    });
  });
}

function sleep(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

async function main() {
  console.log('=== Generating Canasta Game Images ===');
  console.log('Total: ' + PRODUCTS.length + ' images');

  var results = [];

  for (var i = 0; i < PRODUCTS.length; i++) {
    try {
      var result = await generateImage(PRODUCTS[i], i);
      results.push({ product: PRODUCTS[i].id, filename: result.filename || result.file });
      console.log('  [OK] ' + PRODUCTS[i].id);
    } catch (err) {
      console.error('  [FAIL] ' + PRODUCTS[i].id + ': ' + err.message);
      results.push({ product: PRODUCTS[i].id, error: err.message });
    }
    // Small delay between generations
    await sleep(1000);
  }

  // Write results
  var outputPath = path.join(__dirname, 'canasta_results.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log();
  console.log('=== ALL DONE ===');
  console.log('Results saved to: ' + outputPath);

  // List generated files
  var uploadsDir = path.join(__dirname, 'public', 'uploads');
  if (fs.existsSync(uploadsDir)) {
    var files = fs.readdirSync(uploadsDir)
      .filter(function(f) { return f.startsWith('Flux_'); })
      .sort(function(a, b) {
        return fs.statSync(path.join(uploadsDir, a)).mtimeMs - fs.statSync(path.join(uploadsDir, b)).mtimeMs;
      });
    console.log('\nLatest ' + PRODUCTS.length + ' generated files:');
    var recent = files.slice(-PRODUCTS.length);
    recent.forEach(function(f, i) {
      console.log('  ' + (i+1) + '. ' + f);
    });
  }

  process.exit(0);
}

main().catch(function(err) {
  console.error('FATAL:', err.message);
  process.exit(1);
});
