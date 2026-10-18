// ============================================================
// COMFYLATAM - NODO EMBEBIDO
// ------------------------------------------------------------
// Va DENTRO de la app: no hace falta ningún .bat aparte. Cuando el server
// arranca (server.js) este módulo se conecta solo al hub de la red.
//
//   app local (:5634)  ──socket.io──▶  hub (VPS)  ◀──  navegadores
//
// La PC sale hacia afuera: no se abre ningún puerto. El puente lo hace esta
// app; el navegador web nunca habla directo con tu máquina.
// Compartir el Comfy es OPCIONAL y se maneja con el switch (pestaña RED).
// ============================================================
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const TOKEN_PUBLICO = 'comfylatam-nodo-2026';

function leerEnv(clave, porDefecto) {
    if (process.env[clave]) return process.env[clave];
    try {
        const archivo = path.join(__dirname, '.env');
        if (fs.existsSync(archivo)) {
            for (const linea of fs.readFileSync(archivo, 'utf8').split(/\r?\n/)) {
                const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
                if (m && m[1].toUpperCase() === clave.toUpperCase()) return m[2].replace(/^["']|["']$/g, '');
            }
        }
    } catch (e) { }
    return porDefecto;
}

function arrancar(opciones) {
    const op = opciones || {};

    // Esta app usa fetch/Blob/FormData nativos: necesita Node 18 o más.
    const mayor = Number(String(process.versions.node).split('.')[0]);
    if (mayor < 18) {
        console.log('❌ NODE_VIEJO: tenés Node ' + process.versions.node + ' y se necesita 18 o superior.');
        console.log('   Instalá Node LTS desde nodejs.org y volvé a correr la app.');
        return null;
    }

    const { io } = (() => { try { return require('socket.io-client'); } catch (e) { return {}; } })();
    if (!io) {
        console.log('⚠️  Nodo: falta socket.io-client (npm i socket.io-client) — no me conecto a la red.');
        return null;
    }
    let WebSocket = null;
    try { WebSocket = require('ws'); } catch (e) { }

    const APP = (op.app || 'http://127.0.0.1:' + (op.puerto || 5634)).replace(/\/+$/, '');
    const APP_WS = APP.replace(/^http/, 'ws');

    const CFG = {
        HUB: (op.hub || leerEnv('RED_HUB', 'https://vps-4455523-x.dattaweb.com')).replace(/\/+$/, ''),
        BASE: op.base || leerEnv('RED_BASE', '/comfylatam'),
        TOKEN: op.token || leerEnv('AGENT_TOKEN', TOKEN_PUBLICO),
        COMFY: (leerEnv('COMFY_HTTP', '') || op.comfy || '').replace(/\/+$/, ''),
        PRINCIPAL: String(leerEnv('RED_PRINCIPAL', op.principal ? 'true' : 'false')).toLowerCase() === 'true',
        RECONEXION_MS: Number(leerEnv('RED_RECONEXION_MS', '5000'))
    };

    const log = (...a) => console.log('[nodo]', ...a);
    const logErr = (...a) => console.log('[nodo]', ...a);

    let ws = null;
    let socket = null;
    let colaSalida = [];
    let gpuDetectada = process.env.NODO_GPU || '';
    let estVideocomfy = false;
    let estComfy = 'desconocido';
    let ultimoComfyCheck = 0;
    let encolados = 0;
    let ultimoConectado = false;

    const identidad = { peerId: os.hostname(), nombre: os.hostname(), compartir: false, modelos: [], usuario: null, workflows: [] };

    // ------------------------------ utilidades ------------------------------
    async function pedir(ruta, opciones) {
        const r = await fetch(APP + ruta, Object.assign({ signal: AbortSignal.timeout(5000) }, opciones || {}));
        return r;
    }

    async function leerIdentidad() {
        try {
            const r = await pedir('/api/red/estado');
            if (!r.ok) return false;
            const d = await r.json();
            const antes = identidad.peerId + '|' + identidad.nombre + '|' + identidad.compartir;
            identidad.peerId = String(d.peerId || identidad.peerId);
            identidad.nombre = String(d.nombre || identidad.nombre);
            identidad.compartir = !!d.compartir;
            identidad.modelos = Array.isArray(d.modelos) ? d.modelos : identidad.modelos;
            identidad.usuario = d.usuario || identidad.usuario || null;
            identidad.workflows = Array.isArray(d.workflows) ? d.workflows : (identidad.workflows || []);
            if (!CFG.COMFY && d.comfyAddress) CFG.COMFY = String(d.comfyAddress).replace(/\/+$/, '');
            return antes !== (identidad.peerId + '|' + identidad.nombre + '|' + identidad.compartir);
        } catch (e) { return false; }
    }

    async function detectarGpu() {
        if (gpuDetectada) return;
        try {
            const { execFile } = require('child_process');
            const bin = process.platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi';
            execFile(bin, ['--query-gpu=name', '--format=csv,noheader'], { timeout: 8000 }, (err, out) => {
                if (err || !out) return;
                gpuDetectada = String(out).split('\n')[0].trim().slice(0, 60);
                log('🎮 GPU:', gpuDetectada);
                if (socket && socket.connected) { socket.disconnect(); socket.connect(); }
            });
        } catch (e) { }
    }

    function enviarEstado() {
        if (!socket || !socket.connected) return;
        socket.emit('tunnel:estado', {
            videocomfy: !!estVideocomfy,
            comfy: estComfy === 'connected',
            comfyTexto: estComfy,
            host: os.hostname(),
            encolados,
            compartir: identidad.compartir,
            // workflows que ofrece a la red (los que comparte y tiene instalados)
            workflows: identidad.workflows || [],
            ts: Date.now()
        });
    }

    // La dirección puede venir como "127.0.0.1", "127.0.0.1:8188" o una URL
    // completa (RunPod): la normalizamos para poder pegarle a /system_stats.
    function urlComfy() {
        let b = String(CFG.COMFY || process.env.COMFYUI_ADDRESS || '127.0.0.1').trim().replace(/\/+$/, '');
        if (!/^https?:\/\//i.test(b)) b = 'http://' + b;
        if (!/:[0-9]+$/.test(b.replace(/^https?:\/\//i, '')) && !/runpod|proxy/i.test(b)) b = b + ':8188';
        return b;
    }

    async function chequearComfy(desdeWebsocket) {
        if (desdeWebsocket) return;
        if (Date.now() - ultimoComfyCheck < 10000) return;
        ultimoComfyCheck = Date.now();
        const base = urlComfy();
        try {
            const r = await fetch(base + '/system_stats', { signal: AbortSignal.timeout(5000) });
            const nuevo = r.ok ? 'connected' : 'disconnected';
            if (nuevo !== estComfy) { estComfy = nuevo; enviarEstado(); }
        } catch (e) {
            if (estComfy !== 'disconnected') { estComfy = 'disconnected'; enviarEstado(); }
        }
    }

    async function refrescarEncolados() {
        try {
            const r = await pedir('/api/status');
            if (!r.ok) return;
            const d = await r.json();
            const n = Number(d.encolados || 0);
            if (n !== encolados) { encolados = n; enviarEstado(); }
        } catch (e) { }
    }

    // --------------------------- socket.io al hub ---------------------------
    function conectarHub() {
        log(`🔌 conectando a ${CFG.HUB}/agent (${CFG.BASE}/socket.io) como "${identidad.peerId}"`);
        socket = io(CFG.HUB + '/agent', {
            path: CFG.BASE + '/socket.io',
            auth: (cb) => cb({
                token: CFG.TOKEN,
                peerId: identidad.peerId,
                nombre: identidad.nombre,
                host: os.hostname(),
                principal: CFG.PRINCIPAL,
                compartir: identidad.compartir
            }),
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionDelay: CFG.RECONEXION_MS,
            reconnectionDelayMax: 15000
        });

        socket.on('connect', async () => {
            log('═'.repeat(62));
            log('✅ CONECTADO AL VPS (hub de la red COMFYLATAM)');
            log(`   hub: ${CFG.HUB}${CFG.BASE} · socket.io namespace /agent`);
            log(`   esta PC: ${identidad.nombre} (${identidad.peerId})`);
            log('═'.repeat(62));
            ultimoConectado = true;
            await leerIdentidad().catch(() => { });
            socket.emit('agent:hello', {
                peerId: identidad.peerId,
                nombre: identidad.nombre,
                host: os.hostname(),
                platform: os.platform() + ' ' + os.release(),
                gpu: gpuDetectada,
                modelos: identidad.modelos,
                principal: CFG.PRINCIPAL,
                compartir: identidad.compartir,
                avatar: (identidad.usuario && identidad.usuario.avatar) || '',
                usuario: (identidad.usuario && (identidad.usuario.username || identidad.usuario.displayName)) || '',
                email: (identidad.usuario && identidad.usuario.email) || identidad.email || '',
                avatar: (identidad.usuario && identidad.usuario.avatar) || '',
                version: '2.0.0',
                videocomfyUrl: APP
            });
            chequearComfy().catch(() => { });
            enviarEstado();
            refrescarEncolados();
        });

        let intentos = 0;
        socket.on('connect_error', (e) => {
            intentos++;
            const msg = String((e && e.message) || '');
            if (intentos === 1 || intentos % 6 === 0) {
                logErr(`⚠️  no pude conectar al VPS (intento ${intentos}): ${msg}`);
                if (/token/i.test(msg)) {
                    logErr('   ↳ El token del nodo no coincide con el del hub.');
                    logErr('     · Si clonaste el repo: revisá que AGENT_TOKEN en .env sea el público (comfylatam-nodo-2026) o no definas .env.');
                    logErr('     · Si sos el dueño: poné el AGENT_TOKEN privado del VPS en el .env de la app.');
                } else if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network/i.test(msg)) {
                    logErr('   ↳ No hay salida a internet (o un firewall bloquea wss). Sin internet la PC no se publica: la app sale a buscar el hub.');
                }
            }
        });
        socket.io.on('reconnect_attempt', (n) => log(`🔁 reintentando conectar al VPS (${n})...`));
        socket.on('disconnect', (m) => {
            ultimoConectado = false;
            log(`🔌 DESCONECTADO DEL VPS (${m}) — reintento automático en ${Math.round(CFG.RECONEXION_MS / 1000)}s`);
        });

        // trabajo que llega de la red: se encola en la app local
        socket.on('red:job', async (job) => {
            if (!job || !job.jobId) return;
            const quien = (job.pedidoPor && (job.pedidoPor.displayName || job.pedidoPor.usuario)) || job.de || '?';
            log('─'.repeat(62));
            log(`🎯 EL VPS ME MANDÓ UN TRABAJO de @${quien} (${(job.pedidoPor && job.pedidoPor.tipo) || 'web'})`);
            log(`   prompt: ${String(job.prompt || '').slice(0, 70)}`);
            log(`   modelo: ${job.modelo || 'auto'} · jobId ${job.jobId || '?'}`);
            try {
                const r = await fetch(APP + '/api/red/job', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job)
                });
                const d = await r.json().catch(() => ({}));
                if (!r.ok || d.success === false) throw new Error(d.message || ('HTTP ' + r.status));
                socket.emit('red:job:estado', { jobId: job.jobId, evento: 'inicio' });
                encolados++;
                enviarEstado();
            } catch (e) {
                console.log(`[túnel] ✗ error ${r.ruta}: ${e.message}`);
                logErr('   ❌ no pude encolarlo:', e.message);
                socket.emit('red:job:estado', { jobId: job.jobId, evento: 'error', error: e.message });
            }
        });

        socket.on('red:compartir', async ({ compartir } = {}) => {
            try {
                await fetch(APP + '/api/red/compartir', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ compartir: !!compartir, desdeHub: true })
                });
            } catch (e) { }
            identidad.compartir = !!compartir;
            enviarEstado();
        });

        socket.on('red:clientes', (d = {}) => {
            fetch(APP + '/api/red/clientes', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d || {})
            }).catch(() => { });
        });

        socket.on('red:peers', (d = {}) => {
            fetch(APP + '/api/red/nodos', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d || {})
            }).catch(() => { });
        });

        socket.on('red:evento', (d = {}) => {
            // Si el evento lo generó este mismo nodo, no re-inyectarlo
            if (d && d.peerId && d.peerId === identidad.peerId) return;

            // Si data ya viene corrupto / anidado por rebote previo, descartarlo
            if (d && typeof d.data === 'string' && (d.data.includes('"red_evento"') || d.data.startsWith('<recortado'))) return;

            // Los eventos traen la imagen/video del resultado en base64 (megas):
            // la app local los rechaza (413) y el panel se queda sin novedades.
            // Recortamos cualquier string grande de forma RECURSIVA (una imagen
            // puede venir como campo suelto, no sólo como data:URL).
            const LIMITE = 20000;
            function aligerar(v, prof) {
                prof = prof || 0;
                if (typeof v === 'string') return v.length > LIMITE ? '<recortado ' + v.length + ' chars>' : v;
                if (Array.isArray(v)) return v.slice(0, 60).map((x) => aligerar(x, prof + 1));
                if (v && typeof v === 'object') {
                    if (prof > 6) return '<profundo>';
                    const o = {};
                    for (const k of Object.keys(v)) o[k] = aligerar(v[k], prof + 1);
                    return o;
                }
                return v;
            }
            const cuerpo = aligerar(d || {});
            fetch(APP + '/api/red/evento', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo)
            }).catch(() => { });
        });

        // relay
        socket.on('tunnel:ws:frame', ({ data } = {}) => {
            if (data == null) return;
            if (ws && ws.readyState === 1) ws.send(data);
            else { colaSalida.push(data); if (colaSalida.length > 100) colaSalida.shift(); }
        });
        socket.on('tunnel:ws:open', () => { if (!ws || ws.readyState !== 1) conectarApp(); });
        socket.on('tunnel:ws:close', () => { });

        socket.on('tunnel:http', async (r) => {
            if (!r || !r.reqId) return;

            // ---------------------------------------------------------------
            // SEGURIDAD: lo que llega por acá viene de la WEB (internet).
            // Puede pedir generaciones y ver el estado, pero NO puede tocar
            // la configuración de esta PC ni disparar acciones peligrosas.
            // El túnel sólo apunta a la app (127.0.0.1:5634), nunca a ComfyUI.
            // ---------------------------------------------------------------
            const RUTAS_PROHIBIDAS = [
                /^\/api\/config/i,                       // cambiar a qué ComfyUI apunta
                // /api/comfy/cola/limpiar SÍ se permite: es el botón "Vaciar cola"
                // del panel de STAGE, y desde la web quedaba bloqueado sin avisar.
                /^\/api\/actualizar/i,                    // traer código nuevo (git pull)
                /^\/api\/generate-avatar/i,               // escribía archivos
                /^\/api\/red\/(agente|nodos|perfil|job)/i, // identidad y trabajos internos
                /^\/api\/(mo|entorno|salud-memoria)/i
            ];
            // Excepciones: /api/motor/* es la ventana al estado del motor y la
            // precarga (LOAD MODELS). El filtro de arriba lo atrapaba con el
            // prefijo "mo" y desde la web daba 403. Sólo estas dos.
            const RUTAS_PERMITIDAS = [
                /^\/api\/motor\/estado-modelos/i,
                /^\/api\/motor\/precargar/i
            ];
            const ruta = String(r.ruta || '/');
            // Sólo se bloquean las ESCRITURAS: leer configuración es inofensivo
            // y el panel de la web lo necesita para mostrar el estado.
            const esEscritura = !['GET', 'HEAD'].includes(String(r.method || 'GET').toUpperCase());
            if (esEscritura && RUTAS_PROHIBIDAS.some((rx) => rx.test(ruta)) && !RUTAS_PERMITIDAS.some((rx) => rx.test(ruta))) {
                console.log(`⛔ [túnel] pedido de la web BLOQUEADO por seguridad: ${r.method || 'GET'} ${ruta}`);
                // (acá se logueaba buf.length, que todavía no existe: rompía el 403)
                socket.emit('tunnel:http:result', {
                    reqId: r.reqId, status: 403, contentType: 'application/json',
                    headers: {}, body: Buffer.from(JSON.stringify({
                        success: false, message: 'Ese endpoint no está disponible desde la web (sólo desde esta PC).'
                    }))
                });
                return;
            }

            const url = APP + (r.ruta || '/') + (r.query ? '?' + r.query : '');
            console.log(`[túnel] ← ${r.method || 'GET'} ${r.ruta} (desde la web)`);
            const sinCuerpo = r.method === 'GET' || r.method === 'HEAD';
            try {
                const headers = {};
                if (r.contentType) headers['Content-Type'] = r.contentType;
                if (r.range) headers['Range'] = r.range;
                // La sesión del usuario llega desde el hub: se la pasamos a la
                // app local tal cual (así la web ve listas, perfil y avatar).
                if (r.authorization) headers['Authorization'] = r.authorization;
                // Marca de origen: el server la usa para decidir si devuelve la URL
                // de Cloudflare (pedido de la web) o la ruta local (pedido de esta PC).
                headers['X-FSC-Origen'] = 'web';
                if (r.cookie) headers['Cookie'] = r.cookie;
                // Timeout: si la app local no contesta, se corta y se avisa (si no,
                // el pedido que viene de la web quedaba colgado para siempre.
                // Timeout: si la app local no contesta, se corta y se avisa.
                const resp = await fetch(url, {
                    method: r.method || 'GET', headers,
                    body: sinCuerpo ? undefined : (r.body ? Buffer.from(r.body) : undefined),
                    signal: AbortSignal.timeout(12000)
                });
                console.log(`[túnel] fetch OK ${r.ruta} -> ${resp.status}`);
                const ct = resp.headers.get('content-type') || '';
                const largo = Number(resp.headers.get('content-length') || 0);
                const cabeceras = {
                    'Content-Range': resp.headers.get('content-range') || '',
                    'Accept-Ranges': resp.headers.get('accept-ranges') || '',
                    'Content-Length': resp.headers.get('content-length') || ''
                };

                // MEDIA: se manda en pedazos, NUNCA entera en un solo mensaje.
                // Antes iba todo en un mensaje (y en base64): un video de 1 GB
                // ocupaba ~1.3 GB de RAM en el VPS y lo colgaba. Ahora el hub
                // recibe pedazos de 512 KB y los escribe directo al navegador.
                const esMedia = /^(video|audio|image)\//i.test(ct)
                    || /octet-stream/i.test(ct)
                    || largo > 1500000;
                if (esMedia && resp.body && resp.body.getReader) {
                    socket.emit('tunnel:http:meta', { reqId: r.reqId, status: resp.status, contentType: ct, headers: cabeceras });
                    const reader = resp.body.getReader();
                    let enviados = 0;
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        if (value && value.length) {
                            socket.emit('tunnel:http:chunk', { reqId: r.reqId, chunk: Buffer.from(value) });
                            enviados += value.length;
                        }
                    }
                    socket.emit('tunnel:http:fin', { reqId: r.reqId, bytes: enviados });
                    return;
                }

                const buf = Buffer.from(await resp.arrayBuffer());
                socket.emit('tunnel:http:result', {
                    reqId: r.reqId,
                    status: resp.status,
                    contentType: ct,
                    headers: cabeceras,
                    body: buf
                });
            } catch (e) {
                socket.emit('tunnel:http:result', {
                    reqId: r.reqId, status: 502, contentType: 'application/json',
                    body: Buffer.from(JSON.stringify({ success: false, error: 'app local: ' + e.message }))
                });
            }
        });
    }

    // -------------------- websocket local (frames al hub) -------------------
    function conectarApp() {
        if (!WebSocket) return;
        try { ws = new WebSocket(APP_WS); } catch (e) { return setTimeout(conectarApp, CFG.RECONEXION_MS); }

        ws.on('open', () => {
            estVideocomfy = true;
            chequearComfy().catch(() => { });
            enviarEstado();
            while (colaSalida.length) {
                const f = colaSalida.shift();
                try { ws.send(f); } catch (e) { }
            }
        });

        ws.on('message', (raw) => {
            const texto = raw.toString();
            let m = null;
            try { m = JSON.parse(texto); } catch (e) { }

            // NUNCA reenviar mensajes internos de la red al hub (evita loops de rebote)
            if (m && typeof m.type === 'string' && m.type.startsWith('red_')) return;

            if (socket && socket.connected) socket.emit('tunnel:ws:broadcast', { data: texto });
            try {
                if (m && m.type === 'comfy_status' && m.status) {
                    const nuevo = m.status === 'connected' ? 'connected' : 'disconnected';
                    if (nuevo !== estComfy) { estComfy = nuevo; enviarEstado(); }
                    return;
                }
                if (m && (m.type === 'storyboard_generated' || m.type === 'video_generated')) {
                    if (socket && socket.connected) socket.emit('red:job:estado', { evento: 'fin' });
                    if (encolados > 0) encolados--;
                    enviarEstado();
                }
            } catch (e) { }
        });

        ws.on('close', () => {
            estVideocomfy = false;
            enviarEstado();
            setTimeout(conectarApp, CFG.RECONEXION_MS);
        });
        ws.on('error', () => { });
    }

    // ------------------------------- arranque -------------------------------
    setInterval(async () => {
        chequearComfy().catch(() => { });
        const cambio = await leerIdentidad().catch(() => false);
        if (cambio && socket && socket.connected) { socket.disconnect(); socket.connect(); }
        enviarEstado();
    }, 15000);

    setInterval(() => { refrescarEncolados(); }, 8000);

    (async () => {
        await leerIdentidad().catch(() => { });
        log(`nodo "${identidad.nombre}" → hub ${CFG.HUB}${CFG.BASE} · app ${APP}${CFG.PRINCIPAL ? ' [principal]' : ''}`);
        detectarGpu().catch(() => { });
        conectarHub();
        conectarApp();
    })();

    return {
        estado: () => ({ conectado: ultimoConectado, peerId: identidad.peerId, nombre: identidad.nombre, comfy: estComfy, compartir: identidad.compartir }),
        reconectar: () => { try { socket.disconnect(); socket.connect(); } catch (e) { } },
        // Empujar YA el estado al hub (lo usa la app cuando cambian los workflows
        // compartidos, para que la web se entere sin esperar los 15 s).
        avisar: () => { try { leerIdentidad().then(() => enviarEstado()).catch(() => enviarEstado()); } catch (e) { } }
    };
}

module.exports = { arrancar, TOKEN_PUBLICO };
