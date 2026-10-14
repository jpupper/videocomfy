#!/usr/bin/env node
/**
 * Batch generate all 15 product images for the game via videocomfy WebSocket.
 * Queues them one at a time through videocomfy, waits for each to complete.
 * Outputs results JSON when done.
 */
const WebSocket = require('ws');
const FS = require('fs');

const PRODUCTOS = [
  // Correctos (suman punto)
  { id: "vino",          prompt: "Botella de vino tinto, etiqueta clásica, aislado sobre fondo blanco, fotografía de producto, iluminación de estudio, ultra detallado, 8k" },
  { id: "aceite-oliva",  prompt: "Botella de aceite de oliva virgen extra, vidrio verde oscuro, etiqueta rústica dorada, aislado sobre fondo blanco, iluminación de estudio, fotografía de producto, ultra detallado" },
  { id: "miel-dulces",   prompt: "Tarro de miel artesanal con panal de cera, etiqueta dorada, rodeado de dulces regionales, aislado sobre fondo blanco, fotografía de producto, iluminación de estudio, ultra detallado" },
  { id: "tomate",        prompt: "Tarro de vidrio de tomate triturado, salsa roja brillante, etiqueta italiana clásica, aislado sobre fondo blanco, fotografía de producto, iluminación de estudio, ultra detallado" },
  { id: "frutos-secos",  prompt: "Cuenco de madera con frutos secos variados, almendras, nueces, pasas, avellanas, estilo rústico, fotografía de producto, centrado sobre fondo blanco, ultra detallado" },
  { id: "conservas",     prompt: "Latas de conservas artesanales, verduras en escabeche, etiqueta vintage, aislado sobre fondo blanco, fotografía de producto, iluminación de estudio, ultra detallado, 8k" },
  { id: "gin",           prompt: "Botella de ginebra artesanal, vidrio azul oscuro, etiqueta vintage dorada, aislado sobre fondo blanco, fotografía de producto, iluminación de estudio, ultra detallado" },
  { id: "licor",         prompt: "Botella de licor dulce artesanal, vidrio ámbar, etiqueta dorada clásica, aislado sobre fondo blanco, fotografía de producto, iluminación de estudio, ultra detallado, 8k" },
  // Incorrectos (restan punto)
  { id: "yerba-mate",    prompt: "Paquete de yerba mate tradicional, hojas verdes, envase argentino, aislado sobre fondo blanco, fotografía de producto, iluminación de estudio, ultra detallado" },
  { id: "banana",        prompt: "Bananas frescas maduras, racimo amarillo brillante, aislado sobre fondo blanco, fotografía de producto, iluminación de estudio, ultra detallado, 8k" },
  { id: "cafe",          prompt: "Granos de café tostado oscuro, bolsa artesanal de arpillera, aislado sobre fondo blanco, fotografía de producto, iluminación de estudio, ultra detallado" },
  { id: "cacao",         prompt: "Semillas de cacao crudo y tableta de chocolate artesanal oscuro, aislado sobre fondo blanco, fotografía de producto, iluminación de estudio, ultra detallado" },
  { id: "coco",          prompt: "Coco fresco partido mostrando pulpa blanca, con leche de coco en vidrio, aislado sobre fondo blanco, fotografía de producto, iluminación de estudio" },
  { id: "anana",         prompt: "Piña tropical fresca entera con hojas verdes, aislado sobre fondo blanco, fotografía de producto, iluminación de estudio, ultra detallado, 8k" },
  { id: "palta",         prompt: "Aguacate palta fresco entero y corte transversal mostrando pulpa verde, aislado sobre fondo blanco, fotografía de producto, iluminación de estudio" },
];

const BATCH_ID = `productos-${Date.now()}`;
const results = [];
let currentIdx = 0;
let timeoutId = null;

console.log(`Generando ${PRODUCTOS.length} imagenes para batch ${BATCH_ID}...`);

function connect() {
  const ws = new WebSocket('ws://localhost:5634');
  let connected = false;

  ws.on('open', () => {
    connected = true;
    console.log('Conectado a videocomfy');
    queueNext(ws);
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const current = PRODUCTOS[currentIdx];

    if (msg.type === 'progress') {
      // progress silently - no \r chars to avoid MSYS2 issues
      return;
    }

    if (msg.filename || msg.file) {
      const fn = msg.filename || msg.file || 'desconocido';
      results.push({ id: current.id, prompt: current.prompt.slice(0,60), filename: fn });
      console.log(`\n  ✅ ${current.id} → ${fn}`);
      currentIdx++;
      if (currentIdx < PRODUCTOS.length) {
        queueNext(ws);
      } else {
        done(ws);
      }
      return;
    }

    if (msg.type === 'error' || msg.status === 'error') {
      console.error(`\n  ❌ ${current.id}: ${msg.message || 'error desconocido'}`);
      results.push({ id: current.id, prompt: current.prompt.slice(0,60), error: msg.message });
      currentIdx++;
      if (currentIdx < PRODUCTOS.length) {
        queueNext(ws);
      } else {
        done(ws);
      }
      return;
    }

    // type 'result' or unknown - try filename
    if (msg.filename) {
      const fn = msg.filename;
      results.push({ id: current.id, prompt: current.prompt.slice(0,60), filename: fn });
      console.log(`\n  ✅ ${current.id} → ${fn}`);
      currentIdx++;
      if (currentIdx < PRODUCTOS.length) {
        queueNext(ws);
      } else {
        done(ws);
      }
    }
  });

  ws.on('close', () => {
    if (currentIdx < PRODUCTOS.length && connected) {
      console.log('\nWebSocket cerrado, reconectando...');
      setTimeout(() => connect(), 2000);
    }
  });

  ws.on('error', (err) => {
    console.error(`\nWebSocket error: ${err.message}`);
  });
}

function queueNext(ws) {
  if (currentIdx >= PRODUCTOS.length) return;
  const item = PRODUCTOS[currentIdx];
  console.log(`\n[${currentIdx+1}/${PRODUCTOS.length}] Generando ${item.id}...`);

  ws.send(JSON.stringify({
    type: 'generarStoryboard',
    prompt: item.prompt,
    params: {
      storyboardSteps: 25,
      videoWidth: 1024,
      videoHeight: 1024
    },
    storyboardIndex: 0,
    batchId: BATCH_ID
  }));
}

function done(ws) {
  console.log('\n\n========================================');
  console.log('Todas las imagenes generadas!');
  console.log('========================================');
  console.log(JSON.stringify({ batchId: BATCH_ID, results }, null, 2));
  FS.writeFileSync(`resultados_${BATCH_ID}.json`, JSON.stringify({ batchId: BATCH_ID, results }, null, 2));
  ws.close();
  process.exit(0);
}

connect();
