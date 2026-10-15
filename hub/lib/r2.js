/* =============================================================================
   lib/r2.js — MEDIA EN CLOUDFLARE R2 (jpshadereditor)
   -----------------------------------------------------------------------------
   TODAS las imágenes de la app (thumbnails de shaders, imágenes de entrada de
   los shaders, GIFs y las miniaturas de las composiciones) se guardan en el
   MISMO bucket de Cloudflare R2 que usa el resto del ecosistema FSC (bucket
   `fscapps`), así el admin de FSCAUTH puede mostrar TODO lo subido y cuánto
   espacio queda antes de empezar a pagar (free tier: 10 GB-mes).

   Variables de entorno (las mismas que fscauth/mapai):
       CLOUDFLARE_ACCOUNT_ID · R2_BUCKET_NAME · R2_ACCESS_KEY_ID
       R2_SECRET_ACCESS_KEY · R2_ENDPOINT · R2_PUBLIC_URL (opcional)

   Si R2 NO está configurado, el módulo lo dice (r2Configurado() === false) y el
   server sigue guardando en disco como antes: nada se rompe en local/desktop.
   ========================================================================== */

const fs = require('fs');
const path = require('path');

let S3 = null, libUpload = null, cliente = null;

function r2Configurado() {
    return !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_ENDPOINT);
}

function bucket() {
    return process.env.R2_BUCKET_NAME || 'fscapps';
}

function clienteR2() {
    if (cliente) return cliente;
    if (!r2Configurado()) return null;
    if (!S3) {
        S3 = require('@aws-sdk/client-s3');
        libUpload = require('@aws-sdk/lib-storage');
    }
    cliente = new S3.S3Client({
        region: 'auto',
        endpoint: process.env.R2_ENDPOINT,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
        }
    });
    return cliente;
}

// ¿La URL pública está configurada de verdad (no el placeholder del .env)?
function urlPublicaConfigurada() {
    const u = String(process.env.R2_PUBLIC_URL || '');
    return !!u && !/your-domain|TU-DOMINIO|cambiar/i.test(u);
}

// Base ABSOLUTA del proxy (se setea desde server.js con VPS_BASE_URL). Sin esto
// las URLs quedarían relativas y romperían en el desktop / otras apps.
let BASE_PROXY = '';

function setBaseProxy(u) {
    BASE_PROXY = String(u || '').replace(/\/+$/, '');
}

// URL para servir un objeto: CDN si está configurado, si no el proxy del server.
function urlMedia(key) {
    const k = String(key || '').replace(/^\/+/, '');
    if (urlPublicaConfigurada()) {
        return `${String(process.env.R2_PUBLIC_URL).replace(/\/+$/, '')}/${k}`;
    }
    return `${BASE_PROXY}/api/media/${k}`;
}

// Saca la clave R2 de una URL (propia o del CDN) — sirve para borrar.
function claveDeUrl(url) {
    if (!url) return null;
    let s = String(url).trim();
    if (urlPublicaConfigurada()) {
        const base = String(process.env.R2_PUBLIC_URL).replace(/\/+$/, '');
        if (s.startsWith(base + '/')) return s.slice(base.length + 1);
    }
    const i = s.indexOf('/api/media/');
    if (i !== -1) return decodeURIComponent(s.slice(i + '/api/media/'.length));
    return null;
}

// Sube un buffer a R2. tipo = carpeta de primer nivel (jpshadereditor, avatars…).
// sub  = subruta interna (thumbnails/nombre, shader_images/nombre, gifs/user…).
// Devuelve { key, url } o null si R2 no está configurado / falló.
async function subirMedia(buffer, { tipo = 'jpshadereditor', sub = '', filename = 'file', mime = 'application/octet-stream', sobreescribir = true } = {}) {
    if (!r2Configurado()) return null;
    const c = clienteR2();
    const limpio = String(sub || '').replace(/^\/+|\/+$/g, '');
    const nombre = String(filename || 'file').replace(/[^\w.\-]+/g, '_');
    // sobreescribir=true → clave estable (reemplaza el archivo anterior, como el
    // fs.writeFileSync de antes); false → nombre con timestamp (no pisa nada).
    const key = [tipo, limpio, sobreescribir ? nombre : `${Date.now()}_${nombre}`]
        .filter(Boolean).join('/');

    try {
        const up = new libUpload.Upload({
            client: c,
            params: { Bucket: bucket(), Key: key, Body: buffer, ContentType: mime }
        });
        await up.done();
        return { key, url: urlMedia(key) };
    } catch (e) {
        console.error('[R2] Error subiendo ' + key + ':', e.message || e);
        return null;
    }
}

// Borra un objeto por clave (o por URL). Silencioso: nunca tira.
async function borrarMedia(keyOUrl) {
    if (!r2Configurado()) return false;
    const key = claveDeUrl(keyOUrl) || (String(keyOUrl || '').startsWith('http') ? null : String(keyOUrl || ''));
    if (!key) return false;
    try {
        const c = clienteR2();
        await c.send(new S3.DeleteObjectCommand({ Bucket: bucket(), Key: key }));
        return true;
    } catch (e) {
        console.warn('[R2] No pude borrar ' + key + ':', e.message || e);
        return false;
    }
}

// Inventario del bucket (para el panel de admin / verificación).
async function inventario(prefijo = '') {
    if (!r2Configurado()) return { ok: false, error: 'R2 no configurado', objetos: 0, bytes: 0, items: [] };
    const c = clienteR2();
    let token, items = [], bytes = 0;
    do {
        const r = await c.send(new S3.ListObjectsV2Command({
            Bucket: bucket(), Prefix: prefijo || undefined, ContinuationToken: token, MaxKeys: 1000
        }));
        for (const o of (r.Contents || [])) {
            items.push({ key: o.Key, size: o.Size || 0, fecha: o.LastModified, url: urlMedia(o.Key) });
            bytes += o.Size || 0;
        }
        token = r.IsTruncated ? r.NextContinuationToken : null;
    } while (token);
    return { ok: true, bucket: bucket(), objetos: items.length, bytes, items, publico: urlPublicaConfigurada() };
}

// Sube un archivo del disco (para la migración de lo ya guardado).
async function subirArchivoLocal(discoPath, { tipo = 'jpshadereditor', sub = '', key } = {}) {
    const buf = fs.readFileSync(discoPath);
    const ext = path.extname(discoPath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif'
        : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream';
    if (!r2Configurado()) return null;
    const c = clienteR2();
    const nombre = key || [tipo, sub, path.basename(discoPath)].filter(Boolean).join('/');
    const up = new libUpload.Upload({ client: c, params: { Bucket: bucket(), Key: nombre, Body: buf, ContentType: mime } });
    await up.done();
    return { key: nombre, url: urlMedia(nombre), bytes: buf.length };
}

module.exports = {
    r2Configurado, urlPublicaConfigurada, urlMedia, claveDeUrl, setBaseProxy,
    subirMedia, borrarMedia, inventario, subirArchivoLocal, bucket, clienteR2
};
