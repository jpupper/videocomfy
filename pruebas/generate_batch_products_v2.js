#!/usr/bin/env node
// Genera todas las imágenes de productos para el juego Canasta - v2 (sin \r)
const WebSocket = require('ws');

const PRODUCTS = [
  // Correctos (suman punto)
  { id: 'vinos', prompt: 'A premium bottle of red San Juan wine on rustic wooden table, warm golden hour lighting, product photography, clean white background, high quality, 4k, centered composition' },
  { id: 'aceite_oliva', prompt: 'A beautiful bottle of extra virgin olive oil, golden liquid pouring into a small glass, green olives nearby, rustic Mediterranean style, product photography, clean background, high quality' },
  { id: 'miel_dulces', prompt: 'A glass jar of golden honey with honey dipper, artisan dulces and alfajores nearby, warm amber lighting, product photography, clean background, high quality, 4k' },
  { id: 'tomate_triturado', prompt: 'Crushed tomato in a glass jar, rich red color, fresh ripe tomatoes and basil leaves nearby, Italian style, product photography, clean background, high quality' },
  { id: 'frutos_secos', prompt: 'A rustic wooden bowl with mixed nuts and dried fruits, almonds, walnuts, figs and apricots, warm natural lighting, product photography, clean background, high quality' },
  { id: 'conservas', prompt: 'Assorted canned preserves in glass jars, pickled vegetables and artisan conserves, rustic kitchen style, product photography, clean background, high quality, 4k' },
  { id: 'gin', prompt: 'A premium gin bottle with juniper berries and citrus slices, craft distillery style, crystal clear glass, product photography, clean white background, high quality' },
  { id: 'licor', prompt: 'An artisanal liquor bottle, amber colored spirit, small tasting glass beside it, warm bar lighting, product photography, clean background, high quality' },
  // Incorrectos (restan punto)
  { id: 'yerba_mate', prompt: 'A pile of dried yerba mate leaves, traditional South American herbal tea, green textured leaves in a gourd, natural lighting, product photography, clean background, high quality' },
  { id: 'banana', prompt: 'Fresh yellow banana on clean white surface, tropical fruit, vibrant natural colors, product photography, high quality, 4k, bright lighting' },
  { id: 'cafe', prompt: 'Fresh roasted coffee beans scattered on rustic surface, dark rich brown colors, steam rising from a cup, coffee shop style, product photography, clean background' },
  { id: 'cacao', prompt: 'Raw cacao beans and cocoa powder, dark chocolate blocks, rich brown tones, artisanal chocolate making, product photography, clean background, high quality' },
  { id: 'coco', prompt: 'A whole coconut with white flesh and coconut water splash, tropical, green palm leaf, product photography, clean white background, high quality, 4k' },
  { id: 'anana', prompt: 'A fresh golden pineapple, tropical fruit, green crown leaves, vibrant yellow texture, warm sunlight, product photography, clean background, high quality' },
  { id: 'palta', prompt: 'A ripe avocado cut in half showing the pit, creamy green flesh, on clean surface, product photography, bright natural lighting, high quality, 4k' }
];

const results = [];
let failed = 0;
let succeeded = 0;

function generateImage(product, index) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:5634');
    const timeout = setTimeout(() => {
      ws.close();
      console.log(`TIMEOUT: ${product.id}`);
      failed++;
      resolve(null);
    }, 180000);

    ws.on('open', () => {
      console.log(`[${index + 1}/${PRODUCTS.length}] Starting: ${product.id}...`);
      ws.send(JSON.stringify({
        type: 'generarStoryboard',
        prompt: product.prompt,
        params: {
          storyboardSteps: 30,
          videoWidth: 1024,
          videoHeight: 1024
        },
        storyboardIndex: 0,
        batchId: `product-${product.id}`
      }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'progress') {
          // skip progress logs to avoid buffer issues
        }
        if (msg.filename || msg.file) {
          clearTimeout(timeout);
          ws.close();
          const fn = msg.filename || msg.file;
          console.log(`[${index + 1}/${PRODUCTS.length}] DONE: ${product.id} -> ${fn}`);
          succeeded++;
          results.push({ id: product.id, filename: fn });
          resolve({ id: product.id, filename: fn });
          return;
        }
        if (msg.type === 'error' || msg.status === 'error') {
          clearTimeout(timeout);
          ws.close();
          console.log(`ERROR: ${product.id}: ${msg.message || 'unknown error'}`);
          failed++;
          resolve(null);
          return;
        }
        if (msg.type === 'result') {
          clearTimeout(timeout);
          ws.close();
          console.log(`[${index + 1}/${PRODUCTS.length}] DONE: ${product.id} -> result received`);
          succeeded++;
          results.push({ id: product.id, filename: '' });
          resolve({ id: product.id, filename: '' });
          return;
        }
      } catch(e) {
        // ignore partial messages
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      console.log(`WS ERROR: ${product.id}: ${err.message}`);
      failed++;
      resolve(null);
    });
  });
}

async function main() {
  console.log(`Generando ${PRODUCTS.length} imagenes de productos...`);
  
  // Generate sequentially to avoid WebSocket contention
  for (let i = 0; i < PRODUCTS.length; i++) {
    const product = PRODUCTS[i];
    console.log(`\n=== Producto ${i + 1}: ${product.id} ===`);
    await generateImage(product, i);
    // Short pause between each
    if (i < PRODUCTS.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  console.log(`\n\n========================================`);
  console.log(`Total: ${PRODUCTS.length} | Exito: ${succeeded} | Fallos: ${failed}`);
  console.log(`========================================`);
  
  console.log(`\nResultados:`);
  results.forEach(r => console.log(`  ${r.id}: ${r.filename}`));
}

main().catch((err) => {
  console.log(`FATAL: ${err.message}`);
  process.exit(1);
});
