#!/usr/bin/env node
// Genera todas las imágenes de productos para el juego Canasta
// Uso: node generate_batch_products.js

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

let completed = 0;
let failed = 0;

function generateImage(product, index) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:5634');
    const timeout = setTimeout(() => {
      ws.close();
      console.error(`TIMEOUT: ${product.id}`);
      failed++;
      completed++;
      resolve();
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
          process.stderr.write(`\r[${product.id}] ${msg.progress || '?'}%`);
        }
        if (msg.filename || msg.file) {
          clearTimeout(timeout);
          ws.close();
          console.log(`\n[${index + 1}/${PRODUCTS.length}] DONE: ${product.id} -> ${msg.filename || msg.file}`);
          completed++;
          resolve({ id: product.id, filename: msg.filename || msg.file });
        }
        if (msg.type === 'error' || msg.status === 'error') {
          clearTimeout(timeout);
          ws.close();
          console.error(`\nERROR: ${product.id}: ${msg.message || 'unknown error'}`);
          failed++;
          completed++;
          resolve(null);
        }
      } catch(e) {
        // Partial message, ignore
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      console.error(`\nWS ERROR: ${product.id}: ${err.message}`);
      failed++;
      completed++;
      resolve(null);
    });
  });
}

async function main() {
  console.log(`Generando ${PRODUCTS.length} imágenes de productos...\n`);
  
  // Generar en lotes de 3 para no saturar
  const results = [];
  const batchSize = 3;
  
  for (let i = 0; i < PRODUCTS.length; i += batchSize) {
    const batch = PRODUCTS.slice(i, i + batchSize);
    console.log(`\n=== Lote ${Math.floor(i / batchSize) + 1}/${Math.ceil(PRODUCTS.length / batchSize)} ===`);
    const batchResults = await Promise.all(batch.map((p, idx) => generateImage(p, i + idx)));
    results.push(...batchResults);
    // Pequeña pausa entre lotes
    if (i + batchSize < PRODUCTS.length) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  
  console.log(`\n\n========================================`);
  console.log(`Total: ${PRODUCTS.length} | Completados: ${completed - failed} | Fallos: ${failed}`);
  console.log(`========================================`);
  
  // Listar archivos generados
  console.log(`\nArchivos generados en /d/Programacion/videocomfy/public/uploads/:`);
}

main().catch(console.error);
