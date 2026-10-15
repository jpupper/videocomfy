// ============================================================
// comfylatam - VideoComfy Studio en la web (ecosistema FSC)
// ------------------------------------------------------------
// Sirve el editor (el mismo front de videocomfy) y RELAYEA todo hacia
// el videocomfy que corre en la PC de Julián, a traves del agente
// (socket.io, namespace /agent). El VPS no genera ni guarda binarios.
//
//   navegador  <->  comfylatam (VPS :8086)  <->  agente local  <->  videocomfy :5634
//                        |                                        (ComfyUI :8188)
//                        +-- /ws        websocket crudo del editor
//                        +-- /api/*     API del editor
//                        +-- /uploads|videos|audio/*   archivos
//
//   PORT      = 8086
//   BASE_PATH = /comfylatam
// ============================================================
require('dotenv').config();

const express = require('express');
const app = express();
const http = require('http');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');
const { WebSocketServer } = require('ws');

const relay = require('./lib/relay');
const jwt = require('jsonwebtoken');

// ============================================================
// SESIÓN FSC (login de fullscreencode)
// ------------------------------------------------------------
// La versión WEB tiene que usarse logueado con la cuenta de
// fullscreencode: los tokens los emite fscauth, firmados con el
// JWT_SECRET compartido, así que se validan acá sin llamada extra.
//   - El token llega por header Authorization: Bearer ... (el front lo
//     agrega a los fetch), por cookie fsc_token, o por ?token= (websocket).
//   - La MEDIA (/uploads|/videos|/audio) queda pública a propósito: los
//     <img>/<video> del editor no pueden mandar headers.
//   - JPI_AUTH_OFF=1 apaga el control (solo para pruebas locales).
// ============================================================
const JWT_SECRET = process.env.JWT_SECRET || '';
// FSC_AUTH_API: aceptar las dos formas que hay en el ecosistema
// (".../fscauth" y ".../fscauth/api", incluida la interna
// http://localhost:3027/fscauth del VPS) y descartar valores corruptos
// (pasó: el .env traía literalmente "https:...auth").
function baseDeFscAuth(valor, base) {
    var url = (valor && /^https?:\/\//.test(String(valor).trim()))
        ? String(valor).trim()
        : String(base || '').replace(/\/+$/, '') + '/api';
    url = url.replace(/\/+$/, '');
    if (!/\/api$/.test(url)) url += '/api';
    return url;
}
const FSC_AUTH_API = baseDeFscAuth(process.env.FSC_AUTH_API, process.env.FSCAUTH_URL || 'https://vps-4455523-x.dattaweb.com/fscauth');
console.log('[auth] fscauth:', FSC_AUTH_API);
const AUTH_APAGADA = process.env.JPI_AUTH_OFF === '1';
const COOKIE_SESION = 'fsc_token';

function tokenDe(req) {
    const h = req.headers.authorization || '';
    if (h.indexOf('Bearer ') === 0) return h.slice(7).trim();
    if (req.cookies && req.cookies[COOKIE_SESION]) return req.cookies[COOKIE_SESION];
    try {
        const u = new URL(req.url || '', 'http://localhost');
        const t = u.searchParams.get('token');
        if (t) return t;
    } catch (e) { /* url rara: seguimos */ }
    return null;
}

// El JWT de fscauth trae {id, email, role}: sin nombre. Cuando hace falta el
// nombre (registro de quién pidió, lista de conectados) se lo pedimos al perfil.
async function perfilDe(token) {
    const u = usuarioDe(token);
    if (!u) return null;
    if (u.username || u.displayName) return u;
    try {
        const r = await fetch(FSC_AUTH_API + '/auth/profile', {
            headers: { Authorization: 'Bearer ' + token, 'x-fsc-internal-key': process.env.FSC_INTERNAL_KEY || '' },
            signal: AbortSignal.timeout(6000)
        });
        if (r.ok) {
            const d = await r.json();
            const p = (d && (d.user || d.data || d)) || {};
            if (p.username) return Object.assign({}, u, { username: p.username, displayName: p.displayName || p.username, avatar: p.avatar || '' });
        }
    } catch (e) { }
    return u;
}

function usuarioDe(token) {
    if (!token || !JWT_SECRET) return null;
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return null;
    }
}

// Rutas que NO piden sesión: health, estado y la media estática del editor.
function esPublica(ruta) {
    const p = ruta.startsWith(BASE_PATH) ? ruta.slice(BASE_PATH.length) : ruta;
    return p === '/health'
        || p === '/api/status'
        || p.indexOf('/api/auth/') === 0
        || p === '/api/me'
        || p.indexOf('/uploads/') === 0
        || p.indexOf('/videos/') === 0
        || p.indexOf('/audio/') === 0;
}

function exigirSesion(req, res, next) {
    if (AUTH_APAGADA) return next();
    if (esPublica(req.path)) return next();
    const u = usuarioDe(tokenDe(req));
    if (!u) {
        return res.status(401).json({
            success: false,
            requiereLogin: true,
            message: 'Necesitás iniciar sesión con tu cuenta de fullscreencode.'
        });
    }
    req.usuario = u;
    next();
}

const PORT = process.env.PORT || 8086;
const BASE_PATH = process.env.BASE_PATH || '/comfylatam';
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';

// --- CORS (el front vive en el FTP y habla con el VPS) -------------------
const ORIGENES_FSC = [
    'https://fullscreencode.com', 'https://www.fullscreencode.com',
    'https://artedigitaldata.com', 'https://www.artedigitaldata.com',
    'https://exporural.com', 'https://www.exporural.com',
    'https://exporuralsanjuan.com', 'https://www.exporuralsanjuan.com',
    'https://vuelapelucas3000.com', 'https://www.vuelapelucas3000.com',
    'https://vuelapelucas3000.com.ar', 'https://www.vuelapelucas3000.com.ar',
    'https://vps-4455523-x.dattaweb.com'
];
const esOrigenLocal = (o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(o || ''));

app.use(cors({
    origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (ORIGENES_FSC.includes(origin) || esOrigenLocal(origin)) return cb(null, true);
        return cb(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
    credentials: true
}));
app.options('*', cors());

app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://vps-4455523-x.dattaweb.com https://fullscreencode.com https://cdnjs.cloudflare.com https://fonts.googleapis.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        "img-src 'self' data: blob: https://vps-4455523-x.dattaweb.com https://fullscreencode.com https://pub-6289669d41aa4adc9b90385dbd269b1f.r2.dev",
        "media-src 'self' blob: https://vps-4455523-x.dattaweb.com https://fullscreencode.com https://pub-6289669d41aa4adc9b90385dbd269b1f.r2.dev",
        "connect-src 'self' https://vps-4455523-x.dattaweb.com wss://vps-4455523-x.dattaweb.com https://fullscreencode.com",
        "worker-src 'self' blob:",
        "frame-ancestors 'self' https://fullscreencode.com"
    ].join('; '));
    next();
});

app.use(cookieParser());

// --- normalizador de path para nginx (proxy_pass con barra final) --------
app.use((req, res, next) => {
    if (req.url.startsWith(BASE_PATH + '/socket.io') || req.url.startsWith(BASE_PATH + '/ws')) return;
    next();
});

// El front es el MISMO de la app: una sola app, un solo public/
app.use(BASE_PATH, express.static(path.join(__dirname, '..', 'public')));
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Health -------------------------------------------------------------
// Versión del hub: el commit del repo (la web lo muestra en el chip de versión).
let versionCommit = null;
try {
    versionCommit = require('child_process')
        .execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..'), windowsHide: true })
        .toString().trim();
} catch (e) { versionCommit = null; }

app.get(['/health', BASE_PATH + '/health'], (req, res) => {
    res.json({
        status: 'ok',
        app: 'comfylatam',
        version: versionCommit || '1.0.0',
        commit: versionCommit,
        basePath: BASE_PATH,
        agente: !!relay.estado().agent
    });
});

// --- Media generado: el agente lo sube aca y queda en Cloudflare R2 ------
// En local no hay credenciales R2 y esto responde 503: la app sigue guardando
// en el disco como siempre (no se rompe nada).
const multer = require('multer');
const r2 = require('./lib/r2');
const mediaMap = require('./lib/media-map');
const subidaMedia = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } });

function soloPuente(req, res, next) {
    if (!AGENT_TOKEN) return res.status(500).json({ success: false, message: 'AGENT_TOKEN no configurado' });
    if (String(req.headers['x-agent-token'] || '') !== AGENT_TOKEN) {
        return res.status(401).json({ success: false, message: 'token de agente invalido' });
    }
    return next();
}

// Registro en el indice central del ecosistema (panel /fscauth/admin -> Assets).
async function registrarEnFscAuth({ key, url, nombre, mime, bytes }) {
    const base = (process.env.FSC_AUTH_API || 'http://localhost:3027/fscauth').replace(/\/api$/, '').replace(/\/$/, '');
    const interna = process.env.FSC_INTERNAL_KEY || '';
    if (!interna) {
        console.warn('[fscauth] falta FSC_INTERNAL_KEY: el asset queda en R2 pero sin indexar');
        return { ok: false, motivo: 'sin FSC_INTERNAL_KEY' };
    }
    try {
        const r = await fetch(base + '/api/assets/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-fsc-internal': interna },
            body: JSON.stringify({
                application: 'comfylatam',
                publicId: key,
                url,
                originalName: nombre,
                mimetype: mime,
                size: bytes,
                username: 'comfylatam-web'
            })
        });
        const texto = await r.text();
        if (!r.ok) {
            console.warn('[fscauth] registro fallo', r.status, texto.slice(0, 200));
            return { ok: false, motivo: r.status };
        }
        console.log('[fscauth] asset registrado:', key);
        return { ok: true };
    } catch (e) {
        console.warn('[fscauth] registro error:', e.message);
        return { ok: false, motivo: e.message };
    }
}

app.post([BASE_PATH + '/api/agent/media', '/api/agent/media'], soloPuente, subidaMedia.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'falta el archivo (campo file)' });
    const nombre = String(req.body.filename || 'resultado').replace(/[^\w.\-]+/g, '_');
    const kind = String(req.body.kind || 'imagenes');

    // Si el cliente no manda un mime util, lo deducimos de la extension: importa
    // para que el navegador reproduzca los videos del CDN (video/mp4).
    let mime = req.file.mimetype || 'application/octet-stream';
    if (!mime || mime === 'application/octet-stream') {
        const ext = path.extname(nombre).toLowerCase();
        const tabla = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
                        '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
                        '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
        if (tabla[ext]) mime = tabla[ext];
    }

    const subido = await r2.subirMedia(req.file.buffer, {
        tipo: 'comfylatam',
        sub: kind,
        filename: nombre,
        mime: mime,
        sobreescribir: true
    });

    if (!subido) {
        return res.status(503).json({ success: false, message: 'R2 no configurado en el VPS (en local es lo esperado)' });
    }

    mediaMap.anotar(nombre, subido.url, { key: subido.key, kind: kind, bytes: req.file.buffer.length });
    const registro = await registrarEnFscAuth({
        key: subido.key, url: subido.url, nombre,
        mime: req.file.mimetype, bytes: req.file.buffer.length
    });

    console.log(`📦 ${nombre} -> R2 ${subido.url} (indexado: ${registro.ok ? 'SI' : 'NO ' + registro.motivo})`);
    res.json({ success: true, url: subido.url, key: subido.key, indexado: registro.ok });
});

// Que hay ya en Cloudflare (lo usa el backfill para no resubir)
app.get([BASE_PATH + '/api/media-map', '/api/media-map'], soloPuente, (req, res) => {
    res.json({ ok: true, cantidad: mediaMap.cantidad(), mapa: mediaMap.todoElMapa() });
});

// --- Estado real de la cadena (lo muestra la web) ------------------------
// La PC es la unica que sabe si su videocomfy y su ComfyUI estan vivos: el
// agente lo reporta y aca se expone para el navegador. Ojo: va ANTES del relay
// de /api/* (si no, se reenviaria al videocomfy, que no tiene este endpoint).
app.get(['/api/status', BASE_PATH + '/api/status'], (req, res) => {
    const e = relay.estado();
    const agenteOk = !!e.agent;
    const estado = e.estado || null;
    const antiguedad = estado && estado.recibido ? Math.round((Date.now() - estado.recibido) / 1000) : null;
    // si el agente reporto hace mas de 45 s, el dato ya no es confiable
    const fresco = antiguedad != null && antiguedad <= 45;

    res.json({
        ok: agenteOk && fresco && !!estado && estado.videocomfy === true,
        agente: agenteOk,
        videocomfy: agenteOk && fresco ? !!(estado && estado.videocomfy) : false,
        comfy: agenteOk && fresco ? !!(estado && estado.comfy) : false,
        comfyTexto: estado ? estado.comfyTexto || 'desconocido' : 'sin datos',
        host: (estado && estado.host) || (e.info && e.info.host) || null,
        reporteHaceSegundos: antiguedad,
        datoFresco: fresco,
        mensaje: !agenteOk
            ? 'La PC no esta conectada (corré conectar-comfylatam.bat en la PC)'
            : (!estado
                ? 'La PC se conecto pero todavia no reporto su estado'
                : (!fresco
                    ? `La PC no reporta desde hace ${antiguedad}s`
                    : (!estado.videocomfy
                        ? 'La PC no tiene el videocomfy levantado (node server.js en D:\\Programacion\\videocomfy)'
                        : (!estado.comfy
                            ? 'ComfyUI esta apagado en la PC (start_comfy.bat en D:\\Programacion\\videocomfy)'
                            : 'Todo listo: PC + videocomfy + ComfyUI')))),
        actualizado: new Date().toISOString()
    });
});

// --- Relay HTTP: api + archivos -----------------------------------------
// Todo lo que el editor pide (API y binarios) vive en la PC: se relaya.
function esRutaRelay(p) {
    const limpio = p.startsWith(BASE_PATH) ? p.slice(BASE_PATH.length) : p;
    return limpio.startsWith('/api/') ||
           limpio.startsWith('/uploads/') ||
           limpio.startsWith('/videos/') ||
           limpio.startsWith('/audio/');
}

// --- Login / sesión (antes del relay: si no, se reenviarían a la PC) ------
app.post([BASE_PATH + '/api/auth/login', '/api/auth/login'], express.json({ limit: '32mb' }), async (req, res) => {
    try {
        const cuerpo = req.body || {};
        const r = await fetch(FSC_AUTH_API + '/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: cuerpo.username || cuerpo.email || '', password: cuerpo.password || '' })
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
            return res.status(r.status).json({
                success: false,
                message: data.message || data.error || 'Usuario o contraseña incorrectos.'
            });
        }
        const token = data.token || (data.data && data.data.token) || '';
        const user = data.user || (data.data && data.data.user) || null;
        if (token) {
            res.cookie(COOKIE_SESION, token, {
                httpOnly: false, sameSite: 'lax', secure: true,
                maxAge: 7 * 24 * 3600 * 1000, path: '/'
            });
        }
        res.json({ success: true, token, user });
    } catch (e) {
        console.error('[auth] login:', e.message);
        res.status(502).json({ success: false, message: 'No se pudo contactar el login de fullscreencode.' });
    }
});

app.post([BASE_PATH + '/api/auth/logout', '/api/auth/logout'], (req, res) => {
    res.clearCookie(COOKIE_SESION, { path: '/' });
    res.json({ success: true });
});

// Quién soy: el front lo usa para el gate y para la pestaña CUENTA.
app.get([BASE_PATH + '/api/me', '/api/me'], async (req, res) => {
    const token = tokenDe(req);
    const u = usuarioDe(token);
    if (!u) return res.status(401).json({ success: false, requiereLogin: true, message: 'Sin sesión.' });

    let perfil = null;
    try {
        // /auth/profile trae el usuario COMPLETO (incluye avatar); /auth/verify
        // sólo id/username/rol y por eso la foto de perfil llegaba en null.
        const cab = {
            Authorization: 'Bearer ' + token,
            'x-fsc-internal-key': process.env.FSC_INTERNAL_KEY || ''
        };
        let r = await fetch(FSC_AUTH_API + '/auth/profile', { headers: cab });
        if (!r.ok) r = await fetch(FSC_AUTH_API + '/auth/verify', { headers: cab });
        if (r.ok) perfil = await r.json();
    } catch (e) { /* si fscauth no contesta, alcanza con el token */ }

    const p = (perfil && (perfil.user || perfil.data || perfil)) || {};
    const u2 = (perfil && perfil.usuario) || {};
    res.set('Cache-Control', 'no-store');
    res.json({
        success: true,
        user: {
            id: u.id || p._id || p.id || null,
            username: p.username || u2.username || u.username || null,
            displayName: p.displayName || p.display_name || u2.displayName || u.displayName || p.username || u.username || null,
            email: p.email || u2.email || u.email || null,
            role: u.role || p.role || u2.role || 'USER',
            avatar: p.avatar || p.avatarUrl || u2.avatar || null
        }
    });
});

// ==========================================================================
// RED COMFYLATAM: nodos conectados y trabajos entre ellos
// ==========================================================================
// Quién puede ver/usar la red: un USUARIO con sesión de fullscreencode (la web)
// o la propia app local (que se identifica con el token del agente).
function autorizadoRed(req) {
    const t = req.headers['x-agent-token'] || '';
    const publico = process.env.RED_NODO_TOKEN || 'comfylatam-nodo-2026';
    if (AGENT_TOKEN && t && t === AGENT_TOKEN) return { tipo: 'nodo' };
    // Token público: cualquier instalación nueva (clone del repo) entra así.
    if (t && t === publico) return { tipo: 'nodo' };
    if (AUTH_APAGADA) return { tipo: 'local' };
    const u = usuarioDe(tokenDe(req));
    if (u) return { tipo: 'usuario', usuario: u };
    return null;
}
const rutasRed = (sufijo) => [BASE_PATH + sufijo, sufijo];

// Lista de nodos de la red (los que están corriendo la app con su Comfy).
app.get(rutasRed('/api/red/peers'), (req, res) => {
    const quien = autorizadoRed(req);
    if (!quien) {
        return res.status(401).json({
            success: false, requiereLogin: true,
            message: 'Entrá con tu cuenta de fullscreencode para ver la red.'
        });
    }
    res.set('Cache-Control', 'no-store');
    const cuerpo = { success: true, peers: relay.listarPeers() };
    if (String(req.query.pasados || '') === '1') cuerpo.pasados = relay.listarPasados();
    res.json(cuerpo);
});

// Encolar un trabajo EN LA RED: se lo mandamos al nodo elegido.
app.post(rutasRed('/api/red/generar'), express.json({ limit: '32mb' }), async (req, res) => {
    const quien = autorizadoRed(req);
    if (!quien) {
        return res.status(401).json({
            success: false, requiereLogin: true,
            message: 'Entrá con tu cuenta de fullscreencode para generar en la red.'
        });
    }
    const b = req.body || {};
    const destino = b.peerId ? relay.peer(String(b.peerId)) : relay.principal();
    if (!destino || !destino.socket || !destino.socket.connected) {
        return res.status(503).json({ success: false, message: 'Ese nodo no está conectado.' });
    }
    if (!destino.compartir) {
        return res.status(403).json({ success: false, message: `El nodo ${destino.nombre} no está compartiendo su Comfy.` });
    }
    const jobId = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    // Si quien pide está logueado, le completamos el nombre con su perfil
    const quienEs = quien.usuario
        ? (await perfilDe(tokenDe(req))) || quien.usuario
        : {};
    const de = (quienEs.username || quienEs.displayName) || 'local';
    const pedidoPor = {
        usuario: quienEs.username || de,
        displayName: quienEs.displayName || quienEs.username || de,
        avatar: quienEs.avatar || '',
        tipo: quien.tipo === 'nodo' ? 'app-local' : 'web'
    };
    const ok = relay.enviarA(destino.id, 'red:job', {
        jobId,
        tipo: b.tipo || 'imagen',
        prompt: b.prompt || '',
        params: b.params || {},
        modelo: b.modelo || null,
        de,
        pedidoPor,
        origen: 'red',
        ts: Date.now()
    });
    if (!ok) return res.status(503).json({ success: false, message: 'No pude hablar con ese nodo.' });
    console.log(`🔀 Trabajo ${jobId} -> nodo ${destino.id} (${destino.nombre}) · pedido por ${pedidoPor.displayName} (${pedidoPor.tipo})`);
    res.json({ success: true, jobId, peer: relay.publico(destino) });
});

// Cuántos clientes hay, cuántos usuarios y quiénes (lo usa la pestaña RED).
app.get(rutasRed('/api/red/clientes'), (req, res) => {
    const quien = autorizadoRed(req);
    if (!quien) return res.status(401).json({ success: false, requiereLogin: true, message: 'Sin sesión.' });
    res.set('Cache-Control', 'no-store');
    const r = relay.resumenClientes();
    const nodos = relay.listarPeers();
    res.json({
        success: true,
        ...r,
        appsLocales: nodos.length,
        usuariosConNodo: [...new Set(nodos.map((n) => n.usuario).filter(Boolean))],
        nodos: nodos.map((n) => ({
            id: n.id, nombre: n.nombre, usuario: n.usuario, avatar: n.avatar,
            ocupado: n.ocupado, encolados: n.encolados, comfy: n.comfy, compartir: n.compartir
        }))
    });
});

// La app local avisa si habilitó / deshabilitó compartir su Comfy.
app.post(rutasRed('/api/red/compartir'), express.json({ limit: '32mb' }), (req, res) => {
    const quien = autorizadoRed(req);
    if (!quien) return res.status(401).json({ success: false, message: 'Sin permiso.' });
    const b = req.body || {};
    const p = b.peerId ? relay.peer(String(b.peerId)) : relay.principal();
    if (!p) return res.status(404).json({ success: false, message: 'Nodo desconocido.' });
    p.compartir = !!b.compartir;
    try { p.socket.emit('red:compartir', { compartir: p.compartir }); } catch (e) { }
    relay.avisarPeers();
    console.log(`🔓 ${p.id} compartir=${p.compartir} (via API)`);
    res.json({ success: true, peer: relay.publico(p) });
});

// Media y API de un nodo que NO es el principal: /p/<id>/uploads/x.png
// (match a mano: express no resuelve :params en app.use)
app.use((req, res, next) => {
    const p = req.path || '';
    let m = p.match(new RegExp('^' + BASE_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/p/([^/]+)(/.*)$'));
    if (!m) m = p.match(/^\/p\/([^/]+)(\/.*)$/);
    if (!m) return next();
    const query = req.originalUrl.includes('?') ? '?' + req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '';
    req.peerId = decodeURIComponent(m[1]);
    req.url = m[2] + query;
    next();
});

app.use((req, res, next) => {
    if (!esRutaRelay(req.path)) return next();

    // LOGIN FSC: la API del editor pide sesión (el trabajo se hace en la PC de
    // Julián). La media (imágenes/videos/audio) queda libre: los <img>/<video>
    // no pueden mandar el header de autorización.
    if (!esPublica(req.path) && !AUTH_APAGADA) {
        const u = usuarioDe(tokenDe(req));
        if (!u) {
            return res.status(401).json({
                success: false,
                requiereLogin: true,
                message: 'Necesitás iniciar sesión con tu cuenta de fullscreencode para usar el editor.'
            });
        }
        req.usuario = u;
    }

    const limpio = req.path.startsWith(BASE_PATH) ? req.path.slice(BASE_PATH.length) : req.path;
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '';

    if (!relay.principal()) {
        return res.status(503).json({
            success: false,
            message: 'Ningún nodo conectado. En la PC tiene que estar corriendo conectar-comfylatam.bat (y la app local).'
        });
    }

    relay.reenviarHttp({
        peerId: req.peerId || null,
        method: req.method,
        ruta: limpio,
        query,
        // base absoluta para las URLs de media: asi el front las carga desde
        // el VPS aunque la pagina se sirva desde fullscreencode.com.
        // Ojo: nginx termina el TLS y le pasa http a Node, por eso usamos
        // x-forwarded-proto (si no, las URLs salen en http y el navegador las
        // bloquea por contenido mixto).
        origen: (req.get('x-forwarded-proto') || req.protocol) + '://' + req.get('host'),
        contentType: req.headers['content-type'] || '',
        range: req.headers.range || '',
        stream: req
    })
        .then((r) => {
            if (r.contentType) res.setHeader('Content-Type', r.contentType);
            // Streaming de video: hay que devolver 206 + Content-Range tal cual,
            // si no el navegador no puede reproducir ni hacer seek.
            if (r.headers) {
                Object.keys(r.headers).forEach((h) => {
                    if (r.headers[h]) res.setHeader(h, r.headers[h]);
                });
            }
            res.setHeader('Cache-Control', 'no-store');
            if (r.jsonReescrito) return res.status(r.status).send(r.jsonReescrito);
            res.status(r.status).end(r.body);
        })
        .catch((err) => {
            console.error('[relay] error:', err.message);
            res.status(504).json({ success: false, message: 'El agente local no respondió: ' + err.message });
        });
});

// Pedidos gigantes: respuesta limpia en vez del stack de body-parser
app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
        console.warn('⚠️  Pedido demasiado grande:', req.method, req.originalUrl);
        return res.status(413).json({ success: false, message: 'El pedido es demasiado grande (límite 32 MB).' });
    }
    if (err) console.warn('⚠️  Error en un pedido:', req.method, req.originalUrl, err.message);
    next(err);
});

// --- Arranque ------------------------------------------------------------
const servidorHttp = http.createServer();

// 1) socket.io para el agente (la PC)
const io = new Server(servidorHttp, {
    path: BASE_PATH + '/socket.io',
    cors: { origin: (o, cb) => cb(null, true), credentials: true },
    maxHttpBufferSize: 120 * 1024 * 1024
});
relay.iniciar(io, BASE_PATH);
// Latido: la lista de nodos va a los navegadores y a los nodos cada 10 s, así
// nadie queda con una vista vieja (el socket avisa al instante cuando cambia).
setInterval(() => { try { relay.avisarPeers(); } catch (e) { } }, 10000);

// 2) websocket crudo del editor (/ws) -> se relaya al videocomfy local
const wss = new WebSocketServer({ noServer: true });
const clientesWs = new Set();
let wsSeq = 0;

wss.on('connection', (ws, req) => {
    const clientId = 'c' + (++wsSeq);
    clientesWs.add(ws);
    // origen de ESTE cliente, para reescribirle las URLs de media que le
    // llegan por broadcast (local -> http://localhost:8086, web -> el VPS)
    const host = (req && req.headers && req.headers.host) || '';
    const proto = (req && req.headers && req.headers['x-forwarded-proto']) ||
        (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? 'http' : 'https');
    ws._origen = host ? proto + '://' + host : null;
    console.log(`🔌 Editor conectado por /ws (${clientId}) — ${clientesWs.size} online`);
    relay.enviarAlAgente('tunnel:ws:open', { clientId });

    ws.on('message', (data) => {
        relay.enviarAlAgente('tunnel:ws:frame', { clientId, data: data.toString() });
    });
    ws.on('close', () => {
        clientesWs.delete(ws);
        relay.enviarAlAgente('tunnel:ws:close', { clientId });
        console.log(`🔌 Editor desconectado (${clientId}) — ${clientesWs.size} online`);
    });
    ws.on('error', () => {});
});

// El app local de cada nodo emite a todos sus clientes: replicamos a los
// navegadores reescribiendo cada URL con el origen DEL CLIENTE (asi el editor
// abierto en local recibe URLs locales y el de la web, las del VPS) y, si el
// mensaje viene de OTRO nodo, con su prefijo /p/<id>/ para que la media no se
// mezcle entre PCs.
// ============================================================================
// CLIENTES: navegadores conectados (la web y los que usan la app local)
// ----------------------------------------------------------------------------
// Acá se anota quién es cada uno (usuario del token, origen local/web) para que
// la pestaña RED pueda decir cuántos hay, cuántos usuarios y cuáles.
// ============================================================================
relay.setResolutorUsuario(usuarioDe);   // presencia con identidad verificada

io.on('connection', (socket) => {
    const cab = socket.handshake.headers || {};
    const ref = String(cab.origin || cab.referer || '');
    const origen = /127\.0\.0\.1|localhost|192\.168\.|10\.0\./i.test(ref) ? 'local' : 'web';
    console.log(`🌐 Navegador conectado al hub (${origen}) desde ${cab['x-forwarded-for'] || socket.handshake.address || '?'}`);
    relay.anotarCliente(socket, { origen });

    // El JWT de fscauth no trae el nombre: se lo pedimos al perfil (así la lista
    // de conectados muestra usuarios de verdad y no "(sin sesión)").
    socket.on('cliente:yo', async (d = {}) => {
        const u = usuarioDe(d.token || '');
        if (u && !u.username) {
            try {
                const r = await fetch(FSC_AUTH_API + '/auth/profile', {
                    headers: { Authorization: 'Bearer ' + (d.token || ''), 'x-fsc-internal-key': process.env.FSC_INTERNAL_KEY || '' },
                    signal: AbortSignal.timeout(6000)
                });
                if (r.ok) {
                    const perfil = await r.json();
                    const p = (perfil && (perfil.user || perfil.data || perfil)) || {};
                    if (p.username) {
                        relay.actualizarCliente(socket.id, {
                            usuario: p.username,
                            displayName: p.displayName || p.username,
                            avatar: p.avatar || '',
                            verificado: true
                        });
                    }
                }
            } catch (e) { /* si fscauth no contesta queda el nombre declarado */ }
        }
    });
});

relay.alRecibirBroadcast((peerId, data) => {
    const nodo = relay.peer(peerId);
    const esPrincipal = !nodo || nodo.principal;
    if (esPrincipal) {
        for (const c of clientesWs) {
            if (c.readyState !== 1) continue;
            const base = (c._origen || relay.origenPublico()) + BASE_PATH;
            c.send(relay.reescribirTexto(String(data), base));
        }
    }
    // Y a los navegadores por socket.io, etiquetado (lo usa la pestaña RED).
    const evento = {
        peerId: peerId || null,
        principal: !!esPrincipal,
        nombre: (nodo && nodo.nombre) || '',
        data: String(data)
    };
    // Log del cierre: quién terminó qué (para ver la sincronización entre apps)
    try {
        const m = JSON.parse(String(data));
        if (m && (m.type === 'storyboard_generated' || m.type === 'video_generated')) {
            const quien = (m.pedidoPor && (m.pedidoPor.displayName || m.pedidoPor.usuario)) || '?';
            console.log(`📢 ${(nodo && nodo.nombre) || 'nodo'} terminó ${m.filename} — pedido por @${quien} (${m.origen || 'local'}) -> avisado a ${clientesWs.size} navegador(es) y ${relay.listarPeers().length} app(s)`);
        }
    } catch (e) { }
    try { io.emit('red:evento', evento); } catch (e) { }
    // Y a los nodos (para que su pestaña RED vea lo que pasa en la red).
    relay.enviarATodos('red:evento', evento);
});

servidorHttp.on('upgrade', (req, socket, head) => {
    const p = (req.url || '').split('?')[0];
    if (p === BASE_PATH + '/ws' || p === '/ws') {
        // El websocket del editor también pide sesión: el token viaja en ?token=
        // (config-jpi.js lo agrega) o en la cookie fsc_token.
        if (!AUTH_APAGADA && !usuarioDe(tokenDe(req))) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    }
    // el resto (socket.io) lo maneja engine.io
});

// 3) express al final, y sin tocar las rutas de socket.io / ws
servidorHttp.on('request', (req, res) => {
    const p = (req.url || '').split('?')[0];
    if (p.startsWith(BASE_PATH + '/socket.io') || p === BASE_PATH + '/ws' || p === '/ws') return;
    app(req, res);
});

// normalizador para nginx (le saca el prefijo al upstream)
['request', 'upgrade'].forEach((ev) => {
    servidorHttp.prependListener(ev, (req) => {
        if (req.url && req.url.startsWith('/socket.io')) req.url = BASE_PATH + req.url;
        if (req.url && req.url.startsWith('/ws')) req.url = BASE_PATH + req.url;
    });
});

servidorHttp.listen(PORT, '0.0.0.0', () => {
    console.log('\n===========================================');
    console.log(`✅ comfylatam corriendo en el puerto ${PORT}`);
    console.log(`   Local: http://localhost:${PORT}${BASE_PATH}/`);
    console.log('===========================================\n');
});

process.on('SIGTERM', () => { servidorHttp.close(); process.exit(0); });
process.on('SIGINT', () => { servidorHttp.close(); process.exit(0); });
