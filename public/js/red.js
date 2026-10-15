// ============================================================
// COMFYLATAM — pestaña RED (red de Comfys)
// ------------------------------------------------------------
// Lista los NODOS conectados (cada app corriendo en una PC con su
// Comfy), deja ELEGIR en cuál generar y muestra cuál está elegido.
// Si esta app corre en local, además deja compartir SU Comfy.
//
//   local : hablo con MI app (/api/red/estado + su websocket)
//   web   : hablo con el hub (/api/red/peers, /api/red/generar) y
//           escucho socket.io (red:peers / red:evento)
// ============================================================
(function () {
    'use strict';

    var J = window.JPI || {};
    var BASE = J.API_BASE || '';
    var esLocal = !!J.esServidor;
    var CLAVE_ELEGIDO = 'comfylatam_nodo_elegido';

    var CLAVE_PASADOS = 'comfylatam_ver_pasados';
    var ESTADO = {
        peers: [],
        pasados: [],         // conexiones pasadas (desconectados / sin transmisión)
        yo: null,            // solo en local: mi nodo
        elegido: null,       // peerId al que le voy a mandar los trabajos
        verPasados: false,   // ojito: por defecto NO se indexan
        log: []
    };
    try { ESTADO.verPasados = localStorage.getItem(CLAVE_PASADOS) === '1'; } catch (e) { }

    var socket = null;
    var wsLocal = null;
    var ultimaFirmaYo = '';

    // ---------- helpers ----------
    function api(ruta, opciones) {
        var url = (ruta.indexOf('http') === 0) ? ruta : (BASE + ruta);
        var o = opciones || {};
        o.headers = Object.assign({}, o.headers || {});
        var token = J.TOKEN;
        try { token = localStorage.getItem('fsc_token_jpi') || token; } catch (e) { }
        if (token) o.headers['Authorization'] = 'Bearer ' + token;
        if (o.json !== undefined) {
            o.headers['Content-Type'] = 'application/json';
            o.body = JSON.stringify(o.json);
            o.method = o.method || 'POST';
            delete o.json;
        }
        return fetch(url, o).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (d) {
                return { ok: r.ok, status: r.status, datos: d };
            });
        });
    }

    function log(txt) {
        var hora = new Date().toLocaleTimeString('es-AR');
        ESTADO.log.push('[' + hora + '] ' + txt);
        if (ESTADO.log.length > 140) ESTADO.log.shift();
        var caja = document.getElementById('redLog');
        if (caja) { caja.textContent = ESTADO.log.join('\n'); caja.scrollTop = caja.scrollHeight; }
    }

    function esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function guardarElegido(id) {
        ESTADO.elegido = id;
        try { localStorage.setItem(CLAVE_ELEGIDO, id || ''); } catch (e) { }
    }
    function leerElegido() {
        try { return localStorage.getItem(CLAVE_ELEGIDO) || ''; } catch (e) { return ''; }
    }

    // ---------- UI ----------
    function montarUI() {
        if (document.getElementById('panelRed')) return;

        // Botón visible: en la barra superior junto con Previz, Stage, CREATE, etc.
        var btn = document.getElementById('tabRedBtn');
        if (!btn) {
            btn = document.createElement('button');
            btn.className = 'tab-button tab-button-std red-tab-btn';
            btn.id = 'tabRedBtn';
            btn.setAttribute('data-target', 'panelRed');
            btn.textContent = '🌎 RED';
            btn.title = 'Red ComfyLatam: elegir en qué Comfy de la red generar';
            var arriba = document.querySelector('.tabs-container');
            if (arriba) arriba.appendChild(btn);
            else {
                var barra = document.getElementById('projectTabsNav');
                if (barra) barra.appendChild(btn);
                else document.body.appendChild(btn);
            }
        }

        // panel dentro de .workspace-content (así convive con las otras pestañas)
        var contenedor = document.querySelector('.workspace-content') ||
            document.querySelector('main') || document.body;
        var panel = document.createElement('div');
        panel.className = 'tab-content red-panel';
        panel.id = 'panelRed';
        panel.innerHTML = [
            '<div class="red-head">',
            '  <h2>🌎 RED COMFYLATAM</h2>',
            '  <span class="red-badge" id="redModo"></span>',
            '  <span class="red-badge" id="redResumen"></span>',
            '  <button class="red-btn secundario" id="redRefrescar">Actualizar</button>',
            '</div>',
            '<p class="red-sub">Cada persona que corre la app en su PC aporta su Comfy a la red. ',
            'Elegí el nodo, escribí el prompt y el trabajo se hace en la máquina de esa persona: acá llega el resultado.</p>',

            '<div class="red-elegido" id="redElegidoCaja"></div>',
            '<div class="red-aviso" id="redAviso"></div>',

            '<div class="red-disponibles" id="redDisponibles"></div>',
            '<h3 class="red-titulo">🖥️ NODOS CONECTADOS <span id="redCantidad"></span>',
            '  <button class="red-ojo" id="redOjo" title="Ver también los que no están transmitiendo y las conexiones pasadas"></button>',
            '</h3>',
            '<div class="red-leyenda">🟢 listo para generar · 🟡 ocupado (en cola) · ⚪ apagado / sin transmitir · ',
            'el nodo sale de la lista cuando se desconecta (queda en las conexiones pasadas, con el ojito).</div>',
            '<div class="red-grid" id="redNodos"></div>',

            '<div id="redMio"></div>',

            // Esto antes vivía en el panel izquierdo (⚡ COMFYLATAM / Entorno /
            // ComfyUI / Estado): se movió acá, que es donde tiene sentido.
            // Cuántos clientes/usuarios hay conectados y de qué tipo (web o local)
            '<div class="red-clientes" id="redClientes"></div>',

            '<div class="red-equipo" id="redEquipo">',
            '  <h3 class="red-titulo">⚡ TU EQUIPO</h3>',
            '  <div class="red-eq-filas">',
            '    <div class="red-eq-fila"><span>Entorno</span><b id="redEqEntorno">—</b></div>',
            '    <div class="red-eq-fila"><span>ComfyUI</span><b id="redEqComfy">—</b></div>',
            '    <div class="red-eq-fila"><span>Estado</span><b id="redEqEstado">—</b></div>',
            '  </div>',
            '  <button class="red-btn secundario" id="redEqConfig">⚙️ Configurar ComfyUI</button>',
            '</div>',

            '<div class="red-gen">'<h3 class="red-titulo">👥 CLIENTES CONECTADOS</h3>' +
                '<div class="red-sub-chico">Todavía no hay nadie más conectado.</div>';
            return;
        }

        var filas = usuarios.map(function (u) {
            var foto = u.avatar ? '<img class="red-avatar" src="' + esc(u.avatar) + '" alt="">' : '👤 ';
            var tipos = [];
            if (u.web) tipos.push(u.web + ' web');
            if (u.local) tipos.push(u.local + ' local');
            return '<div class="red-cliente-fila">' + foto +
                '<b>@' + esc(u.usuario) + '</b>' +
                '<span class="red-cliente-tipo">' + tipos.join(' · ') + '</span></div>';
        }).join('');

        caja.innerHTML = [
            '<h3 class="red-titulo">👥 CLIENTES CONECTADOS <span class="red-badge">' + total + '</span></h3>',
            '<div class="red-cliente-resumen">',
            '  <span>🌐 ' + (c.web || 0) + ' en la web</span>',
            '  <span>💻 ' + ((c.local || 0) + (c.appsLocales || 0)) + ' en local</span>',
            '  <span>👤 ' + (c.usuariosTotal || 0) + ' usuario(s)</span>',
            (c.anonimos ? '  <span class="red-cliente-anon">' + c.anonimos + ' sin sesión</span>' : ''),
            '</div>',
            filas ? '<div class="red-clientes-lista">' + filas + '</div>' : '',
            '<div class="red-sub-chico">Un <b>cliente</b> es cada navegador conectado (la web o una app local). ' +
            'La app local además aparece como nodo, con su Comfy.</div>'
        ].join('\n');
    }

    // --- el equipo: entorno, ComfyUI en uso y estado (antes en el panel izq) ---
    function pintarEquipo() {
        var ent = document.getElementById('redEqEntorno');
        var com = document.getElementById('redEqComfy');
        var est = document.getElementById('redEqEstado');
        if (!ent) return;
        ent.textContent = esLocal ? '💻 LOCAL' : '🌐 WEB';

        api('/api/config/comfy').then(function (r) {
            var d = r.datos || {};
            if (com) com.textContent = d.base || d.address || '—';
        }).catch(function () { });

        api('/api/status').then(function (r) {
            var d = r.datos || {};
            if (est) {
                est.textContent = d.comfy ? '🟢 Conectado' : '🔴 Sin ComfyUI';
                est.className = d.comfy ? 'bien' : 'mal';
            }
        }).catch(function () { });
    }

    function refrescar(manual) {
        var ruta = esLocal ? '/api/red/estado' : '/api/red/peers';
        return api(ruta).then(function (r) {
            if (!r.ok) {
                if (r.status === 401) log('🔒 Entrá con tu cuenta para ver la red.');
                else log('⚠️ No pude leer la red: HTTP ' + r.status + ' ' + (r.datos.message || ''));
                return;
            }
            if (esLocal) {
                ESTADO.yo = {
                    peerId: r.datos.peerId,
                    nombre: r.datos.nombre,
                    compartir: !!r.datos.compartir,
                    conectado: !!r.datos.conectado,
                    modelos: r.datos.modelos || []
                };
                ESTADO.peers = r.datos.nodos || [];
                ESTADO.pasados = r.datos.pasados || [];
                ESTADO.clientes = r.datos.clientes || ESTADO.clientes;
                ESTADO.enVueloDetalle = r.datos.enVueloDetalle || [];
                ESTADO.computadora = r.datos.computadora || ESTADO.computadora;
            } else {
                ESTADO.yo = null;
                ESTADO.peers = r.datos.peers || [];
                ESTADO.pasados = r.datos.pasados || [];
                api('/api/red/clientes').then(function (rc) {
                    if (rc.ok && rc.datos) { ESTADO.clientes = rc.datos; pintarClientes(); }
                }).catch(function () { });
            }
            if (manual) log('🔄 Red actualizada: ' + ESTADO.peers.length + ' nodo(s)');
            pintar();
            pintarEquipo();
            pintarClientes();
        }).catch(function (e) { if (manual) log('⚠️ ' + e.message); });
    }

    // ---------- generar ----------
    function generar() {
        var prompt = (document.getElementById('redPrompt').value || '').trim();
        if (!prompt) { log('⚠️ Falta el prompt'); return; }
        var destino = document.getElementById('redDestino').value || ESTADO.elegido;
        if (!destino) { log('⚠️ No hay ningún nodo para generar'); return; }
        var modelo = document.getElementById('redModelo').value;
        var steps = parseInt(document.getElementById('redSteps').value) || 10;
        var ancho = parseInt(document.getElementById('redAncho').value) || 1024;
        var btn = document.getElementById('redGenerar');
        btn.disabled = true;
        log('🚀 Mandando a ' + nombreDe(destino) + ' (' + modelo + ', ' + ancho + 'px, ' + steps + ' steps)...');
        api('/api/red/generar', {
            json: {
                pedidoPor: (typeof window.quienPide === 'function') ? window.quienPide() : null,
                peerId: destino,
                tipo: modelo === 'ltx2' ? 'video' : 'imagen',
                prompt: prompt,
                modelo: modelo,
                params: { videoWidth: ancho, videoHeight: ancho, samplerSteps: steps, seed: -1 }
            }
        }).then(function (r) {
            if (!r.ok || r.datos.success === false) log('❌ ' + (r.datos.message || ('HTTP ' + r.status)));
            else log('✅ Trabajo aceptado' + (r.datos.local ? ' (acá mismo)' : ' por ' + ((r.datos.peer && r.datos.peer.nombre) || nombreDe(destino))) +
                (r.datos.jobId ? ' · job ' + r.datos.jobId : ''));
        }).catch(function (e) { log('❌ ' + e.message); })
            .then(function () { btn.disabled = false; });
    }

    // ---------- eventos en vivo ----------
    function conectarEventos() {
        if (esLocal) {
            if (!J.WS) return;
            try {
                wsLocal = new WebSocket(J.WS);
                wsLocal.onmessage = function (ev) {
                    var m = null;
                    try { m = JSON.parse(ev.data); } catch (e) { return; }
                    if (!m) return;
                    if (m.type === 'red_estado' && m.red) {
                        // Los pedidos que llegan por la red se muestran aparte del batch propio
                        window.JPI_RED_VUELO = m.red.enVueloDetalle || [];
                        if (typeof window.jpiPintarVuelo === 'function') { try { window.jpiPintarVuelo(); } catch (e) { } }
                        ESTADO.yo = {
                            peerId: m.red.peerId, nombre: m.red.nombre,
                            compartir: !!m.red.compartir, conectado: !!m.red.conectado,
                            modelos: m.red.modelos || []
                        };
                        ESTADO.peers = m.red.nodos || [];
                        ESTADO.pasados = m.red.pasados || [];
                        pintar();
                    }
                    if (m.type === 'red_job' && m.job) log('🎯 Trabajo de ' + (m.job.de || '?') + ' encolado acá');
                    if (m.type === 'red_evento' && m.evento) verEvento(m.evento);
                };
                wsLocal.onclose = function () { setTimeout(conectarEventos, 4000); };
            } catch (e) { }
            return;
        }
        if (typeof io === 'function') {
            try {
                socket = io(J.ORIGIN, { path: J.BASE + '/socket.io', transports: ['websocket', 'polling'] });
                // El hub necesita saber quién mira: usuario (token) + si es local o web
                function identificarme() {
                    var tok = '';
                    try { tok = localStorage.getItem('fsc_token_jpi') || ''; } catch (e) { }
                    var u = null;
                    try { u = JSON.parse(localStorage.getItem('fsc_user_jpi') || 'null'); } catch (e) { }
                    socket.emit('cliente:yo', {
                        token: tok, origen: 'web',
                        usuario: (u && (u.username || u.displayName)) || '',
                        displayName: (u && (u.displayName || u.username)) || '',
                        avatar: (u && u.avatar) || ''
                    });
                    if (u) log('👤 conectado como @' + (u.username || u.displayName));
                }
                socket.on('connect', identificarme);
                socket.on('red:clientes', function (d) { ESTADO.clientes = d || ESTADO.clientes; pintarClientes(); });
                socket.on('red:peers', function (d) {
                    ESTADO.peers = (d && d.peers) || [];
                    pintar();
                });
                socket.on('red:evento', function (d) { verEvento(d); });
            } catch (e) { log('⚠️ socket.io: ' + e.message); }
        }
    }

    function verEvento(d) {
        if (!d || !d.data) return;
        var m = null;
        try { m = JSON.parse(d.data); } catch (e) { return; }
        if (!m) return;
        if (m.type === 'storyboard_generated' || m.type === 'video_generated') {
            log('🖼️ ' + (d.nombre || d.peerId) + ' terminó: ' + m.filename);
            if (ESTADO.elegido && d.peerId === ESTADO.elegido && m.url) log('   resultado: ' + m.url);
        }
    }

    function arrancar() {
        montarUI();
        ESTADO.elegido = leerElegido();
        refrescar(false);
        conectarEventos();
        setInterval(function () { refrescar(false); }, 7000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar);
    else arrancar();
})();
