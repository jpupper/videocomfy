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
        runpod: { url: '', activo: false }, // motor externo (RunPod) activo
        motorBase: '',       // a dónde apunta el motor de ESTA app
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
        avisarClienteNodo(id);
        try { localStorage.setItem(CLAVE_ELEGIDO, id || ''); } catch (e) { }
    }
    function leerElegido() {
        try { return localStorage.getItem(CLAVE_ELEGIDO) || ''; } catch (e) { return ''; }
    }

    // ---------- CONEXIÓN: una sola a la vez (una PC o un RunPod) ----------
    // El RunPod es el motor externo de ESTA app (`comfyExterno` en el server).
    // Si está activo, no hay PC elegida: nunca las dos cosas juntas.
    function runpodActivo() {
        var r = ESTADO.runpod || {};
        return !!(r.activo && r.url);
    }
    function runpodDe(url) {
        var ls = (window.CK_runpods && window.CK_runpods.lista) ? window.CK_runpods.lista() : [];
        for (var i = 0; i < ls.length; i++) if (ls[i].url === url) return ls[i];
        return null;
    }
    function nombreRunpod() {
        var rp = runpodDe((ESTADO.runpod || {}).url);
        return (rp && rp.nombre) || 'RunPod';
    }
    // la conexión vigente, con su TIPO (lo que el banner tiene que decir)
    function conexionActual() {
        if (runpodActivo()) return { tipo: 'runpod', id: ESTADO.runpod.url, nombre: nombreRunpod() };
        if (ESTADO.elegido) return { tipo: 'pc', id: ESTADO.elegido, nombre: nombreDe(ESTADO.elegido) };
        return { tipo: '', id: '', nombre: '' };
    }
    // prende/apaga el motor externo y deja el estado igual a lo que contestó el server
    function setRunpod(url, activo) {
        return api('/api/config/comfy-externo', { json: { url: url || '', activo: !!activo } })
            .then(function (r) {
                var d = (r && r.datos) || {};
                ESTADO.runpod = { url: d.url || '', activo: !!d.activo };
                ESTADO.motorBase = d.base || ESTADO.motorBase;
                return d;
            });
    }

    // ---------- UI ----------
    function montarUI() {
        if (document.getElementById('panelRed')) return;

        // Botón visible: ya viene en el HTML (#tabRedBtn, en el menú de pestañas).
        // Antes este módulo creaba OTRO botón con el mismo id y en pantalla
        // quedaban dos "RED" (uno en el menú y otro en la fila de sesiones).
        var btn = document.getElementById('tabRedBtn');
        if (!btn) {
            btn = document.createElement('button');
            btn.className = 'tab-button red-tab-btn';
            btn.id = 'tabRedBtn';
            btn.setAttribute('data-target', 'panelRed');
            btn.textContent = 'RED';
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
        } else {
            btn.setAttribute('data-target', 'panelRed');
        }

        // panel dentro de .workspace-content (así convive con las otras pestañas)
        var contenedor = document.querySelector('.workspace-content') ||
            document.querySelector('main') || document.body;
        var panel = document.createElement('div');
        panel.className = 'tab-content red-panel';
        panel.id = 'panelRed';
        panel.innerHTML = [
            '<div class="red-head">',
            '  <h2>CONEXIÓN</h2>',
            '  <span class="red-badge" id="redModo"></span>',
            '  <span class="red-badge" id="redResumen"></span>',
            '  <button class="red-btn secundario" id="redRefrescar">Actualizar</button>',
            '</div>',

            '<div class="red-subtab-content active" id="redTabLaRed">',
            '<p class="red-sub">Hay UNA sola conexión a la vez: o una <b>PC</b> (cada persona que corre la app aporta su Comfy) ' +
            'o un <b>RunPod</b> (ComfyUI en la nube). Elegí una tarjeta abajo, tocá <b>CONECTAR</b> y el trabajo va ahí: ' +
            'el banner de arriba dice siempre a cuál estás conectado.</p>',

            '<div class="red-elegido" id="redElegidoCaja"></div>',
            '<div class="red-aviso" id="redAviso"></div>',

            // ── RunPods del usuario (ComfyUI remoto, queda en su perfil) ──────
            '<h3 class="red-titulo">☁️ AGREGAR UN RUNPOD <span class="red-sub-chico">(se guarda en tu perfil y aparece abajo como una tarjeta más)</span></h3>',
            '<div class="red-runpod-alta">',
            '  <input type="text" id="rpNombre" maxlength="40" placeholder="nombre (ej: RunPod 4090)">',
            '  <input type="text" id="rpUrl" placeholder="https://xxxx-8188.proxy.runpod.net">',
            '  <button class="red-btn" id="rpAgregar">AGREGAR RUNPOD</button>',
            '</div>',
            '<div class="red-sub-chico" id="rpAviso"></div>',

            '<div class="red-disponibles" id="redDisponibles"></div>',
            '<h3 class="red-titulo">🖥️ COMPUTADORAS Y RUNPODS <span id="redCantidad"></span>',
            '  <button class="red-ojo" id="redOjo" title="Ver también los que no están transmitiendo y las conexiones pasadas"></button>',
            '</h3>',
            '<div class="red-leyenda">💻 PC · ☁️ RUNPOD · 🟢 listo para generar · 🟡 ocupado (en cola) · ⚪ apagado / sin transmitir · ',
            'una sola conexión a la vez (al conectar otra, la anterior se suelta).</div>',
            '<div class="red-grid" id="redNodos"></div>',

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
            '</div>',
            '</div>',

            '</div>'
        ].join('\n');
        if (contenedor) contenedor.appendChild(panel);

        // ⚙️ AJUSTES vivía en la pestaña SETTINGS (se borró): ahora es una
        // sección más de CONEXIÓN. El bloque está en el HTML y se mueve acá,
        // así los ids (#ckComfyAddress, etc.) siguen funcionando igual.
        (function () {
            var ajustes = document.getElementById('ckAjustesBloque');
            if (ajustes && !panel.contains(ajustes)) {
                var titulo = document.createElement('h3');
                titulo.className = 'red-titulo';
                titulo.textContent = '⚙️ MI MOTOR — dónde genera esta PC';
                var gen = panel.querySelector('.red-gen');
                if (gen && gen.parentNode === panel) panel.insertBefore(titulo, gen);
                else panel.appendChild(titulo);
                panel.insertBefore(ajustes, titulo.nextSibling);
            }
        })();

        // ── ACCESO: quién puede usar mi PC y cada workflow ───────────────────
        // Pedido del usuario: pestaña propia con 3 sub-pestañas (EQUIPO,
        // WORKFLOWS y PERMISOS), separada de COMUNIDAD.
        var panelA = document.createElement('div');
        panelA.className = 'tab-content red-panel';
        panelA.id = 'panelAcceso';
        panelA.innerHTML = [
            '<div class="red-head">',
            '  <h2>ACCESO</h2>',
            '  <span class="red-badge">quién puede ver y usar lo tuyo</span>',
            '  <button class="red-btn secundario" id="accesoRefrescar">Actualizar</button>',
            '</div>',
            '<div class="red-subtabs">',
            '  <button type="button" class="red-subtab active" data-accsub="accTabEquipo">💻 EQUIPO</button>',
            '  <button type="button" class="red-subtab" data-accsub="accTabWf">🧩 WORKFLOWS</button>',
            '  <button type="button" class="red-subtab" data-accsub="accTabPerm">🔐 PERMISOS</button>',
            '</div>',

            '<div class="red-subtab-content active" id="accTabEquipo">',
            '<p class="red-sub">Así exponés TU computadora a la red. Nada de esto afecta tu uso local.</p>',
            '<div id="redMio"></div>',
            // quién puede ver/usar esta PC (resumen; se edita en PERMISOS)
            '<div id="redMioAcceso"></div>',
            // Cuántos clientes/usuarios hay conectados y de qué tipo (web o local)
            '<div class="red-clientes" id="redClientes"></div>',
            '</div>',

            '<div class="red-subtab-content" id="accTabWf">',
            // acá se engancha el panel de workflows que compartís (js/workflows-red.js)
            '<div id="redWfSlot"></div>',
            '</div>',

            '<div class="red-subtab-content" id="accTabPerm">',
            '<p class="red-sub">Por defecto todo es 👥 TODOS. Si limitás un equipo o un workflow, sólo los usuarios tildados lo ven y pueden usarlo.</p>',
            '<div id="redPermSlot"></div>',
            '</div>'
        ].join('\n');
        if (contenedor) contenedor.appendChild(panelA);

        // sub-pestañas de ACCESO
        panelA.querySelectorAll('.red-subtab').forEach(function (b) {
            b.addEventListener('click', function (e) {
                e.preventDefault();
                var destino = b.getAttribute('data-accsub');
                panelA.querySelectorAll('.red-subtab').forEach(function (x) {
                    x.classList.toggle('active', x === b);
                });
                panelA.querySelectorAll('.red-subtab-content').forEach(function (c) {
                    c.classList.toggle('active', c.id === destino);
                });
            });
        });

        // Botón gemelo en el panel izquierdo (la fila de pestañas se recorta
        // en ventanas angostas) y en la barra mobile.
        var izq = document.querySelector('.ck-panel-izq');
        if (izq && !document.getElementById('ckPiRed')) {
            var bi = document.createElement('button');
            bi.id = 'ckPiRed';
            bi.textContent = '🔌 CONEXIÓN';
            bi.style.marginTop = '6px';
            bi.addEventListener('click', function (e) { e.preventDefault(); abrir(); });
            izq.appendChild(bi);
            var ba = document.createElement('button');
            ba.id = 'ckPiAcceso';
            ba.textContent = '🔐 ACCESO';
            ba.style.marginTop = '6px';
            ba.addEventListener('click', function (e) { e.preventDefault(); abrirAcceso(); });
            izq.appendChild(ba);
        }
        var barra = document.querySelector('.mobile-bar, #mobileBar');
        if (barra && !document.getElementById('mobRed')) {
            var mb = document.createElement('button');
            mb.type = 'button';
            mb.id = 'mobRed';
            mb.className = 'mobile-tab';
            mb.textContent = 'CONEXIÓN';
            barra.appendChild(mb);
            mb.addEventListener('click', function () { abrir(); });
            var mba = document.createElement('button');
            mba.type = 'button';
            mba.id = 'mobAcceso';
            mba.className = 'mobile-tab';
            mba.textContent = 'ACCESO';
            barra.appendChild(mba);
            mba.addEventListener('click', function () { abrirAcceso(); });
        }

        btn.addEventListener('click', function (e) { e.preventDefault(); abrir(); });

        // Al tocar cualquier OTRA pestaña del editor, escondo la mía (el editor
        // capturó sus .tab-content al cargar y no conoce este panel).
        document.querySelectorAll('.workspace-header .tab-button').forEach(function (b) {
            if (b.id === 'tabRedBtn' || b.id === 'tabAccesoBtn') return;
            b.addEventListener('click', function () {
                ['panelRed', 'panelAcceso'].forEach(function (id) {
                    var p = document.getElementById(id);
                    if (p) p.classList.remove('active');
                });
            });
        });

        // el botón ACCESO de la barra de arriba
        var btnA = document.getElementById('tabAccesoBtn');
        if (btnA) {
            btnA.addEventListener('click', function (e) { e.preventDefault(); abrirAcceso(); });
        }

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
        // TODAS las tarjetas (PC y RunPod) se manejan acá: un solo camino de conexión
        document.getElementById('redNodos').addEventListener('click', function (e) {
            var bd = e.target.closest('[data-desconectar]');
            if (bd) { e.preventDefault(); desconectar(); return; }
            var ru = e.target.closest('[data-runpod-usar]');
            if (ru) {
                e.preventDefault();
                if (ru.disabled) return;
                conectarRunpod(ru.getAttribute('data-runpod-usar'));
                return;
            }
            var rb = e.target.closest('[data-runpod-borrar]');
            if (rb) {
                e.preventDefault();
                if (window.CK_runpods && typeof window.CK_runpods.borrar === 'function') {
                    window.CK_runpods.borrar(rb.getAttribute('data-runpod-borrar'));
                }
                return;
            }
            var b = e.target.closest('[data-usar]');
            if (!b) return;
            if (b.disabled) return;
            conectar(b.getAttribute('data-usar'));
        });
    }

    function nombreDe(id) {
        if (esLocal && ESTADO.yo && ESTADO.yo.peerId === id) return 'esta PC (mi Comfy)';
        var p = ESTADO.peers.filter(function (x) { return x.id === id; })[0];
        return p ? p.nombre : id;
    }

    // ---------- conectar / desconectar ----------
    // Al conectar se le pide al nodo que CONFIRME (endpoint /api/red/conectar).
    // En la web va por /p/<nodo>/…, así la respuesta viene de esa computadora y
    // no del hub: si el pedido llegó y el ComfyUI contesta, se dice "conectado".
    function conectar(id) {
        // UNA sola conexión: si estaba el RunPod, se apaga antes de agarrar la PC
        if (runpodActivo()) {
            log('🔌 Soltando el RunPod ' + nombreRunpod() + ' para conectar la PC…');
            setRunpod(ESTADO.runpod.url, false)
                .then(function () { conectarPC(id); })
                .catch(function (e) { log('⚠️ No pude apagar el RunPod: ' + e.message); });
            return;
        }
        conectarPC(id);
    }

    function conectarRunpod(url) {
        var rp = runpodDe(url) || {};
        var nom = rp.nombre || 'RunPod';
        // UNA sola conexión: al RunPod se le suelta la PC
        if (ESTADO.elegido) guardarElegido('');
        log('☁️ Conectando al RunPod ' + nom + '…');
        setRunpod(url, true).then(function (d) {
            if (!d || d.success === false) {
                log('⚠️ ' + ((d && d.message) || 'no pude activar ese RunPod'));
            } else {
                log('✅ Conectado a ' + nom + ' · motor en la nube (' + (d.base || url) + ') · no usa tu PC');
            }
            pintar();
            try { window.CKConexion && window.CKConexion.pintar(); } catch (e) { }
            refrescar(false);
        }).catch(function (e) {
            log('⚠️ No pude activar el RunPod: ' + e.message);
            pintar();
        });
    }

    function conectarPC(id) {
        guardarElegido(id);
        pintar();
        log('🔗 Conectando a ' + nombreDe(id) + '…');
        var ruta = esLocal ? '/api/red/conectar' : ('/p/' + encodeURIComponent(id) + '/api/red/conectar');
        api(ruta, { json: { peerId: id } }).then(function (r) {
            var d = r.datos || {};
            if (r.ok && d.success) {
                var nom = (d.peer && d.peer.nombre) || nombreDe(id);
                var nwf = (d.workflows || []).length;
                if (d.comfy && d.comfy.ok) {
                    log('✅ Conectado a ' + nom + ' · ComfyUI listo · ' + nwf + ' workflow(s) disponibles');
                } else {
                    log('⚠️ Conectado a ' + nom + ', pero su ComfyUI no responde (' + ((d.comfy && d.comfy.base) || '—') + '): no va a poder generar.');
                }
                // los workflows que ese fierro ofrece ya están en la respuesta:
                // sirven para pintar CREATE en el acto, sin esperar al socket.
                if (d.peer && d.peer.id) {
                    var peer = ESTADO.peers.filter(function (x) { return x.id === d.peer.id; })[0];
                    if (peer) peer.workflows = d.workflows || [];
                }
                try { window.CKConexion && window.CKConexion.pintar(); } catch (e) { }
            } else {
                log('⚠️ No pude confirmar la conexión: ' + ((d && d.message) || ('HTTP ' + r.status)));
            }
            pintar();
        }).catch(function (e) {
            log('⚠️ Sin respuesta de esa computadora: ' + e.message);
            pintar();
        });
    }

    // le dice al hub qué computadora está usando este navegador (para que el
    // panel RED de esa PC muestre "clientes conectados a esta PC")
    // clave estable de este navegador (para que el hub lo reconozca entre recargas)
    function claveCliente() {
        try {
            var k = localStorage.getItem('ck_cliente_clave');
            if (!k) {
                k = Math.random().toString(36).slice(2) + Date.now().toString(36);
                localStorage.setItem('ck_cliente_clave', k);
            }
            return k;
        } catch (e) { return ''; }
    }

    // le dice al hub qué computadora está usando este navegador (con quién es),
    // para que el panel RED de esa PC muestre "clientes conectados a esta PC"
    function avisarClienteNodo(id) {
        if (esLocal) return;
        var u = {};
        try { u = JSON.parse(localStorage.getItem('fsc_user_jpi') || 'null') || {}; } catch (e) { }
        try {
            fetch(BASE + '/api/red/cliente-nodo', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    peerId: id || '', clave: claveCliente(),
                    usuario: u.username || u.usuario || '', displayName: u.displayName || '',
                    avatar: u.avatar || ''
                })
            }).catch(function () { });
        } catch (e) { }
    }

    function desconectar() {
        // La conexión puede ser una PC o un RunPod: se suelta la que esté activa.
        if (runpodActivo()) {
            var nom = nombreRunpod();
            log('🔌 Soltando el RunPod ' + nom + '…');
            setRunpod(ESTADO.runpod.url, false).then(function () {
                log('🔌 Desconectado de ' + nom + '. En local volvés a generar en esta PC.');
                pintar();
                try { window.CKConexion && window.CKConexion.pintar(); } catch (e) { }
                refrescar(false);
            }).catch(function (e) { log('⚠️ No pude apagar el RunPod: ' + e.message); });
            return;
        }
        var eraRemoto = !!ESTADO.elegido && !(ESTADO.yo && ESTADO.yo.peerId === ESTADO.elegido);
        guardarElegido('');
        ESTADO.elegido = '';
        avisarClienteNodo('');
        log(eraRemoto || !esLocal
            ? '🔌 Desconectado. Elegí otra computadora cuando quieras.'
            : '🔌 Soltaste el nodo: en local volvés a generar en esta PC.');
        pintar();
        try { window.CKConexion && window.CKConexion.pintar(); } catch (e) { }
    }

    function abrirPanel(id, idBoton) {
        var panel = document.getElementById(id);
        if (!panel) return;
        // misma mecánica que las pestañas del editor, pero en vivo
        document.querySelectorAll('.tab-button').forEach(function (b) {
            b.classList.toggle('active', b.id === idBoton);
        });
        document.querySelectorAll('.tab-content').forEach(function (c) {
            c.classList.toggle('active', c === panel);
        });
        document.body.classList.remove('tab-editor-active');
        if (typeof window.cerrarCajonesMobile === 'function') { try { window.cerrarCajonesMobile(); } catch (e) { } }
    }
    function abrir() {
        abrirPanel('panelRed', 'tabRedBtn');
        refrescar(false);
    }
    function abrirAcceso() {
        abrirPanel('panelAcceso', 'tabAccesoBtn');
        refrescar(false);
        if (typeof window.CK_acciones === 'object' && typeof window.CK_acciones.pintarPermisos === 'function') {
            window.CK_acciones.pintarPermisos();
        }
    }
    window.comfyRed = {
        estado: ESTADO, refrescar: refrescar, generar: generar, abrir: abrir,
        abrirAcceso: abrirAcceso, repintar: pintar,
        conectarRunpod: conectarRunpod, desconectar: desconectar, runpodActivo: runpodActivo,
        conexionActual: conexionActual
    };

    // ---------- pintado ----------
    function pintar() {
        var cont = document.getElementById('redNodos');
        if (!cont) return;
        // el panel se repinta cada pocos segundos: si no guardo el scroll vuelve
        // arriba y nunca se llega a ver lo de abajo (MI EQUIPO y su línea de estado)
        var _panelRed = document.getElementById('panelRed');
        var _scrollRed = _panelRed ? _panelRed.scrollTop : 0;

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
        // UNA sola conexión: si hay un RunPod activo, la PC elegida se suelta.
        if (runpodActivo() && elegido) { guardarElegido(''); elegido = ''; }
        var esWebAqui = (function () {
            try { var h = location.hostname; return h !== 'localhost' && h !== '127.0.0.1' && h.indexOf('localhost') === -1; }
            catch (e) { return false; }
        })();
        if (!elegido && !esWebAqui && !runpodActivo()) {
            // En LOCAL, por defecto se genera en esta PC (salvo que esté conectado
            // un RunPod). En la WEB no se elige NADA por defecto: el usuario decide
            // a quién pedirle en RED y hasta entonces los workflows de CREATE van grises.
            if (yoId) { guardarElegido(yoId); elegido = yoId; }
            else {
                var libre = peers.filter(function (p) { return p.compartir; })[0];
                if (libre) { guardarElegido(libre.id); elegido = libre.id; }
            }
        }
        // Sin conexión (ni PC ni RunPod) los botones de generar van grises.
        try {
            document.body.classList.toggle('ck-sin-computadora', !(elegido || runpodActivo()));
        } catch (e) { }

        var con = conexionActual();
        if (con.tipo === 'runpod') {
            var rpC = runpodDe(con.id) || {};
            caja.innerHTML = '🔗 <b>CONECTADO</b> a <b>' + esc(con.nombre) + '</b>' +
                ' <span class="red-badge">☁️ RunPod</span>' +
                ' <span class="red-sub-chico">' + (rpC.enLinea
                    ? 'motor en la nube · no ocupa tu PC'
                    : 'sin respuesta · revisá que el pod esté prendido') + '</span>' +
                ' <button class="red-btn secundario chico" id="redDesconectar">🔌 DESCONECTAR</button>';
        } else if (con.tipo === 'pc') {
            var esMio = (con.id === yoId);
            var p2 = esMio ? null : peers.filter(function (p) { return p.id === con.id; })[0];
            caja.innerHTML = '🔗 <b>CONECTADO</b> a <b>' + esc(con.nombre) + '</b>' +
                ' <span class="red-badge">' + (esMio ? '💻 Esta PC' : '🖥️ PC') + '</span>' +
                (esMio ? '' : (p2 ? ' <span class="red-sub-chico">' +
                    (p2.ocupado || p2.encolados ? 'ocupada · ' + (p2.encolados || 0) + ' en cola' : 'libre') +
                    '</span>' : '')) +
                ' <button class="red-btn secundario chico" id="redDesconectar">🔌 DESCONECTAR</button>';
        } else {
            caja.innerHTML = '🔌 <b>No estás conectado</b> — elegí una PC o un RunPod abajo y tocá CONECTAR.';
        }
        caja.className = 'red-elegido' + (con.tipo ? '' : ' vacio');
        var bd = document.getElementById('redDesconectar');
        if (bd) bd.addEventListener('click', function (e) {
            e.preventDefault();
            desconectar();
        });

        // grilla de nodos
        var tarjetas = [];
        if (esLocal && ESTADO.yo) {
            tarjetas.push(tarjeta({
                id: yoId,
                nombre: ESTADO.yo.nombre,
                host: 'esta PC',
                gpu: ESTADO.yo.gpu || '',
                modelos: ESTADO.yo.modelos || [],
                compartir: !!ESTADO.yo.compartir,
                comfy: true,
                encolados: 0,
                propio: true,          // "tu nodo": siempre usable desde acá
                conectado: !!ESTADO.yo.conectado
            }));
        }
        otros.forEach(function (p) { tarjetas.push(tarjeta(p)); });

                // ☁️ RUNPODS: se muestran como un nodo más (son ComfyUI en la nube).
        var runpods = (window.CK_runpods && window.CK_runpods.lista) ? window.CK_runpods.lista() : [];
        // el ojo manda también acá: con "ocultar" sólo se ven los que están en línea
        if (!ESTADO.verPasados) runpods = runpods.filter(function (rp) { return rp.enLinea; });
        runpods.forEach(function (rp) { tarjetas.push(tarjetaRunpod(rp)); });

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
            ? [ESTADO.yo.peerId, ESTADO.yo.nombre, ESTADO.yo.compartir, ESTADO.yo.conectado,
               ESTADO.yo.gpu || '', ESTADO.yo.publicarGpu !== false].join('|')
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
                '    <span class="red-pub-estado" id="redPubEstado"></span>',
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
                '  <label class="red-switch"><input type="checkbox" id="redPublicarGpu"' +
                    (ESTADO.yo.publicarGpu !== false ? ' checked' : '') + '>',
                '    <span class="pista"></span><span>🎮 Publicar el nombre de mi placa de video' +
                    (ESTADO.yo.gpu ? ' (' + esc(ESTADO.yo.gpu) + ')' : '') + '</span></label>',
                '</div>',
            ].join('\n');
            // el innerHTML borra el span: repinto lo último que sabía del hub
            if (_ultimoPublicado) pintarPublicado(_ultimoPublicado);
            // feedback de publicación (cada 20 s como mucho)
            if (!_ultimaVerif || (Date.now() - _ultimaVerif) > 20000) setTimeout(verificarPublicado, 400);
            var bc = document.getElementById('redConectar');
            if (bc) {
                bc.addEventListener('click', function () {
                    bc.disabled = true;
                    bc.textContent = '⏳ Conectando...';
                    log('🔌 Arrancando el agente del nodo...');
                    api('/api/red/agente', { json: {} }).then(function (r) {
                        // el endpoint contesta 200 con success:false cuando el nodo
                        // no logró publicarse: hay que mirar success, no el HTTP.
                        var d = (r && r.datos) || {};
                        if (d.success === false) {
                            log('⚠️ ' + (d.message || 'No me pude conectar a la red'));
                            bc.disabled = false;
                            bc.textContent = '🔌 Conectar a la red';
                        } else {
                            log(d.ya ? '✅ Ya estabas publicado en la red' : '✅ Publicado en la red');
                            bc.textContent = '✅ Publicado';
                        }
                        setTimeout(function () { refrescar(true); }, 3000);
                    }).catch(function (e) {
                        log('⚠️ No pude conectar: ' + e.message);
                        bc.disabled = false;
                        bc.textContent = '🔌 Conectar a la red';
                    });
                });
            }
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
            var chkGpu = document.getElementById('redPublicarGpu');
            if (chkGpu) {
                chkGpu.addEventListener('change', function () {
                    log(chkGpu.checked ? '🎮 Publicando la placa de video...' : '🎮 Ocultando la placa de video...');
                    api('/api/red/compartir', { json: { publicarGpu: chkGpu.checked } }).then(function () {
                        log(chkGpu.checked ? '✅ La red ya ve tu placa de video' : '🔒 La placa de video quedó oculta');
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
                    verificarPublicado(10);
                    });
                });
            }
        } else if (!esLocal || !ESTADO.yo) {
            cajaMio.innerHTML = '';
        }
        if (_panelRed && _scrollRed) _panelRed.scrollTop = _scrollRed;
    }

    // ---------- feedback del switch "Transmitir mi Comfy" ----------------
    // Le pregunta AL HUB si esta PC aparece publicada (no usa el estado local).
    var _ultimaVerif = 0;
    var _ultimoPublicado = null;
    function pintarPublicado(d) {
        if (d) _ultimoPublicado = d;
        var caja = document.getElementById('redPubEstado');
        if (!caja) return;
        if (!d) { caja.textContent = ''; return; }
        if (d.publicado) {
            // verde = la WEB la tiene registrada (lista de nodos + IACOMFY), no
            // alcanza con que el socket del hub la escuche
            var reg = d.registrada ? (' · @' + esc(d.registrada.username || '—') +
                (d.registrada.sesiones ? ' · ' + d.registrada.sesiones + ' sesiones' : '')) : '';
            caja.className = 'red-pub-estado ok';
            caja.innerHTML = '✅ La web te tiene registrado como <b>' + esc(d.nombre) + '</b>' + reg +
                (d.compartir ? ' · compartiendo tu Comfy' : ' · sin compartir tu Comfy') +
                (d.nodos ? ' <span class="red-pub-n">(' + d.nodos + ' PC en la red)</span>' : '');
        } else {
            caja.className = 'red-pub-estado no';
            caja.innerHTML = (d.enRed
                ? '⚠️ El VPS te escucha pero la web todavía no te registró'
                : '⚠️ Todavía no aparecés en la red') +
                (d.motivo ? ' · ' + esc(d.motivo) : '');
        }
    }
    function verificarPublicado(intentos) {
        var n = (intentos === undefined) ? 6 : intentos;
        _ultimaVerif = Date.now();
        api('/api/red/publicado').then(function (r) {
            var d = (r && r.datos) || {};
            pintarPublicado(d);
            if (!d.publicado && n > 1) setTimeout(function () { verificarPublicado(n - 1); }, 1500);
        }).catch(function () { });
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

    // --- el botón es EL MISMO para una PC y para un RunPod -------------------
    function botonConexion(activo, attr, valor, habilitado, textoNo, title) {
        if (activo) {
            return '<button class="red-btn chico" data-desconectar="' + esc(valor) + '" title="soltar esta conexión">🔌 DESCONECTAR</button>';
        }
        return '<button class="red-btn secundario chico" ' + attr + '="' + esc(valor) + '"' +
            (habilitado ? '' : ' disabled') +
            (title ? ' title="' + esc(title) + '"' : '') + '>' +
            (habilitado ? 'CONECTAR' : textoNo) + '</button>';
    }

    function tarjeta(p) {
        var mio = !!p.propio;
        var elegido = ESTADO.elegido === p.id;
        var punto = !p.conectado ? 'off' : (p.encolados > 0 ? 'ocupado' : (p.comfy ? 'ok' : 'off'));
        var modelos = (p.modelos || []).map(function (m) { return m.nombre || m.id; }).join(' · ') || '—';
        var puede = mio || (p.compartir && p.conectado);
        var boton = botonConexion(elegido, 'data-usar', p.id, puede,
            p.compartir ? 'No disponible' : 'No comparte');
        var sello = elegido ? ' <span class="red-badge comparto">✅ CONECTADO</span>' : '';
        var estado;
        // OJO: el puntito de estado ya lo pone <span class="red-punto">; acá NO va
        // otro emoji (antes salían dos verdes seguidos: el punto y el 🟢).
        if (mio) {
            estado = p.conectado ? 'publicado en la red' : 'sin publicar (corré conectar-comfylatam.bat)';
        } else {
            if (p.conectado) {
                var quien = p.usuario ? ' · de @' + p.usuario : '';
                var enUso = !!(p.ocupado || p.encolados > 0 || p.ejecutando > 0);
                estado = (p.comfy
                    ? (enUso
                        // se puede conectar igual: sólo se avisa que está trabajando
                        ? 'EN USO · ' + ((p.encolados || 0) + (p.ejecutando > 0 ? 1 : 0)) + ' en cola (te podés conectar igual)'
                        : 'LIBRE para generar')
                    : 'Comfy apagado') + quien;
            } else {
                var hace = '';
                if (p.visto) {
                    var min = Math.round((Date.now() - Number(p.visto)) / 60000);
                    hace = min < 1 ? ' · hace instantes' : (min < 60 ? ' · hace ' + min + ' min' : ' · hace ' + Math.round(min / 60) + ' h');
                }
                estado = (p.visto ? 'conexión pasada' : 'sin conexión') + hace;
            }
        }
        var lineaPc = [p.gpu ? esc(p.gpu) : '', p.usuario ? 'de @' + esc(p.usuario) : '']
            .filter(Boolean).join(' · ');
        return [
            '<div class="red-nodo' + (elegido ? ' elegido' : '') + (puede ? '' : ' apagado') + '">',
            '  <div class="nombre">' + (p.avatar
                ? '<img class="red-avatar" src="' + esc(p.avatar) + '" alt="">'
                : (p.principal ? '⭐ ' : (mio ? '💻 ' : '🖥️ '))) + esc(p.nombre),
            '<span class="red-badge">PC</span>',
            mio ? '<span class="red-badge comparto">tu nodo</span>'
                : '<span class="red-badge ' + (p.compartir ? 'comparto' : '') + '">' + (p.compartir ? 'comparte' : 'transmisión apagada') + '</span>',
            (p.principal && !mio) ? '<span class="red-badge principal">principal</span>' : '',
            // si el dueño limitó quién puede usar su PC, se avisa en la tarjeta
            (p.accesoNodo && p.accesoNodo.modo === 'lista')
                ? '<span class="red-badge acceso-limitado" title="sólo algunos usuarios">🔒 ' + ((p.accesoNodo.usuarios || []).length) + '</span>'
                : '',
            sello,
            '  </div>',
            // Si no hay GPU publicada NO se escribe nada (ni "sin GPU" ni la palabra
            // GPU): la línea se arma sólo con lo que hay, y si queda vacía no se pinta.
            lineaPc ? '  <div class="linea">' + lineaPc + '</div>' : '',
            '  <div class="linea">' + esc(modelos) + '</div>',
            '  <div class="estado"><span class="red-punto ' + punto + '"></span>' + estado + '</div>',
            '  <div class="red-accion">' + boton + '</div>',
            '</div>'
        ].join('\n');
    }

    // --- ☁️ tarjeta de un RunPod: MISMO formato, mismo botón, mismo estado ----
    function tarjetaRunpod(rp) {
        var vivo = !!rp.enLinea;
        var activo = runpodActivo() && ESTADO.runpod.url === rp.url;
        var lineas = [];
        if (rp.gpu) lineas.push(esc(rp.gpu) + (rp.vram ? ' · ' + rp.vram + ' GB' : ''));
        lineas.push(esc(rp.url));
        // Igual que una PC: en la web no se puede conectar el RunPod de otro
        var boton = botonConexion(activo, 'data-runpod-usar', rp.url, esLocal ? vivo : false,
            'No disponible',
            esLocal ? 'usar este ComfyUI de la nube como motor' : 'se usa desde la app local de su dueño');
        var sello = activo ? ' <span class="red-badge comparto">✅ CONECTADO</span>' : '';
        var estado = vivo
            ? (activo ? 'CONECTADO · el motor de tu app es este RunPod' : 'LIBRE para generar')
            : 'sin respuesta · /system_stats no contesta';
        return [
            '<div class="red-nodo runpod' + (activo ? ' elegido' : '') + (vivo ? '' : ' apagado') + '">',
            '  <div class="nombre">☁️ ' + esc(rp.nombre || 'RunPod'),
            '    <span class="red-badge">☁️ NUBE</span>',
            sello,
            '  </div>',
            lineas.map(function (l) { return '  <div class="linea">' + l + '</div>'; }).join('\n'),
            '  <div class="estado"><span class="red-punto ' + (vivo ? 'ok' : 'off') + '"></span>' + estado + '</div>',
            '  <div class="red-accion">' + boton +
                ' <button class="red-btn secundario chico" data-runpod-borrar="' + esc(rp.id) + '" title="quitar de mi perfil">✕</button></div>',
            '</div>'
        ].join('\n');
    }

    // --- 👥 clientes conectados: cuántos, usuarios y de qué tipo -------------
    function pintarClientes() {
        var caja = document.getElementById('redClientes');
        if (!caja) return;
        var c = ESTADO.clientes || {};
        var miId = (ESTADO.yo && ESTADO.yo.peerId) || '';
        var porNodo = (c.porNodo && miId && c.porNodo[miId]) || { web: 0, usuarios: [] };
        // localAca/webAca los calcula el nodo (esta PC); si no vienen, se usa el global
        var locales = Number(c.localAca != null ? c.localAca : (c.local || 0));
        var webAca = Number(c.webAca != null ? c.webAca : (porNodo.web || 0));
        var aca = locales + webAca;
        var usuarios = c.usuarios || [];
        var usandoAca = {};
        (c.usuariosAca || porNodo.usuarios || []).forEach(function (u) { usandoAca[u.usuario] = 1; });

        // si no hay datos todavía
        if (!c.total && !aca && !usuarios.length) {
            caja.innerHTML = '<h3 class="red-titulo">👥 CLIENTES CONECTADOS A ESTA PC</h3>' +
                '<div class="red-sub-chico">Todavía no hay nadie conectado.</div>';
            return;
        }

        var filas = usuarios.map(function (u) {
            var foto = u.avatar ? '<img class="red-avatar" src="' + esc(u.avatar) + '" alt="">' : '👤 ';
            var tipos = [];
            if (u.web) tipos.push(u.web + ' web');
            if (u.local) tipos.push(u.local + ' local');
            var aca = usandoAca[u.usuario] ? ' <span class="red-badge comparto">usando esta PC</span>' : '';
            return '<div class="red-cliente-fila">' + foto +
                '<b>@' + esc(u.usuario) + '</b>' +
                '<span class="red-cliente-tipo">' + tipos.join(' · ') + '</span>' + aca + '</div>';
        }).join('');

        caja.innerHTML = [
            '<h3 class="red-titulo">👥 CLIENTES CONECTADOS A ESTA PC <span class="red-badge">' + aca + '</span></h3>',
            '<div class="red-cliente-resumen">',
            '  <span>💻 ' + locales + ' local(es) en esta PC</span>',
            '  <span>🌐 ' + webAca + ' desde la web usando esta PC</span>',
            '  <span>👤 ' + (c.usuariosTotal || 0) + ' usuario(s) en la red</span>',
            (c.anonimos ? '  <span class="red-cliente-anon">' + c.anonimos + ' sin sesión</span>' : ''),
            '</div>',
            filas ? '<div class="red-clientes-lista">' + filas + '</div>' : '',
            '<div class="red-sub-chico">Un <b>cliente</b> es cada navegador conectado: los locales de esta PC ' +
            'y los de la web que eligieron usarla (los que apretaron <b>usar esta compu</b>). ' +
            'En toda la red hay ' + (c.total || 0) + ' cliente(s): ' + (c.web || 0) + ' web · ' + (c.local || 0) + ' local.</div>'
        ].join('\n');
    }

    // --- (el bloque "TU EQUIPO" se sacó: en la web no tiene sentido y en local
    // duplicaba el panel de la izquierda, que ya muestra entorno/ComfyUI/estado) ---

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
                    modelos: r.datos.modelos || [],
                    gpu: r.datos.gpu || (r.datos.computadora && r.datos.computadora.gpu) || '',
                    publicarGpu: r.datos.publicarGpu !== false
                };
                ESTADO.peers = r.datos.nodos || [];
                ESTADO.pasados = r.datos.pasados || [];
                ESTADO.clientes = r.datos.clientes || ESTADO.clientes;
                ESTADO.enVueloDetalle = r.datos.enVueloDetalle || [];
        // el panel del STAGE se alimenta también con el estado inicial (antes sólo
        // se pintaba cuando llegaba un aviso por WebSocket: al entrar quedaba vacío)
        window.JPI_RED_VUELO = ESTADO.enVueloDetalle || [];
        if (typeof window.jpiPintarVuelo === 'function') { try { window.jpiPintarVuelo(); } catch (e) { } }
                ESTADO.computadora = r.datos.computadora || ESTADO.computadora;
                // motor externo (RunPod): es la otra forma de estar conectado
                var ce = r.datos.comfyExterno || {};
                ESTADO.runpod = { url: ce.url || '', activo: !!ce.activo };
                ESTADO.motorBase = r.datos.motorBase || '';
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
            pintarClientes();
        }).catch(function (e) { if (manual) log('⚠️ ' + e.message); });
    }

    // ---------- generar ----------
    function generar() {
        var prompt = (document.getElementById('redPrompt').value || '').trim();
        if (!prompt) { log('⚠️ Falta el prompt'); return; }
        // SÓLO la PC elegida en la lista. Antes, si el select quedaba vacío, se
        // usaba la última guardada y el trabajo podía irse a otra computadora.
        var selDestino = document.getElementById('redDestino');
        var destino = (selDestino && selDestino.value) || '';
        if (!destino) {
            log(runpodActivo()
                ? '⚠️ Estás conectado al RunPod ' + nombreRunpod() +
                  ': generá desde CREATE (usa ese motor) o conectá una PC para mandarle el trabajo.'
                : '⚠️ Elegí una computadora en la lista (no hay ninguna seleccionada)');
            return;
        }
        var peerDestino = (ESTADO.peers || []).filter(function (x) { return x.id === destino; })[0] || null;
        if (peerDestino && peerDestino.comfy === false) {
            log('⚠️ ' + (peerDestino.nombre || 'Esa PC') + ' tiene el ComfyUI apagado: elegí otra computadora.');
            return;
        }
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
                            modelos: m.red.modelos || [],
                            gpu: m.red.gpu || (m.red.computadora && m.red.computadora.gpu) || '',
                            publicarGpu: m.red.publicarGpu !== false
                        };
                        ESTADO.peers = m.red.nodos || [];
                        ESTADO.pasados = m.red.pasados || [];
                        if (m.red.comfyExterno !== undefined) {
                            ESTADO.runpod = {
                                url: (m.red.comfyExterno && m.red.comfyExterno.url) || '',
                                activo: !!(m.red.comfyExterno && m.red.comfyExterno.activo)
                            };
                        }
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
        // si al entrar ya había una computadora elegida, se la vuelve a avisar al hub
        if (ESTADO.elegido) setTimeout(function () { avisarClienteNodo(ESTADO.elegido); }, 1200);
        // En la WEB se entra SIN computadora conectada (y los botones de generar
        // van grises desde el arranque, sin esperar al estado de la red); en local
        // se elige esta PC. Asi el default no depende de que llegue el WS.
        try {
            var esWeb0 = (function () { var h = location.hostname; return h !== 'localhost' && h !== '127.0.0.1' && h.indexOf('localhost') === -1; })();
            if (esWeb0 && ESTADO.elegido) { guardarElegido(''); ESTADO.elegido = ''; }
            document.body.classList.toggle('ck-sin-computadora', esWeb0 && !ESTADO.elegido);
        } catch (e) { }
        refrescar(false);
        conectarEventos();
        setInterval(function () { refrescar(false); }, 7000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar);
    else arrancar();
})();
