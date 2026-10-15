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
                nombreManual: RED.nombreManual, usuario: RED.usuario, propietario: RED.propietario
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
                    // Las generaciones viejas se anotaron con el usuario global de
                    // la app (bug): si no tienen 'tipo', la atribución no es segura.
                    certero: !!pp.tipo,
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
                    enUso: Object.values(MODELOS_IMAGEN).some((m) => m.archivo === 'workflows/' + f)
                        || ['video_ltx2_t2v_api.json', 'video_ltx2_i2v_api.json', 'flux_dev_fp8_api.json',
                            'flux_dev_full_text_to_image_api.json', 'video_wan2_2_14B_flf2v_api.json']
                           .some((x) => x === f)
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
            // Manejar posibles datos binarios (imágenes de preview)
            if (data instanceof Buffer === false && typeof data !== 'string') {
                return;
            }

            const messageString = data.toString();
            // Log solo si no es binario y no es demasiado ruidoso
            if (messageString.length < 1000) {
                console.log('📩 Mensaje de ComfyUI:', messageString);
            }

            const message = JSON.parse(messageString);

            // Enviar progreso al cliente
            if (message.type === 'progress') {
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'progress',
                            value: message.data.value,
                            max: message.data.max
                        }));
                    }
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
                    metadata: meta.params || {}
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
                    metadata: meta.params || {}
                };
            })
            .sort((a, b) => b.timestamp - a.timestamp);
        res.json(videoFiles);
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
    nombreManual: false,
    clientes: null,
    enVuelo: 0,
    hub: RED_HUB + RED_BASE
};

// Modelos que este nodo puede ofrecer a la red.
function modelosDeLaRed() {
    return Object.keys(MODELOS_IMAGEN).map((k) => ({
        id: k,
        nombre: MODELOS_IMAGEN[k].etiqueta,
        tipo: MODELOS_IMAGEN[k].tipoSalida === 'storyboard' ? 'imagen' : 'video'
    })).concat([{ id: 'ltx2', nombre: 'LTX-2 (video)', tipo: 'video' }]);
}

function estadoRed() {
    return {
        peerId: RED.peerId,
        nombre: RED.nombre,
        compartir: RED.compartir,
        modelos: modelosDeLaRed(),
        usuario: RED.usuario,
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
    console.log(`👥 Del hub: ${RED.clientes.total} cliente(s) — ${RED.clientes.web} web · ${RED.clientes.local} local · ${RED.clientes.usuariosTotal} usuario(s)`);
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
        avatar: pr.avatar || u.avatar || ''
    };
}

async function encolarTrabajoRed(b) {
    const prompt = String((b && b.prompt) || '').trim();
    if (!prompt) throw new Error('El trabajo no trae prompt.');

    const params = Object.assign({
        videoWidth: 1024, videoHeight: 1024, samplerSteps: 10, seed: -1
    }, (b && b.params) || {});
    const modelo = (b.modelo && MODELOS_IMAGEN[b.modelo]) ? b.modelo
        : (String((b && b.tipo) || '').toLowerCase() === 'video' ? null : 'zimage');

    await liberarVram().catch(() => { });
    const promptId = modelo
        ? await generarImagenModelo(modelo, prompt, params)
        : await generarVideo(prompt, params, b && b.imagen);

    // Quién lo pidió: si viene de la red, el hub manda pedidoPor; si es local,
    // es el usuario logueado en esta PC (o "vos").
    const pedidoPor = datosDelPedido(b);
    const details = {
        prompt,
        params,
        type: modelo ? MODELOS_IMAGEN[modelo].tipoSalida : 'video',
        modelo: modelo || 'ltx2',
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
            avatar: RED.usuario.avatar || ''
        };
        console.log(`🔑 Dueño de esta computadora: ${RED.propietario.displayName} (@${RED.propietario.usuario})`);
    }
    if (b.propietario === true && RED.usuario.username) {
        RED.propietario = {
            usuario: RED.usuario.username,
            displayName: RED.usuario.displayName || RED.usuario.username,
            avatar: RED.usuario.avatar || ''
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

server.listen(port, () => {
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
                        : await generarVideo(message.prompt, message.params, message.imageFilename);
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
const MODELOS_IMAGEN = {
    zimage: {
        archivo: 'workflows/z_image_turbo_api.json',
        etiqueta: 'Z-Image Turbo',
        tipoSalida: 'storyboard',            // el editor lo guarda como IMAGEN
        ayuda: 'Modelos: z_image_turbo_int8_convrot + qwen_3_4b + ae',
        aplicar(wf, prompt, params) {
            wf['6'].inputs.text = prompt;
            wf['7'].inputs.text = params.negativePrompt || '';
            const w = parseInt(params.videoWidth) || 1024;
            const h = parseInt(params.videoHeight) || 1024;
            const steps = Math.min(parseInt(params.samplerSteps) || 10, 30);
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

