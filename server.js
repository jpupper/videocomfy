const WebSocket = require('ws');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
// OJO: NO usar el 'form-data' de npm con fetch nativo (rompe el multipart). Se usa el FormData global.
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const bodyParser = require('body-parser');
const socketIO = require('socket.io');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const multer = require('multer');
require('dotenv').config();

// ---------------------------------------------------------------------------
// TELEGRAM: DESACTIVADO (a pedido). El módulo ni se carga, no se manda nada y
// el endpoint responde que está apagado.
// Para reactivarlo algún día:  TELEGRAM_HABILITADO=true  +  TELEGRAM_BOT_TOKEN=...
// ---------------------------------------------------------------------------
const TELEGRAM_HABILITADO = String(process.env.TELEGRAM_HABILITADO || '').toLowerCase() === 'true';
const TELEGRAM_ENABLED = TELEGRAM_HABILITADO && !!process.env.TELEGRAM_BOT_TOKEN;
let telegramBot = null;
if (TELEGRAM_ENABLED) {
    telegramBot = require('./tools/telegram-bot.js');
    console.log('🤖 Telegram: encendido');
} else {
    console.log('🤖 Telegram: DESACTIVADO (no se envía nada)');
}

const ipglobal = process.env.COMFYUI_ADDRESS || "127.0.0.1"; // Default to localhost
const serverAddress = ipglobal.includes(':') ? ipglobal : `${ipglobal}:8188`;

// ============================================================
// DIRECCIÓN DE COMFYUI (configurable desde SETTINGS)
// ------------------------------------------------------------
// Puede ser:
//   - local:    127.0.0.1            -> http://127.0.0.1:8188
//   - en tu red: 192.168.0.50:8188
//   - RunPod u otra nube: https://xxxx-8188.proxy.runpod.net  (https => wss)
// Se guarda en config-local.json (no se versiona) y se puede cambiar en
// caliente con POST /api/config/comfy: reconecta el websocket sin reiniciar.
// ============================================================
const RUTA_CONFIG = path.join(__dirname, process.env.RED_CONFIG || 'config-local.json');
let comfyAddress = ipglobal;

(function cargarConfigLocal() {
    try {
        if (fs.existsSync(RUTA_CONFIG)) {
            const c = JSON.parse(fs.readFileSync(RUTA_CONFIG, 'utf8'));
            if (c && typeof c.comfyAddress === 'string' && c.comfyAddress.trim()) {
                comfyAddress = c.comfyAddress.trim();
                console.log(`📌 Dirección de ComfyUI tomada de config-local.json: ${comfyAddress}`);
            }
        }
    } catch (e) {
        console.warn('⚠️  No pude leer config-local.json:', e.message);
    }
})();

function guardarConfigLocal() {
    try {
        fs.writeFileSync(RUTA_CONFIG, JSON.stringify({
            comfyAddress,
            red: {
                peerId: RED.peerId, nombre: RED.nombre, compartir: RED.compartir,
                nombreManual: RED.nombreManual, usuario: RED.usuario, propietario: RED.propietario,
                workflowsCompartidos: RED.workflowsCompartidos || {}
            }
        }, null, 2));
    } catch (e) {
        console.warn('⚠️  No pude guardar config-local.json:', e.message);
    }
}

// URL base http(s) de ComfyUI, sin barra final
function comfyBase() {
    let a = String(comfyAddress || '').trim().replace(/\/+$/, '');
    if (/^https?:\/\//i.test(a)) return a;                 // URL completa (RunPod)
    if (a.includes(':')) return 'http://' + a;             // host:puerto
    return 'http://' + a + ':8188';                        // host -> puerto por defecto
}

// URL del websocket (wss cuando ComfyUI está detrás de https)
function comfyWs() {
    return comfyBase().replace(/^http/i, 'ws');
}

function esComfyLocal() {
    return /(^|\/\/)(127\.0\.0\.1|localhost)(:|\/|$)/i.test(comfyBase());
}
const clientId = uuidv4();

// Que tipo de trabajo se encolo ultimo ('imagen' | 'video'): sirve para saber
// si hay que liberar la VRAM antes de un video (Flux ~17GB + LTX ~20GB = crash).
let ultimoTrabajo = null;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Estado de la cadena para el badge del front (mismo formato que devuelve
// jpiassets, asi el editor se ve igual en local y en la web).
//   - En local, esta app ES el videocomfy: agente/videocomfy siempre true.
//   - comfy: si la conexion websocket con ComfyUI esta abierta.
app.get('/api/status', (req, res) => {
    const comfyOk = !!(wsComfy && wsComfy.readyState === 1);
    res.set('Cache-Control', 'no-store');
    res.json({
        ok: comfyOk,
        agente: true,
        videocomfy: true,
        comfy: comfyOk,
        comfyTexto: comfyOk ? 'connected' : 'disconnected',
        comfyAddress: comfyAddress,
        red: { peerId: RED.peerId, nombre: RED.nombre, compartir: RED.compartir, nodos: RED.nodos.length, enVuelo: RED.enVuelo },
        encolados: RED.enVuelo,
        comfyBase: comfyBase(),
        comfyEsLocal: esComfyLocal(),
        entorno: 'local',                       // este server ES la app local
        host: os.hostname(),
        reporteHaceSegundos: 0,
        datoFresco: true,
        mensaje: comfyOk
            ? 'Todo listo: videocomfy + ComfyUI'
            : `ComfyUI no responde en ${comfyBase()} (revisá SETTINGS → COMFY)`,
        actualizado: new Date().toISOString()
    });
});

// ============================================================
// CONFIG DE COMFYUI (lo usa la pestaña SETTINGS del editor)
// ============================================================
// ============================================================================
// COLA REAL DE COMFYUI
// ----------------------------------------------------------------------------
// La lista de la app (globalGenerationQueue en el front) es "lo que pedí".
// ComfyUI tiene SU propia cola, que puede tener trabajo que la app ya no
// recuerda (prompts de corridas anteriores, batches que quedaron a medias).
// Por eso el "terminó todo" se calcula mirando LAS DOS: mientras ComfyUI tenga
// algo en cola o ejecutando, no terminó nada.
// ============================================================================
const comfyCola = { pendientes: 0, ejecutando: 0, actualizado: 0 };

function broadcastComfyCola() {
    const msg = JSON.stringify({
        type: 'comfy_cola',
        pendientes: comfyCola.pendientes,
        ejecutando: comfyCola.ejecutando,
        total: comfyCola.pendientes + comfyCola.ejecutando,
        enEjecucion: comfyCola.enEjecucion || [],
        enEspera: comfyCola.enEspera || [],
        actualizado: comfyCola.actualizado
    });
    try {
        wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
    } catch (e) { }
}

// Preguntarle a ComfyUI qué tiene en la cola (fuente de verdad).
// Qué sabe la app de un prompt_id que está en la cola del motor: si es suyo
// (y de quién / con qué prompt) o si es un trabajo que quedó de antes.
function quienEsEstePrompt(promptId) {
    const d = promptDetails[promptId] || (lastPromptDetails && lastPromptDetails.promptId === promptId ? lastPromptDetails : null);
    if (!d) return { conocido: false, detalle: 'no es de esta app (quedó de otra corrida o de otro programa)' };
    return {
        conocido: true,
        prompt: String(d.prompt || '').slice(0, 90),
        de: (d.pedidoPor && (d.pedidoPor.displayName || d.pedidoPor.usuario)) || d.red && d.red.de || 'vos',
        origen: d.origen || (d.red ? 'red' : 'local'),
        modelo: d.modelo || ''
    };
}

async function leerColaComfy() {
    try {
        const r = await fetch(comfyBase() + '/queue', { signal: AbortSignal.timeout(6000) });
        if (!r.ok) return null;
        const d = await r.json();
        const running = Array.isArray(d.queue_running) ? d.queue_running : [];
        const pending = Array.isArray(d.queue_pending) ? d.queue_pending : [];
        const corriendo = running.length;
        const esperando = pending.length;
        const cambio = comfyCola.pendientes !== esperando || comfyCola.ejecutando !== corriendo;
        comfyCola.pendientes = esperando;
        comfyCola.ejecutando = corriendo;
        comfyCola.actualizado = Date.now();
        // El prompt_id viene en el índice 1 de cada item de /queue
        comfyCola.enEjecucion = running.map((it) => {
            const id = Array.isArray(it) ? it[1] : (it && it.prompt_id);
            return Object.assign({ promptId: id }, quienEsEstePrompt(id));
        });
        comfyCola.enEspera = pending.slice(0, 10).map((it) => {
            const id = Array.isArray(it) ? it[1] : (it && it.prompt_id);
            return Object.assign({ promptId: id }, quienEsEstePrompt(id));
        });
        if (cambio) broadcastComfyCola();
        return { corriendo, esperando, total: corriendo + esperando };
    } catch (e) {
        return null;
    }
}

// REGISTRO: qué computadora generó cada cosa, quién la pidió y a quién está
// registrada esa computadora. Se arma con los metadata.json de uploads/videos.
app.get('/api/registro', (req, res) => {
    const leer = (ruta, tipo) => {
        try {
            if (!fs.existsSync(ruta)) return [];
            const d = JSON.parse(fs.readFileSync(ruta, 'utf8'));
            return Object.keys(d).map((f) => {
                const m = d[f] || {};
                const pc = m.computadora || {};
                const pp = m.pedidoPor || {};
                return {
                    archivo: f,
                    tipo,
                    fecha: m.timestamp || m.savedAt || m.generationStartTime || null,
                    prompt: String(m.prompt || '').slice(0, 160),
                    computadora: pc.nombre || RED.nombre,
                    peerId: pc.peerId || RED.peerId,
                    host: '',
                    dueno: pc.dueno || (RED.propietario && RED.propietario.usuario) || 'sin dueño registrado',
                    duenoNombre: pc.duenoNombre || pc.dueno || '',
                    pedidoPor: pp.displayName || pp.usuario || 'desconocido',
                    pedidoPorUsuario: pp.usuario || '',
                    avatar: pp.avatar || '',
                    pedidoDesde: pp.tipo === 'web' ? 'la web'
                        : (pp.tipo === 'app-local' ? 'otra app local' : 'esta app (local)'),
                    origen: m.origen || (m.red ? 'red' : 'local'),
                    // Desde este momento el pedido viaja CON cada trabajo. Todo lo
                    // anterior se anotó con el usuario global de la app (bug), así
                    // que su atribución no es confiable y se marca con ≈.
                    certero: (Number(m.timestamp || 0) >= ATRIBUCION_DESDE) || !!(pp && pp.marca === 'trabajo'),
                    modelo: m.modelo || ''
                };
            });
        } catch (e) { return []; }
    };
    const todo = leer(IMAGE_META_PATH, 'imagen').concat(leer(VIDEO_META_PATH, 'video'))
        .sort((a, b) => (b.fecha || 0) - (a.fecha || 0));
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, total: todo.length, registros: todo.slice(0, Number(req.query.limite) || 60) });
});

// ===========================================================================
// MEDIA A CLOUDFLARE R2 (la media NO viaja por el VPS)
// ---------------------------------------------------------------------------
// Regla del ecosistema (skillmaestro §0.5): R2 es el único almacenamiento de
// binarios. Acá la app sube cada imagen/video/audio a R2, lo anota en el mapa
// de media y lo registra en fscauth; el hub después redirige (302) el pedido
// al CDN, así el VPS no mueve un solo byte de media.
// El 15/10 el relay tiraba el archivo entero por el túnel: un video de 1 GB
// dejaba el VPS (4 GB de RAM) sin memoria y se cayó todo.
// ===========================================================================
const r2lib = require('./hub/lib/r2');
const mediaMap = require('./hub/lib/media-map');
const R2_ACTIVO = String(process.env.SUBIR_A_R2 || 'true').toLowerCase() !== 'false';
const CARPETAS_MEDIA = { uploads: 'imagenes', videos: 'videos', audio: 'audio' };
const MIME_POR_EXT = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4'
};
let server_logClientes = '';   // última firma de clientes logueada

const r2Estado = { activo: R2_ACTIVO, subidos: 0, bytes: 0, errores: 0, ultimo: null, enCurso: false, faltan: null };

function mimeDe(nombre) {
    return MIME_POR_EXT[String(path.extname(nombre)).toLowerCase()] || 'application/octet-stream';
}

// Registra el asset en fscauth (así aparece en el panel central del ecosistema).
async function registrarAsset(nombre, url, bytes) {
    try {
        const base = String(process.env.FSC_AUTH_API || process.env.FSC_AUTH_URL
            || 'https://vps-4455523-x.dattaweb.com/fscauth').replace(/\/+$/, '').replace(/\/api$/, '');
        const clave = String(process.env.FSC_INTERNAL_KEY || '');
        if (!clave) { console.log('⚠️  [R2] sin FSC_INTERNAL_KEY: no registro el asset en fscauth'); return false; }
        const r = await fetch(base + '/api/assets/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-fsc-internal': clave },
            body: JSON.stringify({
                application: 'comfylatam',
                publicId: nombre,
                url,
                originalName: nombre,
                mimetype: mimeDe(nombre),
                size: bytes || 0,
                username: (RED.propietario && RED.propietario.usuario) || (RED.usuario && RED.usuario.username) || 'comfylatam'
            })
        });
        if (!r.ok) console.log('⚠️  [R2] fscauth no aceptó el registro de ' + nombre + ': HTTP ' + r.status);
        return r.ok;
    } catch (e) {
        console.log('⚠️  [R2] no pude registrar ' + nombre + ' en fscauth: ' + e.message);
        return false;
    }
}

// Sube un archivo puntual (si ya está en R2 no hace nada).
// ¿Esta media salió de un pedido de la web/red? Sólo eso va a la nube.
// Lo generado en local se queda en el disco de esta computadora.
function origenDeLaMedia(nombre) {
    try {
        const metas = [IMAGE_META_PATH, VIDEO_META_PATH];
        for (const mp of metas) {
            if (!fs.existsSync(mp)) continue;
            const m = JSON.parse(fs.readFileSync(mp, 'utf8'))[nombre];
            if (m && m.origen) return String(m.origen).toLowerCase();
        }
    } catch (e) { }
    return 'local';
}

// ¿Queda cupo en la nube para esta cuenta? (se le pregunta al hub; ADMIN no tiene tope)
async function hayCupoEnLaNube() {
    try {
        const yo = datosDeEstaPC();
        const clave = yo.email || yo.dueno || '';
        const destino = urlDelHub('/api/limite?usuario=' + encodeURIComponent(clave));
        if (!destino) return { permitido: true };
        const r = await fetch(destino, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return { permitido: true };   // si el hub no contesta, no bloqueo
        const d = await r.json();
        if (!d.permitido) {
            console.log(`⚠️  [nube] cupo lleno para ${clave}: usó ${d.usadoMB} de ${d.limiteMB} MB — la media nueva queda en esta PC`);
        }
        return d;
    } catch (e) { return { permitido: true }; }
}

async function subirArchivoAR2(carpeta, nombre) {
    const ruta = path.join(__dirname, 'public', carpeta, nombre);   // la media vive en public/
    try {
        if (!fs.existsSync(ruta)) return false;
        if (mediaMap.urlDeArchivo(nombre)) return false;   // ya está en la nube
        // REGLA: lo generado en local se queda en la PC. A la nube va sólo lo que
        // se pidió desde la web o desde otra computadora de la red.
        const origen = origenDeLaMedia(nombre);
        if (origen !== 'web' && origen !== 'red') return false;
        const cupo = await hayCupoEnLaNube();
        if (!cupo.permitido) return false;
        const st = fs.statSync(ruta);
        if (!st.isFile() || st.size === 0) return false;
        const r = await r2lib.subirArchivo(ruta, {
            tipo: 'comfylatam', sub: carpeta, filename: nombre,
            mime: mimeDe(nombre), size: st.size
        });
        if (!r) { r2Estado.errores++; return false; }
        mediaMap.anotar(nombre, r.url, { carpeta, bytes: st.size, cuando: Date.now() });
        colaMapa.set(nombre, {          // avisa al hub (302 al CDN) y queda en la base
            url: r.url, bytes: st.size, key: r.key || '',
            tipo: (MIME_POR_EXT[String(path.extname(nombre)).toLowerCase()] || '').split('/')[0] === 'video' ? 'video'
                : (MIME_POR_EXT[String(path.extname(nombre)).toLowerCase()] || '').split('/')[0] === 'audio' ? 'audio' : 'image',
            mimetype: mimeDe(nombre)
        });
        r2Estado.subidos++; r2Estado.bytes += st.size; r2Estado.ultimo = nombre;
        console.log('☁️  [R2] subido ' + nombre + ' (' + (st.size / 1048576).toFixed(1) + ' MB) -> ' + r.url);
        registrarAsset(nombre, r.url, st.size).catch(() => { });
        return true;
    } catch (e) {
        r2Estado.errores++;
        console.log('⚠️  [R2] error con ' + nombre + ': ' + e.message);
        return false;
    }
}

// Barre todas las carpetas de media y sube lo que falte (de lo más nuevo a lo
// más viejo, de a uno, para no saturar la PC ni la conexión).
async function barrerMediaAR2() {
    if (!R2_ACTIVO || r2Estado.enCurso) return r2Estado;
    if (!r2lib.r2Configurado()) {
        console.log('⚠️  [R2] no hay credenciales de R2 en el .env: la media va a seguir yendo por el VPS.');
        return r2Estado;
    }
    r2Estado.enCurso = true;
    let total = 0, hechos = 0;
    try {
        const pendientes = [];
        for (const carpeta of Object.keys(CARPETAS_MEDIA)) {
            const dir = path.join(__dirname, 'public', carpeta);
            if (!fs.existsSync(dir)) continue;
            for (const f of fs.readdirSync(dir)) {
                try {
                    if (!/\.(png|jpe?g|webp|gif|mp4|webm|mov|mkv|mp3|wav|ogg|m4a)$/i.test(f)) continue;
                    const st = fs.statSync(path.join(dir, f));
                    if (!st.isFile() || st.size === 0) continue;
                    total++;
                    if (mediaMap.urlDeArchivo(f)) continue;
                    pendientes.push({ carpeta, f, mtime: st.mtimeMs, bytes: st.size });
                } catch (e) { }
            }
        }
        pendientes.sort((a, b) => b.mtime - a.mtime);
        r2Estado.faltan = pendientes.length;
        const bytesFaltan = pendientes.reduce((a, x) => a + x.bytes, 0);
        if (pendientes.length) {
            // Ojo: 'faltan' son los que NO están en la nube, pero sólo se suben los que
        // se pidieron desde la web o desde otra computadora. Lo generado en local
        // se queda en el disco de esta PC (por eso puede quedar en 0 subidos).
        console.log(`☁️  [R2] ${pendientes.length} archivo(s) fuera de la nube (${(bytesFaltan / 1048576).toFixed(0)} MB) — sólo se sube lo pedido desde la web o la red; lo local queda en esta PC`);
        }
        for (const x of pendientes) {
            if (await subirArchivoAR2(x.carpeta, x.f)) hechos++;
            r2Estado.faltan = pendientes.length - hechos;
        }
        if (hechos) console.log(`☁️  [R2] listo: ${hechos} archivo(s) nuevos en la nube (${(r2Estado.bytes / 1048576).toFixed(0)} MB acumulados)`);
    } catch (e) {
        console.log('⚠️  [R2] error en el barrido: ' + e.message);
    }
    r2Estado.enCurso = false;
    r2Estado.total = total;
    return r2Estado;
}

// Vigila las carpetas: lo que se genera se sube enseguida.
function vigilarMedia() {
    if (!R2_ACTIVO) return;
    for (const carpeta of Object.keys(CARPETAS_MEDIA)) {
        const dir = path.join(__dirname, 'public', carpeta);
        try {
            if (!fs.existsSync(dir)) continue;
            fs.watch(dir, (evento, nombre) => {
                if (!nombre || !/\.(png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|ogg|m4a)$/i.test(nombre)) return;
                clearTimeout(vigilarMedia['t_' + nombre]);
                vigilarMedia['t_' + nombre] = setTimeout(() => subirArchivoAR2(carpeta, nombre).catch(() => { }), 4000);
            });
        } catch (e) { }
    }
}

if (R2_ACTIVO) {
    setTimeout(() => { barrerMediaAR2().catch(() => { }); vigilarMedia(); }, 15000);
    setInterval(() => { barrerMediaAR2().catch(() => { }); }, 30 * 60 * 1000);
    console.log('☁️  R2 activo: la media se sube a Cloudflare y el hub la sirve por el CDN (no por el VPS)');
} else {
    console.log('ℹ️  SUBIR_A_R2=false: la media se sirve por el túnel del hub (puede cargar el VPS)');
}

// URL completa del hub: el .env trae RED_HUB (el dominio pelado) y RED_BASE
// (/comfylatam). Antes se usaba sólo RED_HUB y los avisos caían en el dominio
// raíz (otra app). Siempre por acá.
function urlDelHub(ruta) {
    const base = String(process.env.RED_HUB || '').replace(/\/+$/, '');
    const prefijo = String(process.env.RED_BASE || process.env.BASE_PATH || '/comfylatam').replace(/\/+$/, '');
    if (!base) return null;
    return base + prefijo + ruta;
}

// Avisa al hub cada generación terminada: así queda en la base IACOMFY (quién
// la pidió, en qué computadora se hizo y a quién pertenece esa computadora).
const colaGeneraciones = [];
function avisarGeneracionAlHub(archivo, meta) {
    const destino = urlDelHub('/api/red/generacion');
    if (!destino || !archivo) return;
    const ext = String(path.extname(archivo)).toLowerCase();
    const cuerpo = {
        archivo,
        prompt: (meta && meta.prompt) || '',
        modelo: (meta && meta.modelo) || '',
        tipo: /mp4|webm|mov|mkv/.test(ext) ? 'video' : (/png|jpe?g|webp|gif/.test(ext) ? 'imagen' : 'otro'),
        pedidoPor: (meta && meta.pedidoPor) || datosDelPedido(null),
        computadora: (meta && meta.computadora) || datosDeEstaPC(),
        origen: (meta && meta.origen) || 'local',
        cuando: (meta && meta.timestamp) || Date.now()
    };
    colaGeneraciones.push(cuerpo);
    if (colaGeneraciones.length > 200) colaGeneraciones.shift();
}
function enviarGeneracionesAlHub() {
    if (!colaGeneraciones.length) return;
    const destino = urlDelHub('/api/red/generacion');
    if (!destino) return;
    const lote = colaGeneraciones.splice(0, colaGeneraciones.length);
    (async () => {
        for (const g of lote) {
            try {
                const r = await fetch(destino, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-agent-token': process.env.AGENT_TOKEN || '' },
                    body: JSON.stringify(g)
                });
                if (!r.ok) throw new Error('HTTP ' + r.status);
            } catch (e) {
                colaGeneraciones.push(g);   // se reintenta en la próxima vuelta
            }
        }
    })();
}
setInterval(enviarGeneracionesAlHub, 20000);

// Avisa al hub qué hay en la nube (para que sirva 302 al CDN y no traiga la
// media por el túnel). Se acumula y se manda cada 15 s.
const colaMapa = new Map();
function avisarMapaAlHub() {
    if (!colaMapa.size) return;
    const yo = datosDeEstaPC();
    const items = [...colaMapa.entries()].map(([nombre, v]) => ({
        nombre, url: v.url, bytes: v.bytes, key: v.key, tipo: v.tipo, mimetype: v.mimetype
    }));
    colaMapa.clear();
    const destino = urlDelHub('/api/red/media-mapa');
    if (!destino) return;
    fetch(destino, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-token': process.env.AGENT_TOKEN || '' },
        body: JSON.stringify({
            items,
            email: yo.email || '', username: yo.dueno || '', displayName: yo.duenoNombre || '',
            avatar: yo.avatar || '', peerId: yo.peerId || '', computadora: yo.nombre || '',
            ubicacion: 'nube'
        })
    }).then((r) => {
        if (!r.ok) console.log('⚠️  [R2] el hub no aceptó el mapa de media: HTTP ' + r.status);
    }).catch((e) => {
        for (const it of items) colaMapa.set(it.nombre, { url: it.url, bytes: it.bytes });
    });
}
setInterval(avisarMapaAlHub, 15000);

// Al arrancar, avisa TODO lo que ya está en R2 (lo que se subió antes de que
// existiera este aviso, o mientras el hub estaba caído). Se manda en tandas.
async function anunciarMapaCompleto() {
    try {
        const mapa = mediaMap.todoElMapa ? mediaMap.todoElMapa() : {};
        const nombres = Object.keys(mapa);
        if (!nombres.length) return;
        // ¿qué ya tiene el hub? (para no mandar 500 de nuevo si no hace falta)
        const destino = urlDelHub('/api/red/media-mapa');
        if (!destino) return;
        let enviados = 0;
        for (let i = 0; i < nombres.length; i += 150) {
            const items = nombres.slice(i, i + 150).map((n) => {
                const v = mapa[n] || {};
                const ext = String(path.extname(n)).toLowerCase();
                const me = MIME_POR_EXT[ext] || '';
                return {
                    nombre: n, url: v.url, ubicacion: 'nube', bytes: v.bytes || 0,
                    tipo: me.split('/')[0] === 'video' ? 'video' : me.split('/')[0] === 'audio' ? 'audio' : 'image',
                    mimetype: me
                };
            });
            try {
                const r = await fetch(destino, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-agent-token': process.env.AGENT_TOKEN || '' },
                    body: JSON.stringify({
                        items, email: (datosDeEstaPC().email || ''), username: datosDeEstaPC().dueno || '',
                        displayName: datosDeEstaPC().duenoNombre || '', avatar: datosDeEstaPC().avatar || '',
                        peerId: datosDeEstaPC().peerId || '', computadora: datosDeEstaPC().nombre || ''
                    })
                });
                if (r.ok) enviados += items.length;
            } catch (e) { }
        }
        console.log('☁️  [R2] anuncié ' + enviados + ' archivo(s) al hub (quedan asociados a tu cuenta)');
    } catch (e) { }
}
setTimeout(() => anunciarMapaCompleto().catch(() => { }), 8000);

// Estado de memoria del proceso (para ver si algo se está inflando)

// ===========================================================================
// VIGILANTE DE MEMORIA
// ---------------------------------------------------------------------------
// La app se venía muriendo por heap lleno (4 GB). Acá:
//   · cada 5 min registra el consumo + cuántas cosas tiene guardadas (diagnóstico)
//   · todos los detalles de generación viejos se borran (se acumulaban sin tope)
//   · si el heap pasa el 88%, la app se reinicia SOLA y limpia (mejor un corte
//     de 2 segundos que un cuelgue con el heap muerto)
// ===========================================================================
const LIMITE_HEAP_MB = () => Math.round(require('v8').getHeapStatistics().heap_size_limit / 1048576);
let ultimoDiagnostico = 0;

function diagnosticoMemoria(etiqueta) {
    const m = process.memoryUsage();
    const mb = (x) => Math.round(x / 1048576);
    const uso = Math.round((m.heapUsed / require('v8').getHeapStatistics().heap_size_limit) * 100);
    console.log(`🧠 [memoria${etiqueta ? ' ' + etiqueta : ''}] heap ${mb(m.heapUsed)}MB de ${LIMITE_HEAP_MB()}MB (${uso}%) · rss ${mb(m.rss)}MB ` +
        `· generaciones en memoria ${Object.keys(promptDetails || {}).length} · historial ${(completedJobs || []).length} ` +
        `· media anunciada ${(colaMapa ? colaMapa.size : 0)} · nodo ${(typeof socket !== 'undefined' && socket) ? 'conectado' : 'sin socket'}`);
    return uso;
}

// limpia lo que crece sin control
function limpiarMemoria() {
    try {
        const ids = Object.keys(promptDetails || {});
        if (ids.length > 300) {
            // los más viejos primero (se ordena por la hora de arranque del trabajo)
            ids.sort((a, b) => ((promptDetails[a] || {}).generationStartTime || 0) - ((promptDetails[b] || {}).generationStartTime || 0));
            ids.slice(0, ids.length - 200).forEach((k) => { delete promptDetails[k]; });
        }
        if (typeof historial !== 'undefined' && Array.isArray(historial) && historial.length > 300) {
            historial.splice(0, historial.length - 200);
        }
    } catch (e) { }
}

function reiniciarPorMemoria(uso) {
    console.log(`🔁 [memoria] el heap está al ${uso}%: reinicio la app para limpiar (se reconecta sola al hub en unos segundos).`);
    try {
        const hijo = require('child_process').spawn(process.execPath,
            ['--max-old-space-size=4096', path.join(__dirname, 'server.js')],
            { cwd: __dirname, detached: true, stdio: 'ignore' });
        hijo.unref();
    } catch (e) { }
    setTimeout(() => process.exit(0), 800);
}

setInterval(() => {
    limpiarMemoria();
    const uso = diagnosticoMemoria('');
    if (uso >= 88) reiniciarPorMemoria(uso);
}, 5 * 60 * 1000);

setTimeout(() => { diagnosticoMemoria('arranque'); limpiarMemoria(); }, 45000);

// Alias de salud: el front lo consulta como /health (antes daba 404).
app.get(['/health', '/api/health'], (req, res) => {
    res.json({ status: 'ok', app: 'comfylatam', version: (typeof VERSION_APP !== 'undefined' ? VERSION_APP : ''), basePath: (typeof BASE_PATH !== 'undefined' ? BASE_PATH : ''), hora: new Date().toISOString() });
});

// Quién es el dueño de ESTA computadora: lo usa el perfil cuando la app corre
// en local sin sesión (así se ve tu foto, tu nombre y tus datos igual).
app.get(['/api/yo', '/api/quien-soy'], (req, res) => {
    let pc = {};
    try { pc = datosDeEstaPC() || {}; } catch (e) { pc = {}; }
    const guardado = (() => { try { return RED && RED.computadora ? RED.computadora : {}; } catch (e) { return {}; } })();
    const u = Object.assign({}, guardado, pc);
    res.json({
        success: true, local: true,
        usuario: {
            username: u.dueno || u.usuario || '', displayName: u.duenoNombre || u.nombre || '',
            avatar: u.avatar || '', email: u.email || u.emailDueno || '',
            peerId: u.peerId || '', computadora: u.nombre || ''
        }
    });
});

app.get('/api/salud-memoria', (req, res) => {
    const m = process.memoryUsage();
    res.json({
        success: true,
        rssMB: Math.round(m.rss / 1048576),
        heapUsadoMB: Math.round(m.heapUsed / 1048576),
        heapTotalMB: Math.round(m.heapTotal / 1048576),
        limiteMB: Math.round((require('v8').getHeapStatistics().heap_size_limit) / 1048576),
        uptimeMin: Math.round(process.uptime() / 60),
        clientesFront: (typeof wss !== 'undefined' && wss.clients) ? wss.clients.size : null,
        generacionesEnMemoria: Object.keys(promptDetails || {}).length,
        historial: (typeof historial !== 'undefined' && historial && (historial.length || Object.keys(historial).length)) || 0,
        mediaEnCola: (colaMapa ? colaMapa.size : 0),
        usoPorciento: Math.round((m.heapUsed / require('v8').getHeapStatistics().heap_size_limit) * 100)
    });
});

app.get('/api/r2/estado', (req, res) => {
    res.json(Object.assign({ success: true }, r2Estado, {
        mapeados: mediaMap.cantidad(),
        publico: (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, ''),
        bucket: process.env.R2_BUCKET_NAME || null
    }));
});

app.post('/api/r2/barrer', async (req, res) => {
    res.json({ success: true, message: 'barrido iniciado', antes: Object.assign({}, r2Estado) });
    barrerMediaAR2().catch(() => { });
});

// ---------------------------------------------------------------------------
// Momento en que el "quién lo pidió" pasó a viajar con cada trabajo. Antes de
// esta fecha el registro usaba el usuario logueado de turno (poco confiable).
const ATRIBUCION_DESDE = 1792071000000;   // 2026-10-15 10:30 (desde acá el pedido viaja con cada trabajo)


// ===========================================================================
// WORKFLOWS QUE SE COMPARTEN + DETECCIÓN DE LO QUE ESTÁ INSTALADO
// ---------------------------------------------------------------------------
// 1) Cada persona elige QUÉ workflows comparte con la red (checkboxes).
// 2) La app le pregunta a ComfyUI (/object_info) qué modelos hay instalados y
//    avisa cuáles workflows NO se pueden usar acá (faltan modelos).
// 3) Eso se publica en la red: quien quiera generar en tu PC sólo puede elegir
//    los workflows que compartís Y que tenés instalados. Si igual llega un
//    pedido de un workflow que no tenés, se rechaza con el motivo.
// ===========================================================================
const COMFY_BASE = () => (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '');

// qué workflow usa cada modelo del front
const MODELO_A_WORKFLOW = {
    zimage: 'z_image_turbo_api.json',
    qwen21: 'qwen_image_21_api.json',
    flux: 'flux_dev_fp8_api.json',
    fluxfull: 'flux_dev_full_text_to_image_api.json',
    ltx2t2v: 'video_ltx2_t2v_api.json',
    ltx2i2v: 'video_ltx2_i2v_api.json',
    ltx25i2v: 'video_ltx25_i2v_api.json',
    wan22: 'video_wan2_2_14B_flf2v_api.json'
};

// nombres lindos para mostrar
const NOMBRE_WORKFLOW = {
    'z_image_turbo_api.json': 'Z-Image Turbo (imagen)',
    'qwen_image_21_api.json': 'Qwen-Image 2.1 (imagen)',
    'flux_dev_fp8_api.json': 'FLUX dev fp8 (imagen)',
    'flux_dev_full_text_to_image_api.json': 'FLUX dev full (imagen)',
    'video_ltx2_t2v_api.json': 'LTX-2.5 texto→video',
    'video_ltx2_i2v_api.json': 'LTX-2 imagen→video',
    'video_ltx25_i2v_api.json': 'LTX-2.5 imagen→video',
    'video_wan2_2_14B_flf2v_api.json': 'WAN 2.2 (video)'
};

let OBJECT_INFO = null, OBJECT_INFO_TS = 0, WORKFLOWS_ESTADO = null, WORKFLOWS_TS = 0;

async function traerObjectInfo(forzar) {
    if (!forzar && OBJECT_INFO && (Date.now() - OBJECT_INFO_TS) < 5 * 60 * 1000) return OBJECT_INFO;
    try {
        const r = await fetch(COMFY_BASE() + '/object_info', { signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        OBJECT_INFO = await r.json();
        OBJECT_INFO_TS = Date.now();
    } catch (e) {
        OBJECT_INFO = null;
    }
    return OBJECT_INFO;
}

// Qué modelos pide un workflow: recorre los nodos y junta los campos de modelo
// (los que en ComfyUI son listas: unet_name, ckpt_name, vae_name, lora_name...).
const CAMPOS_DE_MODELO = /^(unet_name|ckpt_name|vae_name|lora_name|clip_name|clip_name1|clip_name2|clip_name3|text_encoder|control_net_name|style_model_name|model_name|gguf_name|filename_prefix_ignore|embedding|ipadapter_file)$/;

async function faltantesDeWorkflow(archivo) {
    const info = await traerObjectInfo(false);
    if (!info) return { disponible: null, falta: ['no pude consultar ComfyUI (/object_info)'], nodos: 0 };
    let wf;
    try { wf = JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, archivo), 'utf8')); }
    catch (e) { return { disponible: false, falta: ['el archivo no es un JSON válido'], nodos: 0 }; }

    const falta = new Set();
    let nodos = 0;
    for (const id of Object.keys(wf)) {
        const n = wf[id];
        if (!n || !n.class_type) continue;
        nodos++;
        const def = info[n.class_type];
        if (!def) { falta.add('falta el nodo "' + n.class_type + '" (no está instalado ese custom node)'); continue; }
        const req = (def.input && def.input.required) || {};
        const opt = (def.input && def.input.optional) || {};
        for (const [campo, valor] of Object.entries(n.inputs || {})) {
            if (!CAMPOS_DE_MODELO.test(campo)) continue;
            const lista = (req[campo] || opt[campo] || [])[0];
            if (!Array.isArray(lista)) continue;
            const valores = Array.isArray(valor) ? valor : [valor];
            for (const v of valores) {
                if (typeof v !== 'string' || !v) continue;
                if (!lista.includes(v)) falta.add(`${campo}: ${v}`);
            }
        }
    }
    return { disponible: falta.size === 0, falta: [...falta].slice(0, 8), nodos };
}

// Estado de todos los workflows: si se comparten y si están instalados.
async function estadoDeWorkflows(forzar) {
    if (!forzar && WORKFLOWS_ESTADO && (Date.now() - WORKFLOWS_TS) < 2 * 60 * 1000) return WORKFLOWS_ESTADO;
    const lista = indiceDeWorkflows();
    const salida = [];
    for (const w of lista) {
        const r = await faltantesDeWorkflow(w.archivo);
        salida.push({
            archivo: w.archivo,
            nombre: NOMBRE_WORKFLOW[w.archivo] || w.archivo.replace(/_(api)?\.json$/i, ''),
            kb: w.kb, nodos: r.nodos || w.nodos, valido: w.valido,
            enUso: w.enUso,
            disponible: r.disponible,
            falta: r.falta || [],
            compartido: comparteWorkflow(w.archivo)
        });
    }
    WORKFLOWS_ESTADO = salida;
    WORKFLOWS_TS = Date.now();
    return salida;
}

// ¿Comparte este workflow? (por defecto sí, salvo que lo haya apagado a mano)
function comparteWorkflow(archivo) {
    const m = RED.workflowsCompartidos || {};
    if (Object.prototype.hasOwnProperty.call(m, archivo)) return !!m[archivo];
    return true;
}

// Lo que se publica en la red: sólo los que comparte Y tiene instalados.
async function workflowsPublicables() {
    try {
        const todos = await estadoDeWorkflows(false);
        return todos.filter((w) => w.compartido && w.disponible !== false).map((w) => w.archivo);
    } catch (e) { return []; }
}

// se recalcula cada 2 minutos y cuando alguien cambia la selección
async function refrescarWorkflowsRed() {
    try {
        RED.workflowsRed = await workflowsPublicables();
        avisarRedATodos();
    } catch (e) { }
}
setTimeout(() => { refrescarWorkflowsRed(); }, 12000);
setInterval(() => { refrescarWorkflowsRed(); }, 2 * 60 * 1000);

app.get('/api/red/workflows', async (req, res) => {
    try {
        res.json({ success: true, workflows: await estadoDeWorkflows(!!req.query.forzar), carpeta: 'workflows/' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/red/workflows', async (req, res) => {
    const b = req.body || {};
    if (!b.archivo) return res.status(400).json({ success: false, message: 'falta el archivo' });
    RED.workflowsCompartidos = RED.workflowsCompartidos || {};
    RED.workflowsCompartidos[b.archivo] = !!b.compartido;
    guardarConfigLocal();
    console.log(`🔧 Workflow ${b.archivo}: ${b.compartido ? 'COMPARTIDO' : 'privado (no se ofrece en la red)'}`);
    const wfs = await estadoDeWorkflows(true);
    avisarRedATodos();
    res.json({ success: true, workflows: wfs });
});

// Valida un pedido que llega DE LA RED: sólo workflows compartidos e instalados.
async function validarPedidoDeRed(b) {
    const modelo = (b && b.modelo) || (String((b && b.tipo) || '').toLowerCase() === 'video' ? null : 'zimage');
    const archivo = modelo ? MODELO_A_WORKFLOW[modelo] : null;
    if (!archivo) return { ok: true };   // no se pudo determinar: no bloqueo
    const todos = await estadoDeWorkflows(false);
    const w = todos.find((x) => x.archivo === archivo);
    if (!w) return { ok: false, motivo: `este fierro no tiene el workflow "${archivo}"` };
    if (!w.compartido) return { ok: false, motivo: `el dueño de esta computadora NO comparte el workflow "${w.nombre}"` };
    if (w.disponible === false) return { ok: false, motivo: `en esta computadora faltan modelos para "${w.nombre}": ${w.falta.join(', ')}` };
    return { ok: true, workflow: archivo };
}

// ===========================================================================
// VERSIÓN Y ACTUALIZACIÓN
// ---------------------------------------------------------------------------
// La app informa en qué versión está (commit git), chequea sola si hay una
// nueva en el repositorio y, si hay, ofrece un botón para actualizarse.
// ===========================================================================
const { execFile } = require('child_process');

function correr(cmd, args, opts) {
    return new Promise((resolve) => {
        execFile(cmd, args, Object.assign({ timeout: 30000, windowsHide: true }, opts || {}), (err, stdout) => {
            resolve({ ok: !err, salida: String(stdout || '').trim(), error: err ? String(err.message || err) : '' });
        });
    });
}

const REPO_APP = process.env.GITHUB_REPO || 'jpupper/videocomfy';
let VERSION = { commit: null, corto: null, fecha: null, rama: null, origen: 'desconocido', package: null };
let REMOTO = null;            // último chequeo contra el repo
let ULTIMO_CHEQUEO = 0;
let ACTUALIZANDO = false;

async function leerVersionLocal() {
    const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || null; } catch (e) { return null; } })();
    const rev = await correr('git', ['rev-parse', 'HEAD'], { cwd: __dirname });
    if (!rev.ok) {
        VERSION = { commit: null, corto: null, fecha: null, rama: null, origen: 'sin git (copia zip)', package: pkg };
        return VERSION;
    }
    const corto = await correr('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname });
    const fecha = await correr('git', ['log', '-1', '--format=%cI'], { cwd: __dirname });
    const asunto = await correr('git', ['log', '-1', '--format=%s'], { cwd: __dirname });
    const rama = await correr('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: __dirname });
    VERSION = {
        commit: rev.salida,
        corto: corto.salida,
        fecha: fecha.salida,
        asunto: asunto.salida,
        rama: rama.salida,
        origen: 'git',
        package: pkg
    };
    return VERSION;
}

// ¿Hay algo nuevo en el repositorio? (no cambia nada: sólo consulta)
async function chequearVersion() {
    await leerVersionLocal();
    ULTIMO_CHEQUEO = Date.now();
    if (VERSION.origen !== 'git') {
        REMOTO = null;
        return { hayNueva: false, motivo: 'esta copia no es un clon de git: actualizá bajando el repo de nuevo' };
    }
    const rama = VERSION.rama || 'main';
    // hay que traer las referencias del repo para poder comparar
    const trae = await correr('git', ['fetch', '--quiet', 'origin'], { cwd: __dirname });
    let commitRemoto = null;
    const ref = await correr('git', ['rev-parse', 'origin/' + rama], { cwd: __dirname });
    if (ref.ok && ref.salida) commitRemoto = ref.salida;
    if (!commitRemoto) {
        // sin remoto configurado (copia suelta): se consulta el repo público
        const ls = await correr('git', ['ls-remote', 'https://github.com/' + REPO_APP, 'refs/heads/' + rama], { cwd: __dirname });
        if (ls.ok && ls.salida) commitRemoto = ls.salida.split(/\s+/)[0];
    }
    if (!commitRemoto) {
        REMOTO = null;
        return { hayNueva: false, motivo: trae.ok ? 'no pude comparar con el repositorio' : 'no pude consultar el repositorio (¿sin internet?)' };
    }
    const atras = await correr('git', ['rev-list', '--count', 'HEAD..' + commitRemoto], { cwd: __dirname });
    const adelante = await correr('git', ['rev-list', '--count', commitRemoto + '..HEAD'], { cwd: __dirname });
    REMOTO = {
        commit: commitRemoto,
        corto: commitRemoto.slice(0, 7),
        atras: atras.ok ? Number(atras.salida) : null,
        adelante: adelante.ok ? Number(adelante.salida) : null
    };
    const hayNueva = (REMOTO.atras || 0) > 0;
    console.log(hayNueva
        ? `⬆️  Hay una versión nueva (${REMOTO.atras} commit(s) atrás) — ${VERSION.corto} -> ${REMOTO.corto}`
        : `✅ Versión al día (${VERSION.corto || '?'})`);
    return { hayNueva, atras: REMOTO.atras, local: VERSION.corto, remoto: REMOTO.corto };
}

function estadoVersion() {
    return {
        version: VERSION,
        remoto: REMOTO,
        hayNueva: !!(REMOTO && (REMOTO.atras || 0) > 0),
        revisado: ULTIMO_CHEQUEO || null,
        actualizando: ACTUALIZANDO,
        repo: REPO_APP
    };
}

app.get('/api/version', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    // ?forzar=1 vuelve a consultar el repositorio ya mismo (lo usa el boton)
    if (req.query.forzar || Date.now() - ULTIMO_CHEQUEO > 5 * 60 * 1000) {
        try { await chequearVersion(); } catch (e) { }
    }
    res.json(Object.assign({ success: true }, estadoVersion()));
});

// Botón ACTUALIZAR: trae la última versión del repositorio y deja todo listo.
app.post('/api/actualizar', async (req, res) => {
    if (ACTUALIZANDO) return res.status(409).json({ success: false, message: 'Ya se está actualizando.' });
    if (VERSION.origen !== 'git') {
        return res.status(400).json({ success: false, message: 'Esta copia no es un clon de git: bajá el repositorio de nuevo para actualizar.' });
    }
    ACTUALIZANDO = true;
    const antes = VERSION.corto;
    console.log('⬆️  Actualizando desde el repositorio...');
    try {
        await correr('git', ['fetch', 'origin'], { cwd: __dirname });
        const rama = VERSION.rama || 'main';

        // Si hay cambios locales sin commitear (alguien tocó algún archivo de la
        // app), se guardan aparte, se actualiza y se vuelven a poner. Así el
        // botón nunca se traba por eso.
        const sucio = await correr('git', ['status', '--porcelain'], { cwd: __dirname });
        let guardado = false;
        if (String(sucio.salida || '').trim()) {
            const st = await correr('git', ['stash', 'push', '-u', '-m', 'comfylatam-actualizar'], { cwd: __dirname });
            guardado = st.ok && !/No local changes/.test(st.salida);
            if (guardado) console.log('📦 Cambios locales guardados aparte (stash) para poder actualizar...');
        }

        // Escalera para llegar SIEMPRE a la última versión:
        //   1. avance simple (ff)       -> lo normal
        //   2. rebase sobre el remoto   -> si esta copia tiene algún commit propio
        //   3. reset --hard al remoto   -> último recurso: manda la versión oficial
        let ajuste = 'ff';
        let pull = await correr('git', ['merge', '--ff-only', 'origin/' + rama], { cwd: __dirname });
        if (!pull.ok) {
            console.log('↩️  No fue avance simple: reaplico los commits locales sobre el remoto (rebase)...');
            pull = await correr('git', ['rebase', 'origin/' + rama], { cwd: __dirname });
            ajuste = 'rebase';
            if (!pull.ok) {
                await correr('git', ['rebase', '--abort'], { cwd: __dirname });
                console.log('🔁 El rebase no se pudo: dejo la versión oficial del repositorio (reset)...');
                const rst = await correr('git', ['fetch', 'origin'], { cwd: __dirname });
                const rst2 = await correr('git', ['reset', '--hard', 'origin/' + rama], { cwd: __dirname });
                if (!rst2.ok) {
                    if (guardado) await correr('git', ['stash', 'pop'], { cwd: __dirname });
                    throw new Error(rst2.error || pull.error || rst.error);
                }
                ajuste = 'reset';
            }
        }

        let conflicto = false;
        if (guardado) {
            const pop = await correr('git', ['stash', 'pop'], { cwd: __dirname });
            conflicto = !pop.ok;
            if (conflicto) console.log('⚠️  Algunos cambios locales chocaron con la actualización (quedaron en el stash):', pop.error);
        }
        await leerVersionLocal();
        const despues = VERSION.corto;

        // ¿cambiaron las dependencias? entonces hay que instalarlas
        const diff = await correr('git', ['diff', '--name-only', antes || 'HEAD@{1}', 'HEAD'], { cwd: __dirname });
        const toco = String(diff.salida || '');
        let instalo = false;
        if (/package(-lock)?\.json/.test(toco)) {
            console.log('📦 Cambiaron las dependencias: npm install...');
            const npm = await correr(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: __dirname });
            instalo = npm.ok;
        }
        const backendCambio = /(^|\n)(server\.js|nodo\.js)/.test(toco) || instalo;
        console.log(`✅ Actualizado: ${antes} -> ${despues}${instalo ? ' (con npm install)' : ''}`);
        if (backendCambio) console.log('🔁 Hay cambios en el backend: la app se reinicia sola en 2 segundos...');

        ACTUALIZANDO = false;
        res.json({
            success: true, antes, despues,
            commits: REMOTO ? REMOTO.atras : null,
            npm: instalo, reiniciar: backendCambio, ajuste,
            cambiosLocalesGuardados: guardado, conflicto
        });

        if (backendCambio) {
            setTimeout(() => {
                try {
                    const hijo = require('child_process').spawn(process.execPath,
                        ['--max-old-space-size=4096', path.join(__dirname, 'server.js')],
                        { cwd: __dirname, detached: true, stdio: 'ignore' });
                    hijo.unref();
                } catch (e) { }
                process.exit(0);
            }, 2000);
        }
    } catch (e) {
        ACTUALIZANDO = false;
        console.log('❌ No pude actualizar:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

// chequeo automático: al arrancar y cada 30 minutos
setTimeout(() => { chequearVersion().catch(() => { }); }, 6000);
setInterval(() => { chequearVersion().catch(() => { }); }, 30 * 60 * 1000);

// ---------------------------------------------------------------------------
// ÍNDICE DE WORKFLOWS: todo lo que hay en la carpeta workflows/ se lista acá
// (así se agregan nuevos archivos sin tocar el código).
// ---------------------------------------------------------------------------
const WORKFLOWS_DIR = path.join(__dirname, 'workflows');

function indiceDeWorkflows() {
    try {
        return fs.readdirSync(WORKFLOWS_DIR)
            .filter((f) => f.toLowerCase().endsWith('.json'))
            .map((f) => {
                const ruta = path.join(WORKFLOWS_DIR, f);
                let nodos = 0, ok = true;
                try {
                    const d = JSON.parse(fs.readFileSync(ruta, 'utf8'));
                    nodos = Object.keys(d || {}).length;
                } catch (e) { ok = false; }
                const st = fs.statSync(ruta);
                return {
                    archivo: f,
                    ruta: 'workflows/' + f,
                    kb: Math.round(st.size / 1024),
                    nodos,
                    valido: ok,
                    modificado: st.mtimeMs,
                    // 'enUso' = la app realmente lo usa (tiene botones/sliders en CREATE)
                    enUso: Object.values(MODELOS_IMAGEN).some((m) => m.archivo === 'workflows/' + f)
                        || Object.values(MODELO_A_WORKFLOW).includes(f)
                        || f === 'flux_dev_full_text_to_image_api.json'
                };
            })
            .sort((a, b) => (b.enUso - a.enUso) || a.archivo.localeCompare(b.archivo));
    } catch (e) {
        return [];
    }
}

app.get('/api/workflows', (req, res) => {
    const lista = indiceDeWorkflows();
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, carpeta: 'workflows/', total: lista.length, workflows: lista });
});

app.get('/api/comfy/cola', async (req, res) => {
    const real = await leerColaComfy();
    res.json({
        success: true,
        pendientes: comfyCola.pendientes,
        ejecutando: comfyCola.ejecutando,
        total: comfyCola.pendientes + comfyCola.ejecutando,
        enEjecucion: comfyCola.enEjecucion || [],
        enEspera: comfyCola.enEspera || [],
        comfy: real,
        actualizado: comfyCola.actualizado
    });
});

// Vaciar la cola de ComfyUI (para las sobras de corridas viejas) o cortar lo
// que está ejecutando ahora.
app.post('/api/comfy/cola/limpiar', async (req, res) => {
    const que = String((req.body && req.body.que) || 'pendientes');
    try {
        if (que === 'todo' || que === 'ejecutando') {
            await fetch(comfyBase() + '/interrupt', { method: 'POST', signal: AbortSignal.timeout(6000) });
        }
        if (que === 'todo' || que === 'pendientes') {
            await fetch(comfyBase() + '/queue', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clear: true }),
                signal: AbortSignal.timeout(8000)
            });
        }
        await leerColaComfy();
        console.log(`🧹 Cola de ComfyUI limpiada (${que}) — quedan ${comfyCola.pendientes}`);
        res.json({ success: true, pendientes: comfyCola.pendientes, ejecutando: comfyCola.ejecutando });
    } catch (e) {
        res.status(502).json({ success: false, message: e.message });
    }
});

// refresco periódico (aunque ComfyUI no mande nada por ws)
setInterval(() => { leerColaComfy().catch(() => { }); }, 5000);

app.get('/api/config/comfy', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
        success: true,
        address: comfyAddress,
        base: comfyBase(),
        ws: comfyWs(),
        esLocal: esComfyLocal(),
        conectado: !!(wsComfy && wsComfy.readyState === 1)
    });
});

app.post('/api/config/comfy', bodyParser.json(), async (req, res) => {
    const nueva = String((req.body && req.body.address) || '').trim();
    if (!nueva) return res.status(400).json({ success: false, message: 'Falta la dirección.' });
    if (!/^(https?:\/\/)?[\w.-]+(:\d+)?(\/.*)?$/i.test(nueva)) {
        return res.status(400).json({ success: false, message: 'Esa dirección no parece válida.' });
    }

    const anterior = comfyAddress;
    comfyAddress = nueva;
    guardarConfigLocal();
    console.log(`🔧 Dirección de ComfyUI: ${anterior} -> ${comfyAddress} (${comfyBase()})`);

    // Reconectar al nuevo ComfyUI sin reiniciar la app
    try { if (wsComfy) wsComfy.close(); } catch (e) { }
    setTimeout(() => { try { connectToComfy(); } catch (e) { } }, 300);

    res.json({ success: true, address: comfyAddress, base: comfyBase(), ws: comfyWs(), esLocal: esComfyLocal() });
});
// El limite por defecto de body-parser es 100 KB: cualquier POST mas grande
// (proyectos con timeline, batches, etc.) explotaba con PayloadTooLargeError.
app.use(bodyParser.json({ limit: '32mb' }));
app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
        console.warn('⚠️  Pedido demasiado grande:', req.method, req.originalUrl);
        return res.status(413).json({ success: false, message: 'El pedido es demasiado grande (límite 32 MB).' });
    }
    if (err) console.warn('⚠️  Error en un pedido:', req.method, req.originalUrl, err.message);
    next(err);
});

// Configurar multer para upload de imágenes
const uploadDir = path.join(__dirname, 'public', 'uploads');
const projectsDir = path.join(__dirname, 'public', 'projects');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
if (!fs.existsSync(projectsDir)) {
    fs.mkdirSync(projectsDir, { recursive: true });
}
const upload = multer({ dest: uploadDir });

const promptDetails = {};  // Almacena detalles del prompt
let lastPromptDetails = null; // Fallback por si acaso el ID falla

function enviarAlFront(obj) {
    const msg = typeof obj === 'string' ? obj : JSON.stringify(obj);
    if (typeof wss !== 'undefined' && wss.clients) {
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                if (client.bufferedAmount > 65536) return;
                client.send(msg);
            }
        });
    }
}

// ============================================
// COMFYUI WEBSOCKET CON RECONEXIÓN
// ============================================

let wsComfy;
function connectToComfy() {
    console.log(`Conectando a ComfyUI en ${comfyWs()}/ws?clientId=${clientId}...`);
    wsComfy = new WebSocket(`${comfyWs()}/ws?clientId=${clientId}`);

    wsComfy.on('open', () => {
        console.log('✅ Conexión establecida con ComfyUI');
        broadcastComfyStatus('connected');
    });

    wsComfy.on('message', async (data) => {
        try {
            // ComfyUI manda los PREVIEWS en binario/base64 (cientos de KB por frame)
            // mientras genera. Antes eso se convertía a texto y se parseaba: con un
            // video largo, miles de esos strings hacían volar el heap de 4 GB.
            // Los previews no se usan (la app manda su propio progreso), así que se
            // descartan sin convertirlos.
            if (Buffer.isBuffer(data) || typeof data !== 'string') {
                return;
            }
            const messageString = data.toString();
            if (messageString.length > 40000) {   // los previews rondan 50-150 KB
                // mensaje gigante (preview / frame en base64): no lo tocamos
                return;
            }
            // Log solo si no es binario y no es demasiado ruidoso
            if (messageString.length < 1000) {
                console.log('📩 Mensaje de ComfyUI:', messageString);
            }

            const message = JSON.parse(messageString);

            // Enviar progreso al cliente
            if (message.type === 'progress') {
                // el progreso es lo que más se repite: si un navegador está atrasado
                // se saltea (su buffer no crece y no se come la memoria)
                enviarAlFront({
                    type: 'progress',
                    value: message.data.value,
                    max: message.data.max
                });
            }

            // ---- COLA REAL DE COMFYUI -------------------------------------
            // ComfyUI manda el estado de su cola acá. El front necesita esto
            // para NO decir "terminó todo" mientras ComfyUI sigue trabajando
            // (pasaba con batches: la lista de la app quedaba vacía y ComfyUI
            // seguía con prompts encolados de antes).
            if (message.type === 'status' && message.data && message.data.status && message.data.status.exec_info) {
                comfyCola.pendientes = Number(message.data.status.exec_info.queue_remaining || 0);
                comfyCola.actualizado = Date.now();
                broadcastComfyCola();
            }
            if (message.type === 'executing' && message.data && message.data.prompt_id) {
                // queda registrado qué prompt está ejecutando ahora mismo
                comfyCola.enEjecucion = [Object.assign({ promptId: message.data.prompt_id },
                    quienEsEstePrompt(message.data.prompt_id))];
                broadcastComfyCola();
            }

            // Enviar mensajes de ejecución de nodos (Mini-Consola)
            if (message.type === 'executing') {
                comfyCola.ejecutando = message.data.node === null ? 0 : 1;
                broadcastComfyCola();
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'executing',
                            node: message.data.node,
                            prompt_id: message.data.prompt_id
                        }));
                    }
                });
            }

            if (message.type === 'execution_error') {
                console.error('❌ ComfyUI execution error:', JSON.stringify(message.data).substring(0, 500));
                const promptId = message.data?.prompt_id;
                const errorDetail = message.data?.exception_message || message.data?.exception?.message || JSON.stringify(message.data).substring(0, 300);
                const nodeId = message.data?.node_id || 'unknown';
                
                // Broadcast error to all clients
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'generation_error',
                            error: `❌ ComfyUI execution error (node ${nodeId}): ${errorDetail}`,
                            prompt_id: promptId,
                            node: nodeId
                        }));
                    }
                });
                
                // Clean up prompt details for this prompt_id
                if (promptId && promptDetails[promptId]) {
                    delete promptDetails[promptId];
                }
            }

            if (message.type === 'executed') {
                const promptId = message.data.prompt_id;
                const details = promptDetails[promptId];
                console.log(`🎬 Ejecución completada para el nodo: ${message.data.node} (Prompt ID: ${promptId})`);

                // Buscar video o imagen en las distintas posibles salidas de ComfyUI
                let assetFound = null;
                let assetType = 'video';
                const output = message.data.output || {};

                if (output.video) assetFound = output.video;
                else if (output.gifs) assetFound = output.gifs;
                else if (output.images) {
                    const imgs = Array.isArray(output.images) ? output.images : [output.images];
                    if (imgs.length === 0) {
                        console.log(`   ⚠️ output.images is empty array for node ${message.data.node}`);
                    }
                    // Primero buscar videos camuflados como imágenes
                    const possibleVideo = imgs.find(img => img.filename.endsWith('.webm') || img.filename.endsWith('.mp4'));
                    if (possibleVideo) {
                        assetFound = possibleVideo;
                    } else if (details && (details.type === 'storyboard' || details.isImage)) {
                        // Si es explícitamente un storyboard o imagen
                        assetFound = imgs;
                        assetType = 'image';
                    } else if (imgs.length > 0) {
                        // Por defecto, si hay imágenes y no se encontró video
                        assetFound = imgs;
                        assetType = 'image';
                    }
                }

                if (!assetFound && message.data.node) {
                    console.log(`   ℹ️ No downloadable asset for node ${message.data.node}${output.images ? ` (images=${Array.isArray(output.images) ? output.images.length : typeof output.images})` : ''}${output.video ? ' (has video)' : ''}${output.gifs ? ' (has gifs)' : ''}`);
                }

                if (assetFound) {
                    console.log(`   ✅ Asset found for node ${message.data.node}: ${assetType} count=${Array.isArray(assetFound) ? assetFound.length : 1}`);
                    const assetItems = Array.isArray(assetFound) ? assetFound : [assetFound];

                    for (const asset of assetItems) {
                        console.log(`📦 Procesando ${assetType} encontrado:`, asset.filename);

                        const subfolder = asset.subfolder || '';
                        const assetUrl = `${comfyBase()}/view?filename=${encodeURIComponent(asset.filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(asset.type || 'output')}`;

                        const filenameOnly = path.basename(asset.filename);
                        const targetSubdir = assetType === 'video' ? 'videos' : 'uploads'; // Guardamos storyboard en uploads para I2V
                        const targetDir = path.join(__dirname, 'public', targetSubdir);
                        const targetPath = path.join(targetDir, filenameOnly);

                        if (!fs.existsSync(targetDir)) {
                            fs.mkdirSync(targetDir, { recursive: true });
                        }

                        try {
                            if (fs.existsSync(targetPath)) {
                                fs.unlinkSync(targetPath);
                            }
                        } catch (e) {
                            console.warn(`No se pudo borrar el archivo previo ${filenameOnly}, puede estar bloqueado.`);
                        }

                        try {
                            // Informar inicio de descarga
                            wss.clients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({ type: `${assetType}_downloading`, message: `Descargando ${assetType}...` }));
                                }
                            });

                            await downloadImage(assetUrl, targetPath);
                            console.log(`✅ ${assetType} descargado: ${filenameOnly}`);

                            // RE-UPLOAD TO COMFYUI: Si es una imagen (Storyboard), debemos subirla a ComfyUI/input 
                            // para que el proceso de I2V pueda encontrarla, ya que por defecto Comfy solo la guardó en output.
                            if (assetType === 'image') {
                                try {
                                    console.log(`📤 Re-subiendo storyboard a ComfyUI/input: ${filenameOnly}...`);
                                    await uploadImageToComfy(targetPath, filenameOnly);
                                    console.log(`✅ ${assetType} listo en ComfyUI.`);
                                } catch (errUpload) {
                                    console.error(`❌ Fallo al re-subir imagen a ComfyUI:`, errUpload);
                                }
                            }

                            // Guardar metadatos asociados al archivo (incluye QUIÉN lo pidió,
                            // en QUÉ computadora se hizo y a quién está registrada).
                            const metaToSave = Object.assign(
                                { prompt: 'Unknown Prompt', params: {} },
                                lastPromptDetails || {}, details || {}
                            );
                            metaToSave.computadora = metaToSave.computadora || datosDeEstaPC();
                            if (!metaToSave.pedidoPor) {
                                // Sin datos del pedido: se asume el usuario logueado acá
                                const pc = datosDeEstaPC();
                                const uu = RED.usuario || {};
                                metaToSave.pedidoPor = {
                                    usuario: pc.dueno || 'local',
                                    displayName: (uu.displayName || pc.dueno) || 'local',
                                    avatar: pc.avatar || '',
                                    tipo: 'local'
                                };
                            }
                            metaToSave.origen = metaToSave.origen || 'local';
                            // Si el workflow produce varias salidas, se cuentan
                            if (metaToSave.salidas && metaToSave.salidas > 1) {
                                const d2 = promptDetails[promptId];
                                if (d2) {
                                    d2.salidasHechas = (d2.salidasHechas || 0) + 1;
                                    console.log(`🎛️  Salida ${d2.salidasHechas}/${d2.salidas} de este trabajo`);
                                }
                            }
                            console.log(`🏷️  Registro: ${filenameOnly} | computadora ${metaToSave.computadora.nombre} (dueño ${metaToSave.computadora.dueno}) | pedido por ${metaToSave.pedidoPor.displayName || metaToSave.pedidoPor.usuario} (${metaToSave.pedidoPor.tipo}) | origen ${metaToSave.origen}`);

                            // Si era un pedido de la red, ya terminó: sale del detalle
                            // de "en vuelo" (antes el contador sólo subía).
                            if (metaToSave.origen === 'red') {
                                RED.enVuelo = Math.max(0, (RED.enVuelo || 0) - 1);
                                RED.enVueloDetalle = (RED.enVueloDetalle || []).filter((j) => j.promptId !== promptId);
                                console.log(`✅ Pedido de la red terminado — quedan ${RED.enVuelo} en vuelo`);
                                avisarRedATodos();
                            }
                            
                            if (assetType === 'video') {
                                saveVideoMetadata(filenameOnly, {
                                    prompt: metaToSave.prompt,
                                    params: metaToSave.params,
                                    imageFilename: metaToSave.imageFilename,
                                    prompt_id: promptId,
                                    batchId: metaToSave.batchId,
                                    batchName: metaToSave.batchName,
                                    type: metaToSave.type || 'video',
                                    computadora: metaToSave.computadora,
                                    pedidoPor: metaToSave.pedidoPor,
                                    origen: metaToSave.origen,
                                    modelo: metaToSave.modelo,
                                    model: metaToSave.model || metaToSave.modelo,
                                });
                            } else {
                                saveImageMetadata(filenameOnly, {
                                    prompt: metaToSave.prompt,
                                    params: metaToSave.params,
                                    storyboardIndex: metaToSave.storyboardIndex,
                                    batchId: metaToSave.batchId,
                                    computadora: metaToSave.computadora,
                                    pedidoPor: metaToSave.pedidoPor,
                                    origen: metaToSave.origen,
                                    modelo: metaToSave.modelo,
                                    model: metaToSave.model || metaToSave.modelo,
                                    batchName: metaToSave.batchName,
                                    prompt_id: promptId,
                                    isForWan: metaToSave.isForWan,
                                    wanRole: metaToSave.wanRole,
                                    wanId: metaToSave.wanId
                                });
                            }

                            // Notificar al frontend
                            wss.clients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    const msg = {
                                        type: assetType === 'video' ? 'video_generated' : 'storyboard_generated',
                                        url: `/${targetSubdir}/${filenameOnly}`,
                                        filename: filenameOnly,
                                        prompt: metaToSave.prompt,
                                        storyboardIndex: metaToSave.storyboardIndex,
                                        batchId: metaToSave.batchId,
                                        prompt_id: promptId,
                                        // Registro de la generación: quién la pidió, en qué PC
                                        // se hizo y a quién está registrada esa computadora.
                                        origen: metaToSave.origen || 'local',
                                        pedidoPor: metaToSave.pedidoPor || null,
                                        computadora: metaToSave.computadora || datosDeEstaPC(),
                                        modelo: metaToSave.modelo || ''
                                    };
                                    // Include WAN2.2 specific info if applicable
                                    if (metaToSave.isForWan) {
                                        msg.isForWan = true;
                                        msg.wanRole = metaToSave.wanRole;
                                        msg.wanId = metaToSave.wanId;
                                        msg.wanStepIndex = metaToSave.wanStepIndex;
                                    }
                                    client.send(JSON.stringify(msg));
                                }
                            });

                            // Enviar a Telegram automáticamente si está configurado
                            if (TELEGRAM_ENABLED && telegramBot.getDefaultChatId()) {
                                const telegramCaption = `🎬 <b>${assetType === 'video' ? 'Video' : 'Image'} Generated</b>\n\n📝 <code>${(metaToSave.prompt || '').substring(0, 200)}</code>`;
                                const telegramPromise = assetType === 'video'
                                    ? telegramBot.sendVideoToTelegram(null, targetPath, telegramCaption)
                                    : telegramBot.sendPhotoToTelegram(null, targetPath, telegramCaption);
                                telegramPromise
                                    .then(() => console.log(`🤖 Sent ${assetType} to Telegram: ${filenameOnly}`))
                                    .catch(err => console.warn(`🤖 Failed to send ${assetType} to Telegram: ${err.message}`));
                            }
                        } catch (error) {
                            console.error(`❌ Error al descargar ${assetType}:`, error);
                            // Notify frontend about the failure so it can recover the queue
                            const errorMsg = `❌ Failed to download ${assetType} from ComfyUI: ${error.message || error}`;
                            wss.clients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: 'generation_error',
                                        error: errorMsg,
                                        prompt_id: promptId
                                    }));
                                }
                            });
                        }
                    }
                }
            }
        } catch (err) {
            // Ignorar errores de parseo de mensajes binarios
            if (!(err instanceof SyntaxError)) {
                console.error('Error procesando mensaje de ComfyUI:', err);
            }
        }
    });

    wsComfy.on('close', () => {
        console.log('❌ Conexión con ComfyUI cerrada. Reconectando en 5s...');
        broadcastComfyStatus('disconnected');
        setTimeout(connectToComfy, 5000);
    });

    wsComfy.on('error', (err) => {
        console.error('❌ Error en WebSocket de ComfyUI:', err.message);
        broadcastComfyStatus('disconnected');
    });
}

// Se llamará al final del archivo para asegurar que wss esté definido
// connectToComfy();

// ============================================
// GENERATION TIMEOUT CHECKER — DISABLED (no hard timeout)
// ============================================
// Generations can run as long as needed. No timeout.
// Only warnings are sent to frontend (handled client-side).

// ============================================
// ENDPOINTS API
// ============================================

app.post('/api/upload-image', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No image received' });

        const ext = path.extname(req.file.originalname) || '.png';
        const newFilename = `input_image_${Date.now()}${ext}`;
        const newPath = path.join(uploadDir, newFilename);
        fs.renameSync(req.file.path, newPath);

        const comfyResult = await uploadImageToComfy(newPath, newFilename);
        console.log('Imagen subida a ComfyUI:', comfyResult);

        res.json({
            success: true,
            filename: comfyResult.name || newFilename,
            localPath: `/uploads/${newFilename}`
        });
    } catch (error) {
        console.error('Error uploading image:', error);
        res.status(500).json({ error: error.message });
    }
});

const VIDEO_META_PATH = path.join(__dirname, 'public', 'videos', 'metadata.json');
const IMAGE_META_PATH = path.join(__dirname, 'public', 'uploads', 'metadata.json');

function saveVideoMetadata(filename, metadata) {
    saveMetadata(VIDEO_META_PATH, filename, metadata);
}

function saveImageMetadata(filename, metadata) {
    saveMetadata(IMAGE_META_PATH, filename, metadata);
}

function saveMetadata(metaPath, filename, metadata) {
    try { avisarGeneracionAlHub(filename, metadata); } catch (e) { }
    let allMetadata = {};
    try {
        if (fs.existsSync(metaPath)) {
            allMetadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        }
    } catch (e) { 
        console.error(`[METADATA] Error reading file ${metaPath}:`, e); 
    }

    allMetadata[filename] = {
        ...metadata,
        timestamp: Date.now()
    };

    try {
        fs.writeFileSync(metaPath, JSON.stringify(allMetadata, null, 2));
        console.log(`[METADATA] ✅ Guardado exitoso para: ${filename} en ${path.basename(metaPath)}`);
    } catch (e) { 
        console.error(`[METADATA] Error writing file ${metaPath}:`, e); 
    }
}

function getVideoMetadata(filename) {
    return getMetadata(VIDEO_META_PATH, filename);
}

function getImageMetadata(filename) {
    return getMetadata(IMAGE_META_PATH, filename);
}

function getMetadata(metaPath, filename) {
    try {
        if (fs.existsSync(metaPath)) {
            const allMetadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            return allMetadata[filename] || null;
        }
    } catch (e) { }
    return null;
}

app.get('/api/images', (req, res) => {
    const uploadsDir = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(uploadsDir)) return res.json([]);
    
    let allMetadata = {};
    try {
        if (fs.existsSync(IMAGE_META_PATH)) {
            allMetadata = JSON.parse(fs.readFileSync(IMAGE_META_PATH, 'utf8'));
        }
    } catch (e) {}

    fs.readdir(uploadsDir, (err, files) => {
        if (err) return res.json([]);
        const images = files
            .filter(file => /\.(png|jpg|jpeg|webp)$/i.test(file))
            .map(file => {
                const stats = fs.statSync(path.join(uploadsDir, file));
                const meta = allMetadata[file] || {};
                return { 
                    filename: file, 
                    url: `/uploads/${file}`, 
                    mtime: stats.mtime.getTime(),
                    timestamp: meta.timestamp || stats.mtime.getTime(),
                    prompt: meta.prompt || '',
                    metadata: { ...(meta.params || {}), imageFilename: meta.imageFilename || null, model: meta.model || null }
                };
            })
            .sort((a, b) => b.timestamp - a.timestamp);
        res.json(images);
    });
});

app.get('/api/audio', (req, res) => {
    const audioDir = path.join(__dirname, 'public', 'audio');
    if (!fs.existsSync(audioDir)) return res.json([]);
    
    fs.readdir(audioDir, (err, files) => {
        if (err) return res.json([]);
        const audioFiles = files
            .filter(file => /\.(mp3|wav|ogg|m4a)$/i.test(file))
            .map(file => {
                const stats = fs.statSync(path.join(audioDir, file));
                return { 
                    filename: file, 
                    url: `/audio/${file}`, 
                    mtime: stats.mtime.getTime()
                };
            })
            .sort((a, b) => b.mtime - a.mtime);
        res.json(audioFiles);
    });
});

app.post('/api/upload-audio', upload.single('audio'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No audio received' });

        const ext = path.extname(req.file.originalname) || '.mp3';
        const newFilename = `audio_${Date.now()}${ext}`;
        const audioDir = path.join(__dirname, 'public', 'audio');
        if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
        
        const newPath = path.join(audioDir, newFilename);
        fs.renameSync(req.file.path, newPath);

        res.json({
            success: true,
            filename: newFilename,
            url: `/audio/${newFilename}`
        });
    } catch (error) {
        console.error('Error uploading audio:', error);
        res.status(500).json({ error: error.message });
    }
});


app.post('/api/generate-avatar', upload.fields([
    { name: 'audio', maxCount: 1 },
    { name: 'image', maxCount: 1 }
]), async (req, res) => {
    try {
        if (!req.files || !req.files['audio']) {
            return res.status(400).json({ error: 'Se requiere un archivo de audio' });
        }
        
        const prompt = req.body.prompt || '';
        const resolution = req.body.resolution || '480p';
        
        // Procesar audio
        const audioFile = req.files['audio'][0];
        const audioExt = path.extname(audioFile.originalname) || '.mp3';
        const audioFilename = `longcat_audio_${Date.now()}${audioExt}`;
        const audioPath = path.join(__dirname, 'public', 'uploads', audioFilename);
        fs.renameSync(audioFile.path, audioPath);
        
        // Procesar imagen (opcional)
        let imageFilename = null;
        if (req.files['image']) {
            const imgFile = req.files['image'][0];
            const imgExt = path.extname(imgFile.originalname) || '.png';
            imageFilename = `longcat_img_${Date.now()}${imgExt}`;
            const imgPath = path.join(__dirname, 'public', 'uploads', imageFilename);
            fs.renameSync(imgFile.path, imgPath);
        }
        
        // Generar avatar via WebSocket (para que el frontend reciba updates)
        const outputFilename = `longcat_${Date.now()}.mp4`;
        const outputPath = path.join(__dirname, 'public', 'videos', outputFilename);
        const scriptPath = path.join(__dirname, 'tools', 'longcat_avatar.py');
        
        if (!fs.existsSync(scriptPath)) {
            return res.status(500).json({ error: 'Script LongCat no encontrado. Ejecutá setup primero.' });
        }
        
        const mode = imageFilename ? 'ai2v' : 'at2v';
        let cmd = `"${process.execPath}" "${scriptPath}" --no_setup --mode ${mode} --audio "${audioPath}" --prompt "${prompt.replace(/"/g, '\\"')}" --output "${outputPath}" --resolution ${resolution} --use_int8`;
        if (imageFilename) {
            const imgPath = path.join(__dirname, 'public', 'uploads', imageFilename);
            cmd += ` --image "${imgPath}"`;
        }
        
        console.log(`🐱 [REST] LongCat generando: ${outputFilename}`);
        
        // Responder inmediatamente con el filename
        // La generación corre en background
        exec(cmd, { timeout: 86400000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                console.error(`❌ [REST] LongCat error: ${error.message}`);
                return;
            }
            console.log(`✅ [REST] LongCat completado: ${outputFilename}`);
            
            // Guardar metadata
            saveVideoMetadata(outputFilename, {
                prompt: prompt,
                params: { resolution, mode },
                type: 'longcat-avatar'
            });
            
            // Notificar frontend
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'video_generated',
                        url: `/videos/${outputFilename}`,
                        filename: outputFilename,
                        prompt: prompt,
                        prompt_id: 'longcat-' + Date.now()
                    }));
                }
            });
        });
        
        res.json({
            success: true,
            message: 'Generación de avatar iniciada',
            outputFilename: outputFilename,
            estimatedTime: '5-10 minutos'
        });
    } catch (error) {
        console.error('Error generating avatar:', error);
        res.status(500).json({ error: error.message });
    }
});


app.post('/api/setup-longcat', async (req, res) => {
    try {
        const scriptPath = path.join(__dirname, 'tools', 'longcat_avatar.py');
        if (!fs.existsSync(scriptPath)) {
            return res.status(500).json({ error: 'longcat_avatar.py no encontrado' });
        }
        
        res.json({ 
            success: true, 
            message: 'Setup iniciado. Corré: python longcat_avatar.py --help',
            instructions: [
                '1. Asegurate de tener Python 3.10+ y CUDA 12.4',
                '2. El script descargará automáticamente el modelo (~75GB)',
                '3. Corré: python longcat_avatar.py --mode at2v --audio test.mp3 --prompt "test" --output test.mp4',
                '4. Requiere ~24GB VRAM con --use_int8',
                '5. Opcional: git clone https://github.com/meituan-longcat/LongCat-Video.git'
            ]
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


async function checkAudio(filePath) {
    try {
        const { stdout } = await execPromise(`ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "${filePath}"`);
        return stdout.trim().length > 0;
    } catch (e) {
        console.warn(`[FFPROBE] Error checking audio for ${filePath}:`, e.message);
        return false;
    }
}

app.get('/api/videos', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const videosDir = path.join(__dirname, 'public', 'videos');
    if (!fs.existsSync(videosDir)) return res.json([]);

    fs.readdir(videosDir, (err, files) => {
        if (err) return res.json([]);
        
        let allMetadata = {};
        try {
            if (fs.existsSync(VIDEO_META_PATH)) {
                allMetadata = JSON.parse(fs.readFileSync(VIDEO_META_PATH, 'utf8'));
            }
        } catch (e) {}

        const videoFiles = files
            .filter(file => /\.(webm|mp4|gif)$/i.test(file))
            .map(file => {
                const stats = fs.statSync(path.join(videosDir, file));
                const meta = allMetadata[file] || {};
                return { 
                    filename: file, 
                    url: `/videos/${file}`, 
                    mtime: stats.mtime.getTime(),
                    timestamp: meta.timestamp || stats.mtime.getTime(),
                    prompt: meta.prompt || '',
                    metadata: { ...(meta.params || {}), imageFilename: meta.imageFilename || null, model: meta.model || null }
                };
            })
            .sort((a, b) => b.timestamp - a.timestamp);
        res.json(videoFiles);
    });
});

app.get('/api/examples', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const dir = path.join(__dirname, 'public', 'examples');
    if (!fs.existsSync(dir)) return res.json([]);

    fs.readdir(dir, (err, files) => {
        if (err) return res.json([]);
        let allMetadata = {};
        try {
            const metaPath = path.join(dir, 'metadata.json');
            if (fs.existsSync(metaPath)) allMetadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        } catch (e) {}

        const list = files
            .filter(file => /\.(webm|mp4|gif)$/i.test(file))
            .map(file => {
                const stats = fs.statSync(path.join(dir, file));
                const meta = allMetadata[file] || {};
                return {
                    filename: file,
                    url: `/examples/${file}`,
                    mtime: stats.mtime.getTime(),
                    timestamp: meta.timestamp || stats.mtime.getTime(),
                    prompt: meta.prompt || '',
                    metadata: { ...(meta.params || {}), imageFilename: meta.imageFilename || null, model: meta.model || null }
                };
            })
            .sort((a, b) => b.timestamp - a.timestamp);
        res.json(list);
    });
});

app.post('/api/export-timeline', async (req, res) => {
    try {
        const { clips, batchId, batchName } = req.body;
        if (!clips || clips.length === 0) return res.status(400).json({ error: 'No clips provided' });

        console.log(`🎬 Iniciando exportación de timeline: ${clips.length} clips`);

        const videosDir = path.join(__dirname, 'public', 'videos');
        const audioDir = path.join(__dirname, 'public', 'audio');
        const outputFilename = `export_${Date.now()}.mp4`;
        const outputPath = path.join(videosDir, outputFilename);

        // 1. Determinar duración total
        let targetWidth = 1280;
        let targetHeight = 720;
        let totalDuration = 0;

        clips.forEach(c => {
            const end = c.startTime + c.duration;
            if (end > totalDuration) totalDuration = end;
        });

        // 2. Construir inputs de ffmpeg y mapear rutas
        const inputPaths = clips.map(c => {
            let fullPath = path.join(videosDir, c.filename);
            if (!fs.existsSync(fullPath)) {
                fullPath = path.join(audioDir, c.filename);
            }
            return fullPath;
        });

        const inputs = inputPaths.map(p => `-i "${p}"`).join(' ');

        // 3. Construir Filter Complex
        let filterComplex = '';
        // Crear fondo negro base
        filterComplex += `color=s=${targetWidth}x${targetHeight}:d=${totalDuration}:c=black[bg];`;

        let currentLayer = '[bg]';
        let audioLabels = [];
        let videoInputsCount = 0;

        for (let i = 0; i < clips.length; i++) {
            const c = clips[i];
            const isAudioTrack = c.track && c.track.startsWith('A');
            const offsetMs = Math.round(c.startTime * 1000);
            const offsetSec = offsetMs / 1000;
            const clipPath = inputPaths[i];

            // --- VIDEO (Solo si no es track de audio) ---
            if (!isAudioTrack) {
                filterComplex += `[${i}:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS-STARTPTS+(${offsetSec}/TB)[v${i}];`;
                
                const nextLayer = `[layer${i}]`;
                filterComplex += `${currentLayer}[v${i}]overlay=enable='between(t,${c.startTime},${c.startTime + c.duration})'${nextLayer};`;
                currentLayer = nextLayer;
                videoInputsCount++;
            }

            // --- AUDIO (En cualquier clip que lo tenga y NO este muteado) ---
            const hasAudio = await checkAudio(clipPath);
            if (hasAudio && !c.muted) {
                filterComplex += `[${i}:a]atrim=0:${c.duration},asetpts=PTS-STARTPTS,adelay=${offsetMs}:all=1[a${i}];`;
                audioLabels.push(`[a${i}]`);
            }
        }

        // Renombrar la última capa de video
        if (videoInputsCount > 0) {
            filterComplex = filterComplex.replace(new RegExp(`\\[layer${clips.length - 1}\\]$`), '[outv]');
            // Si por alguna razón no se reemplazó (ej: el último clip era audio), aseguramos la salida
            if (!filterComplex.includes('[outv]')) {
                 filterComplex += `${currentLayer}copy[outv];`;
            }
        } else {
             filterComplex += `${currentLayer}copy[outv];`;
        }

        // 4. Mixing de Audio si existe
        let mapVideo = '-map "[outv]"';
        let mapAudio = '';
        if (audioLabels.length > 0) {
            filterComplex += `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest[outa]`;
            mapAudio = '-map "[outa]" -c:a aac -b:a 192k';
        }

        const command = `ffmpeg ${inputs} -filter_complex "${filterComplex}" ${mapVideo} ${mapAudio} -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -y "${outputPath}"`;
        
        console.log('Ejecutando FFmpeg:', command);
        await execPromise(command);

        // Recopilar todos los prompts de los clips para metadata completo
        const clipPrompts = clips.map(c => c.prompt || 'Unknown').filter(p => p && p !== 'Unknown');
        const combinedPrompt = clipPrompts.length > 0 ? clipPrompts.join(' | ') : 'Final Project Export';

        saveVideoMetadata(outputFilename, {
            prompt: combinedPrompt,
            isExport: true,
            clipCount: clips.length,
            duration: totalDuration,
            batchId: batchId || null,
            batchName: batchName || null,
            clips: clips.map(c => ({
                filename: c.filename,
                prompt: c.prompt,
                startTime: c.startTime,
                duration: c.duration
            })),
            params: { videoWidth: targetWidth, videoHeight: targetHeight }
        });

        res.json({ success: true, filename: outputFilename, url: `/videos/${outputFilename}` });

    } catch (error) {
        console.error('Error exporting timeline:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// PROJECTS API
// ============================================

app.get('/api/projects', (req, res) => {
    if (!fs.existsSync(projectsDir)) return res.json([]);
    
    fs.readdir(projectsDir, (err, files) => {
        if (err) return res.json([]);
        const projects = files
            .filter(file => file.endsWith('.json'))
            .map(file => {
                const stats = fs.statSync(path.join(projectsDir, file));
                return { 
                    name: file.replace('.json', ''),
                    filename: file,
                    mtime: stats.mtime.getTime()
                };
            })
            .sort((a, b) => b.mtime - a.mtime);
        res.json(projects);
    });
});

app.post('/api/projects/save', (req, res) => {
    try {
        const { name, data } = req.body;
        if (!name) return res.status(400).json({ error: 'Project name required' });
        
        const filename = `${name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.json`;
        const filePath = path.join(projectsDir, filename);
        
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        console.log(`[PROJECT] ✅ Guardado: ${name} -> ${filename}`);
        res.json({ success: true, filename });
    } catch (error) {
        console.error('Error saving project:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// OLLAMA PROMPT ENHANCER
// ============================================

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

app.get('/api/list-ollama-models', async (req, res) => {
    try {
        const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
        if (!response.ok) throw new Error(`Ollama responded with ${response.status}`);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        const isConnRefused = error?.cause?.code === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED';
        if (!isConnRefused) console.error('Error listing Ollama models:', error);
        res.json({ models: [] });
    }
});

app.post('/api/enhance-prompt', async (req, res) => {
    try {
        const { text, modelName } = req.body;
        if (!text) return res.status(400).json({ error: 'No prompt text provided' });

        const ollamaModel = modelName || 'llama3.2:latest';

        const skillPath = path.join(__dirname, '.agents', 'skills', 'prompt_master', 'SKILL.md');
        let skillGuide = "";
        try {
            skillGuide = fs.readFileSync(skillPath, 'utf8');
        } catch (e) {
            console.warn("⚠️ No se pudo leer SKILL.md");
        }

        const promptText = `
        Sos un asistente experto en ingeniería de prompts para modelos de IA como Flux y LTX-2. 
        Tu tarea es tomar la siguiente "Idea del Usuario" y generar un JSON de batch siguiendo ESTRICTAMENTE las reglas de esta guía de estilo:

        --- GUIA DE ESTILO (SKILL.MD) ---
        ${skillGuide}
        --- FIN GUIA ---

        IDEA DEL USUARIO: "${text}"

        REGLAS DE SALIDA:
        - Debes devolver ÚNICAMENTE el JSON válido.
        - El JSON debe tener llaves "globalImage", "globalVideo" y un array "steps".
        - "globalImage" debe definir el estilo visual de alta calidad basado en la guía.
        - "globalVideo" debe definir el tono de voz y estilo de cámara global basado en la guía.
        - Crea al menos de 3 a 5 "steps" que cuenten una pequeña historia basada en la idea.
        - Cada step debe tener "PROMPT IMAGE" (detalles visuales de Flux) y "VIDEO IMAGE" (acción, cámara y diálogos entre comillas para LTX-2).
        - Asegura la consistencia de los sujetos en todos los pasos.
        - NO incluyas explicaciones fuera del bloque JSON.
        `;

        const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: ollamaModel,
                prompt: promptText,
                stream: false
            })
        });
        if (!ollamaRes.ok) throw new Error(`Ollama responded with ${ollamaRes.status}`);
        const ollamaData = await ollamaRes.json();
        const generatedText = ollamaData.response || "";

        const jsonMatch = generatedText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const cleanJson = JSON.parse(jsonMatch[0]);
            res.json(cleanJson);
        } else {
            throw new Error("No se pudo extraer un JSON válido de la respuesta de Ollama.");
        }

    } catch (error) {
        console.error('Error enhancing prompt:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/improve-step-prompt', async (req, res) => {
    try {
        const { text, type, modelName } = req.body;
        if (!text) return res.status(400).json({ error: 'No prompt text provided' });

        const ollamaModel = modelName || 'llama3.2:latest';
        const skillPath = path.join(__dirname, '.agents', 'skills', 'prompt_master', 'SKILL.md');
        let skillGuide = "";
        try { skillGuide = fs.readFileSync(skillPath, 'utf8'); } catch (e) {}

        const promptText = `
        Sos un asistente experto en ingeniería de prompts. 
        Tu tarea es mejorar el siguiente prompt de usuario para que sea de alta calidad.
        
        --- GUIA DE ESTILO ---
        ${skillGuide}
        --- FIN GUIA ---

        TIPO DE PROMPT: ${type === 'video' ? 'VIDEO / ANIMACIÓN (LTX-2)' : 'IMAGEN ESTÁTICA (FLUX)'}
        PROMPT ORIGINAL: "${text}"

        REGLAS DE SALIDA:
        - Devuelve ÚNICAMENTE el texto del prompt mejorado.
        - NO incluyas introducciones, explicaciones ni comillas externas.
        - Asegúrate de seguir las reglas de estilo de la guía (detalles técnicos, iluminación, cámara, etc).
        `;

        const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: ollamaModel,
                prompt: promptText,
                stream: false
            })
        });
        
        if (!ollamaRes.ok) throw new Error(`Ollama responded with ${ollamaRes.status}`);
        const ollamaData = await ollamaRes.json();
        res.json({ improvedText: ollamaData.response.trim() });

    } catch (error) {
        console.error('Error improving step prompt:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/projects/:name', (req, res) => {
    try {
        const name = req.params.name;
        const filePath = path.join(projectsDir, `${name}.json`);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Project not found' });
        
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/projects/:name', (req, res) => {
    try {
        const name = req.params.name;
        const filePath = path.join(projectsDir, `${name}.json`);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Project not found' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// TELEGRAM BOT API ENDPOINT
// ============================================

app.post('/api/send-to-telegram', async (req, res) => {
    if (!TELEGRAM_ENABLED) {
        return res.status(503).json({ success: false, telegram: false, message: 'Telegram está desactivado.' });
    }
    try {
        const { filename, type, chatId, caption } = req.body;

        if (!filename) {
            return res.status(400).json({ error: 'filename is required' });
        }

        // Determine the file path based on type
        let filePath;
        if (type === 'video') {
            filePath = path.join(__dirname, 'public', 'videos', filename);
        } else {
            // Default to uploads for images
            filePath = path.join(__dirname, 'public', 'uploads', filename);
        }

        // If the file doesn't exist in the default location, try the other
        if (!fs.existsSync(filePath)) {
            const altPath = type === 'video'
                ? path.join(__dirname, 'public', 'uploads', filename)
                : path.join(__dirname, 'public', 'videos', filename);
            if (fs.existsSync(altPath)) {
                filePath = altPath;
            } else {
                return res.status(404).json({ error: `File not found: ${filename}` });
            }
        }

        if (!TELEGRAM_ENABLED) {
            return res.status(400).json({ error: 'Telegram Bot not configured (TELEGRAM_BOT_TOKEN missing)' });
        }

        const targetChatId = chatId || telegramBot.getDefaultChatId();
        if (!targetChatId) {
            return res.status(400).json({ error: 'No chat ID provided and TELEGRAM_CHAT_ID not configured' });
        }

        const fileType = type || 'image';
        let result;

        if (fileType === 'video') {
            result = await telegramBot.sendVideoToTelegram(targetChatId, filePath, caption || '');
            console.log(`🤖 Sent video ${filename} to Telegram chat ${targetChatId}`);
        } else {
            result = await telegramBot.sendPhotoToTelegram(targetChatId, filePath, caption || '');
            console.log(`🤖 Sent image ${filename} to Telegram chat ${targetChatId}`);
        }

        res.json({
            success: true,
            message_id: result.result?.message_id,
            chat: result.result?.chat
        });
    } catch (error) {
        console.error('❌ Error sending to Telegram:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// SERVIDOR Y WEBSOCKETS CLIENTES
// ============================================

const port = Number(process.env.PORT) || 5634;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.error(`❌ Error: El puerto ${port} ya está en uso.`);
        console.error(`💡 Probablemente el servidor ya esté corriendo en otra ventana. Ciérrala e intenta de nuevo.`);
        process.exit(1);
    }
});

// ==========================================================================
// RED COMFYLATAM (lado app local)
// --------------------------------------------------------------------------
// Cada app que corre en una PC es un NODO de la red: tiene un peerId estable,
// un nombre y la opcion de COMPARTIR su Comfy (apagada por defecto). El agente
// (conectar-comfylatam.bat) publica ese nodo en el hub y le manda los trabajos
// que otros usuarios pidan; aca se encolan y se generan con el Comfy local.
// ==========================================================================
const RED_HUB = (process.env.RED_HUB || 'https://vps-4455523-x.dattaweb.com').replace(/\/+$/, '');
const RED_BASE = process.env.RED_BASE || '/comfylatam';
const RED_TOKEN = process.env.AGENT_TOKEN || '';

const RED = {
    peerId: '',
    nombre: '',
    compartir: false,
    nodos: [],
    pasados: [],
    usuario: null,
    propietario: null,
    workflowsCompartidos: {},
    workflowsRed: [],
    nombreManual: false,
    clientes: null,
    enVuelo: 0,
    hub: RED_HUB + RED_BASE
};

// Modelos que este nodo puede ofrecer a la red.
function modelosDeLaRed() {
    // Sólo se ofrecen los modelos cuyo workflow este fierro COMPARTE y TIENE
    // instalado: así nadie puede pedir algo que acá no existe.
    const ofrecidos = RED.workflowsRed || null;
    const permitido = (k) => {
        if (!ofrecidos) return true;               // todavía no se calculó
        const wf = MODELO_A_WORKFLOW[k];
        return wf ? ofrecidos.includes(wf) : true;
    };
    const base = Object.keys(MODELOS_IMAGEN)
        .filter(permitido)
        .map((k) => ({
            id: k,
            nombre: MODELOS_IMAGEN[k].etiqueta,
            tipo: MODELOS_IMAGEN[k].tipoSalida === 'storyboard' ? 'imagen' : 'video'
        }));
    // el video LTX-2 (t2v/i2v) usa dos workflows distintos
    if (permitido('ltx2t2v') || permitido('ltx2i2v') || permitido('ltx25i2v')) {
        base.push({ id: 'ltx2', nombre: 'LTX-2 (video)', tipo: 'video' });
    }
    return base;
}

function estadoRed() {
    return {
        peerId: RED.peerId,
        nombre: RED.nombre,
        compartir: RED.compartir,
        modelos: modelosDeLaRed(),
        // workflows que este fierro ofrece a la red (compartidos Y con modelos instalados)
        workflows: RED.workflowsRed || [],
        usuario: RED.usuario,
        email: (RED.propietario && RED.propietario.email) || (RED.usuario && RED.usuario.email) || '',
        propietario: RED.propietario,
        computadora: datosDeEstaPC(),
        clientes: RED.clientes,
        enVueloDetalle: RED.enVueloDetalle || [],
        hub: RED.hub,
        // "conectado" = MI nodo aparece publicado en la red (lo dice el hub)
        conectado: RED.nodos.some((p) => p && p.id === RED.peerId),
        enVuelo: RED.enVuelo,
        nodos: RED.nodos,
        pasados: RED.pasados
    };
}

function avisarRedATodos(extra) {
    const msg = JSON.stringify(Object.assign({ type: 'red_estado', red: estadoRed() }, extra || {}));
    wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// Le avisamos al hub que cambiamos "compartir" (si hay token configurado).
async function avisarHubCompartir() {
    if (!RED_TOKEN) return { ok: false, motivo: 'sin token (corré conectar-comfylatam.bat)' };
    try {
        const r = await fetch(RED.hub + '/api/red/compartir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-agent-token': RED_TOKEN },
            body: JSON.stringify({ peerId: RED.peerId, compartir: RED.compartir })
        });
        const d = await r.json().catch(() => ({}));
        return { ok: r.ok, datos: d };
    } catch (e) {
        return { ok: false, motivo: e.message };
    }
}

// --- estado de la red ------------------------------------------------------
app.get('/api/red/estado', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(Object.assign({ success: true }, estadoRed()));
});

// --- prender / apagar compartir + cambiar el nombre ------------------------
app.post('/api/red/compartir', async (req, res) => {
    const b = req.body || {};
    const nombreAntes = RED.nombre;
    if (b.compartir !== undefined) RED.compartir = !!b.compartir;
    if (b.nombre) { RED.nombre = String(b.nombre).slice(0, 40); RED.nombreManual = true; }
    guardarConfigLocal();
    let hub = null;
    if (!b.desdeHub) hub = await avisarHubCompartir();
    // Si cambió el nombre hay que REINDEXAR YA en la red (si no, en
    // fullscreencode/comfylatam se sigue viendo el nombre viejo hasta que
    // el nodo se reconecte solo, ~15 s después).
    if (RED.nombre !== nombreAntes) {
        console.log(`✏️  Nombre de la computadora: "${nombreAntes}" -> "${RED.nombre}" — reindexando en la red`);
        try {
            if (global.__comfylatamNodo && typeof global.__comfylatamNodo.reconectar === 'function') {
                setTimeout(() => { try { global.__comfylatamNodo.reconectar(); } catch (e) { } }, 300);
            }
        } catch (e) { }
    }
    avisarRedATodos();
    console.log(`🌎 Red: compartir=${RED.compartir} | nombre=${RED.nombre}${hub ? ' (hub: ' + (hub.ok ? 'ok' : hub.motivo) + ')' : ''}`);
    res.json({ success: true, red: estadoRed(), hub });
});

// --- el agente nos pasa la lista de nodos ---------------------------------
// El nodo recibe del hub cuántos clientes/usuarios hay conectados.
app.post('/api/red/clientes', (req, res) => {
    const d = req.body || {};
    RED.clientes = {
        total: Number(d.total || 0),
        web: Number(d.web || 0),
        local: Number(d.local || 0),
        usuariosTotal: Number(d.usuariosTotal || 0),
        usuarios: Array.isArray(d.usuarios) ? d.usuarios : [],
        clientes: Array.isArray(d.clientes) ? d.clientes : [],
        appsLocales: Number(d.appsLocales || 0),
        recibido: Date.now()
    };
    // Sólo se avisa cuando CAMBIA: antes escribía esto cada vez que el hub
    // mandaba los clientes y el log era un chorro continuo de datos iguales.
    // La última firma vista se guarda EN EL PROPIO ESTADO DE LA RED: así no
    // depende de ninguna variable del módulo (el bug original fue justamente
    // una variable usada y nunca declarada).
    const firma = `${RED.clientes.total}|${RED.clientes.web}|${RED.clientes.local}|${RED.clientes.usuariosTotal}`;
    if (RED._firmaClientes !== firma) {
        RED._firmaClientes = firma;
        console.log(`👥 Del hub: ${RED.clientes.total} cliente(s) — ${RED.clientes.web} web · ${RED.clientes.local} local · ${RED.clientes.usuariosTotal} usuario(s)`);
    }
    avisarRedATodos();
    res.json({ success: true });
});

app.post('/api/red/nodos', (req, res) => {
    const b = req.body || {};
    RED.nodos = Array.isArray(b.peers) ? b.peers : (Array.isArray(b) ? b : []);
    avisarRedATodos();
    res.json({ success: true, nodos: RED.nodos.length });
});

// --- lo que pasa en la red (lo empuja el agente) --------------------------
app.post('/api/red/evento', (req, res) => {
    const d = req.body || {};
    // Si viene de este mismo nodo o no tiene datos válidos, descartar
    if (!d || !d.data || (d.peerId && d.peerId === RED.peerId)) {
        return res.json({ success: true });
    }
    // Si los datos ya vienen con recursión de red_evento, no reenviar
    if (typeof d.data === 'string' && d.data.includes('"red_evento"')) {
        return res.json({ success: true });
    }
    wss.clients.forEach((c) => {
        if (c.readyState === WebSocket.OPEN) {
            c.send(JSON.stringify({ type: 'red_evento', evento: d }));
        }
    });
    res.json({ success: true });
});

// --- ENCOLAR UN TRABAJO EN ESTE NODO --------------------------------------
// Lo usan el agente (trabajos que llegan de la red) y el propio front cuando
// el nodo elegido es este mismo.
// QUIÉN PIDE este trabajo. Viaja CON el trabajo (el front manda su usuario
// logueado en el mensaje); si no viene, se usa el que está logueado en la app.
// Antes se tomaba el usuario global de la app y por eso CUALQUIER generación
// quedaba a nombre del último que se había logueado en esa PC.
function datosDelPedido(fuente) {
    const pp = (fuente && fuente.pedidoPor) || null;
    if (pp && (pp.usuario || pp.displayName)) {
        return {
            usuario: pp.usuario || pp.displayName,
            displayName: pp.displayName || pp.usuario,
            avatar: pp.avatar || '',
            email: pp.email || '',
            tipo: pp.tipo || 'local',
            sesion: pp.sesion || null
        };
    }
    const u = RED.usuario || {};
    if (u.username || u.displayName) {
        return {
            usuario: u.username || u.displayName,
            displayName: u.displayName || u.username,
            avatar: u.avatar || '',
            email: u.email || (RED.propietario && RED.propietario.email) || '',
            tipo: 'local',
            sesion: null
        };
    }
    return { usuario: 'sin sesión', displayName: 'sin sesión (nadie logueado)', avatar: '', tipo: 'local', sesion: null };
}

// Los datos de ESTA computadora: cómo se llama en la red y a qué usuario está
// registrada (lo que después queda anotado en el registro de generaciones).
function datosDeEstaPC() {
    // El DUEÑO es el propietario registrado de esta computadora (estable), no el
    // usuario que esté logueado en este momento.
    const pr = RED.propietario || {};
    const u = RED.usuario || {};
    return {
        peerId: RED.peerId,
        nombre: RED.nombre,
        // el hostname NO se publica: la red muestra el nombre de la computadora
        dueno: pr.usuario || u.username || u.displayName || 'local',
        duenoNombre: pr.displayName || pr.usuario || u.displayName || u.username || 'local',
        // el EMAIL es el identificador universal del ecosistema (skillmaestro)
        email: pr.email || u.email || '',
        emailDueno: pr.email || u.email || '',
        avatar: pr.avatar || u.avatar || ''
    };
}

async function encolarTrabajoRed(b) {
    const prompt = String((b && b.prompt) || '').trim();
    if (!prompt) throw new Error('El trabajo no trae prompt.');

    // Si el pedido viene DE LA RED, sólo se acepta un workflow que este fierro
    // comparta Y tenga instalado (si no, se rechaza con el motivo).
    const pp = (b && b.pedidoPor) || {};
    const deLaRed = pp.tipo === 'web' || pp.tipo === 'app-local' || !!(b && b.de && b.red);
    if (deLaRed) {
        const v = await validarPedidoDeRed(b);
        if (!v.ok) {
            console.log('⛔ Pedido de la red rechazado: ' + v.motivo);
            throw new Error(v.motivo);
        }
    }

    const params = Object.assign({
        videoWidth: 1024, videoHeight: 1024, samplerSteps: 10, seed: -1
    }, (b && b.params) || {});
    const modelo = (b.modelo && MODELOS_IMAGEN[b.modelo]) ? b.modelo
        : (String((b && b.tipo) || '').toLowerCase() === 'video' ? null : 'zimage');

    await liberarVram().catch(() => { });
    const promptId = modelo
        ? await generarImagenModelo(modelo, prompt, params)
        : (b && b.imagen
            ? await generarVideoLTX25(prompt, params, b.imagen)
            : await generarVideoT2VLTX25(prompt, params));

    // Quién lo pidió: si viene de la red, el hub manda pedidoPor; si es local,
    // es el usuario logueado en esta PC (o "vos").
    const pedidoPor = datosDelPedido(b);
    const details = {
        prompt,
        params,
        type: modelo ? MODELOS_IMAGEN[modelo].tipoSalida : 'video',
        modelo: modelo || 'ltx2',
        model: modelo ? MODELOS_IMAGEN[modelo].etiqueta : 'LTX-2.5 distilled',
        origen: 'red',
        pedidoPor,
        computadora: datosDeEstaPC(),
        red: { jobId: (b && b.jobId) || null, de: pedidoPor.displayName || pedidoPor.usuario, peerId: RED.peerId },
        generationStartTime: Date.now()
    };
    promptDetails[promptId] = details;
    lastPromptDetails = details;
    RED.enVuelo++;
    // Detalle de los pedidos que están entrando por la red (para poder mostrarlos
    // SEPARADOS del batch propio en la cola del editor).
    RED.enVueloDetalle = (RED.enVueloDetalle || []);
    RED.enVueloDetalle.push({
        jobId: details.red.jobId, promptId, prompt: prompt.slice(0, 120),
        modelo: details.modelo, de: pedidoPor.displayName || pedidoPor.usuario,
        usuario: pedidoPor.usuario, avatar: pedidoPor.avatar || '', tipo: pedidoPor.tipo || 'web',
        desde: Date.now()
    });
    if (RED.enVueloDetalle.length > 20) RED.enVueloDetalle = RED.enVueloDetalle.slice(-20);
    avisarRedATodos({ job: { jobId: details.red.jobId, promptId, modelo: details.modelo, de: details.red.de } });
    console.log(`🌎 [RED] trabajo de ${pedidoPor.displayName} (${pedidoPor.tipo}) recibido del VPS -> encolado acá (${details.modelo})`);
    console.log(`   prompt: ${prompt.slice(0, 70)}`);
    return { promptId, modelo: details.modelo, jobId: details.red.jobId };
}

app.post('/api/red/job', async (req, res) => {
    try {
        const d = await encolarTrabajoRed(req.body || {});
        res.json(Object.assign({ success: true }, d));
    } catch (e) {
        console.error('❌ Error encolando un trabajo de la red:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- PEDIR UN TRABAJO A LA RED (lo llama el front) ------------------------
// Si el destino soy yo, se encola acá; si es otro nodo, se lo pedimos al hub.
app.post('/api/red/generar', async (req, res) => {
    const b = req.body || {};
    const destino = String(b.peerId || '');
    if (!destino || destino === RED.peerId) {
        try {
            const d = await encolarTrabajoRed(Object.assign({ tipo: 'imagen' }, b, {
                de: (b.pedidoPor && (b.pedidoPor.displayName || b.pedidoPor.usuario)) || b.de || 'local'
            }));
            return res.json(Object.assign({ success: true, local: true }, d));
        } catch (e) {
            return res.status(500).json({ success: false, message: e.message });
        }
    }
    if (!RED_TOKEN) {
        return res.status(503).json({
            success: false,
            message: 'Para generar en otro nodo tenés que correr conectar-comfylatam.bat (falta el token de la red).'
        });
    }
    try {
        const r = await fetch(RED.hub + '/api/red/generar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-agent-token': RED_TOKEN },
            body: JSON.stringify({
                peerId: destino,
                tipo: b.tipo || 'imagen',
                prompt: b.prompt || '',
                modelo: b.modelo || null,
                params: b.params || {}
            })
        });
        const d = await r.json().catch(() => ({}));
        return res.status(r.status).json(d);
    } catch (e) {
        return res.status(502).json({ success: false, message: 'No pude hablar con el hub: ' + e.message });
    }
});

// --- los nodos los pedimos nosotros al hub (no dependemos del agente) -------
// Así la pestaña RED funciona apenas abre la app, sin esperar a que el hub
// avise por socket de un cambio.
let ultimoJsonNodos = '';
async function refrescarNodosDelHub() {
    if (!RED_TOKEN) return;
    try {
        const r = await fetch(RED.hub + '/api/red/peers?pasados=1', {
            headers: { 'x-agent-token': RED_TOKEN },
            signal: AbortSignal.timeout(6000)
        });
        if (!r.ok) return;
        const d = await r.json().catch(() => ({}));
        const lista = Array.isArray(d.peers) ? d.peers : [];
        const viejos = Array.isArray(d.pasados) ? d.pasados : [];
        const j = JSON.stringify(lista) + '|' + JSON.stringify(viejos);
        RED.nodos = lista;
        RED.pasados = viejos;
        if (j !== ultimoJsonNodos) { ultimoJsonNodos = j; avisarRedATodos(); }
    } catch (e) { /* sin red: se reintenta */ }
}
setInterval(refrescarNodosDelHub, 6000);
setTimeout(refrescarNodosDelHub, 1500);

// --- el front manda tu perfil (nombre + avatar) para publicarlo en la red ----
app.post('/api/red/perfil', async (req, res) => {
    const b = req.body || {};
    RED.usuario = {
        username: b.username || null,
        displayName: b.displayName || null,
        avatar: b.avatar || null,
        email: b.email || null,
        id: b.id || null
    };
    // PROPIETARIO de la computadora: es ESTABLE. El primero que se loguea en esta
    // máquina queda como dueño (o el dueño se cambia a mano con ?propietario=1).
    // Antes se usaba el usuario logueado de turno y así cualquier generación
    // quedaba a nombre del último que abrió la app.
    if (!RED.propietario && RED.usuario.username) {
        RED.propietario = {
            usuario: RED.usuario.username,
            displayName: RED.usuario.displayName || RED.usuario.username,
            avatar: RED.usuario.avatar || '',
            email: RED.usuario.email || ''
        };
        console.log(`🔑 Dueño de esta computadora: ${RED.propietario.displayName} (@${RED.propietario.usuario})`);
    }
    if (b.propietario === true && RED.usuario.username) {
        RED.propietario = {
            usuario: RED.usuario.username,
            displayName: RED.usuario.displayName || RED.usuario.username,
            avatar: RED.usuario.avatar || '',
            email: RED.usuario.email || ''
        };
        console.log(`🔑 Dueño de esta computadora cambiado a ${RED.propietario.displayName}`);
    }
    // si el dueño nunca eligió un nombre a mano, se usa el del perfil
    if (!RED.nombreManual && RED.usuario.displayName) {
        RED.nombre = RED.usuario.displayName + ' · ComfyLatam';
    }
    guardarConfigLocal();
    avisarRedATodos();
    console.log(`👤 Perfil de la app: ${RED.usuario.displayName || RED.usuario.username || '?'}`);
    res.json({ success: true, red: estadoRed() });
});

// --- conectar la app a la red (lanza el agente/nodo) ----------------------
// El agente vive en el repo jpiassets; acá lo arrancamos desprendido para que
// el usuario no tenga que buscar el .bat. Se puede fijar con AGENT_PATH en .env.
function rutaDelAgente() {
    if (process.env.AGENT_PATH && fs.existsSync(process.env.AGENT_PATH)) return process.env.AGENT_PATH;
    const candidatos = [
        path.join(__dirname, 'agent', 'comfylatam-agent.js'),
        path.join(__dirname, '..', 'jpiassets', 'agent', 'comfylatam-agent.js'),
        path.join(__dirname, '..', 'sistemasfullscreen', 'jpiassets', 'agent', 'comfylatam-agent.js')
    ];
    for (const c of candidatos) if (fs.existsSync(c)) return c;
    return '';
}

app.post('/api/red/agente', async (req, res) => {
    if (RED.nodos.some((p) => p && p.id === RED.peerId)) {
        return res.json({ success: true, ya: true, message: 'Ya estás publicado en la red.' });
    }
    if (!RED_TOKEN) {
        return res.status(400).json({ success: false, message: 'Falta AGENT_TOKEN en el .env de la app (el mismo token del hub).' });
    }
    const ruta = rutaDelAgente();
    if (!ruta) {
        return res.status(400).json({
            success: false,
            message: 'No encontré el agente. Poné AGENT_PATH en el .env apuntando a agent/comfylatam-agent.js del repo jpiassets.'
        });
    }
    try {
        const { spawn } = require('child_process');
        const hijo = spawn(process.execPath, [ruta], {
            cwd: path.dirname(path.dirname(ruta)),
            detached: true,
            stdio: 'ignore',
            env: Object.assign({}, process.env, {
                VIDEOCOMFY_HTTP: 'http://127.0.0.1:' + port,
                VIDEOCOMFY_WS: 'ws://127.0.0.1:' + port
            })
        });
        hijo.unref();
        console.log(`🔌 Agente lanzado desde la app (pid ${hijo.pid}) — ${ruta}`);
        res.json({ success: true, lanzado: true, pid: hijo.pid, agente: ruta });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- identidad del nodo: se crea una vez y queda en config-local.json ------
function leerIdentidadRedDeConfig() {
    try {
        if (!fs.existsSync(RUTA_CONFIG)) return;
        const c = JSON.parse(fs.readFileSync(RUTA_CONFIG, 'utf8'));
        if (c && c.red) {
            RED.peerId = c.red.peerId || RED.peerId;
            RED.nombre = c.red.nombre || RED.nombre;
            RED.compartir = !!c.red.compartir;
            // OJO: el nombre elegido a mano y el perfil logueado tienen que
            // sobrevivir a los reinicios, si no cada login te renombra el nodo.
            RED.nombreManual = !!c.red.nombreManual;
            RED.usuario = c.red.usuario || null;
            RED.propietario = c.red.propietario || null;
            RED.workflowsCompartidos = c.red.workflowsCompartidos || {};
            console.log(`🌎 Nodo de la red: ${RED.peerId} (${RED.nombre}) compartir=${RED.compartir}${RED.nombreManual ? ' [nombre propio]' : ''}`);
        }
    } catch (e) {
        console.warn('⚠️  No pude leer la identidad de red:', e.message);
    }
}

function asegurarIdentidadRed() {
    leerIdentidadRedDeConfig();
    if (!RED.peerId) {
        RED.peerId = process.env.RED_PEER_ID || ('nodo-' + uuidv4().slice(0, 8));
        console.log(`🌎 Nodo nuevo: ${RED.peerId}`);
    }
    if (!RED.nombre) {
        let quien = '';
        try { quien = require('os').userInfo().username || ''; } catch (e) { }
        if (!quien) quien = os.hostname();
        RED.nombre = process.env.RED_NODO_NOMBRE || (quien + ' · ComfyLatam');
    }
    if (process.env.RED_COMPARTIR !== undefined) RED.compartir = String(process.env.RED_COMPARTIR).toLowerCase() === 'true';
    guardarConfigLocal();
}
asegurarIdentidadRed();

// ---------------------------------------------------------------------------
// Salud del proceso: la app tiene que quedar VIVA (si se cae, la PC desaparece
// de la red y el usuario ve "no aparece mi máquina").
// ---------------------------------------------------------------------------
function vigilarMemoria() {
    const mb = (n) => Math.round(n / 1048576);
    setInterval(() => {
        const m = process.memoryUsage();
        const pct = Math.round((m.heapUsed / m.heapTotal) * 100);
        if (pct >= 80) {
            console.log(`⚠️  Memoria alta: heap ${mb(m.heapUsed)}/${mb(m.heapTotal)} MB (${pct}%). Si se cae, subí con --max-old-space-size=4096`);
            if (global.gc) { try { global.gc(); } catch (e) { } }
        }
    }, 120000);
    const cada = 30 * 60 * 1000;
    setInterval(() => {
        const m = process.memoryUsage();
        console.log(`🩺 memoria: heap ${mb(m.heapUsed)} MB · rss ${mb(m.rss)} MB · uptime ${Math.round(process.uptime() / 60)} min`);
    }, cada);
}
vigilarMemoria();

// Una promesa rechazada no manejada NO debe tumbar la app (mataba el nodo y la
// PC desaparecía de la red sin explicación).
process.on('unhandledRejection', (e) => {
    console.log('⚠️  Promesa rechazada sin manejar (sigo vivo):', (e && e.message) || e);
});
process.on('uncaughtException', (e) => {
    console.log('⚠️  Excepción no capturada (sigo vivo):', (e && e.message) || e);
});

// ESCUCHA: por defecto sólo en tu PC (127.0.0.1). Antes escuchaba en toda la
// red local, así que cualquier dispositivo de la misma red podía entrar.
// Si necesitás abrirla a la red, poné HOST=0.0.0.0 en el .env.
const HOST_ESCUCHA = process.env.HOST || '127.0.0.1';
server.listen(port, HOST_ESCUCHA, () => {
    console.log(`🚀 Servidor listo en http://localhost:${port}`);
    try {
        const wfs = indiceDeWorkflows();
        console.log(`🧩 Workflows indexados desde workflows/: ${wfs.length} archivo(s)`);
        wfs.filter((w) => w.enUso).forEach((w) => console.log(`   · en uso: ${w.archivo} (${w.nodos} nodos, ${w.kb} KB)`));
    } catch (e) { }

    // --- NODO DE LA RED: va DENTRO de la app, no hace falta ningún .bat ----
    // Al abrir COMFYLATAM la app se conecta sola al hub; el switch de la
    // pestaña RED sólo decide si otros pueden usar este Comfy.
    try {
        const nodo = require('./nodo.js');
        global.__comfylatamNodo = nodo.arrancar({ puerto: port, app: `http://127.0.0.1:${port}`, comfy: comfyAddress });
        console.log('🌐 Nodo de la red iniciado (embebido en la app)');
    } catch (e) {
        console.log('⚠️  No pude iniciar el nodo de la red:', e.message);
    }
});

// --- perfil del usuario logueado (local): se lo pedimos al hub -------------
// En la web el front habla directo con el hub; en local la app hace de proxy
// para que la pestaña PERFIL muestre tu ficha y tu avatar.
app.get('/api/me', async (req, res) => {
    try {
        const host = (process.env.RED_HUB || 'https://vps-4455523-x.dattaweb.com').replace(/\/+$/, '');
        const base = (process.env.RED_BASE || '/comfylatam').replace(/\/+$/, '');
        const cabeceras = { Accept: 'application/json' };
        if (req.headers.authorization) cabeceras.Authorization = req.headers.authorization;
        const r = await fetch(host + base + '/api/me', { headers: cabeceras, signal: AbortSignal.timeout(8000) });
        const texto = await r.text();
        res.status(r.status).type('application/json').send(texto);
    } catch (e) {
        res.status(502).json({ success: false, message: 'No pude consultar el perfil: ' + e.message });
    }
});

// --- proxy al hub para ranking y estadísticas (en local) -------------------
app.use(['/api/ranking', '/api/estadisticas'], async (req, res) => {
    try {
        const host = (process.env.RED_HUB || 'https://vps-4455523-x.dattaweb.com').replace(/\/+$/, '');
        const base = (process.env.RED_BASE || '/comfylatam').replace(/\/+$/, '');
        const url = host + base + req.originalUrl;
        const cabeceras = { Accept: 'application/json' };
        if (req.headers.authorization) cabeceras.Authorization = req.headers.authorization;
        const agentToken = process.env.AGENT_TOKEN || 'comfylatam-nodo-2026';
        cabeceras['x-agent-token'] = agentToken;
        const r = await fetch(url, { headers: cabeceras, signal: AbortSignal.timeout(8000) });
        const texto = await r.text();
        res.status(r.status).type('application/json').send(texto);
    } catch (e) {
        res.status(502).json({ success: false, message: 'Hub no disponible: ' + e.message });
    }
});


wss.on('connection', (ws) => {
    console.log('🔌 Cliente conectado');
    
    // Informar estado actual de ComfyUI al nuevo cliente
    const currentStatus = (wsComfy && wsComfy.readyState === 1) ? 'connected' : 'disconnected';
    console.log(`🔌 Estado entregado a nuevo cliente: ${currentStatus}`);
    ws.send(JSON.stringify({ type: 'comfy_status', status: currentStatus }));

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            if (message.type === 'request_queue_state') {
                // Send back the current prompt_ids that are being tracked by the server
                const activePromptIds = Object.keys(promptDetails).map(pid => ({
                    prompt_id: pid,
                    details: promptDetails[pid]
                }));
                ws.send(JSON.stringify({
                    type: 'queue_state',
                    activePrompts: activePromptIds,
                    comfyConnected: wsComfy && wsComfy.readyState === 1 ? true : false
                }));
                console.log(`📡 Sent queue state to reconnecting client: ${activePromptIds.length} active prompts`);
                return;
            }
            if (message.type === 'generarImagen') {
                // Que modelo pide el front: los nuevos (zimage/qwen21) van por su
                // propio workflow; si no viene nada, es el LTX de siempre (T2V/I2V).
                const modeloImagen = (message.params && message.params.modelo && MODELOS_IMAGEN[message.params.modelo])
                    ? message.params.modelo : null;
                const mode = modeloImagen ? MODELOS_IMAGEN[modeloImagen].etiqueta : (message.imageFilename ? 'I2V' : 'T2V');
                console.log(`\n🎬 [${mode}] Nueva generación recibida`);
                console.log(`   Batch   : ${message.batchName || message.batchId || 'sin batch'}`);
                console.log(`   Prompt  : ${message.prompt}`);
                console.log(`   Imagen  : ${message.imageFilename || 'ninguna'}`);
                console.log(`   Params  : steps=${message.params?.samplerSteps} cfg=${message.params?.cfgScale} size=${message.params?.videoWidth}x${message.params?.videoHeight}`);
                try {
                    const promptId = modeloImagen
                        ? await generarImagenModelo(modeloImagen, message.prompt, message.params)
                        : (message.imageFilename
                            ? await generarVideoLTX25(message.prompt, message.params, message.imageFilename)
                            : await generarVideoT2VLTX25(message.prompt, message.params));
                    console.log(`   ✅ Enviado a ComfyUI — prompt_id: ${promptId}`);
                    const details = { 
                        prompt: message.prompt,
                        params: message.params,
                        imageFilename: message.imageFilename,
                        // De dónde salió: local (esta PC) o red (un pedido que llegó del VPS)
                        origen: 'local',
                        // Quién pidió: viene en el mensaje del front (su sesión)
                        pedidoPor: datosDelPedido(message),
                        computadora: datosDeEstaPC(),
                        // 'storyboard' = imagen (asi el editor la indexa como imagen);
                        // 'video' = video. Lo lee el manejador de 'executed'.
                        type: modeloImagen ? MODELOS_IMAGEN[modeloImagen].tipoSalida : 'video',
                        modelo: modeloImagen || 'ltx2',
                        // Nombre lindo para el panel de metadata (el DATA del previz)
                        model: modeloImagen ? MODELOS_IMAGEN[modeloImagen].etiqueta : 'LTX-2.5 distilled',
                        batchId: message.batchId,
                        batchName: message.batchName,
                        generationStartTime: Date.now()
                    };
                    promptDetails[promptId] = details;
                    lastPromptDetails = details;
                    
                    // NOTIFICAR AL FRONTEND: enviar el prompt_id real de ComfyUI
                    ws.send(JSON.stringify({
                        type: 'prompt_queued',
                        prompt_id: promptId,
                        queueItemId: message.queueItemId || null
                    }));
                } catch (e) {
                    console.error(`❌ Error generando video: ${e.message}`);
                    ws.send(JSON.stringify({ type: 'generation_error', error: `❌ Error generando video: ${e.message}` }));
                }
            } else if (message.type === 'generarStoryboard') {
                const wanTag = message.isForWan ? ` [WAN2.2 ${message.wanRole} step=${message.wanStepIndex}]` : '';
                console.log(`\n🖼️ [FLUX${wanTag}] Nueva generación recibida`);
                console.log(`   Batch   : ${message.batchName || message.batchId || 'sin batch'}`);
                console.log(`   Prompt  : ${message.prompt}`);
                console.log(`   Params  : steps=${message.params?.storyboardSteps || 'default'}`);
                try {
                    const promptId = await generarStoryboard(message.prompt, message.params, message.storyboardIndex, message.batchId);
                    console.log(`   ✅ Enviado a ComfyUI — prompt_id: ${promptId}`);
                    const details = { 
                        prompt: message.prompt,
                        params: message.params,
                        type: 'storyboard',
                        storyboardIndex: message.storyboardIndex,
                        batchId: message.batchId,
                        batchName: message.batchName,
                        isForWan: message.isForWan || false,
                        wanRole: message.wanRole || null,
                        wanId: message.wanId || null,
                        wanStepIndex: message.wanStepIndex !== undefined ? message.wanStepIndex : null,
                        generationStartTime: Date.now()
                    };
                    promptDetails[promptId] = details;
                    lastPromptDetails = details;
                    
                    // NOTIFICAR AL FRONTEND: enviar el prompt_id real de ComfyUI
                    ws.send(JSON.stringify({
                        type: 'prompt_queued',
                        prompt_id: promptId,
                        queueItemId: message.queueItemId || null
                    }));
                } catch (e) {
                    console.error(`❌ Error generando storyboard: ${e.message}`);
                    ws.send(JSON.stringify({ type: 'generation_error', error: `❌ Error generando storyboard: ${e.message}` }));
                }
            } else if (message.type === 'generarWan22') {
                console.log(`\n🔥 [WAN2.2] Nueva generación recibida`);
                console.log(`   Batch   : ${message.batchName || message.batchId || 'sin batch'}`);
                console.log(`   Prompt  : ${message.prompt}`);
                console.log(`   Start   : ${message.startImageFilename || 'ninguna'}`);
                console.log(`   End     : ${message.endImageFilename || 'ninguna'}`);
                console.log(`   Params  : steps=${message.params?.samplerSteps} cfg=${message.params?.cfgScale} size=${message.params?.videoWidth}x${message.params?.videoHeight} length=${message.params?.videoLength}`);
                try {
                    const promptId = await generarWan22Video(message.prompt, message.params, message.startImageFilename, message.endImageFilename);
                    console.log(`   ✅ Enviado a ComfyUI — prompt_id: ${promptId}`);
                    const details = { 
                        prompt: message.prompt,
                        params: message.params,
                        type: 'wan22',
                        startImageFilename: message.startImageFilename,
                        endImageFilename: message.endImageFilename,
                        batchId: message.batchId,
                        batchName: message.batchName
                    };
                    promptDetails[promptId] = details;
                    lastPromptDetails = details;
                    
                    // NOTIFICAR AL FRONTEND: enviar el prompt_id real de ComfyUI
                    ws.send(JSON.stringify({
                        type: 'prompt_queued',
                        prompt_id: promptId,
                        queueItemId: message.queueItemId || null
                    }));
                } catch (e) {
                    console.error(`❌ Error generando WAN2.2 video: ${e.message}`);
                    ws.send(JSON.stringify({ type: 'generation_error', error: `❌ Error generando WAN2.2 video: ${e.message}` }));
                }
            } else if (message.type === 'generarLongCat') {
                const mode = message.imageFilename ? 'AI2V' : 'AT2V';
                console.log(`\n🐱 [LONGCAT ${mode}] Nueva generación de avatar recibida`);
                console.log(`   Prompt  : ${message.prompt}`);
                console.log(`   Audio   : ${message.audioFilename || 'ninguno'}`);
                console.log(`   Imagen  : ${message.imageFilename || 'ninguna'}`);
                console.log(`   Res     : ${message.params?.resolution || '480p'}`);
                try {
                    const result = await generarLongCat(message);
                    console.log(`   ✅ Video de avatar generado: ${result.filename}`);
                    const details = {
                        prompt: message.prompt,
                        params: message.params,
                        type: 'longcat',
                        audioFilename: message.audioFilename,
                        imageFilename: message.imageFilename,
                        batchId: message.batchId,
                        batchName: message.batchName
                    };
                    // Notificar al frontend
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'video_generated',
                                url: `/videos/${result.filename}`,
                                filename: result.filename,
                                prompt: message.prompt,
                                prompt_id: 'longcat-' + Date.now()
                            }));
                        }
                    });
                } catch (e) {
                    console.error(`❌ Error generando LongCat avatar: ${e.message}`);
                    ws.send(JSON.stringify({ type: 'generation_error', error: `❌ Error generando LongCat avatar: ${e.message}` }));
                }
            }
        } catch (e) {
            console.error('Error en mensaje de cliente:', e);
        }
    });
});

// ============================================
// FUNCIONES AUXILIARES COMFYUI
// ============================================

async function uploadImageToComfy(filePath, filename) {
    // OJO: acá estaba el bug. El paquete `form-data` de npm NO funciona como
    // body del fetch nativo (undici): lo manda como stream opaco y ComfyUI
    // (aiohttp) responde 500 "Could not find starting boundary" porque el
    // cuerpo no arranca con el boundary que declara el Content-Type.
    // Con el FormData nativo (+ Blob) undici arma el multipart bien:
    // probado 200 contra /upload/image, igual que con http.request clásico.
    const buf = await fs.promises.readFile(filePath);
    const ext = (path.extname(filename || filePath) || '.png').toLowerCase();
    const tipo = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || 'application/octet-stream';
    const formData = new FormData();
    formData.append('image', new Blob([buf], { type: tipo }), filename || path.basename(filePath));
    // fetch en vez de http.request: soporta local, red y RunPod (https) por igual
    const res = await fetch(comfyBase() + '/upload/image', { method: 'POST', body: formData });
    const texto = await res.text();
    if (!res.ok) throw new Error(`ComfyUI /upload/image respondió ${res.status}: ${texto.slice(0, 200)}`);
    try { return JSON.parse(texto); } catch (e) { return {}; }
}

async function queuePrompt(promptWorkflow) {
    const res = await fetch(comfyBase() + '/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: promptWorkflow, client_id: clientId })
    });
    const data = await res.text();
    let parsed;
    try {
        parsed = JSON.parse(data);
    } catch (e) {
        throw new Error(`Failed to parse ComfyUI response: ${e.message}. Raw: ${data.substring(0, 300)}`);
    }
    if (parsed.error) {
        const errorDetail = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error);
        const nodeErrors = parsed.node_errors ? '\nNode errors: ' + JSON.stringify(parsed.node_errors) : '';
        throw new Error(`ComfyUI rejected the prompt: ${errorDetail}${nodeErrors}`);
    }
    if (!parsed.prompt_id) {
        throw new Error(`ComfyUI returned no prompt_id. Response: ${data.substring(0, 300)}`);
    }
    return parsed.prompt_id;
}

async function downloadImage(url, targetPath) {
    // fetch: sirve igual para http local que para https (RunPod).
    // Se escribe por STREAM: antes se cargaba todo el archivo en memoria y con
    // videos grandes (30+ MB) eso infla el heap de la app.
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Status: ${res.status}`);
    const { pipeline } = require('stream/promises');
    await pipeline(res.body, fs.createWriteStream(targetPath));
}

async function generarVideo(promptText, params = {}, imageFilename = null) {
    const isI2V = !!imageFilename;
    const workflowFile = isI2V ? 'workflows/video_ltx2_i2v_api.json' : 'workflows/video_ltx2_t2v_api.json';
    const data = await fs.promises.readFile(path.join(__dirname, workflowFile), 'utf8');
    const promptWorkflow = JSON.parse(data);

    // Normalize sg_XX_ prefixed node IDs (I2V workflow from ComfyUI exports with sg_92_ prefix)
    const keys = Object.keys(promptWorkflow);
    for (const key of keys) {
        const match = key.match(/^sg_\d+_(.+)$/);
        if (match) {
            promptWorkflow[match[1]] = promptWorkflow[key];
            delete promptWorkflow[key];
        }
    }
    
    // Also normalize internal node references (e.g. ["sg_92_107", 0] -> ["107", 0])
    // ComfyUI connection arrays reference other nodes by their key, so sg_ prefixes must be stripped
    for (const [nodeKey, node] of Object.entries(promptWorkflow)) {
        if (!node || !node.inputs) continue;
        for (const [inputKey, inputVal] of Object.entries(node.inputs)) {
            if (Array.isArray(inputVal) && typeof inputVal[0] === 'string' && inputVal[0].match(/^sg_\d+_\d+$/)) {
                const m = inputVal[0].match(/^sg_\d+_(\d+)$/);
                if (m) {
                    node.inputs[inputKey][0] = m[1];
                }
            }
        }
    }

    // Configurar workflow
    if (isI2V) {
        // Validate required nodes exist (67=2nd RandomNoise, 107/108=ImgToVideo are optional)
        ['3','4','11','98','47','62','9'].forEach(n => {
            if (!promptWorkflow[n]) {
                console.error(`[I2V] NODE ${n} MISSING after normalization!`);
                console.error(`[I2V] Available keys (${Object.keys(promptWorkflow).length}):`, Object.keys(promptWorkflow).sort((a,b)=>Number(a)-Number(b)).join(', '));
                throw new Error(`Node "${n}" not found in I2V workflow after sg_ prefix normalization`);
            }
        });
        promptWorkflow["3"]["inputs"]["text"] = promptText;
        if (params.negativePrompt) promptWorkflow["4"]["inputs"]["text"] = params.negativePrompt;
        
        const seedValue = (params.seed !== undefined && params.seed !== -1) ? params.seed : Math.floor(Math.random() * 1000000000);
        promptWorkflow["11"]["inputs"]["noise_seed"] = seedValue;
        if (promptWorkflow["67"]) promptWorkflow["67"]["inputs"]["noise_seed"] = seedValue;
        
        // Note: node 98 is LoadImage in the I2V workflow
        promptWorkflow["98"]["inputs"]["image"] = imageFilename;
        
        if (params.cfgScale) promptWorkflow["47"]["inputs"]["cfg"] = params.cfgScale;
        if (params.refStrength) {
            if (promptWorkflow["107"]) promptWorkflow["107"]["inputs"]["strength"] = params.refStrength;
            if (promptWorkflow["108"]) promptWorkflow["108"]["inputs"]["strength"] = params.refStrength;
        }
    } else {
        promptWorkflow["3"]["inputs"]["text"] = promptText;
        if (params.negativePrompt) promptWorkflow["4"]["inputs"]["text"] = params.negativePrompt;

        const seedValue = (params.seed !== undefined && params.seed !== -1) ? params.seed : Math.floor(Math.random() * 1000000000);
        promptWorkflow["11"]["inputs"]["noise_seed"] = seedValue;
        if (promptWorkflow["67"]) promptWorkflow["67"]["inputs"]["noise_seed"] = seedValue;

        if (params.videoWidth) promptWorkflow["89"]["inputs"]["width"] = params.videoWidth;
        if (params.videoHeight) promptWorkflow["89"]["inputs"]["height"] = params.videoHeight;
        if (params.cfgScale) promptWorkflow["47"]["inputs"]["cfg"] = params.cfgScale;

        // SAFETY: Always fix EmptyImage batch_size=1 (workflow JSON may be corrupt)
        if (promptWorkflow["89"] && promptWorkflow["89"].inputs) {
            promptWorkflow["89"]["inputs"]["batch_size"] = 1;
            promptWorkflow["89"]["inputs"]["color"] = 0;
        }

        // SAFETY: Clamp videoLength — 169 frames max (~7s at 24fps) to prevent OOM on 24GB VRAM
        if (params.videoLength) {
            promptWorkflow["62"]["inputs"]["value"] = Math.min(params.videoLength, 169);
        } else {
            promptWorkflow["62"]["inputs"]["value"] = 97; // default safe value
        }
    }

    // --- LIMITES DE SEGURIDAD + LIBERACION DE VRAM --------------------------
    // La cadena "imagen y despues video" deja el modelo de imagen (Flux, ~17 GB)
    // cargado: si encima entra LTX-2 (~20 GB) ComfyUI MUERE con segfault (exit
    // 139) sin error legible, y el editor lo ve como "ComfyUI desconectado".
    // Solucion: pedir /free antes del video si el trabajo anterior no fue video.
    const MAX_FRAMES = 169;   // ~7 s a 24 fps: arriba de esto revienta en 24 GB
    const MAX_STEPS = 30;     // arriba de esto tambien vimos crashes
    let avisos = [];

    let frames = Number(params.videoLength) || null;
    if (frames && frames > MAX_FRAMES) {
        avisos.push(`videoLength ${frames} -> ${MAX_FRAMES} (limite seguro en 24GB)`);
        frames = MAX_FRAMES;
    }
    if (frames && promptWorkflow['62']) promptWorkflow['62']['inputs']['value'] = frames;

    let steps = Number(params.samplerSteps) || null;
    if (steps && steps > MAX_STEPS) {
        avisos.push(`samplerSteps ${steps} -> ${MAX_STEPS} (limite seguro en 24GB)`);
        steps = MAX_STEPS;
    }
    if (steps && promptWorkflow['9']) promptWorkflow['9']['inputs']['steps'] = steps;

    if (avisos.length) console.warn('⚠️  Ajustes por memoria:', avisos.join(' | '));

    if (ultimoTrabajo !== 'video') {
        console.log('🧹 Liberando VRAM antes del video (el modelo de imagen no se descarga solo)...');
        await liberarVram();
    }
    ultimoTrabajo = 'video';

    const promptId = await queuePrompt(promptWorkflow);
    console.log(`🚀 Prompt enviado a ComfyUI. ID: ${promptId}`);
    return promptId;
}

// Le pide a ComfyUI que suelte los modelos de la VRAM (y el cache).
async function liberarVram() {
    try {
        await fetch(comfyBase() + '/free', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ unload_models: true, free_memory: true })
        });
    } catch (e) {
        // si ComfyUI no está, no hay nada que liberar
    }
    await new Promise((r) => setTimeout(r, 5000));   // margen para que suelte
}

// ============================================================
// MODELOS DE IMAGEN (tarjetas nuevas del tab CREATE)
// ------------------------------------------------------------
// El front manda params.modelo = 'zimage' | 'qwen21'. Cada modelo tiene su
// workflow en formato API (mismo formato que usan los de video) y su manera
// de inyectar prompt/tamano/steps/seed.
// Antes de encolar se libera la VRAM si el trabajo anterior NO fue imagen: si
// queda cargado el modelo viejo, la suma de los dos puede tirar ComfyUI.
// ============================================================
// ============================================================
// I2V LTX 2.5 (GGUF) — workflow del escritorio adaptado a la app
// ------------------------------------------------------------
// Usa video_ltx25_i2v_api.json: UnetLoaderGGUF (Q6_K) + gemma4-12b
// + VAE 2.5 + 2 etapas de sampler (AV latent). Toggles del panel:
//   params.ltx25Enhance (bool) — TextGenerateLTX2Prompt
//   params.ltx25Upscale (bool) — LTXVLatentUpsampler x2
//   params.ltx25Audio   (bool) — decodear/embeber el audio
// Steps y CFG van FIJO (distilled usa ManualSigmas + video_cfg/audio_cfg=1).
// ============================================================
async function generarVideoLTX25(promptText, params = {}, imageFilename = null) {
    const data = await fs.promises.readFile(path.join(__dirname, 'workflows/video_ltx25_i2v_api.json'), 'utf8');
    const wf = JSON.parse(data);

    const seedValue = (params.seed !== undefined && params.seed !== -1)
        ? params.seed : Math.floor(Math.random() * 1000000000);

    const enhance = params.ltx25Enhance !== false;   // default ON
    const upscale = params.ltx25Upscale !== false;   // default ON
    const audio   = params.ltx25Audio   !== false;   // default ON

    // LTX 2.5 exige resolución en múltiplos de 32 (VAE espacial 32x)
    const round32 = (v) => Math.max(32, Math.round(v / 32) * 32);
    const W = round32(Number(params.videoWidth)  || 1280);
    const H = round32(Number(params.videoHeight) || 704);
    let frames = Number(params.videoLength) || 121;
    const MAX_FRAMES = 169;   // limite seguro
    if (frames > MAX_FRAMES) { console.warn(`⚠️  frames ${frames} -> ${MAX_FRAMES} (limite)`); frames = MAX_FRAMES; }

    const refStrength = Number(params.refStrength) || 1.0;

    // imagen de referencia
    wf['98']['inputs']['image'] = imageFilename;

    // prompt y negativo
    wf['376']['inputs']['value'] = promptText;
    if (params.negativePrompt) wf['373']['inputs']['text'] = params.negativePrompt;

    // enhance
    wf['383']['inputs']['value'] = enhance;
    wf['408']['inputs']['text'] = enhance ? ['382', 0] : promptText;

    // seed
    wf['339']['inputs']['noise_seed'] = seedValue;

    // resolucion base (con upscale se genera a la mitad y se reescala x2); base también múltiplo de 32
    wf['356']['inputs']['width']  = upscale ? round32(W / 2) : W;
    wf['356']['inputs']['height'] = upscale ? round32(H / 2) : H;
    wf['356']['inputs']['length'] = frames;
    wf['366']['inputs']['frames_number'] = frames;

    // fuerza de la imagen de referencia (etapa 1)
    wf['357']['inputs']['strength'] = refStrength;

    // routing del upscaler
    wf['349']['inputs']['latent'] = upscale ? ['348', 0] : ['367', 0];

    // audio
    if (!audio) delete wf['370']['inputs']['audio'];

    if (ultimoTrabajo !== 'video') {
        console.log('🧹 Liberando VRAM antes del video LTX 2.5...');
        await liberarVram();
    }
    ultimoTrabajo = 'video';

    const promptId = await queuePrompt(wf);
    console.log(`🚀 Prompt LTX 2.5 enviado a ComfyUI. ID: ${promptId}`);
    return promptId;
}

// ============================================================
// T2V LTX 2.5 (GGUF distilled) — mismo pipeline que el I2V pero
// SIN imagen de referencia. Workflow: video_ltx2_t2v_api.json.
// Toggles del panel: ltx25Enhance / ltx25Upscale / ltx25Audio.
// Steps y CFG van FIJO (ManualSigmas + video_cfg/audio_cfg=1).
// ============================================================
async function generarVideoT2VLTX25(promptText, params = {}) {
    const data = await fs.promises.readFile(path.join(__dirname, 'workflows/video_ltx2_t2v_api.json'), 'utf8');
    const wf = JSON.parse(data);

    const seedValue = (params.seed !== undefined && params.seed !== -1)
        ? params.seed : Math.floor(Math.random() * 1000000000);

    const enhance = params.ltx25Enhance !== false;   // default ON
    const upscale = params.ltx25Upscale !== false;   // default ON
    const audio   = params.ltx25Audio   !== false;   // default ON

    // LTX 2.5 exige resolución en múltiplos de 32 (VAE espacial 32x)
    const round32 = (v) => Math.max(32, Math.round(v / 32) * 32);
    const W = round32(Number(params.videoWidth)  || 1280);
    const H = round32(Number(params.videoHeight) || 704);
    let frames = Number(params.videoLength) || 121;
    const MAX_FRAMES = 169;   // limite seguro
    if (frames > MAX_FRAMES) { console.warn(`⚠️  frames ${frames} -> ${MAX_FRAMES} (limite)`); frames = MAX_FRAMES; }

    // prompt y negativo
    wf['376']['inputs']['value'] = promptText;
    if (params.negativePrompt) wf['373']['inputs']['text'] = params.negativePrompt;

    // enhance (Prompt Enhance del panel)
    wf['383']['inputs']['value'] = enhance;
    wf['408']['inputs']['text'] = enhance ? ['382', 0] : promptText;

    // seed
    wf['339']['inputs']['noise_seed'] = seedValue;

    // resolucion base (con upscale se genera a la mitad y se reescala x2); base también múltiplo de 32
    wf['356']['inputs']['width']  = upscale ? round32(W / 2) : W;
    wf['356']['inputs']['height'] = upscale ? round32(H / 2) : H;
    wf['356']['inputs']['length'] = frames;
    wf['366']['inputs']['frames_number'] = frames;

    // routing del upscaler (etapa 2)
    wf['340']['inputs']['video_latent'] = upscale ? ['348', 0] : ['367', 0];

    // audio
    if (!audio) delete wf['370']['inputs']['audio'];

    if (ultimoTrabajo !== 'video') {
        console.log('🧹 Liberando VRAM antes del video LTX 2.5 (T2V)...');
        await liberarVram();
    }
    ultimoTrabajo = 'video';

    const promptId = await queuePrompt(wf);
    console.log(`🚀 Prompt LTX 2.5 T2V enviado a ComfyUI. ID: ${promptId}`);
    return promptId;
}

const MODELOS_IMAGEN = {
    zimage: {
        archivo: 'workflows/z_image_turbo_api.json',
        etiqueta: 'Z-Image Turbo',
        tipoSalida: 'storyboard',            // el editor lo guarda como IMAGEN
        ayuda: 'Modelos: z_image_turbo_fp8_e4m3fn + qwen_3_4b + ae',
        aplicar(wf, prompt, params) {
            wf['6'].inputs.text = prompt;
            wf['7'].inputs.text = params.negativePrompt || '';
            // TOPE_ZIMAGE: z-image con este modelo int8 se lleva un pico de VRAM
            // que puede tumbar ComfyUI. Probado: hasta 768 px anda (512 y 768 probados OK); 1024 lo mata.
            const TOPE_ZIMAGE = 768;
            const w = Math.min(parseInt(params.videoWidth) || TOPE_ZIMAGE, TOPE_ZIMAGE);
            const h = Math.min(parseInt(params.videoHeight) || TOPE_ZIMAGE, TOPE_ZIMAGE);
            const steps = Math.min(parseInt(params.samplerSteps) || 8, 12);
            wf['13'].inputs.width = w;
            wf['13'].inputs.height = h;
            wf['3'].inputs.steps = steps;
            wf['3'].inputs.seed = (params.seed !== undefined && params.seed !== -1)
                ? Number(params.seed) : Math.floor(Math.random() * 1000000000000000);
            if (params.cfgScale) wf['3'].inputs.cfg = parseFloat(params.cfgScale);
            return { width: w, height: h, steps };
        }
    },
    qwen21: {
        archivo: 'workflows/qwen_image_21_api.json',
        etiqueta: 'Qwen-Image 2.1',
        tipoSalida: 'storyboard',
        ayuda: 'Modelos: qwen_image_2.1_Q8_0.gguf + qwen3vl_8b_int8_convrot + qwen_image_2.1_vae_bf16',
        aplicar(wf, prompt, params) {
            wf['452'].inputs.prompt = prompt;
            wf['452'].inputs.negative_prompt = params.negativePrompt || '';
            const w = parseInt(params.videoWidth) || 1024;
            const h = parseInt(params.videoHeight) || 1024;
            const steps = Math.min(parseInt(params.samplerSteps) || 25, 40);
            wf['456'].inputs.width = w;
            wf['456'].inputs.height = h;
            wf['452'].inputs.resolution = Math.max(w, h);   // como escala las referencias
            wf['458'].inputs.steps = steps;
            wf['458'].inputs.seed = (params.seed !== undefined && params.seed !== -1)
                ? Number(params.seed) : Math.floor(Math.random() * 1000000000000000);
            if (params.cfgScale) wf['458'].inputs.cfg = parseFloat(params.cfgScale);
            return { width: w, height: h, steps };
        }
    }
};

// Cuántas salidas va a producir un workflow: mira los batch_size de los nodos
// de latentes/ruido y cuántos nodos guardan imagen. Los workflows cambian, así
// que en vez de hardcodear nodos se recorre el grafo.
function cuantasSalidas(workflow) {
    let lote = 1;
    const guardan = [];
    for (const [id, nodo] of Object.entries(workflow || {})) {
        const cls = String((nodo && nodo.class_type) || '');
        const ins = (nodo && nodo.inputs) || {};
        if (ins.batch_size !== undefined) lote = Math.max(lote, Number(ins.batch_size) || 1);
        if (/SaveImage|SaveAnimatedWEBP|SaveVideo|VHS_VideoCombine/i.test(cls)) guardan.push(id);
    }
    const salidas = Math.max(1, lote) * Math.max(1, guardan.length);
    return { salidas, lote, guardan: guardan.length };
}

async function generarImagenModelo(modelo, promptText, params = {}) {
    const m = MODELOS_IMAGEN[modelo];
    if (!m) throw new Error(`Modelo de imagen desconocido: ${modelo}`);
    const ruta = path.join(__dirname, m.archivo);
    if (!fs.existsSync(ruta)) throw new Error(`Falta el workflow ${m.archivo} (${m.etiqueta})`);

    const data = await fs.promises.readFile(ruta, 'utf8');
    const promptWorkflow = JSON.parse(data);
    const info = m.aplicar(promptWorkflow, promptText, params);

    if (ultimoTrabajo !== 'imagen') {
        console.log(`🧹 Liberando VRAM antes de ${m.etiqueta} (el trabajo anterior era ${ultimoTrabajo || 'desconocido'})...`);
        await liberarVram();
    }
    ultimoTrabajo = 'imagen';

    const salidas = cuantasSalidas(promptWorkflow);
    if (salidas.salidas > 1) {
        console.log(`🎛️  Este workflow genera ${salidas.salidas} salidas (batch ${salidas.lote} x ${salidas.guardan} nodo(s) de guardado)`);
    }
    const promptId = await queuePrompt(promptWorkflow);
    console.log(`🚀 ${m.etiqueta} enviado a ComfyUI. ID: ${promptId} (${info.width}x${info.height}, ${info.steps} steps${salidas.salidas > 1 ? ', ' + salidas.salidas + ' salidas' : ''})`);
    // Se anota en el trabajo para que la cola pueda decir "1 de N"
    if (promptDetails[promptId]) {
        promptDetails[promptId].salidas = salidas.salidas;
        promptDetails[promptId].salidasHechas = 0;
    } else {
        lastPromptDetails = Object.assign({}, lastPromptDetails || {}, { salidas: salidas.salidas, salidasHechas: 0 });
    }
    return promptId;
}

async function generarStoryboard(promptText, params = {}, storyboardIndex = 0, batchId = null) {
    // El paso de imagen del storyboard y del pipeline "imagen + video" tambien
    // puede usar los modelos nuevos: si el front manda params.modelo (zimage /
    // qwen21) esa etapa va por su workflow; si no, sigue con Flux como siempre.
    if (params.modelo && MODELOS_IMAGEN[params.modelo]) {
        return generarImagenModelo(params.modelo, promptText, params);
    }

    // Usar el checkpoint fused fp8 cuando está disponible: el workflow original
    // (flux1-dev fp16 23.8GB + t5xxl fp16 9.3GB) no entra en 24GB de VRAM y
    // hace crashear ComfyUI con segfault (exit 139) al cargar el CLIP.
    const fp8File = 'workflows/flux_dev_fp8_api.json';
    const workflowFile = fs.existsSync(path.join(__dirname, fp8File))
        ? fp8File
        : 'workflows/flux_dev_full_text_to_image_api.json';
    const data = await fs.promises.readFile(path.join(__dirname, workflowFile), 'utf8');
    const promptWorkflow = JSON.parse(data);

    // Configurar workflow de Flux
    promptWorkflow["41"]["inputs"]["clip_l"] = promptText;
    promptWorkflow["41"]["inputs"]["t5xxl"] = promptText;
    promptWorkflow["31"]["inputs"]["seed"] = Math.floor(Math.random() * 1000000000000000);
    
    // Dimensiones (opcional, Flux suele ir bien en 1024)
    if (params.videoWidth) promptWorkflow["27"]["inputs"]["width"] = params.videoWidth;
    if (params.videoHeight) promptWorkflow["27"]["inputs"]["height"] = params.videoHeight;
    if (params.storyboardSteps) promptWorkflow["31"]["inputs"]["steps"] = params.storyboardSteps;
    
    const promptId = await queuePrompt(promptWorkflow);
    console.log(`🚀 Storyboard enviado a ComfyUI. ID: ${promptId}`);
    ultimoTrabajo = 'imagen';   // deja Flux en VRAM: el proximo video libera antes
    return promptId;
}

function broadcastComfyStatus(status) {
    if (!wss) {
        console.warn('⚠️ No se pudo difundir el estado: wss no está inicializado');
        return;
    }
    console.log(`📡 Difundiendo estado de ComfyUI a los clientes: ${status}`);
    wss.clients.forEach(client => {
        if (client.readyState === 1) { // 1 = OPEN
            client.send(JSON.stringify({ type: 'comfy_status', status }));
        }
    });
}

async function generarWan22Video(promptText, params = {}, startImageFilename = null, endImageFilename = null) {
    const workflowFile = 'workflows/video_wan2_2_14B_flf2v_api.json';
    const data = await fs.promises.readFile(path.join(__dirname, workflowFile), 'utf8');
    const promptWorkflow = JSON.parse(data);

    // Configurar el workflow WAN2.2
    // Texto del prompt
    promptWorkflow["90"]["inputs"]["text"] = promptText;
    
    // Configurar imágenes de inicio y fin si están disponibles
    if (startImageFilename) {
        promptWorkflow["80"]["inputs"]["image"] = startImageFilename;
    }
    if (endImageFilename) {
        promptWorkflow["89"]["inputs"]["image"] = endImageFilename;
    }
    
    // Configurar dimensiones y parámetros
    if (params.videoWidth) {
        promptWorkflow["81"]["inputs"]["width"] = params.videoWidth;
    }
    if (params.videoHeight) {
        promptWorkflow["81"]["inputs"]["height"] = params.videoHeight;
    }
    if (params.videoLength) {
        promptWorkflow["81"]["inputs"]["length"] = params.videoLength;
    }
    if (params.samplerSteps) {
        promptWorkflow["84"]["inputs"]["steps"] = params.samplerSteps;
    }
    if (params.cfgScale) {
        promptWorkflow["84"]["inputs"]["cfg"] = params.cfgScale;
    }
    
    // Seed
    const seedValue = (params.seed !== undefined && params.seed !== -1) ? params.seed : Math.floor(Math.random() * 1000000000000000);
    promptWorkflow["84"]["inputs"]["noise_seed"] = seedValue;

    const promptId = await queuePrompt(promptWorkflow);
    console.log(`🚀 WAN2.2 prompt enviado a ComfyUI. ID: ${promptId}`);
    ultimoTrabajo = 'video';
    return promptId;
}

// ============================================
// LONGCAT: Audio-Driven Avatar Generation
// ============================================

async function generarLongCat(message) {
    const { execSync } = require('child_process');
    const prompt = message.prompt || '';
    const audioFilename = message.audioFilename || '';
    const imageFilename = message.imageFilename || null;
    const resolution = message.params?.resolution || '480p';
    const useInt8 = message.params?.useInt8 !== false; // default true
    
    // Validar que tenemos audio
    if (!audioFilename) {
        throw new Error('Se requiere un archivo de audio para LongCat');
    }
    
    // Construir paths
    const audioPath = path.join(__dirname, 'public', 'uploads', audioFilename);
    let imagePath = null;
    if (imageFilename) {
        imagePath = path.join(__dirname, 'public', 'uploads', imageFilename);
    }
    
    // Verificar que existe el audio
    if (!fs.existsSync(audioPath)) {
        throw new Error(`Archivo de audio no encontrado: ${audioPath}`);
    }
    
    const outputFilename = `longcat_${Date.now()}.mp4`;
    const outputPath = path.join(__dirname, 'public', 'videos', outputFilename);
    const scriptPath = path.join(__dirname, 'tools', 'longcat_avatar.py');
    
    // Si no existe el script, crearlo (ya debería estar)
    if (!fs.existsSync(scriptPath)) {
        throw new Error(`Script LongCat no encontrado: ${scriptPath}`);
    }
    
    // Construir comando
    const mode = imageFilename ? 'ai2v' : 'at2v';
    let cmd = `"${process.execPath}" "${scriptPath}" --mode ${mode} --audio "${audioPath}" --prompt "${prompt.replace(/"/g, '\\"')}" --output "${outputPath}" --resolution ${resolution}`;
    
    if (useInt8) cmd += ' --use_int8';
    if (imagePath) cmd += ` --image "${imagePath}"`;
    
    console.log(`🐱 Ejecutando LongCat: ${cmd.substring(0, 200)}...`);
    
    // Informar inicio
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ 
                type: 'executing', 
                node: 'LongCat-Avatar',
                message: 'Generando avatar con audio... (puede tomar 5-10 minutos)'
            }));
        }
    });
    
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        
        exec(cmd, { timeout: 86400000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            
            if (error) {
                console.error(`❌ LongCat error (${elapsed}s): ${error.message}`);
                console.error(`   stderr: ${(stderr || '').substring(0, 500)}`);
                reject(new Error(`LongCat falló: ${error.message}. stderr: ${(stderr || '').substring(0, 200)}`));
                return;
            }
            
            // Intentar parsear la salida JSON
            let resultData = null;
            for (const line of stdout.split('\n')) {
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.success !== undefined) {
                        resultData = parsed;
                        break;
                    }
                } catch (e) { /* ignorar líneas que no son JSON */ }
            }
            
            console.log(`✅ LongCat completado (${elapsed}s)`);
            
            if (resultData && resultData.success) {
                // Guardar metadata
                saveVideoMetadata(outputFilename, {
                    prompt: prompt,
                    params: { resolution, mode, useInt8 },
                    type: 'longcat-avatar',
                    elapsed_seconds: elapsed
                });
                
                resolve({ filename: outputFilename });
            } else if (fs.existsSync(outputPath)) {
                // Fallback: si existe el archivo, asumimos éxito
                saveVideoMetadata(outputFilename, {
                    prompt: prompt,
                    params: { resolution, mode, useInt8 },
                    type: 'longcat-avatar',
                    elapsed_seconds: elapsed
                });
                resolve({ filename: outputFilename });
            } else {
                const errorMsg = resultData?.error || 'No se generó video';
                console.error(`❌ LongCat: ${errorMsg}`);
                reject(new Error(errorMsg));
            }
        });
    });
}

// ============================================
// PRESETS API (Save/Load per-workflow presets)
// ============================================
const PRESETS_DIR = path.join(__dirname, 'public', 'presets');
if (!fs.existsSync(PRESETS_DIR)) fs.mkdirSync(PRESETS_DIR, { recursive: true });

// GET /api/presets/:workflow — list all presets for a workflow
app.get('/api/presets/:workflow', (req, res) => {
    const { workflow } = req.params;
    const wfDir = path.join(PRESETS_DIR, workflow);
    if (!fs.existsSync(wfDir)) return res.json([]);
    try {
        const files = fs.readdirSync(wfDir)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                const name = f.replace(/\.json$/, '');
                const fullPath = path.join(wfDir, f);
                const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
                return { name, ...data, _path: fullPath };
            })
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        res.json(files);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/presets/:workflow — save a new preset
app.post('/api/presets/:workflow', (req, res) => {
    try {
        const { workflow } = req.params;
        const { name, label, data } = req.body;
        if (!name || !data) return res.status(400).json({ error: 'name and data required' });
        
        const wfDir = path.join(PRESETS_DIR, workflow);
        if (!fs.existsSync(wfDir)) fs.mkdirSync(wfDir, { recursive: true });
        
        const safeName = name.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
        if (!safeName) return res.status(400).json({ error: 'Invalid preset name' });
        
        const presetPath = path.join(wfDir, `${safeName}.json`);
        const preset = {
            label: label || safeName,
            data,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        fs.writeFileSync(presetPath, JSON.stringify(preset, null, 2));
        
        console.log(`💾 Preset saved: ${workflow}/${safeName}`);
        res.json({ success: true, name: safeName });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/presets/:workflow/:name — delete a preset
app.delete('/api/presets/:workflow/:name', (req, res) => {
    try {
        const { workflow, name } = req.params;
        const safeName = name.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
        const presetPath = path.join(PRESETS_DIR, workflow, `${safeName}.json`);
        if (fs.existsSync(presetPath)) {
            fs.unlinkSync(presetPath);
            console.log(`🗑️ Preset deleted: ${workflow}/${safeName}`);
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Preset not found' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Iniciar conexión con ComfyUI una vez que el servidor está listo
connectToComfy();

