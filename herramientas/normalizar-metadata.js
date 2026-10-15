// ============================================================
// Normaliza los metadata.json de las imágenes/videos generados.
// ------------------------------------------------------------
// Quedaron entradas de distintas épocas: algunas sin computadora/pedidoPor,
// otras con campos de WAN, otras sin modelo. Este script las deja TODAS con la
// misma forma (sin borrar nada: lo que falta se completa con valores neutros) y
// las ordena por fecha.
//
//   node herramientas/normalizar-metadata.js            (informa)
//   node herramientas/normalizar-metadata.js --aplicar  (escribe)
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

const APLICAR = process.argv.includes('--aplicar');
const ARCHIVOS = [
    { ruta: path.join(__dirname, '..', 'public', 'uploads', 'metadata.json'), tipo: 'imagen' },
    { ruta: path.join(__dirname, '..', 'public', 'videos', 'metadata.json'), tipo: 'video' }
];

function normalizar(entrada, tipo) {
    const e = entrada || {};
    const pc = e.computadora || {};
    const pp = e.pedidoPor || {};
    return {
        prompt: String(e.prompt || '(sin prompt)'),
        params: e.params && typeof e.params === 'object' ? e.params : {},
        tipo: e.tipo || (e.type === 'video' ? 'video' : tipo),
        modelo: e.modelo || (e.red ? 'red' : '') || '',
        origen: e.origen || (e.red ? 'red' : 'local'),
        computadora: {
            peerId: pc.peerId || '',
            nombre: pc.nombre || '(computadora desconocida)',
            dueno: pc.dueno || 'desconocido',
            avatar: pc.avatar || ''
        },
        pedidoPor: {
            usuario: pp.usuario || 'desconocido',
            displayName: pp.displayName || pp.usuario || 'desconocido',
            avatar: pp.avatar || '',
            tipo: pp.tipo || (e.origen === 'red' || e.red ? 'web' : 'local')
        },
        // se conservan los extras que ya existían (WAN, storyboard, batch...)
        batchId: e.batchId || null,
        batchName: e.batchName || null,
        storyboardIndex: e.storyboardIndex !== undefined ? e.storyboardIndex : null,
        isForWan: e.isForWan !== undefined ? !!e.isForWan : undefined,
        wanRole: e.wanRole || undefined,
        prompt_id: e.prompt_id || null,
        timestamp: e.timestamp || e.savedAt || e.generationStartTime || null
    };
}

for (const f of ARCHIVOS) {
    if (!fs.existsSync(f.ruta)) { console.log('— no existe', f.ruta); continue; }
    let datos = {};
    try { datos = JSON.parse(fs.readFileSync(f.ruta, 'utf8')); } catch (e) { console.log('✗ no pude leer', f.ruta, e.message); continue; }

    const claves = Object.keys(datos);
    const salida = {};
    // ordenar por fecha (los sin fecha van primero, como estaban)
    claves.sort((a, b) => Number(datos[a].timestamp || 0) - Number(datos[b].timestamp || 0));
    for (const k of claves) {
        const n = normalizar(datos[k], f.tipo);
        // limpiar los undefined para no ensuciar el JSON
        Object.keys(n).forEach((kk) => { if (n[kk] === undefined) delete n[kk]; });
        salida[k] = n;
    }

    const sinPc = claves.filter((k) => !datos[k].computadora).length;
    const sinPidio = claves.filter((k) => !datos[k].pedidoPor).length;
    console.log(`${path.basename(path.dirname(f.ruta))}/metadata.json: ${claves.length} entradas — ${sinPc} sin computadora, ${sinPidio} sin quién la pidió`);
    if (APLICAR) {
        fs.writeFileSync(f.ruta, JSON.stringify(salida, null, 2), 'utf8');
        console.log('   ✅ normalizado');
    }
}
if (!APLICAR) console.log('\n(para escribir: --aplicar)');
