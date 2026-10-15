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

        // Botón visible: en la barra de pestañas del proyecto (la del borde
        // inferior del header). El header recorta su contenido y esa barra
        // tiene z-index propio, así que un botón dentro del header queda
        // tapado y el click no llega.
        var btn = document.createElement('button');
        btn.className = 'tab-button red-tab-btn';
        btn.id = 'tabRedBtn';
        btn.setAttribute('data-target', 'panelRed');
        btn.textContent = '🌎 RED';
        btn.title = 'Red ComfyLatam: elegir en qué Comfy de la red generar';
        var barra = document.getElementById('projectTabsNav');
        var badge = document.getElementById('jpiEstado');
        if (barra) barra.appendChild(btn);
        else if (badge && badge.parentNode) badge.parentNode.insertBefore(btn, badge.nextSibling);
        else {
            var nav = document.querySelector('.workspace-header .tabs') ||
                document.querySelector('.workspace-header nav') ||
                document.querySelector('.workspace-header');
            if (nav) nav.appendChild(btn);
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

            '<div class="red-gen">',
            '  <h3>🎯 GENERAR EN LA RED</h3>',
            '  <textarea id="redPrompt" placeholder="Escribí el prompt... el trabajo va al nodo elegido"></textarea>',
            '  <div class="red-fila">',
            '    <label class="red-etiqueta">Nodo</label>',
            '    <select id="redDestino"></select>',
            '    <label class="red-etiqueta">Modelo</label>',
            '    <select id="redModelo">',
            '      <option value="zimage">Z-Image Turbo (imagen, rápido)</option>',
            '      <option value="qwen21">Qwen-Image 2.1 (imagen, mejor calidad)</option>',
            '      <option value="ltx2">LTX-2 (video)</option>',
            '    </select>',
            '    <input type="number" id="redSteps" value="10" min="1" max="40" style="width:78px" title="steps">',
            '    <input type="number" id="redAncho" value="1024" min="256" max="2048" step="64" style="width:88px" title="ancho">',
            '    <button class="red-btn" id="redGenerar">GENERAR EN LA RED</button>',
            '  </div>',
            '  <div class="red-log" id="redLog">Todavía no hay movimientos.</div>',
            '</div>'
        ].join('\n');
        if (contenedor) contenedor.appendChild(panel);

        // Botón gemelo en el panel izquierdo (la fila de pestañas se recorta
        // en ventanas angostas) y en la barra mobile.
        var izq = document.querySelector('.ck-panel-izq');
        if (izq && !document.getElementById('ckPiRed')) {
            var bi = document.createElement('button');
            bi.id = 'ckPiRed';
            bi.textContent = '🌎 Red ComfyLatam';
            bi.style.marginTop = '6px';
            bi.addEventListener('click', function (e) { e.preventDefault(); abrir(); });
            izq.appendChild(bi);
        }
        var barra = document.querySelector('.mobile-bar, #mobileBar');
        if (barra && !document.getElementById('mobRed')) {
            var mb = document.createElement('button');
            mb.type = 'button';
            mb.id = 'mobRed';
            mb.className = 'mobile-tab';
            mb.textContent = '🌎 RED';
            barra.appendChild(mb);
            mb.addEventListener('click', function () { abrir(); });
        }

        btn.addEventListener('click', function (e) { e.preventDefault(); abrir(); });

        // Al tocar cualquier OTRA pestaña del editor, escondo la mía (el editor
        // capturó sus .tab-content al cargar y no conoce este panel).
        document.querySelectorAll('.workspace-header .tab-button').forEach(function (b) {
            if (b.id === 'tabRedBtn') return;
            b.addEventListener('click', function () {
                var p = document.getElementById('panelRed');
                if (p) p.classList.remove('active');
            });
        });

        document.getElementById('redRefrescar').addEventListener('click', function () { refrescar(true); });
        document.getElementById('redOjo').addEventListener('click', function () {
            ESTADO.verPasados = !ESTADO.verPasados;
            try { localStorage.setItem(CLAVE_PASADOS, ESTADO.verPasados ? '1' : '0'); } catch (e) { }
            log(ESTADO.verPasados ? '👁 Mostrando también los que no transmiten' : '👁 Mostrando sólo los disponibles');
            pintar();
        });
        document.getElementById('redGenerar').addEventListener('click', generar);
        document.getElementById('redModelo').addEventListener('change', actualizarModelos);
        document.getElementById('redDestino').addEventListener('change', function (e) {
            guardarElegido(e.target.value);
            pintar();
        });
        document.getElementById('redNodos').addEventListener('click', function (e) {
            var b = e.target.closest('[data-usar]');
            if (!b) return;
            var id = b.getAttribute('data-usar');
            if (b.disabled) return;
            guardarElegido(id);
            log('🎯 Nodo elegido: ' + nombreDe(id));
            pintar();
        });
    }

    function nombreDe(id) {
        if (esLocal && ESTADO.yo && ESTADO.yo.peerId === id) return 'esta PC (mi Comfy)';
        var p = ESTADO.peers.filter(function (x) { return x.id === id; })[0];
        return p ? p.nombre : id;
    }

    function abrir() {
        var panel = document.getElementById('panelRed');
        if (!panel) return;
        // misma mecánica que las pestañas del editor, pero en vivo
        document.querySelectorAll('.tab-button').forEach(function (b) {
            b.classList.toggle('active', b.id === 'tabRedBtn');
        });
        document.querySelectorAll('.tab-content').forEach(function (c) {
            c.classList.toggle('active', c === panel);
        });
        document.body.classList.remove('tab-editor-active');
        if (typeof window.cerrarCajonesMobile === 'function') { try { window.cerrarCajonesMobile(); } catch (e) { } }
        refrescar(false);
    }
    window.comfyRed = { estado: ESTADO, refrescar: refrescar, generar: generar, abrir: abrir };

    // ---------- pintado ----------
    function pintar() {
        var cont = document.getElementById('redNodos');
        if (!cont) return;

        var peers = ESTADO.peers.slice();
        // mi propio nodo (en local): no lo repito en la grilla si ya viene en la lista
        var yoId = (esLocal && ESTADO.yo) ? ESTADO.yo.peerId : null;
        var todos = peers.filter(function (p) { return p.id !== yoId; });
        // Por defecto SÓLO se indexan los que están conectados Y transmitiendo.
        // El ojito revela el resto + las conexiones pasadas.
        var usables = todos.filter(function (p) { return p.conectado && p.compartir; });
        var ocultos = todos.filter(function (p) { return !(p.conectado && p.compartir); });
        if (ESTADO.verPasados) {
            ocultos = ocultos.concat((ESTADO.pasados || []).filter(function (h) {
                return !todos.some(function (p) { return p.id === h.id; });
            }));
        }
        var otros = ESTADO.verPasados ? usables.concat(ocultos) : usables;

        document.getElementById('redModo').textContent = esLocal ? '💻 LOCAL' : '🌐 WEB';
        var compartiendo = peers.filter(function (p) { return p.compartir && p.conectado; }).length;
        document.getElementById('redResumen').textContent =
            compartiendo + ' dando Comfy · ' + peers.length + ' en la red';
        var ojoBtn = document.getElementById('redOjo');
        if (ojoBtn) {
            ojoBtn.textContent = ESTADO.verPasados ? '👁 ▾' : '👁 ▸';
            ojoBtn.classList.toggle('activo', ESTADO.verPasados);
            ojoBtn.title = ESTADO.verPasados
                ? 'Ocultar los que no transmiten y las conexiones pasadas'
                : 'Ver también los que no transmiten (' + ocultos.length + ') y las conexiones pasadas';
        }
        // "disponible" = conectado Y con el Comfy libre (no alcanza con el socket)
        var cajaDisp = document.getElementById('redDisponibles');
        if (cajaDisp) {
            var conectados = ESTADO.peers.filter(function (p) { return p.conectado; });
            var libres = conectados.filter(function (p) { return p.comfy && !p.ocupado && !(p.encolados > 0); });
            var ocupados = conectados.filter(function (p) { return p.ocupado || p.encolados > 0; });
            var apagados = conectados.filter(function (p) { return !p.comfy; });
            cajaDisp.innerHTML =
                '<span class="ok">🟢 ' + libres.length + ' disponible(s) ahora</span>' +
                '<span class="ojo">🟡 ' + ocupados.length + ' ocupada(s)</span>' +
                '<span class="off">⚪ ' + apagados.length + ' sin ComfyUI</span>' +
                '<span class="tot">de ' + conectados.length + ' conectada(s)</span>';
        }
        document.getElementById('redCantidad').textContent =
            '(' + usables.length + ' disponibles' + (ESTADO.verPasados && ocultos.length ? ' + ' + ocultos.length + ' ocultos' : '') + ')';

        // aviso de permiso (web sin sesión)
        var aviso = document.getElementById('redAviso');
        if (!esLocal && !tokenActual()) {
            aviso.style.display = 'block';
            aviso.textContent = 'Para ver y usar los nodos de la red entrá con tu cuenta de fullscreencode.';
        } else {
            aviso.style.display = 'none';
        }

        // ¿a quién le voy a mandar? (banner grande, también en la web)
        var caja = document.getElementById('redElegidoCaja');
        var elegido = ESTADO.elegido;
        var existeElegido = elegido && (elegido === yoId || peers.some(function (p) { return p.id === elegido; }));
        if (!existeElegido) { guardarElegido(''); elegido = ''; }
        if (!elegido) {
            // default: mi Comfy si estoy en local, si no el primer nodo que comparte
            if (yoId) { guardarElegido(yoId); elegido = yoId; }
            else {
                var libre = peers.filter(function (p) { return p.compartir; })[0];
                if (libre) { guardarElegido(libre.id); elegido = libre.id; }
            }
        }
        if (elegido) {
            var esMio = (elegido === yoId);
            var p2 = esMio ? null : peers.filter(function (p) { return p.id === elegido; })[0];
            caja.innerHTML = '🎯 Vas a generar en: <b>' + esc(nombreDe(elegido)) + '</b>' +
                (esMio ? ' <span class="red-badge comparto">tu Comfy</span>'
                    : (p2 ? ' <span class="red-badge">' + (p2.ocupado || p2.encolados ? 'ocupada · ' + (p2.encolados || 0) + ' en cola' : 'libre') + '</span>' : ''));
        } else {
            caja.innerHTML = '🎯 No hay ningún nodo para generar. Prendé compartir en tu app (o esperá que alguien entre a la red).';
        }
        caja.className = 'red-elegido' + (elegido ? '' : ' vacio');

        // grilla de nodos
        var tarjetas = [];
        if (esLocal && ESTADO.yo) {
            tarjetas.push(tarjeta({
                id: yoId,
                nombre: ESTADO.yo.nombre,
                host: 'esta PC',
                gpu: '',
                modelos: ESTADO.yo.modelos || [],
                compartir: !!ESTADO.yo.compartir,
                comfy: true,
                encolados: 0,
                propio: true,          // "tu nodo": siempre usable desde acá
                conectado: !!ESTADO.yo.conectado
            }));
        }
        otros.forEach(function (p) { tarjetas.push(tarjeta(p)); });

        cont.innerHTML = tarjetas.length ? tarjetas.join('\n')
            : '<div class="red-nodo vacio"><div class="nombre">😴 No hay otros nodos conectados</div>' +
              '<div class="linea">Cuando otra persona abra la app y habilite "compartir", aparece acá para que la uses.</div></div>';

        // selector del generador (espejo de la grilla)
        var sel = document.getElementById('redDestino');
        if (sel) {
            var ops = [];
            if (esLocal && ESTADO.yo) ops.push(opcion(yoId, '💻 ' + ESTADO.yo.nombre + ' (esta PC)'));
            otros.forEach(function (p) {
                if (!p.compartir) return;
                ops.push(opcion(p.id, (p.principal ? '⭐ ' : '') + p.nombre + (p.encolados ? ' (' + p.encolados + ' en cola)' : '')));
            });
            sel.innerHTML = ops.join('') || '<option value="">sin nodos</option>';
            sel.value = elegido || '';
            sel.disabled = !ops.length;
        }

        actualizarModelos();

        // mi nodo (switch de compartir + nombre), solo en local.
        // OJO: si el usuario está escribiendo el nombre, NO se vuelve a pintar
        // (antes el repintado cada 7 s le borraba lo que escribía).
        var cajaMio = document.getElementById('redMio');
        var activo = document.activeElement;
        var escribiendoNombre = !!(activo && activo.id === 'redNombre');
        var firmaYo = (esLocal && ESTADO.yo)
            ? [ESTADO.yo.peerId, ESTADO.yo.nombre, ESTADO.yo.compartir, ESTADO.yo.conectado].join('|')
            : '';
        if (esLocal && ESTADO.yo && !escribiendoNombre && firmaYo !== ultimaFirmaYo) {
            ultimaFirmaYo = firmaYo;
            var conectadoRed = !!ESTADO.yo.conectado;
            cajaMio.innerHTML = [
                '<div class="red-mio">',
                '  <div class="datos">',
                '    <span class="titulo">💻 ' + esc(ESTADO.yo.nombre) + ' <span class="red-badge">tu nodo</span></span>',
                '    <span class="meta">' + (conectadoRed
                    ? 'publicado en la red · id ' + esc(ESTADO.yo.peerId)
                    : 'sin publicar todavía — corré <b>conectar-comfylatam.bat</b> para entrar a la red') + '</span>',
                (!conectadoRed
                    ? '    <span class="red-nombre-fila"><button class="red-btn chico" id="redConectar">🔌 Conectar a la red</button></span>'
                    : '') +
                '    <span class="red-nombre-fila">',
                '      <input type="text" id="redNombre" maxlength="40" placeholder="nombre con el que te ve la red" value="' + esc(ESTADO.yo.nombre) + '">',
                '      <button class="red-btn secundario chico" id="redGuardarNombre">Guardar nombre</button>',
                '    </span>',
                '  </div>',
                '  <label class="red-switch"><input type="checkbox" id="redCompartir"' + (ESTADO.yo.compartir ? ' checked' : '') + '>',
                '    <span class="pista"></span><span>🌐 Transmitir mi Comfy a la red (que otros generen en esta PC)</span></label>',
                '</div>'
            ].join('\n');
            var bc = document.getElementById('redConectar');
            if (bc) {
                bc.addEventListener('click', function () {
                    bc.disabled = true;
                    bc.textContent = '⏳ Conectando...';
                    log('🔌 Arrancando el agente del nodo...');
                    api('/api/red/agente', { json: {} }).then(function (r) {
                        if (r.ok) log(r.datos.ya ? '✅ Ya estabas publicado' : '✅ Agente lanzado, en unos segundos aparecés en la red');
                        else log('⚠️ ' + (r.datos.message || 'No pude arrancarlo'));
                        setTimeout(function () { refrescar(true); }, 6000);
                    });
                });
            }
            var ec = document.getElementById('redEqConfig');
            if (ec) ec.addEventListener('click', function () {
                var b = document.getElementById('tabSettingsBtn');
                if (b) b.click();
            });
            var gb = document.getElementById('redGuardarNombre');
            if (gb) {
                gb.addEventListener('click', function () {
                    var nuevo = (document.getElementById('redNombre').value || '').trim();
                    if (!nuevo) { log('⚠️ Poné un nombre'); return; }
                    api('/api/red/compartir', { json: { nombre: nuevo } }).then(function (r) {
                        if (r.ok) log('✏️ Listo, en la red te ven como "' + nuevo + '"');
                        else log('⚠️ No pude guardar el nombre');
                        refrescar(true);
                    });
                });
            }
            var chk = document.getElementById('redCompartir');
            if (chk) {
                chk.addEventListener('change', function () {
                    log(chk.checked ? '⏳ Compartiendo mi Comfy...' : '⏳ Dejando de compartir...');
                    api('/api/red/compartir', { json: { compartir: chk.checked } }).then(function (r) {
                        log(chk.checked ? '✅ Compartiendo mi Comfy con la red' : '🔒 Ya no comparto mi Comfy');
                        if (r.datos && r.datos.hub && r.datos.hub.ok === false) {
                            log('⚠️ Al hub:' + (r.datos.hub.motivo || 'no pude avisarle') + ' → corré conectar-comfylatam.bat');
                        }
                        refrescar(true);
                    });
                });
            }
        } else if (!esLocal || !ESTADO.yo) {
            cajaMio.innerHTML = '';
        }
    }

    function opcion(id, texto) {
        return '<option value="' + esc(id) + '">' + esc(texto) + '</option>';
    }

    function tokenActual() {
        var t = J.TOKEN;
        try { t = localStorage.getItem('fsc_token_jpi') || t; } catch (e) { }
        return t;
    }

    // El modelo que el nodo elegido puede correr (si no sé, muestro todos).
    function actualizarModelos() {
        var sel = document.getElementById('redModelo');
        if (!sel) return;
        var p = ESTADO.peers.filter(function (x) { return x.id === ESTADO.elegido; })[0];
        var ids = (p && p.modelos && p.modelos.length) ? p.modelos.map(function (m) { return m.id; }) : null;
        Array.prototype.forEach.call(sel.options, function (o) {
            var sirve = !ids || ids.indexOf(o.value) !== -1 || o.value === 'ltx2';
            o.disabled = !sirve;
            o.hidden = !sirve;
        });
        if (sel.selectedOptions[0] && sel.selectedOptions[0].disabled) {
            var primera = Array.prototype.filter.call(sel.options, function (o) { return !o.disabled; })[0];
            if (primera) sel.value = primera.value;
        }
    }

    function tarjeta(p) {
        var mio = !!p.propio;
        var elegido = ESTADO.elegido === p.id;
        var punto = !p.conectado ? 'off' : (p.encolados > 0 ? 'ocupado' : (p.comfy ? 'ok' : 'off'));
        var modelos = (p.modelos || []).map(function (m) { return m.nombre || m.id; }).join(' · ') || '—';
        var puede = mio || (p.compartir && p.conectado);
        var boton = elegido
            ? '<button class="red-btn chico" data-usar="' + esc(p.id) + '"' + (puede ? '' : ' disabled') + '>✅ ELEGIDO</button>'
            : '<button class="red-btn secundario chico" data-usar="' + esc(p.id) + '"' + (puede ? '' : ' disabled') + '>' +
              (puede ? 'Usar este Comfy' : (p.compartir ? 'No disponible' : 'No comparte')) + '</button>';
        var estado;
        if (mio) {
            estado = p.conectado ? '🟢 publicado en la red' : '⚪ sin publicar (corré conectar-comfylatam.bat)';
        } else {
            if (p.conectado) {
                var quien = p.usuario ? ' · de @' + p.usuario : '';
                estado = (p.comfy
                    ? (p.ocupado || p.encolados > 0
                        ? '🟡 OCUPADO · ' + (p.encolados || 0) + ' en cola'
                        : '🟢 LIBRE para generar')
                    : '⚪ Comfy apagado') + quien;
            } else {
                var hace = '';
                if (p.visto) {
                    var min = Math.round((Date.now() - Number(p.visto)) / 60000);
                    hace = min < 1 ? ' · hace instantes' : (min < 60 ? ' · hace ' + min + ' min' : ' · hace ' + Math.round(min / 60) + ' h');
                }
                estado = (p.visto ? 'conexión pasada' : 'sin conexión') + hace;
            }
        }
        return [
            '<div class="red-nodo' + (elegido ? ' elegido' : '') + (puede ? '' : ' apagado') + '">',
            '  <div class="nombre">' + (p.avatar
                ? '<img class="red-avatar" src="' + esc(p.avatar) + '" alt="">'
                : (p.principal ? '⭐ ' : (mio ? '💻 ' : '🖥️ '))) + esc(p.nombre),
            mio ? '<span class="red-badge comparto">tu nodo</span>'
                : '<span class="red-badge ' + (p.compartir ? 'comparto' : '') + '">' + (p.compartir ? 'comparte' : 'transmisión apagada') + '</span>',
            (p.principal && !mio) ? '<span class="red-badge principal">principal</span>' : '',
            '  </div>',
            '  <div class="linea">' + (p.gpu ? esc(p.gpu) : 'sin GPU') + (p.usuario ? ' · de @' + esc(p.usuario) : '') + '</div>',
            '  <div class="linea">' + esc(modelos) + '</div>',
            '  <div class="estado"><span class="red-punto ' + punto + '"></span>' + estado + '</div>',
            '  <div class="red-accion">' + boton + '</div>',
            '</div>'
        ].join('\n');
    }

    // --- 👥 clientes conectados: cuántos, usuarios y de qué tipo -------------
    function pintarClientes() {
        var caja = document.getElementById('redClientes');
        if (!caja) return;
        var c = ESTADO.clientes || {};
        var total = Number(c.total || 0);
        var usuarios = c.usuarios || [];

        if (!total && !usuarios.length && !(c.appsLocales || 0)) {
            caja.innerHTML = '<h3 class="red-titulo">👥 CLIENTES CONECTADOS</h3>' +
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
