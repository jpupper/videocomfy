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
const { Readable } = require('stream');
const app = express();
const http = require('http');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');
const { WebSocketServer } = require('ws');

const relay = require('./lib/relay');
const db = require('./modelos');           // base IACOMFY (estadísticas, uptime y ranking)
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
    // Si viene configurado con /jpconnect, cambiarlo a la api de auth real /fscauth/api
    if (url.indexOf('/jpconnect') >= 0) {
        url = url.replace(/\/jpconnect(\/api)?$/, '/fscauth/api');
    }
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
    if (u.avatar && (u.username || u.displayName)) return u;
    try {
        if (db && typeof db.rolEnElEcosistema === 'function') {
            const ec = await db.rolEnElEcosistema(u.username || u.id || u.email);
            if (ec) {
                return Object.assign({}, u, {
                    username: ec.username || u.username,
                    displayName: ec.displayName || ec.username || u.displayName || u.username,
                    avatar: ec.avatar || u.avatar || ''
                });
            }
        }
        const r = await fetch(FSC_AUTH_API + '/auth/profile', {
            headers: { Authorization: 'Bearer ' + token, 'x-fsc-internal-key': process.env.FSC_INTERNAL_KEY || '' },
            signal: AbortSignal.timeout(3000)
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
        || p.indexOf('/audio/') === 0
        || p.indexOf('/examples/') === 0
        || p === '/api/examples'
        // IACOMFY: el ranking y las estadísticas son públicos (son el
        // programa de incentivos: cualquiera puede ver el podio). El
        // detalle de cada uno lo resuelve el propio endpoint.
        || p.indexOf('/api/ranking/') === 0
        || p.indexOf('/api/iacomfy/') === 0
        || p.indexOf('/api/estadisticas/') === 0
        // ojo: NO abrir todo /api/red/ (ahí está 'generar'): sólo los dos
        // que llama el nodo y que ya validan el token de agente adentro.
        || p === '/api/red/generacion'
        || p === '/api/red/media-mapa';
}

// ===========================================================================
// CORS: lista blanca en el SERVIDOR (nunca en nginx) — patrón FSC canónico,
// idéntico al de fscauth/server.js (skillmaestro apiconfigs.md §3).
// Las apps se sirven desde el FTP en su dominio y llaman a este hub en el VPS:
// si el dominio no está en la lista, el navegador bloquea la respuesta.
// Al sumar un dominio al ecosistema, sumarlo acá.
// ===========================================================================
const ORIGENES_FSC = [
    'https://fullscreencode.com',
    'https://www.fullscreencode.com',
    'https://artedigitaldata.com',
    'https://www.artedigitaldata.com',
    'https://exporural.com',
    'https://www.exporural.com',
    'https://exporuralsanjuan.com',
    'https://www.exporuralsanjuan.com',
    'https://vuelapelucas3000.com',
    'https://www.vuelapelucas3000.com',
    'https://vuelapelucas3000.com.ar',
    'https://www.vuelapelucas3000.com.ar',
    'https://vps-4455523-x.dattaweb.com'
];
const esOrigenLocal = (o) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(String(o));

// ------------------------------------------------------------
// /health y /api/version los contesta el propio HUB (no el tunel). El front de
// la web lee de aca la version; antes se quedaba en 'Verificando...' para
// siempre porque el pedido se iba al tunel y no habia nodo que lo atendiera.
// ------------------------------------------------------------
const CK_BASE = process.env.BASE_PATH || process.env.RED_BASE || '/comfylatam';
let CK_VERSION_HUB = '';
try {
    CK_VERSION_HUB = require('child_process')
        .execSync('git rev-parse --short HEAD', { cwd: require('path').join(__dirname, '..'), timeout: 4000 })
        .toString().trim();
} catch (e) { CK_VERSION_HUB = ''; }
const CK_HEALTH = function (req, res) {
    let nodos = null;
    try { if (relay && relay.nodos) nodos = Object.keys(relay.nodos).length; } catch (e) { }
    res.json({ ok: true, rol: 'hub', version: CK_VERSION_HUB || 'hub', base: CK_BASE, nodos: nodos, fecha: new Date().toISOString() });
};
app.use(cors({
    origin: (origin, cb) => {
        // Sin Origin (curl, llamadas server → server) no hay nada que habilitar.
        if (!origin) return cb(null, true);
        if (ORIGENES_FSC.includes(origin) || esOrigenLocal(origin)) return cb(null, true);
        // Origen desconocido: sin ACAO el navegador no puede leer la respuesta.
        return cb(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true
}));

app.get([CK_BASE + '/health', '/health', CK_BASE + '/api/version', '/api/version'], CK_HEALTH);

// La version tambien como archivo: el front de la web la pide asi (el chip
// mostraba 'verificando' cuando el pedido iba al tunel o al dominio sin proxy).
app.get([CK_BASE + '/version.json', '/version.json'], function (req, res) {
    res.set('Cache-Control', 'no-store');
    res.json({ version: CK_VERSION_HUB || 'hub', rol: 'hub', base: CK_BASE });
});

// Apache/Nginx también agrega Allow-Credentials: se omite la nuestra cuando el
// origen no es local para no mandar "true, true" (el navegador lo rechaza).
app.use((req, res, next) => {
    const origen = req.headers.origin || '';
    if (origen && !esOrigenLocal(origen) && res.getHeader('Access-Control-Allow-Credentials')) {
        res.removeHeader('Access-Control-Allow-Credentials');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    next();
});

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

// El hub se reiniciaba (PM2 lo mostraba en rojo con 13 reinicios): un error sin
// atrapar lo mataba. Ahora los errores se registran y el proceso sigue vivo.
process.on('unhandledRejection', (e) => {
    console.log('⚠️  Promesa rechazada sin atrapar:', (e && e.message) || e);
});
process.on('uncaughtException', (e) => {
    console.log('⚠️  Excepción sin atrapar:', (e && e.message) || e);
});

const PORT = process.env.PORT || 8086;

// ---- Base IACOMFY (MongoDB): estadísticas, uptime de fierros y ranking ----
db.conectar().catch(() => { });
// latido: cada 30 s se anota qué computadoras están prendidas (para el uptime).
// Si un fierro deja de latir, la sesión se cierra sola 3 minutos después.
setInterval(async () => {
    try {
        const peers = relay.listarPeers ? relay.listarPeers() : [];
        for (const pp of peers) { await db.latidoDeComputadora(pp); }
    } catch (e) { }
}, 30000);
setInterval(() => { db.cerrarSesionesViejas().catch(() => { }); }, 60000);
const BASE_PATH = process.env.BASE_PATH || '/comfylatam';
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';


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
                        ? 'La PC no tiene el videocomfy levantado (node server.js en D:\\Programacion\\comfylatam)'
                        : (!estado.comfy
                            ? 'ComfyUI esta apagado en la PC (start_comfy.bat en D:\\Programacion\\comfylatam)'
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
        const cab = {
            Authorization: 'Bearer ' + token,
            'x-fsc-internal-key': process.env.FSC_INTERNAL_KEY || ''
        };
        let r = await fetch(FSC_AUTH_API + '/auth/profile', { headers: cab, signal: AbortSignal.timeout(2500) });
        if (!r.ok) r = await fetch(FSC_AUTH_API + '/auth/verify', { headers: cab, signal: AbortSignal.timeout(2500) });
        if (r.ok) perfil = await r.json();
    } catch (e) { /* si fscauth no contesta o tarda, caemos a mongo directo */ }

    const p = (perfil && (perfil.user || perfil.data || perfil)) || {};
    const u2 = (perfil && perfil.usuario) || {};

    // Si falta avatar o displayName, consultamos directo la base de datos de usuarios del ecosistema (fullscreen_global.users)
    let ec = null;
    if ((!p.avatar && !u2.avatar) && db && typeof db.rolEnElEcosistema === 'function') {
        try {
            ec = await db.rolEnElEcosistema(u.username || u.id || p.username || u2.username || u.email);
        } catch (e) { }
    }

    let rawAvatar = p.avatar || p.avatarUrl || u2.avatar || (ec && ec.avatar) || null;
    if (rawAvatar && typeof rawAvatar === 'string' && !/^https?:\/\//i.test(rawAvatar)) {
        rawAvatar = rawAvatar.startsWith('/') ? ('https://fullscreencode.com' + rawAvatar) : ('https://fullscreencode.com/' + rawAvatar);
    }

    res.set('Cache-Control', 'no-store');
    res.json({
        success: true,
        user: {
            id: u.id || p._id || p.id || (ec && (ec._id || ec.id)) || null,
            username: p.username || u2.username || (ec && ec.username) || u.username || null,
            displayName: p.displayName || p.display_name || u2.displayName || (ec && (ec.displayName || ec.username)) || u.displayName || u.username || null,
            email: p.email || u2.email || (ec && ec.email) || u.email || null,
            role: u.role || p.role || u2.role || (ec && ec.role) || 'USER',
            bio: p.bio || (ec && ec.bio) || null,
            avatar: rawAvatar
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

// ¿el pedido viene del nodo (la app local) con el token de agente?
function esAgente(req) {
    return !!AGENT_TOKEN && String(req.headers['x-agent-token'] || '') === AGENT_TOKEN;
}

// Lista de nodos de la red (los que están corriendo la app con su Comfy).

// --- PEDIDOS: el BATCH agregado de TODAS las máquinas conectadas ------------
// En la web el BATCH no es de una sola PC: se le pide a cada nodo en línea su
// registro y se junta todo, marcando de qué máquina es cada pedido.

// --- qué nodo está usando este cliente web ---------------------------------
// El front avisa al elegir una computadora. Sirve para que el panel RED de esa
// PC muestre cuántos clientes la están usando ("usar esta compu").
app.post(rutasRed('/api/red/cliente-nodo'), express.json({ limit: '4kb' }), (req, res) => {
    try {
        const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
        const b = req.body || {};
        const clave = ip + '|' + String(req.headers['user-agent'] || '').slice(0, 60) + '|' + (b.clave || '');
        relay.anotarUsoNodo(clave, b.peerId || '', b);
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

app.get(rutasRed('/api/pedidos'), async (req, res) => {
    const peers = relay.listarPeers().filter((p) => p.conectado);
    const pedidos = [];
    const maquinas = [];
    await Promise.all(peers.map(async (p) => {
        try {
            const r = await relay.reenviarHttp({ peerId: p.id, method: 'GET', ruta: '/api/pedidos' });
            // ojo: jsonReescrito viene como TEXTO (JSON.stringify), hay que parsearlo
            const j = r.jsonReescrito ? JSON.parse(r.jsonReescrito) : JSON.parse(r.body.toString('utf8'));
            const lista = (j && j.pedidos) || [];
            maquinas.push({ id: p.id, nombre: p.nombre, usuario: p.usuario, gpu: p.gpu, pedidos: lista.length });
            lista.forEach((x) => pedidos.push(Object.assign({}, x, {
                maquina: { id: p.id, nombre: p.nombre, usuario: p.usuario, gpu: p.gpu }
            })));
        } catch (e) {
            maquinas.push({ id: p.id, nombre: p.nombre, usuario: p.usuario, error: e.message });
        }
    }));
    // --- pedidos anotados en el hub (lado web) -----------------------------
    // Se suman a los de las máquinas; si el nodo ya reportó el mismo pedido
    // (mismo prompt, pocos minutos de diferencia), el del hub se descarta.
    const ahora = Date.now();
    for (let i = PEDIDOS_HUB.length - 1; i >= 0; i--) {
        const p = PEDIDOS_HUB[i];
        // nadie lo tomó en 10 minutos: no queda "pedida" para siempre
        if (p.estado === 'pedida' && ahora - p.cuando > 10 * 60 * 1000) {
            p.estado = 'error';
            p.motivo = 'la computadora no respondió (no llegó a tomarlo)';
            p.actualizado = ahora;
            p.pasos = p.pasos || {};
            p.pasos.error = ahora;
        }
        if (ahora - p.cuando > 6 * 60 * 60 * 1000) PEDIDOS_HUB.splice(i, 1);
    }
    const delHub = PEDIDOS_HUB.filter((p) => {
        const gemelo = pedidos.find((x) => x.prompt === p.prompt &&
            Math.abs(Number(x.cuando || 0) - Number(p.cuando || 0)) < 3 * 60 * 1000);
        return !gemelo;
    });
    for (const p of delHub) pedidos.push(Object.assign({}, p));
    pedidos.sort((a, b) => (b.cuando || 0) - (a.cuando || 0));
    res.json({ success: true, agregado: true, maquinas, pedidos: pedidos.slice(0, 200) });
});

// limpiar el batch: se les pide a todas las máquinas
app.post(rutasRed('/api/pedidos/limpiar'), express.json({ limit: '1mb' }), async (req, res) => {
    let cancelados = 0;
    for (const p of PEDIDOS_HUB) {
        if (p.estado === 'pedida') {
            p.estado = 'cancelada'; p.actualizado = Date.now(); p.motivo = 'se limpió el batch';
            p.pasos = p.pasos || {}; p.pasos.cancelada = p.actualizado; cancelados++;
        }
    }
    await Promise.all(relay.listarPeers().filter((p) => p.conectado).map(async (p) => {
        try {
            const r = await relay.reenviarHttp({
                peerId: p.id, method: 'POST', ruta: '/api/pedidos/limpiar',
                contentType: 'application/json', stream: Readable.from(['{}'])
            });
            const j = r.jsonReescrito ? JSON.parse(r.jsonReescrito) : JSON.parse(r.body.toString('utf8'));
            cancelados += (j && j.cancelados) || 0;
        } catch (e) { }
    }));
    res.json({ success: true, cancelados });
});


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

    // ¿Ese fierro tiene y comparte el workflow que se pide? Si no, se corta acá:
    // nunca se le manda a la PC un trabajo que no puede hacer.
    const MODELO_A_WORKFLOW_HUB = {
        zimage: 'z_image_turbo_api.json', qwen21: 'qwen_image_21_api.json',
        flux: 'flux_dev_fp8_api.json', fluxfull: 'flux_dev_full_text_to_image_api.json',
        ltx2t2v: 'video_ltx2_t2v_api.json', ltx2i2v: 'video_ltx2_i2v_api.json',
        ltx2: 'video_ltx2_t2v_api.json', ltx25i2v: 'video_ltx25_i2v_api.json',
        wan22: 'video_wan2_2_14B_flf2v_api.json'
    };
    const wfPedido = MODELO_A_WORKFLOW_HUB[b.modelo];
    const ofrece = (destino.estado && Array.isArray(destino.estado.workflows)) ? destino.estado.workflows : null;
    if (wfPedido && ofrece && !ofrece.includes(wfPedido)) {
        return res.status(409).json({
            success: false,
            message: `La computadora "${destino.nombre}" no tiene disponible ese workflow (${wfPedido}). ` +
                `Ahí no está instalado o su dueño no lo comparte: elegí otro modelo o pedilo en otra PC.`,
            workflows: ofrece
        });
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
// El nodo (la app local) avisa qué media subió a Cloudflare R2. Con esto el hub
// puede responder un 302 al CDN en vez de traer el archivo por el túnel: la
// media nunca pasa por el VPS.
app.post(rutasRed('/api/red/media-mapa'), express.json({ limit: '16mb' }), (req, res) => {
    if (!AGENT_TOKEN) return res.status(500).json({ success: false, message: 'AGENT_TOKEN no configurado' });
    if (String(req.headers['x-agent-token'] || '') !== AGENT_TOKEN) {
        return res.status(403).json({ success: false, message: 'token inválido' });
    }
    const items = (req.body && req.body.items) || [];
    let n = 0;
    for (const it of items) {
        // El asset es de QUIEN LO PIDIÓ: el nodo manda la identidad por archivo
        // (it.email/username), no sólo la del dueño de la PC. Si no viene, se usa
        // la del cuerpo (comportamiento viejo).
        // Si el archivo trae SU identidad (quién lo pidió), se usa esa y NO se cae
        // a la del cuerpo: si no, un pedido de vjpuppet quedaba con el email del
        // dueño de la PC (mezcla rara) y no aparecía en los assets de quien lo pidió.
        const traeSuya = !!(it.username || it.email || it.displayName);
        const quien = traeSuya ? {
            email: it.email || '', username: it.username || '',
            displayName: it.displayName || '', avatar: it.avatar || ''
        } : {
            email: (req.body && req.body.email) || '',
            username: (req.body && req.body.username) || '',
            displayName: (req.body && req.body.displayName) || '',
            avatar: (req.body && req.body.avatar) || ''
        };
        if (it && it.nombre && it.url) {
            mediaMap.anotar(it.nombre, it.url, { bytes: it.bytes || null });
            db.anotarAsset(Object.assign({
                publicId: it.nombre, url: it.url, bytes: it.bytes || 0,
                tipo: it.tipo || 'image', mimetype: it.mimetype || '', key: it.key || '',
                ubicacion: it.ubicacion || 'nube',
                computadoraPeerId: it.peerId || (req.body && req.body.peerId) || '',
                computadoraNombre: it.computadora || (req.body && req.body.computadora) || '',
                modelo: it.modelo || '', prompt: it.prompt || ''
            }, quien)).catch(() => { });
            n++;
        } else if (it && it.nombre && it.local) {
            // Archivo que vive SOLO en esa PC: se registra para que el perfil pueda
            // mostrar 'en tu PC' (no se sube nada: la nube es sólo para lo de la web).
            db.anotarAsset(Object.assign({
                publicId: it.nombre, url: '', bytes: it.bytes || 0,
                tipo: it.tipo || 'image', mimetype: it.mimetype || '',
                ubicacion: 'local',
                computadoraPeerId: (req.body && req.body.peerId) || '',
                computadoraNombre: (req.body && req.body.computadora) || '',
                modelo: it.modelo || '', prompt: it.prompt || ''
            }, quien)).catch(() => { });
            n++;
        }
    }
    console.log('☁️  Mapa de media actualizado desde el nodo: +' + n + ' (total ' + mediaMap.cantidad() + ')');
    res.json({ success: true, anotados: n, total: mediaMap.cantidad() });
});

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

// ===========================================================================
// IACOMFY - estadísticas, ranking y registro en la base (MongoDB)
// ===========================================================================

// El nodo avisa cada generación terminada (queda por usuario y por computadora).
app.post(rutasRed('/api/red/generacion'), express.json({ limit: '2mb' }), async (req, res) => {
    if (!esAgente(req)) return res.status(403).json({ success: false, message: 'token de agente inválido' });
    const doc = await db.anotarGeneracion(req.body || {});
    res.json({ success: !!doc, id: doc && doc._id });
});

// Estado de la base (para el panel).
app.get(rutasRed('/api/iacomfy/estado'), (req, res) => {
    res.json(Object.assign({ success: true }, db.estadoDb()));
});

// ¿Cuánto puede subir esta cuenta a la nube? (lo consulta la app antes de subir)
app.get(rutasRed('/api/limite'), async (req, res) => {
    const clave = (req.usuario && (req.usuario.email || req.usuario.username)) || req.query.usuario || '';
    const d = await db.puedeSubir(clave);
    res.json(Object.assign({ success: true, usuario: clave }, d));
});

// El panel de administración (sólo ADMIN) puede cambiar el cupo.
async function esAdmin(req) {
    const r = String((req.usuario && req.usuario.role) || '').toUpperCase();
    if (r === 'ADMIN' || r === 'SYSTEM') return true;
    const clave = (req.usuario && (req.usuario.email || req.usuario.username)) || '';
    return db.esAdminDelEcosistema(clave);
}
app.get(rutasRed('/api/admin/limite'), async (req, res) => {
    if (!(await esAdmin(req))) return res.status(403).json({ success: false, message: 'sólo administradores' });
    res.json({ success: true, limiteMB: await db.leerLimiteMB(), defectoMB: db.LIMITE_DEFECTO_MB });
});
app.post(rutasRed('/api/admin/limite'), express.json(), async (req, res) => {
    if (!(await esAdmin(req))) return res.status(403).json({ success: false, message: 'sólo administradores' });
    const v = await db.guardarLimiteMB((req.body || {}).limiteMB);
    console.log('⚙️  cupo de la nube por cuenta = ' + v + ' MB');
    res.json({ success: true, limiteMB: v });
});

// Resumen general del proyecto.
app.get(rutasRed('/api/iacomfy/resumen'), async (req, res) => {
    const r = await db.resumen();
    res.json({ success: !!r, ...(r || {}), db: db.estadoDb() });
});

// RANKING DE LOS FIERROS: tiempo prendido / generaciones provistas / fierros
app.get(rutasRed('/api/ranking/fierros'), async (req, res) => {
    const r = await db.ranking(req.query.orden);
    if (!r) return res.json({ success: false, message: 'la base no está disponible' });
    res.json({ success: true, ...r });
});

// Mis estadísticas: assets creados, mis fierros con uptime, mis generaciones.
// Con sesión (web) o con ?usuario=<email|username> (app local sin login).
app.get(rutasRed('/api/estadisticas/mia'), async (req, res) => {
    const t = tokenDe(req);
    const u = (t ? usuarioDe(t) : null) || req.usuario;
    let clave = null;
    if (u) {
        clave = u.email || u.username;
        if (db && typeof db.rolEnElEcosistema === 'function') {
            try {
                const ec = await db.rolEnElEcosistema(u.username || u.email || u.id);
                if (ec) clave = ec.email || ec.username || clave;
            } catch (e) { }
        }
    }
    if (!clave && esAgente(req)) clave = req.query.usuario || null;
    if (!clave && req.query.usuario) {
        // sin token ni sesión: consultar por el usuario pedido
        const pub = await db.estadisticasDe(req.query.usuario);
        return res.json({ success: !!pub, ...(pub || {}), publico: true });
    }
    if (!clave) return res.status(401).json({ success: false, message: 'requiereLogin' });
    const d = await db.estadisticasDe(clave);
    if (!d) return res.json({ success: false, message: 'la base no está disponible' });
    res.json({ success: true, ...d, yo: true });
});

// Estadísticas públicas de un usuario (para el ranking).
app.get(rutasRed('/api/estadisticas/usuario/:clave'), async (req, res) => {
    const d = await db.estadisticasDe(req.params.clave);
    if (!d) return res.json({ success: false, message: 'la base no está disponible' });
    res.json({ success: true, ...d, publico: true });
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

    // El ranking, las estadísticas y el estado de la base NO necesitan que haya
    // un nodo conectado: se leen de la base IACOMFY (MongoDB).
    const sinNodo = limpio.indexOf('/api/ranking/') === 0
        || limpio.indexOf('/api/estadisticas/') === 0
        || limpio.indexOf('/api/iacomfy/') === 0;

    if (!relay.principal() && !sinNodo) {
        return res.status(503).json({
            success: false,
            message: 'Ningún nodo conectado: abrí COMFYLATAM en la PC que va a generar (el botón "Transmitir mi Comfy" de la pestaña RED) y reintentá.'
        });
    }

    // =====================================================================
    // LA MEDIA NO PASA POR EL VPS
    // Si el archivo ya está en Cloudflare R2, el navegador lo trae DIRECTO del
    // CDN (302) y el VPS no mueve un solo byte. Antes la media viajaba por el
    // túnel del hub, junta en memoria: un video de 1 GB dejaba el server sin
    // RAM y lo colgaba (pasó el 15/10 y se cayó todo el VPS).
    // Regla del ecosistema (skillmaestro §0.5): R2 es el único almacenamiento
    // de binarios.
    // =====================================================================
    if (req.method === 'GET' || req.method === 'HEAD') {
        const mMedia = /^\/(uploads|videos|audio)\/(.+)$/.exec(limpio || '');
        if (mMedia) {
            const clave = decodeURIComponent(mMedia[2]).split('?')[0];
            let urlR2 = null;
            try { urlR2 = mediaMap.urlDeArchivo(clave); } catch (e) { }
            if (!urlR2 && req.query && req.query.r2) urlR2 = req.query.r2;
            if (urlR2) {
                res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                return res.redirect(302, urlR2);
            }
        }
    }

    // deja anotado que este cliente web está usando ese nodo (para el panel RED
    // de esa PC: "clientes conectados a esta computadora")
    try {
        if (req.peerId) {
            const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
            relay.marcarClienteEnNodo(ip, req.peerId);
        }
    } catch (e) { }

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
        // LA SESIÓN VIAJA: sin esto la app local recibe los pedidos de la web
        // SIN token, contesta 401 y la web queda vacía (listas y foto incluidos).
        authorization: req.headers.authorization || '',
        cookie: req.headers.cookie || '',
        stream: req,
        // MEDIA GRANDE: se escribe al navegador a medida que llega, sin juntarla
        // en memoria. Antes el nodo mandaba el archivo entero en un mensaje y el
        // VPS (4 GB de RAM) se quedaba sin memoria y se colgaba.
        alStream: {
            meta: (m) => {
                if (m.contentType) res.setHeader('Content-Type', m.contentType);
                if (m.headers) {
                    Object.keys(m.headers).forEach((h) => {
                        if (m.headers[h]) res.setHeader(h, m.headers[h]);
                    });
                }
                res.setHeader('Cache-Control', 'no-store');
                res.status(m.status || 200);
            },
            chunk: (c) => { try { res.write(c); } catch (e) { } },
            fin: () => { try { res.end(); } catch (e) { } },
            error: () => { try { res.end(); } catch (e) { } }
        }
    })
        .then((r) => {
            // ya se escribió todo desde alStream (modo pedazos)
            if (r.streamed) return;
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


// ---------------------------------------------------------------------------
// PEDIDOS DEL LADO WEB: cuando un navegador manda un trabajo por el /ws, el
// hub lo anota ACÁ MISMO antes de reenviarlo. Así el pedido aparece en el
// BATCH y el REGISTRO apenas apretás generar, aunque la PC tarde o falle.
// Los pedidos que después reporta el nodo se reconocen por prompt+tiempo y
// reemplazan a estos (no se duplican).
// ---------------------------------------------------------------------------
const PEDIDOS_HUB = [];
let pedidoHubSeq = 0;

function anotarPedidoHub(msg, clientId) {
    try {
        const tipo = String(msg.type || '');
        if (tipo !== 'generarImagen' && tipo !== 'generarStoryboard' && tipo !== 'generarWan22') return null;
        const pp = msg.pedidoPor || {};
        const ahora = Date.now();
        const prompt = String(msg.prompt || '').slice(0, 400);
        // si el mismo navegador repite el mismo prompt en <90s, no se duplica
        const dup = PEDIDOS_HUB.find((p) => p.prompt === prompt && p.cliente === clientId && (ahora - p.cuando) < 90000);
        if (dup) return dup;
        const destino = relay.principal();
        const p = {
            id: 'hub-' + (++pedidoHubSeq) + '-' + ahora.toString(36),
            jobId: null, promptId: null,
            prompt,
            modelo: (msg.params && msg.params.modelo) || (tipo === 'generarStoryboard' ? 'flux' : 'ltx2'),
            usuario: pp.usuario || 'anónimo',
            displayName: pp.displayName || pp.usuario || 'anónimo',
            avatar: pp.avatar || '',
            origen: 'web',
            desde: 'la web',
            estado: 'pedida',
            archivo: null, url: null,
            cuando: ahora, actualizado: ahora,
            pasos: { pedida: ahora },
            cliente: clientId,
            hubPedido: true,
            computadora: {
                nombre: (destino && destino.nombre) || '—',
                peerId: (destino && destino.id) || null,
                dueno: (destino && destino.usuario) || '',
                gpu: (destino && destino.gpu) || ''
            }
        };
        p.dueno = p.computadora.dueno;
        PEDIDOS_HUB.push(p);
        if (PEDIDOS_HUB.length > 200) PEDIDOS_HUB.splice(0, PEDIDOS_HUB.length - 200);
        console.log(`📝 Pedido web anotado en el hub: "${prompt.slice(0, 40)}" · @${p.usuario} · ${p.computadora.nombre}`);
        return p;
    } catch (e) { return null; }
}

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
        const texto = data.toString();
        // el pedido se anota en el HUB antes de mandarlo: aparece al instante
        // en el BATCH y el REGISTRO de la web, aunque la PC tarde o falle.
        try {
            const m = JSON.parse(texto);
            const tipo = String((m && m.type) || '');
            if (tipo === 'generarImagen' || tipo === 'generarStoryboard' || tipo === 'generarWan22') {
                anotarPedidoHub(m, clientId);
            }
        } catch (e) { }
        relay.enviarAlAgente('tunnel:ws:frame', { clientId, data: texto });
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

    // Solo emitir red:evento cuando una generación termina (storyboard o video).
    // Antes se emitía en CUALQUIER broadcast (progreso, frames, status) y a TODOS
    // los nodos (incluido el emisor), provocando que los nodos se re-enviaran el evento
    // a sí mismos en un bucle infinito que anidaba JSONs con miles de barras invertidas (\).
    try {
        const m = JSON.parse(String(data));
        if (!m || (typeof m.type === 'string' && m.type.startsWith('red_'))) return;

        if (m.type === 'storyboard_generated' || m.type === 'video_generated') {
            const quien = (m.pedidoPor && (m.pedidoPor.displayName || m.pedidoPor.usuario)) || '?';
            console.log(`📢 ${(nodo && nodo.nombre) || 'nodo'} terminó ${m.filename} — pedido por @${quien} (${m.origen || 'local'}) -> avisado a ${clientesWs.size} navegador(es) y ${relay.listarPeers().length} app(s)`);

            const evento = {
                peerId: peerId || null,
                principal: !!esPrincipal,
                nombre: (nodo && nodo.nombre) || '',
                data: String(data)
            };
            try { io.emit('red:evento', evento); } catch (e) { }
            // Y a los demás nodos (excluyendo al que lo generó para evitar echo/loop)
            relay.enviarATodos('red:evento', evento, peerId);
        }
    } catch (e) { }
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