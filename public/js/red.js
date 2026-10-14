// ============================================================
// COMFYLATAM — pestaña RED (red de Comfys)
// ------------------------------------------------------------
// Cada app que corre en una PC se publica como NODO. Acá se ve la
// lista de nodos conectados, se elige en cuál generar y (si estoy
// corriendo la app en local) se habilita compartir mi Comfy.
//
//   local : hablo con MI app (/api/red/estado) y con su websocket.
//   web   : hablo con el hub (/api/red/peers, /api/red/generar) y
//           escucho socket.io (red:peers / red:evento).
// ============================================================
(function () {
    'use strict';

    var J = window.JPI || {};
    var BASE = J.API_BASE || '';
    var esLocal = !!J.esServidor;
    var ESTADO = { peers: [], yo: null, elegido: null, nodos: 0 };
    var logLineas = [];
    var socket = null;

    // ---------- helpers ----------
    function api(ruta, opciones) {
        var url = (ruta.indexOf('http') === 0) ? ruta : (BASE + ruta);
        var o = opciones || {};
        o.headers = Object.assign({}, o.headers || {});
        // el token se lee en vivo: si el usuario entra después de cargar la
        // página, la pestaña RED ya anda sin recargar
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
        logLineas.push('[' + hora + '] ' + txt);
        if (logLineas.length > 120) logLineas.shift();
        var caja = document.getElementById('redLog');
        if (caja) { caja.textContent = logLineas.join('\n'); caja.scrollTop = caja.scrollHeight; }
    }

    function esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ---------- UI ----------
    function montarUI() {
        if (document.getElementById('tabRedBtn')) return;

        // botón de pestaña, al lado de SETTINGS
        var nav = document.querySelector('.workspace-header .tabs') ||
            document.querySelector('.workspace-header nav') ||
            document.querySelector('.workspace-header');
        var btn = document.createElement('button');
        btn.className = 'tab-btn';
        btn.id = 'tabRedBtn';
        btn.textContent = '🌎 RED';
        btn.title = 'Red ComfyLatam: usar el Comfy de otras personas';
        if (nav) nav.appendChild(btn);

        // panel (dentro de .workspace-content: así el editor lo trata como una
        // pestaña más y lo desactiva solo cuando tocás otra)
        var main = document.querySelector('.workspace-content') || document.querySelector('main') || document.body;
        var panel = document.createElement('div');
        panel.className = 'tab-content red-panel';
        panel.id = 'panelRed';
        panel.innerHTML = [
            '<div class="red-head"><h2>🌎 RED COMFYLATAM</h2>',
            '<span class="red-badge" id="redModo"></span>',
            '<button class="red-btn secundario" id="redRefrescar">Actualizar</button>',
            '</div>',
            '<p class="red-sub">Cada persona que corre la app en su PC aporta su Comfy a la red. ',
            'El trabajo se hace en la máquina del nodo que elijas: acá llega el resultado.</p>',
            '<div id="redMio"></div>',
            '<div class="red-aviso" id="redAviso"></div>',
            '<div class="red-grid" id="redNodos"></div>',
            '<div class="red-gen">',
            '  <h3>🎯 GENERAR EN LA RED</h3>',
            '  <textarea id="redPrompt" placeholder="Escribí el prompt y elegí en qué nodo generarlo..."></textarea>',
            '  <div class="red-fila">',
            '    <select id="redModelo">',
            '      <option value="zimage">Z-Image Turbo (imagen, rápido)</option>',
            '      <option value="qwen21">Qwen-Image 2.1 (imagen, mejor calidad)</option>',
            '      <option value="ltx2">LTX-2 (video)</option>',
            '    </select>',
            '    <select id="redDestino"></select>',
            '    <input type="number" id="redSteps" value="10" min="1" max="40" style="width:82px" title="steps">',
            '    <input type="number" id="redAncho" value="1024" min="256" max="2048" step="64" style="width:92px" title="ancho">',
            '    <button class="red-btn" id="redGenerar">GENERAR EN LA RED</button>',
            '  </div>',
            '  <div class="red-log" id="redLog">Todavía no hay movimientos.</div>',
            '</div>'
        ].join('\n');
        if (main) main.appendChild(panel);

        // botón/cajón mobile si existe la barra inferior
        var barra = document.querySelector('.mobile-bar, #mobileBar');
        if (barra) {
            var mb = document.createElement('button');
            mb.type = 'button';
            mb.id = 'mobRed';
            mb.className = 'mobile-tab';
            mb.textContent = '🌎 RED';
            barra.appendChild(mb);
            mb.addEventListener('click', function () { abrir(); });
        }

        btn.addEventListener('click', function () { abrir(); });
        document.getElementById('redRefrescar').addEventListener('click', function () { refrescar(true); });
        document.getElementById('redGenerar').addEventListener('click', generar);
        document.getElementById('redNodos').addEventListener('click', function (e) {
            var card = e.target.closest('.red-nodo');
            if (!card) return;
            ESTADO.elegido = card.getAttribute('data-peer');
            pintar();
        });

        document.getElementById('redModo').textContent = esLocal ? '💻 LOCAL' : '🌐 WEB';
    }

    function abrir() {
        var panel = document.getElementById('panelRed');
        if (!panel) return;
        // misma mecánica que las otras pestañas del editor
        document.querySelectorAll('.workspace-content .tab-content').forEach(function (p) {
            p.classList.toggle('active', p === panel);
        });
        panel.classList.add('active');
        if (typeof window.cerrarCajonesMobile === 'function') try { window.cerrarCajonesMobile(); } catch (e) { }
        refrescar(false);
    }
    window.cerrarRed = abrir;

    // ---------- datos ----------
    function pintar() {
        var cont = document.getElementById('redNodos');
        if (!cont) return;

        // mi nodo (solo en local)
        var cajaMio = document.getElementById('redMio');
        if (esLocal && ESTADO.yo) {
            cajaMio.innerHTML = [
                '<div class="red-mio">',
                '  <div class="datos">',
                '    <span class="titulo">💻 ' + esc(ESTADO.yo.nombre) + ' <span class="red-badge principal">tu nodo</span></span>',
                '    <span class="meta">id ' + esc(ESTADO.yo.peerId) + ' · conectado a la red: ' + (ESTADO.yo.conectado ? 'sí' : 'no (corré conectar-comfylatam.bat)') + '</span>',
                '  </div>',
                '  <label class="red-switch"><input type="checkbox" id="redCompartir"' + (ESTADO.yo.compartir ? ' checked' : '') + '>',
                '    <span class="pista"></span><span>Compartir mi Comfy en la red</span></label>',
                '</div>'
            ].join('\n');
            var chk = document.getElementById('redCompartir');
            if (chk) {
                chk.addEventListener('change', function () {
                    api('/api/red/compartir', { json: { compartir: chk.checked } }).then(function (r) {
                        log(chk.checked ? '✅ Compartiendo mi Comfy con la red' : '🔒 Dejé de compartir mi Comfy');
                        if (r.datos && r.datos.hub && r.datos.hub.ok === false) log('⚠️ hub: ' + (r.datos.hub.motivo || 'no pude avisarle'));
                        refrescar(true);
                    });
                });
            }
        } else {
            cajaMio.innerHTML = '';
        }

        // aviso de login en la web
        var aviso = document.getElementById('redAviso');
        if (!esLocal && !J.TOKEN) {
            aviso.style.display = 'block';
            aviso.textContent = 'Para usar la red tenés que entrar con tu cuenta de fullscreencode.';
        } else {
            aviso.style.display = 'none';
        }

        // grilla
        var peers = ESTADO.peers.filter(function (p) { return esLocal ? true : p.compartir; });
        if (!peers.length) {
            cont.innerHTML = '<div class="red-nodo"><div class="nombre">😴 No hay nodos ofreciendo Comfy</div>' +
                '<div class="linea">Cuando alguien más abra la app y habilite compartir, aparece acá.</div></div>';
        } else {
            cont.innerHTML = peers.map(function (p) {
                var punto = p.compartir === false ? 'off' : (p.encolados > 0 ? 'ocupado' : (p.comfy ? 'ok' : 'off'));
                var modelo = (p.modelos || []).map(function (m) { return m.nombre || m.id; }).join(', ') || '—';
                return [
                    '<div class="red-nodo' + (ESTADO.elegido === p.id ? ' elegido' : '') + '" data-peer="' + esc(p.id) + '">',
                    '  <div class="nombre">' + (p.principal ? '⭐ ' : '🖥️ ') + esc(p.nombre),
                    p.principal ? '<span class="red-badge principal">principal</span>' : '',
                    p.compartir ? '<span class="red-badge comparte">comparte</span>' : '<span class="red-badge">privado</span>',
                    '  </div>',
                    '  <div class="linea">' + esc(p.host) + (p.gpu ? ' · ' + esc(p.gpu) : '') + '</div>',
                    '  <div class="linea">' + esc(modelo) + '</div>',
                    '  <div class="estado"><span class="red-punto ' + punto + '"></span>',
                    (p.comfy ? 'Comfy listo' : 'Comfy apagado') + (p.encolados ? ' · ' + p.encolados + ' en cola' : ' · libre'),
                    '  </div>',
                    '</div>'
                ].join('\n');
            }).join('\n');
        }

        // selector de destino
        var sel = document.getElementById('redDestino');
        if (sel) {
            var opciones = [];
            if (esLocal && ESTADO.yo) opciones.push('<option value="' + esc(ESTADO.yo.peerId) + '">💻 Esta PC (mi Comfy)</option>');
            peers.forEach(function (p) {
                if (esLocal && ESTADO.yo && p.id === ESTADO.yo.peerId) return;
                opciones.push('<option value="' + esc(p.id) + '">' + (p.principal ? '⭐ ' : '') + esc(p.nombre) +
                    (p.encolados ? ' (' + p.encolados + ' en cola)' : '') + '</option>');
            });
            sel.innerHTML = opciones.join('') || '<option value="">sin nodos</option>';
            if (ESTADO.elegido) sel.value = ESTADO.elegido;
        }
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
                ESTADO.yo = { peerId: r.datos.peerId, nombre: r.datos.nombre, compartir: !!r.datos.compartir, conectado: !!r.datos.conectado };
                ESTADO.peers = r.datos.nodos || [];
            } else {
                ESTADO.yo = null;
                ESTADO.peers = r.datos.peers || [];
            }
            ESTADO.nodos = ESTADO.peers.length;
            if (manual) log('🔄 Red actualizada: ' + ESTADO.nodos + ' nodo(s)');
            pintar();
        }).catch(function (e) { if (manual) log('⚠️ ' + e.message); });
    }

    // ---------- generar ----------
    function generar() {
        var prompt = (document.getElementById('redPrompt').value || '').trim();
        if (!prompt) { log('⚠️ Falta el prompt'); return; }
        var destino = document.getElementById('redDestino').value;
        if (!destino) { log('⚠️ No hay nodo destino'); return; }
        var modelo = document.getElementById('redModelo').value;
        var steps = parseInt(document.getElementById('redSteps').value) || 10;
        var ancho = parseInt(document.getElementById('redAncho').value) || 1024;
        var btn = document.getElementById('redGenerar');
        btn.disabled = true;
        log('🚀 Mandando el trabajo a ' + destino + ' (' + modelo + ', ' + ancho + 'px, ' + steps + ' steps)...');
        api('/api/red/generar', {
            json: {
                peerId: destino,
                tipo: modelo === 'ltx2' ? 'video' : 'imagen',
                prompt: prompt,
                modelo: modelo,
                params: { videoWidth: ancho, videoHeight: ancho, samplerSteps: steps, seed: -1 }
            }
        }).then(function (r) {
            if (!r.ok || r.datos.success === false) {
                log('❌ ' + (r.datos.message || ('HTTP ' + r.status)));
            } else {
                log('✅ Trabajo aceptado' + (r.datos.local ? ' (acá mismo)' : ' por ' + ((r.datos.peer && r.datos.peer.nombre) || destino)) +
                    (r.datos.jobId ? ' · job ' + r.datos.jobId : ''));
            }
        }).catch(function (e) { log('❌ ' + e.message); })
            .then(function () { btn.disabled = false; });
    }

    // ---------- eventos en vivo ----------
    function conectarEventos() {
        // LOCAL: el websocket de la app avisa de la red (el agente le pasa los nodos)
        if (esLocal && J.WS) {
            try {
                var ws = new WebSocket(J.WS);
                ws.onmessage = function (ev) {
                    var m = null;
                    try { m = JSON.parse(ev.data); } catch (e) { return; }
                    if (!m) return;
                    if (m.type === 'red_estado' && m.red) {
                        ESTADO.yo = { peerId: m.red.peerId, nombre: m.red.nombre, compartir: !!m.red.compartir, conectado: !!m.red.conectado };
                        ESTADO.peers = m.red.nodos || [];
                        pintar();
                    }
                    if (m.type === 'red_job') log('🎯 Trabajo de ' + (m.job && m.job.de || '?') + ' encolado acá');
                };
                ws.onclose = function () { setTimeout(conectarEventos, 4000); };
            } catch (e) { }
            return;
        }
        // WEB: socket.io del hub
        if (!esLocal && typeof io === 'function') {
            try {
                socket = io(J.ORIGIN, { path: J.BASE + '/socket.io', transports: ['websocket', 'polling'] });
                socket.on('red:peers', function (d) {
                    ESTADO.peers = (d && d.peers) || [];
                    pintar();
                });
                socket.on('red:evento', function (d) {
                    if (!d || !d.data) return;
                    var m = null;
                    try { m = JSON.parse(d.data); } catch (e) { return; }
                    if (!m) return;
                    if (m.type === 'storyboard_generated' || m.type === 'video_generated') {
                        log('🖼️ ' + (d.nombre || d.peerId) + ' terminó: ' + m.filename);
                        if (ESTADO.elegido && d.peerId === ESTADO.elegido && m.url) {
                            log('   resultado: ' + m.url);
                        }
                    }
                });
            } catch (e) { log('⚠️ socket.io: ' + e.message); }
        }
    }

    function arrancar() {
        montarUI();
        refrescar(false);
        conectarEventos();
        setInterval(function () { refrescar(false); }, 7000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar);
    else arrancar();

    window.comfyRed = { estado: ESTADO, refrescar: refrescar, generar: generar, abrir: abrir };
})();
