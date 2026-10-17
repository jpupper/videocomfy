// ============================================================
// COMFYLATAM — ¿el modelo de este workflow está CARGADO?
// ------------------------------------------------------------
// Pinta, en cada botón de selección de workflow (CREATE), si los modelos de ese
// workflow están en VRAM, en RAM o sólo en disco, y deja precargarlos con un
// click (LOAD MODELS).
//
// El dato NO se adivina: lo lee el nodo `comfylatam_state` que vive dentro de
// ComfyUI (custom_nodes) y la app lo expone en /api/motor/estado-modelos.
//   local  -> el ComfyUI de esta PC
//   web    -> el ComfyUI del nodo elegido, por el túnel del hub
// Si el nodo no está instalado en ese ComfyUI, la app avisa `detalle: false` y
// acá se muestra "sin dato" en vez de inventar un estado.
// ============================================================
(function () {
    'use strict';

    var J = window.JPI || {};
    var BASE = J.API_BASE || '';
    var esWeb = false;
    try {
        var h = location.hostname;
        esWeb = (h !== 'localhost' && h !== '127.0.0.1' && h.indexOf('localhost') === -1);
    } catch (e) { }

    // qué archivo(s) de workflows/ usa cada tarjeta (misma tabla que conexion.js)
    var ARCHIVOS = {
        t2i: { todos: ['flux_dev_fp8_api.json'] },
        t2v: { todos: ['video_ltx2_t2v_api.json'] },
        t2i2v: { todos: ['flux_dev_fp8_api.json', 'video_ltx2_t2v_api.json'] },
        i2v: { alguno: ['video_ltx25_i2v_api.json', 'video_ltx2_i2v_api.json'] },
        chainvideo: { todos: ['video_wan2_2_14B_flf2v_api.json'] },
        storyboard: { todos: ['flux_dev_full_text_to_image_api.json'] },
        zimage: { todos: ['z_image_turbo_api.json'] },
        qwen21: { todos: ['qwen_image_21_api.json'] },
        ideogram4: { todos: ['ideogram4_api.json'] }
    };

    var ESTADOS = {
        cargado: { txt: '🔥 en memoria', cls: 'wf-load-vram', tip: 'los modelos ya se leyeron del disco y están en la memoria de la máquina: genera sin esperar la carga' },
        parcial: { txt: '🔥 parcial', cls: 'wf-load-parcial', tip: 'sólo una parte de los modelos de este workflow está en memoria' },
        ram: { txt: '🧠 en RAM', cls: 'wf-load-ram', tip: 'leído en memoria, todavía no en la placa' },
        disco: { txt: '💤 en disco', cls: 'wf-load-disco', tip: 'no está cargado: al generar se lee del disco primero' },
        desconocido: { txt: '❔ sin dato', cls: 'wf-load-sindato', tip: 'no pude ver el estado del motor' },
        'sin-modelos': { txt: '—', cls: 'wf-load-disco', tip: 'ese workflow no declara modelos' }
    };

    var ultimo = null;
    var pidiendo = false;

    function api(ruta, opciones) {
        var opt = opciones || {};
        var init = { method: opt.method || 'GET', headers: { 'Content-Type': 'application/json' } };
        try {
            var tok = localStorage.getItem('fsc_token_jpi') || J.TOKEN;
            if (tok) init.headers['Authorization'] = 'Bearer ' + tok;
        } catch (e) { }
        if (opt.json) init.body = JSON.stringify(opt.json);
        return fetch(BASE + ruta, init).then(function (r) { return r.json(); });
    }

    function conectadoEnWeb() {
        // en la web sin nodo elegido no hay a quién preguntarle
        if (!esWeb) return true;
        return !!nodoElegido();
    }

    function nodoElegido() {
        try { return localStorage.getItem('comfylatam_nodo_elegido') || ''; } catch (e) { return ''; }
    }

    // En la web el pedido tiene que ir AL NODO ELEGIDO (/p/<nodo>/…), no al hub:
    // si no, le preguntaríamos el estado del motor a la PC equivocada.
    function rutaMotor(ruta) {
        return esWeb && nodoElegido() ? ('/p/' + encodeURIComponent(nodoElegido()) + ruta) : ruta;
    }

    // estado del workflow para una tarjeta
    function estadoDeCard(card) {
        var regla = ARCHIVOS[card];
        if (!regla || !ultimo) return null;
        var porArchivo = {};
        (ultimo.workflows || []).forEach(function (w) { porArchivo[w.archivo] = w; });
        var lista = (regla.todos || regla.alguno || []).map(function (f) {
            return porArchivo[f] || { archivo: f, estado: 'desconocido', piezas: [] };
        });
        if (!lista.length) return null;

        function prioridad(e) {
            return { parcial: 5, cargado: 4, ram: 3, disco: 2, desconocido: 1, 'sin-modelos': 0 }[e] || 0;
        }
        var elegido = lista.slice().sort(function (a, b) { return prioridad(b.estado) - prioridad(a.estado); })[0];
        return { estado: elegido.estado, workflow: elegido, todos: lista };
    }

    function detalle(wf) {
        if (!wf) return '';
        var piezas = (wf.piezas || []).map(function (p) {
            var e = (ESTADOS[p.estado] || ESTADOS.desconocido).txt;
            var gb = '';
            if (p.estado === 'cargado') {
                var total = (p.vramMB || 0) + (p.ramMB || 0);
                gb = total ? ' (' + (total / 1024).toFixed(1) + ' GB)' : '';
            }
            return '· ' + p.archivo + ' → ' + e + gb;
        });
        return piezas.join('\n');
    }

    function pintar() {
        var cards = document.querySelectorAll('.wf-card[data-workflow]');
        if (!cards.length) return;
        Array.prototype.forEach.call(cards, function (card) {
            var clave = card.getAttribute('data-workflow');
            var info = estadoDeCard(clave);
            if (!info) return;
            var meta = ESTADOS[info.estado] || ESTADOS.desconocido;
            var badge = card.querySelector('.wf-load-badge');
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'wf-load-badge';
                badge.addEventListener('click', function (ev) {
                    // que el click NO seleccione la tarjeta ni dispare el generate
                    ev.preventDefault();
                    ev.stopPropagation();
                    if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
                    precargar(info);
                }, true);
                card.appendChild(badge);
            }
            badge.className = 'wf-load-badge ' + meta.cls;
            badge.textContent = meta.txt;
            badge.setAttribute('data-wf-file', (info.workflow && info.workflow.archivo) || '');
            badge.title = meta.tip + (detalle(info.workflow) ? '\n' + detalle(info.workflow) : '') +
                (ultimo && ultimo.detalle === false ? '\n(instalá el nodo comfylatam_state en ComfyUI para ver el detalle exacto)' : '') +
                '\nclick = precargar los modelos en la placa';
        });

        // resumen de VRAM arriba de las tarjetas
        var barra = document.querySelector('.wf-selector-bar') || document.querySelector('.wf-cards-container');
        if (barra && ultimo && ultimo.vram && ultimo.vram.total) {
            var lbl = document.getElementById('ckVramLabel');
            if (!lbl) {
                lbl = document.createElement('span');
                lbl.id = 'ckVramLabel';
                lbl.className = 'ck-vram-label';
                barra.appendChild(lbl);
            }
            var usado = ultimo.vram.usado / (1024 * 1024 * 1024);
            var total = ultimo.vram.total / (1024 * 1024 * 1024);
            lbl.textContent = '🎛️ VRAM ' + usado.toFixed(1) + ' / ' + total.toFixed(0) + ' GB';
            lbl.title = ultimo.detalle ? 'medido por comfylatam_state' : (ultimo.error || 'sin detalle');
        }
    }

    function traer(primera) {
        if (pidiendo) return;
        if (!conectadoEnWeb()) {
            document.querySelectorAll('.wf-load-badge').forEach(function (b) { b.remove(); });
            var l = document.getElementById('ckVramLabel');
            if (l) l.remove();
            return;
        }
        pidiendo = true;
        api(rutaMotor('/api/motor/estado-modelos' + (primera ? '?forzar=1' : '')))
            .then(function (d) {
                pidiendo = false;
                if (!d || !d.success) return;
                ultimo = d;
                pintar();
            })
            .catch(function () { pidiendo = false; });
    }

    function precargar(info) {
        if (!info || !info.workflow) return;
        var archivo = info.workflow.archivo;
        var badge = document.querySelector('.wf-load-badge[data-wf-file="' + archivo + '"]');
        var antes = badge ? badge.textContent : '';
        if (badge) { badge.textContent = '⏳ cargando…'; badge.className = 'wf-load-badge wf-load-cargando'; }
        api(rutaMotor('/api/motor/precargar'), { method: 'POST', json: { archivo: archivo } })
            .then(function (r) {
                if (r && r.success) {
                    try {
                        if (typeof appendConsoleLine === 'function') {
                            appendConsoleLine('🔥 Precargando ' + archivo + ' (' + (r.nodos || 0) + ' nodos de carga)', 'system');
                        }
                    } catch (e) { }
                    setTimeout(function () { traer(true); }, 4000);
                    setTimeout(function () { traer(true); }, 15000);
                    return;
                }
                if (badge) { badge.textContent = antes; }
                try {
                    if (typeof appendConsoleLine === 'function') {
                        appendConsoleLine('⚠️ No pude precargar: ' + ((r && r.message) || 'sin respuesta') +
                            ((r && r.pista) ? ' — ' + r.pista : ''), 'warning');
                    }
                } catch (e) { }
            })
            .catch(function () {
                if (badge) { badge.textContent = antes; }
            });
    }

    function arrancar() {
        traer(true);
        setInterval(function () {
            if (document.hidden) return;
            traer(false);
        }, 4000);
        // cuando cambia el nodo elegido, se vuelve a preguntar
        document.addEventListener('click', function (e) {
            if (e.target && e.target.closest && e.target.closest('#redNodos, #redDestino, .red-nodo')) {
                setTimeout(function () { traer(true); }, 800);
            }
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(arrancar, 3500); });
    else setTimeout(arrancar, 3500);
})();
