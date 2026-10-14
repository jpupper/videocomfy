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

    const identidad = { peerId: os.hostname(), nombre: os.hostname(), compartir: false, modelos: [], usuario: null };

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
            log('✅ conectado a la red COMFYLATAM');
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
                version: '2.0.0',
                videocomfyUrl: APP
            });
            chequearComfy().catch(() => { });
            enviarEstado();
            refrescarEncolados();
        });

        socket.on('connect_error', (e) => logErr('⚠️  sin conexión al hub:', e.message));
        socket.on('disconnect', (m) => { ultimoConectado = false; log('🔌 desconectado del hub:', m); });

        // trabajo que llega de la red: se encola en la app local
        socket.on('red:job', async (job) => {
            if (!job || !job.jobId) return;
            log(`🎯 trabajo de ${job.de || '?'}: ${String(job.prompt || '').slice(0, 50)}`);
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

        socket.on('red:peers', (d = {}) => {
            fetch(APP + '/api/red/nodos', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d || {})
            }).catch(() => { });
        });

        socket.on('red:evento', (d = {}) => {
            // Los eventos pueden traer la imagen del resultado en base64 (megas):
            // le sacamos lo pesado — el panel sólo necesita saber qué pasó.
            let cuerpo = d || {};
            try {
                const texto = JSON.stringify(cuerpo);
                if (texto.length > 400000) {
                    cuerpo = JSON.parse(texto.replace(/"data:image\/[^"]{2000,}"/g, '"<imagen omitida>"'));
                }
            } catch (e) { cuerpo = { tipo: (d && d.tipo) || 'evento', grande: true }; }
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
            const url = APP + (r.ruta || '/') + (r.query ? '?' + r.query : '');
            const sinCuerpo = r.method === 'GET' || r.method === 'HEAD';
            try {
                const headers = {};
                if (r.contentType) headers['Content-Type'] = r.contentType;
                if (r.range) headers['Range'] = r.range;
                const resp = await fetch(url, {
                    method: r.method || 'GET', headers,
                    body: sinCuerpo ? undefined : (r.body ? Buffer.from(r.body) : undefined)
                });
                const buf = Buffer.from(await resp.arrayBuffer());
                socket.emit('tunnel:http:result', {
                    reqId: r.reqId,
                    status: resp.status,
                    contentType: resp.headers.get('content-type') || '',
                    headers: {
                        'Content-Range': resp.headers.get('content-range') || '',
                        'Accept-Ranges': resp.headers.get('accept-ranges') || '',
                        'Content-Length': resp.headers.get('content-length') || ''
                    },
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
            if (socket && socket.connected) socket.emit('tunnel:ws:broadcast', { data: texto });
            try {
                const m = JSON.parse(texto);
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
        reconectar: () => { try { socket.disconnect(); socket.connect(); } catch (e) { } }
    };
}

module.exports = { arrancar, TOKEN_PUBLICO };
