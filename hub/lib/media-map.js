// ============================================================
// jpiassets - mapa de media: archivo local -> URL en Cloudflare R2
// ------------------------------------------------------------
// Cuando el agente sube un resultado generado, el VPS lo guarda en R2 y
// anota aca la relacion (nombre de archivo local -> URL publica). El relay
// usa este mapa para reescribir las URLs que devuelve el videocomfy:
//   /uploads/Flux_0001_.png  ->  https://pub-...r2.dev/jpiassets/imagenes/...
// Si no hay entrada (o no hay R2 configurado, como en local), se deja la
// URL relativa y el navegador la pide por el relay (comportamiento viejo).
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

const ARCHIVO = process.env.MEDIA_MAP_PATH || path.join(__dirname, '..', 'data', 'media-map.json');

let mapa = null;

function cargar() {
    if (mapa) return mapa;
    try {
        mapa = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));
    } catch (e) {
        mapa = {};
    }
    return mapa;
}

function guardar() {
    try {
        fs.mkdirSync(path.dirname(ARCHIVO), { recursive: true });
        fs.writeFileSync(ARCHIVO, JSON.stringify(cargar(), null, 1));
    } catch (e) {
        console.warn('[media-map] no pude guardar:', e.message);
    }
}

// nombre de archivo local (Flux_0001_.png) -> URL publica en R2
function urlDeArchivo(nombre) {
    if (!nombre) return null;
    const m = cargar();
    const e = m[nombre];
    if (!e) return null;
    return typeof e === 'string' ? e : (e.url || null);
}

function anotar(nombre, url, extra) {
    if (!nombre || !url) return;
    const m = cargar();
    m[nombre] = Object.assign({ url: url, at: Date.now() }, extra || {});
    guardar();
}

function cantidad() { return Object.keys(cargar()).length; }

// devuelve el mapa completo (para saber que falta subir, backfill incluido)
function todoElMapa() { return cargar(); }

module.exports = { urlDeArchivo, anotar, cantidad, todoElMapa, ARCHIVO };
