// ============================================================
// jpiassets - RELAY hacia el agente local (la PC de Julián)
// ------------------------------------------------------------
// El navegador nunca habla con la PC: le pide al VPS, el VPS le
// pide al agente (socket.io, namespace /agent) y el agente hace la
// llamada real contra el videocomfy de 127.0.0.1:5634.
//
//   HTTP:  navegador -> VPS -> [tunnel:http] -> agente -> local:5634
//   WS:    navegador -> VPS -> [tunnel:ws:*]  -> agente -> local:5634
// ============================================================
'use strict';

const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const TIMEOUT_HTTP = Number(process.env.RELAY_TIMEOUT_MS || 240000);
const mediaMap = require('./media-map');
const registro = require('./registro');

const state = { io: null, agent: null, basePath: '/comfylatam', info: {}, estado: null, peers: new Map(), historial: new Map() };
const pendientes = new Map();
// Respuestas que se mandan EN PEDAZOS (media): el hub las escribe directo al
// navegador sin juntarlas en memoria. Antes un video grande se acumulaba entero
// en el VPS y lo colgaba (4 GB de RAM).
const enStream = new Map();
let seq = 0;
let onBroadcast = null;
let onPeers = null;

// ------------------------- red de nodos ----------------------------------
// Cada agente conectado es un NODO. Si comparte, cualquiera puede mandarle
// trabajos. El PRINCIPAL sirve el editor de siempre (media sin prefijo).
const ahora = () => Date.now();

function crearPeer(socket, auth) {
    const a = auth || {};
    const host = a.host || 'PC';
    return {
        id: String(a.peerId || host).trim() || host,
        socket,
        principal: a.principal === true || a.principal === 'true',
        nombre: a.nombre || host,
        host,
        gpu: a.gpu || '',
        modelos: Array.isArray(a.modelos) ? a.modelos : [],
        version: a.version || '',
        avatar: a.avatar || '',
        usuario: a.usuario || '',
        email: a.email || '',
        avatar: (a.usuario && a.usuario.avatar) || a.avatar || '',
        compartir: a.compartir === true || a.compartir === 'true',
        estado: null,
        desde: ahora(),
        ultimoLatido: ahora(),
        trabajos: 0
    };
}

function publico(p) {
    return {
        id: p.id,
        nombre: p.nombre,
        host: p.host,
        gpu: p.gpu,
        modelos: p.modelos,
        version: p.version,
        avatar: p.avatar || '',
        usuario: p.usuario || '',
        email: p.email || '',
        compartir: !!p.compartir,
        principal: !!p.principal,
        conectado: !!(p.socket && p.socket.connected),
        desde: p.desde,
        // host NO se expone (pedido: la red muestra el nombre, no el nombre de máquina)
        host: '',
        ultimoLatido: p.ultimoLatido,
        trabajos: p.trabajos,
        videocomfy: !!(p.estado && p.estado.videocomfy),
        comfy: !!(p.estado && p.estado.comfy),
        encolados: (p.estado && p.estado.encolados) || 0,
        // ¿está trabajando ahora? (lo que el usuario quiere ver: quién está libre)
        ejecutando: (p.estado && p.estado.ejecutando) ? 1 : 0,
        ocupado: !!(p.estado && p.estado.comfy && ((p.estado.encolados || 0) > 0 || p.estado.ejecutando)),
        dueno: p.usuario || '',
        // workflows que ese fierro ofrece (compartidos y con modelos instalados)
        workflows: (p.estado && Array.isArray(p.estado.workflows)) ? p.estado.workflows : [],
        // quién puede ver/usar esa PC (👥 todos por defecto)
        accesoNodo: (p.estado && p.estado.accesoNodo) || { modo: 'todos', usuarios: [] },
        ultimoVisto: p.ultimoLatido
    };
}

function listarPeers() {
    const arr = [];
    // limpio nodos muertos (socket caído hace rato sin reconectar)
    for (const [id, p] of state.peers) {
        const vivo = p.socket && p.socket.connected;
        if (!vivo && (ahora() - p.ultimoLatido) > 45000) { state.peers.delete(id); continue; }
        arr.push(publico(p));
    }
    arr.sort((a, b) => (b.principal - a.principal) || (a.encolados - b.encolados) ||
        String(a.nombre).localeCompare(String(b.nombre)));
    return arr;
}

// Conexiones pasadas: nodos que se desconectaron (o nunca compartieron) y que
// la UI muestra sólo si el usuario toca el ojito. Se limpian a los 30 min.
function listarPasados() {
    const arr = [];
    for (const [id, h] of state.historial) {
        if (ahora() - (h.visto || 0) > 30 * 60 * 1000) { state.historial.delete(id); continue; }
        if (state.peers.has(id)) { state.historial.delete(id); continue; }
        arr.push(h);
    }
    arr.sort((a, b) => (b.visto || 0) - (a.visto || 0));
    return arr;
}

function principal() {
    for (const p of state.peers.values()) if (p.principal && p.socket && p.socket.connected) return p;
    for (const p of state.peers.values()) if (p.socket && p.socket.connected) return p;
    return null;
}

function peer(id) {
    // OJO: si viene un id, tiene que ser ESE nodo o nada. Antes caía en
    // principal() y un id viejo/inexistente mandaba el trabajo a OTRA PC
    // (se generó en la PC equivocada sin avisar).
    if (id) return state.peers.get(id) || null;
    return principal();
}

function avisarPeers() {
    // Cuando cambia la lista de apps locales también cambia el resumen de
    // clientes (appsLocales), así que se re-emite junto con los peers.
    try { setTimeout(avisarClientes, 0); } catch (e) { }
    const lista = listarPeers();
    if (typeof onPeers === 'function') { try { onPeers(lista); } catch (e) { } }
    if (state.io) { try { state.io.emit('red:peers', { peers: lista, ts: ahora() }); } catch (e) { } }
    for (const p of state.peers.values()) {
        if (p.socket && p.socket.connected) {
            try { p.socket.emit('red:peers', { peers: lista }); } catch (e) { }
        }
    }
    return lista;
}

// --- Arranque del namespace /agent ---------------------------------------

// ============================================================================
// CLIENTES CONECTADOS (navegadores: la web y las apps locales)
// ----------------------------------------------------------------------------
// Los nodos son "apps locales"; además hay navegadores mirando (la web y los
// que usan la app en su PC). Acá se anota quién es cada uno para poder decir
// cuántos clientes hay, cuántos usuarios y de qué tipo es cada uno.
// ============================================================================
const clientes = new Map();   // socket.id -> { id, usuario, origen, ... }

// El hub inyecta acá su verificador de token (jwt.verify). Sin él, se decodifica
// el payload nomás (alcanza para mostrar presencia, no para autorizar nada).
let resolverUsuarioInyectado = null;
function setResolutorUsuario(fn) { resolverUsuarioInyectado = fn; }
function resolverUsuario(token) {
    if (!token) return null;
    if (typeof resolverUsuarioInyectado === 'function') {
        try { const u = resolverUsuarioInyectado(token); if (u) return u; } catch (e) { }
    }
    try {
        const partes = String(token).split('.');
        if (partes.length < 2) return null;
        const payload = JSON.parse(Buffer.from(partes[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        return payload && (payload.username || payload.displayName) ? payload : null;
    } catch (e) { return null; }
}

// Qué cliente web está usando qué nodo ("usar esta computadora"). Se anota con
// una clave propia (ip+navegador) y caduca sola, para no depender de que la IP
// coincida (IPv6 cambia y detrás de nginx no siempre hay x-forwarded-for).
const usoNodo = new Map();
const USO_TTL = 3 * 60 * 1000;

let _tUso = null;
function anotarUsoNodo(clave, peerId, datos = {}) {
    if (!clave) return;
    if (!peerId) { usoNodo.delete(clave); }
    else {
        usoNodo.set(clave, {
            peerId, ts: Date.now(),
            usuario: datos.usuario || '', displayName: datos.displayName || datos.usuario || '',
            avatar: datos.avatar || ''
        });
    }
    // avisar a los nodos sin spamear (esto corre en cada pedido de la web)
    if (!_tUso) _tUso = setTimeout(() => { _tUso = null; try { avisarClientes(); } catch (e) { } }, 1500);
    return;
}

function porNodoActual() {
    const ahora = Date.now();
    const out = {};
    usoNodo.forEach((v, k) => {
        if (ahora - v.ts > USO_TTL) { usoNodo.delete(k); return; }
        const n = out[v.peerId] = out[v.peerId] || { web: 0, usuarios: [] };
        n.web += 1;
        if (v.usuario && !n.usuarios.some((u) => u.usuario === v.usuario)) {
            n.usuarios.push({ usuario: v.usuario, displayName: v.displayName, avatar: v.avatar });
        }
    });
    return out;
}

function resumenClientes() {
    const lista = [...clientes.values()];
    const usuarios = {};
    lista.forEach((c) => {
        if (!c.usuario) return;
        usuarios[c.usuario] = usuarios[c.usuario] || {
            usuario: c.usuario, displayName: c.displayName || c.usuario, avatar: c.avatar || '',
            web: 0, local: 0
        };
        usuarios[c.usuario][c.origen === 'local' ? 'local' : 'web'] += 1;
    });
    // quién está usando cada nodo (lo anota el front al elegir una PC)
    const porNodo = porNodoActual();
    return {
        porNodo,
        total: lista.length,
        web: lista.filter((c) => c.origen !== 'local').length,
        local: lista.filter((c) => c.origen === 'local').length,
        anonimos: lista.filter((c) => !c.usuario).length,
        usuarios: Object.values(usuarios),
        usuariosTotal: Object.keys(usuarios).length,
        clientes: lista
    };
}

function avisarClientes() {
    const r = resumenClientes();
    // Mismo payload que el REST: los nodos son "apps locales" y tienen que
    // contarse del lado local también.
    r.appsLocales = state.peers.size;
    r.usuariosConNodo = [...new Set([...state.peers.values()].map((p) => p.usuario).filter(Boolean))];
    try { if (state.io) state.io.emit('red:clientes', r); } catch (e) { }
    // y a los nodos, para que su app local muestre lo mismo
    try { enviarATodos('red:clientes', r); } catch (e) { }
    return r;
}

// Marca con qué nodo está trabajando un cliente web (por su IP) para poder
// mostrar "clientes conectados a esta PC" en el panel RED de cada máquina.
let _tAvisoClientes = null;
function marcarClienteEnNodo(ip, peerId) {
    // peerId === '' => el cliente ya no está usando ninguna PC
    const ipLimpia = String(ip || '').split(',')[0].trim();
    if (!ipLimpia) return;
    let cambio = false;
    clientes.forEach((c) => {
        if (c.ip && c.ip === ipLimpia && c.peerId !== (peerId || undefined)) {
            if (peerId) { c.peerId = peerId; c.peerIdDesde = Date.now(); }
            else { delete c.peerId; }
            cambio = true;
        }
    });
    if (ipLimpia) anotarUsoNodo('ip:' + ipLimpia, peerId, {});
    // avisar a los nodos (para que el panel RED muestre "usando esta PC"),
    // con freno: esto corre en cada pedido HTTP que pasa por el túnel
    if (cambio && !_tAvisoClientes) {
        _tAvisoClientes = setTimeout(() => { _tAvisoClientes = null; try { avisarClientes(); } catch (e) { } }, 2500);
    }
}

function anotarCliente(socket, datos) {
    const h = (socket && socket.handshake) || {};
    const cab = (h.headers) || {};
    const ref = String(cab.origin || cab.referer || '');
    const esLocal = /127\.0\.0\.1|localhost|192\.168\.|10\.0\./i.test(ref) ||
        String((datos && datos.origen) || '') === 'local';
    const c = {
        id: socket.id,
        usuario: '',
        displayName: '',
        avatar: '',
        rol: '',
        origen: esLocal ? 'local' : 'web',
        ip: String(cab['x-forwarded-for'] || h.address || '').split(',')[0].trim(),
        navegador: String(cab['user-agent'] || '').slice(0, 60),
        desde: ahora(),
        peerId: (datos && datos.peerId) || ''
    };
    clientes.set(socket.id, c);
    console.log(`👤 Cliente conectado: ${c.usuario || 'anónimo'} · ${c.origen.toUpperCase()} · ip ${c.ip || '?'} · ${clientes.size} en total`);

    // El front se identifica apenas se conecta (o cuando inicia sesión).
    socket.on('cliente:yo', (d = {}) => {
        const token = d.token || '';
        const u = resolverUsuario(token);
        if (u) {
            // El JWT de fscauth trae {id, email, role} — SIN nombre. Si el token no
            // lo dice, se usa el que declara el front (y el hub lo corrige después
            // pidiéndole el perfil a fscauth).
            c.usuario = u.username || u.displayName || d.usuario || '';
            c.displayName = u.displayName || u.username || d.displayName || d.usuario || '';
            c.rol = u.role || d.rol || '';
            c.avatar = u.avatar || d.avatar || c.avatar || '';
            c.verificado = true;
        } else if (d.usuario) {
            c.usuario = d.usuario;
            c.displayName = d.displayName || d.usuario;
            c.avatar = d.avatar || '';
            c.verificado = false;
        }
        if (d.origen === 'local' || d.origen === 'web') c.origen = d.origen;
        if (d.peerId) c.peerId = d.peerId;
        console.log(`👤 Cliente identificado: ${c.usuario || '(sin sesión)'} · ${c.origen.toUpperCase()} · usuarios: ${resumenClientes().usuariosTotal}`);
        avisarClientes();
    });

    socket.on('disconnect', (motivo) => {
        clientes.delete(socket.id);
        console.log(`👋 Cliente desconectado: ${c.usuario || 'anónimo'} · ${c.origen.toUpperCase()} (${motivo}) · quedan ${clientes.size}`);
        avisarClientes();
    });

    avisarClientes();
    return c;
}

function listarClientes() { return resumenClientes(); }

// El hub corrige la ficha de un cliente ya conectado (p. ej. con el perfil que
// devuelve fscauth, que sí tiene el nombre y el avatar).
function actualizarCliente(id, datos = {}) {
    const c = clientes.get(id);
    if (!c) return null;
    if (datos.usuario) c.usuario = datos.usuario;
    if (datos.displayName) c.displayName = datos.displayName;
    if (datos.avatar) c.avatar = datos.avatar;
    if (datos.verificado !== undefined) c.verificado = !!datos.verificado;
    console.log(`👤 Cliente actualizado: ${c.usuario || '(sin sesión)'} · ${c.origen.toUpperCase()}`);
    avisarClientes();
    return c;
}

function iniciar(io, basePath) {
    state.io = io;
    state.basePath = basePath || '/comfylatam';

    const nsp = io.of('/agent');

    // Dos tokens válidos, ninguno "especial":
    //   NODO_TOKEN  -> el PÚBLICO: con éste entra cualquier PC que clone el repo,
    //                  sin configurar nada (compartir sigue siendo opt-IN, y para
    //                  pedir trabajo desde la web hay que loguearse).
    //   AGENT_TOKEN -> token interno del servidor para mantenimiento. NO hace
    //                  falta para conectarse a la red.
    const NODO_TOKEN = process.env.RED_NODO_TOKEN || 'comfylatam-nodo-2026';
    nsp.use((socket, next) => {
        const t = (socket.handshake.auth && socket.handshake.auth.token) || socket.handshake.query.token || '';
        if (!AGENT_TOKEN) return next(new Error('AGENT_TOKEN no configurado en el servidor'));
        const valido = String(t) === AGENT_TOKEN || (NODO_TOKEN && String(t) === NODO_TOKEN);
        if (!valido) {
            console.log(`⛔ Nodo rechazado: token inválido (${String(t).length} chars). Un clone nuevo usa el token público del repo.`);
            return next(new Error('token de agente invalido'));
        }
        if (String(t) === NODO_TOKEN) console.log('👋 Nodo entrando con el token PÚBLICO (instalación nueva)');
        return next();
    });

    nsp.on('connection', (socket) => {
        const p = crearPeer(socket, socket.handshake.auth || {});
        const anterior = state.peers.get(p.id);
        if (anterior && anterior.socket && anterior.socket !== socket) {
            try { anterior.socket.disconnect(true); } catch (e) { }
        }
        state.peers.set(p.id, p);
        state.historial.delete(p.id);
        const ip = ((socket.handshake.headers && socket.handshake.headers['x-forwarded-for']) ||
            (socket.handshake && socket.handshake.address) || '').split(',')[0].trim();
        console.log('─'.repeat(70));
        console.log(`🔌 NODO CONECTADO AL VPS: ${p.nombre} (${p.id})`);
        console.log(`   desde ${ip || '?'} · app ${p.host || '?'}${p.principal ? ' · PRINCIPAL' : ''}${p.compartir ? ' · comparte su Comfy' : ' · no comparte'}`);
        console.log(`   ${state.peers.size} app(s) local(es) conectada(s)`);
        console.log('─'.repeat(70));
        registro.anotar('conectado', {
            peerId: p.id, nombre: p.nombre, host: p.host, gpu: p.gpu,
            usuario: p.usuario || '', ip: ip || '', compartir: !!p.compartir, version: p.version || ''
        });
        avisarPeers();

        socket.on('agent:hello', (info) => {
            const i = info || {};
            p.nombre = i.nombre || p.nombre;
            p.host = i.host || p.host;
            p.email = i.email || p.email || '';
            p.hostname = i.hostname || p.hostname || '';
            p.gpu = i.gpu || p.gpu;
            p.modelos = Array.isArray(i.modelos) ? i.modelos : p.modelos;
            p.version = i.version || p.version;
            // El nodo puede estar LIMPIANDO su perfil (avatar/usuario vacíos): si
            // mandó el campo, vale lo que mandó — si no, se conserva lo que había.
            p.avatar = (i.avatar !== undefined) ? (i.avatar || '') : (p.avatar || '');
            p.usuario = (i.usuario !== undefined) ? (i.usuario || '') : (p.usuario || '');
            p.compartir = i.compartir === true || i.compartir === 'true';
            if (i.principal !== undefined) p.principal = i.principal === true || i.principal === 'true';
            p.ultimoLatido = ahora();
            if (p.principal || state.peers.size === 1) { state.agent = socket; state.info = i; }
            console.log(`ℹ️  Nodo ${p.id} se presentó: ${p.nombre} | usuario ${p.usuario || '(sin sesión)'} | host ${p.host} | gpu ${p.gpu || '?'} | compartir ${p.compartir} | modelos ${(p.modelos || []).length}`);
            registro.anotar('presentado', {
                peerId: p.id, nombre: p.nombre, host: p.host, gpu: p.gpu,
                usuario: p.usuario || '', email: p.email || '', compartir: !!p.compartir,
                principal: !!p.principal, modelos: (p.modelos || []).length
            });
            // que el hub anote la computadora YA (no esperar los 30 s del latido)
            if (typeof state.alPresentarse === 'function') {
                try { state.alPresentarse(p); } catch (e) { }
            }
            avisarPeers();
        });

        socket.on('tunnel:http:result', (r) => {
            if (!r || !r.reqId) return;
            const pd = pendientes.get(r.reqId);
            if (pd) {
                pendientes.delete(r.reqId);
                clearTimeout(pd.timer);
                pd.resolve(r);
                return;
            }
            // El hub pide TODO con alStream (para la media grande), pero el nodo
            // contesta con un 'result' simple cuando la respuesta NO es media (un
            // JSON de /api/images, /api/examples, etc.). Antes se buscaba solo en
            // 'pendientes', no estaba, y se DESCARTABA: el pedido quedaba colgado
            // hasta el timeout ('timeout esperando al nodo') y la web no veia nada.
            const es = enStream.get(r.reqId);
            if (!es) return;
            enStream.delete(r.reqId);
            clearTimeout(es.timer);
            try { es.meta({ status: r.status, contentType: r.contentType, headers: r.headers || {} }); } catch (e) { }
            try { if (r.body) es.chunk(Buffer.from(r.body)); } catch (e) { }
            try { es.fin(r.body ? Buffer.from(r.body).length : 0); } catch (e) { }
        });

        // --- respuesta EN PEDAZOS (media grande): nunca se junta en memoria ---
        socket.on('tunnel:http:meta', (r) => {
            const es = enStream.get(r && r.reqId);
            if (!es) return;
            try { es.meta(r); } catch (e) { }
        });
        socket.on('tunnel:http:chunk', (r) => {
            const es = enStream.get(r && r.reqId);
            if (!es) return;
            try { es.chunk(r.chunk); } catch (e) { }
        });
        socket.on('tunnel:http:fin', (r) => {
            const es = enStream.get(r && r.reqId);
            if (!es) return;
            enStream.delete(r.reqId);
            clearTimeout(es.timer);
            try { es.fin(r.bytes); } catch (e) { }
        });

        socket.on('tunnel:ws:broadcast', ({ data } = {}) => {
            p.ultimoLatido = ahora();
            if (typeof onBroadcast === 'function' && data != null) onBroadcast(p.id, data);
        });

        socket.on('agent:log', (line) => console.log(`[${p.id}]`, line));

        // Estado que reporta la PC: app local + Comfy + cola.
        socket.on('tunnel:estado', (datos) => {
            p.estado = Object.assign({}, datos || {}, { recibido: ahora() });
            p.ultimoLatido = ahora();
            if (p.principal || state.peers.size === 1) {
                state.estado = Object.assign({}, datos || {}, { recibido: ahora() });
            }
            avisarPeers();
        });

        // El dueño habilitó / deshabilitó compartir su Comfy.
        socket.on('agent:compartir', (datos) => {
            p.compartir = !!(datos && (datos.compartir === true || datos.compartir === 'true'));
            p.ultimoLatido = ahora();
            console.log(`🔓 Nodo ${p.id} compartir=${p.compartir}`);
            avisarPeers();
        });

        // Métrica de trabajos de la red
        socket.on('red:job:estado', (d) => {
            if (!d) return;
            if (d.evento === 'inicio') p.trabajos = (p.trabajos || 0) + 1;
            if (d.evento === 'fin' && p.trabajos > 0) p.trabajos -= 1;
            avisarPeers();
        });

        socket.on('disconnect', (motivo) => {
            const actual = state.peers.get(p.id);
            if (actual && actual.socket === socket) {
                state.peers.delete(p.id);
                // queda como conexión pasada (la pestaña RED lo puede mostrar
                // con el ojito; por defecto NO se lista)
                console.log(`🔌 NODO DESCONECTADO DEL VPS: ${p.nombre} (${p.id}) — ${motivo || 'sin motivo'} · quedan ${state.peers.size - 1} app(s)`);
                registro.anotar('desconectado', { peerId: p.id, nombre: p.nombre, motivo: motivo || '' });
            state.historial.set(p.id, Object.assign(publico(p), {
                    conectado: false, visto: ahora(), comfy: false, encolados: 0
                }));
                console.log(`❌ Nodo desconectado: ${p.id} (${motivo})`);
                if (state.agent === socket) state.agent = null;
                for (const [reqId, es] of enStream) {
                    clearTimeout(es.timer);
                    try { es.error(new Error('nodo desconectado')); } catch (e) { }
                    enStream.delete(reqId);
                }
                for (const [reqId, pd] of pendientes) {
                    if (pd.peerId === p.id) {
                        clearTimeout(pd.timer);
                        pd.reject(new Error('nodo desconectado'));
                        pendientes.delete(reqId);
                    }
                }
                avisarPeers();
            }
        });
    });
}

function estado() {
    const pr = principal();
    state.agent = pr ? pr.socket : null;
    return state;
}

function enviarA(peerId, evento, payload) {
    const p = peer(peerId);
    if (!p || !p.socket || !p.socket.connected) return false;
    p.socket.emit(evento, payload);
    return true;
}

function enviarAlAgente(evento, payload) { return enviarA(null, evento, payload); }

// A TODOS los nodos conectados (lo usa el hub para bajar eventos de la red).
function enviarATodos(evento, payload, excluirPeerId) {
    let n = 0;
    for (const p of state.peers.values()) {
        if (excluirPeerId && p.id === excluirPeerId) continue;
        if (p.socket && p.socket.connected) {
            try { p.socket.emit(evento, payload); n++; } catch (e) { }
        }
    }
    return n;
}

function alRecibirBroadcast(cb) { onBroadcast = cb; }
function alCambiarPeers(cb) { onPeers = cb; }

// --- Relay HTTP ----------------------------------------------------------
function juntarCuerpo(stream) {
    return new Promise((resolve, reject) => {
        const partes = [];
        stream.on('data', (c) => partes.push(c));
        stream.on('end', () => resolve(Buffer.concat(partes)));
        stream.on('error', reject);
    });
}

// Origen publico: las URLs de media tienen que ser ABSOLUTAS porque el front
// las usa directo como src; una ruta relativa apunta al dominio del FTP, que
// no tiene esos archivos (dan 404). En local se usa el host de la peticion.
function origenPublico() {
    return (process.env.PUBLIC_ORIGIN || 'https://vps-4455523-x.dattaweb.com').replace(/\/+$/, '');
}

// Reescribe las URLs que devuelve el editor local:
//   - si el archivo ya esta en Cloudflare R2 -> devuelve la URL publica (CDN)
//   - si no -> la pasa por el relay (/jpiassets/uploads/...)
// Prefijo del nodo: el principal va sin prefijo (compat con todo el editor),
// los demás por /p/<id>/ para no mezclar la media de cada PC.
function prefijoDe(peerId) {
    if (!peerId) return '';
    const p = state.peers.get(peerId);
    if (!p || p.principal) return '';
    return '/p/' + encodeURIComponent(peerId);
}

function reescribirUrl(v, basePath, peerId) {
    if (typeof v !== 'string') return v;
    if (!/^\/(uploads|videos|audio|presets|projects)\//.test(v)) return v;
    const nombre = v.split('/').pop().split('?')[0];
    const enR2 = mediaMap.urlDeArchivo(nombre);
    if (enR2) return enR2;
    return (basePath || '') + prefijoDe(peerId) + v;
}

function reescribirJson(texto, basePath, peerId) {
    let data;
    try { data = JSON.parse(texto); } catch (e) { return null; }

    const arreglar = (v) => {
        if (typeof v === 'string') return reescribirUrl(v, basePath, peerId);
        if (Array.isArray(v)) return v.map(arreglar);
        if (v && typeof v === 'object') {
            const o = {};
            for (const k of Object.keys(v)) o[k] = arreglar(v[k]);
            return o;
        }
        return v;
    };

    return JSON.stringify(arreglar(data));
}

// Para los mensajes del websocket (el editor manda "/uploads/x.png" y con eso
// arma el <img>): mismo criterio que arriba, pero sobre texto.
function reescribirTexto(texto, basePath, peerId) {
    if (!texto || typeof texto !== 'string') return texto;
    return texto.replace(/["'](\/(?:uploads|videos|audio)\/[^"']+)["']/g, (todo, ruta) => {
        const reemplazo = reescribirUrl(ruta, basePath, peerId);
        return '"' + reemplazo + '"';
    });
}

async function reenviarHttp({ peerId, method, ruta, query, contentType, range, stream, origen, alStream, authorization, cookie, usuario }) {
    const nodo = peer(peerId);
    if (!nodo || !nodo.socket || !nodo.socket.connected) throw new Error('nodo offline');

    const sinCuerpo = method === 'GET' || method === 'HEAD';
    // base absoluta para reescribir las URLs de la respuesta (media)
    const baseAbs = (origen || origenPublico()) + state.basePath;
    const body = sinCuerpo ? null : await juntarCuerpo(stream);

    const reqId = 'h' + (++seq) + '-' + Date.now();

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendientes.delete(reqId);
            reject(new Error('timeout esperando al nodo'));
        }, TIMEOUT_HTTP);

        if (alStream) {
            // Se resuelve apenas llegan las cabeceras; los pedazos se escriben
            // directo (alStream.chunk) y el cierre avisa (alStream.fin).
            enStream.set(reqId, {
                timer,
                meta: (m) => {
                    clearTimeout(timer);
                    // primero el caller escribe las cabeceras (si no, los pedazos
                    // salen sin Content-Type ni 206 y el video no se puede mover)
                    try { if (alStream.meta) alStream.meta(m); } catch (e) { }
                    resolve({ streamed: true, status: m.status, contentType: m.contentType, headers: m.headers || {} });
                },
                chunk: (c) => alStream.chunk(c),
                fin: (bytes) => alStream.fin(bytes),
                error: (e) => { alStream.error(e); resolve({ streamed: true, error: e }); }
            });
        } else {
            pendientes.set(reqId, { resolve, reject, timer, peerId: nodo.id });
        }

        nodo.socket.emit('tunnel:http', {
            authorization: authorization || '',
            cookie: cookie || '',
            // quién pide (username): el nodo filtra los workflows restringidos
            usuario: usuario || '',
            reqId,
            method,
            ruta,
            query: query || '',
            contentType: contentType || '',
            // Range es clave para los <video>: sin esto el navegador pide el
            // archivo entero (y con 400 videos se cae todo).
            range: range || '',
            body: body || null
        });
    }).then((r) => {
        if (r && r.streamed) return r;
        const cuerpo = Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body || '');
        const esJson = String(r.contentType || '').includes('json');
        let jsonReescrito = null;
        if (esJson && cuerpo.length) {
            jsonReescrito = reescribirJson(cuerpo.toString('utf8'), baseAbs, nodo.principal ? null : nodo.id);
        }
        return {
            status: r.status || 200,
            contentType: r.contentType || 'application/octet-stream',
            headers: r.headers || {},
            body: cuerpo,
            jsonReescrito
        };
    });
}

// El hub se engancha acá para anotar la computadora en IACOMFY en el momento
// en que el nodo se presenta (antes sólo pasaba cada 30 s y si fallaba no se
// sabía nada).
function alPresentarse(fn) { state.alPresentarse = fn; }

module.exports = {
    alPresentarse,
    anotarUsoNodo, porNodoActual, anotarCliente, listarClientes, resumenClientes, avisarClientes, setResolutorUsuario, actualizarCliente,
    iniciar, estado, enviarAlAgente, enviarA, enviarATodos, alRecibirBroadcast, alCambiarPeers,
    reenviarHttp, reescribirJson, marcarClienteEnNodo, reescribirUrl, reescribirTexto, origenPublico,
    listarPeers, listarPasados, peer, principal, prefijoDe, avisarPeers, publico
};
