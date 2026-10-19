// ============================================================
// COMFYLATAM — LA BARRA DE PROGRESO CUENTA LO QUE PASA DE VERDAD
// ------------------------------------------------------------
// Antes la barra la escribían 8 lugares distintos de script.js: en la web
// quedaba diciendo "Nothing to generate / all done" mientras la lista de abajo
// mostraba un trabajo en curso (el usuario lo reportó: "abajo dice que está
// procesando y arriba que no hay nada").
//
// Ahora hay UN solo dueño de #progressText / #progressFill / #progressPct y la
// barra muestra el pipeline real, paso por paso:
//
//   web:  🔌 no hay nodo → 📤 pidiendo al nodo → ⚙️ ComfyUI (paso x/N)
//         → ☁️ subiendo a Cloudflare → ✅ listo
//   local: 🔴 Comfy apagado → ⚙️ generando (paso x/N) → ✅ listo
//
// Se alimenta de: los mensajes del WebSocket (progress/executing/executed/…),
// el estado de la red (nodo elegido) y el estado de las colas (app + ComfyUI).
// ============================================================
(function () {
    'use strict';

    var fill = document.getElementById('progressFill');
    var txt = document.getElementById('progressText');
    var pctEl = document.getElementById('progressPct');
    if (!txt) return;

    var esWeb = false;
    try {
        var h = location.hostname;
        esWeb = (h !== 'localhost' && h !== '127.0.0.1' && h.indexOf('localhost') === -1);
    } catch (e) { }

    // ---------- dónde va cada cosa en el pipeline ----------
    var PASOS = ['Nodo', 'Comfy', 'Nube'];
    var S = {
        etapa: esWeb ? 'sinNodo' : 'reposo',
        nodo: '',
        pct: 0,
        pasos: { Nodo: 'espera', Comfy: 'espera', Nube: 'espera' },
        prompt: '',
        archivo: '',
        error: '',
        desde: 0,          // cuándo arrancó la generación en curso
        hasta: 0,
        paso: 0, total: 0, // paso x/N que reporta ComfyUI
        ultimoMsg: 0,
        colaApp: 0,
        colaComfy: 0
    };

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    function seg(ms) {
        if (!ms || ms < 0) return '';
        var s = Math.round(ms / 1000);
        if (s < 60) return s + 's';
        var m = Math.floor(s / 60);
        return m + 'm ' + (s % 60) + 's';
    }

    // nodo elegido en la red (lo mantiene js/red.js)
    function nodoElegido() {
        try {
            var e = (window.comfyRed && window.comfyRed.estado) || null;
            if (!e) return null;
            var id = e.elegido;
            if (!id) return null;
            var peers = e.peers || [];
            for (var i = 0; i < peers.length; i++) {
                if (peers[i].id === id) return peers[i];
            }
            if (e.yo && e.yo.peerId === id) return { id: id, nombre: e.yo.nombre || 'esta PC', gpu: '' };
            return { id: id, nombre: id, gpu: '' };
        } catch (err) { return null; }
    }

    function hayTrabajo() {
        // ¿hay algo corriendo de verdad? (lo que ve el usuario abajo)
        if (S.colaApp > 0) return true;
        if (S.colaComfy > 0) return true;
        if (S.etapa === 'comfy' || S.etapa === 'nube' || S.etapa === 'pidiendo') return true;
        return false;
    }

    // ---------- el texto y la barra ----------
    function pintar() {
        var pct = Math.max(0, Math.min(100, Math.round(S.pct)));
        if (fill) fill.style.width = pct + '%';
        if (pctEl) pctEl.textContent = pct + '%';

        var clase = 'ck-prog-normal';
        var t = '';

        switch (S.etapa) {
            case 'sinNodo':
                clase = 'ck-prog-ojo';
                t = '🔌 No estás conectado a ningún nodo — elegí uno en RED para generar';
                break;
            case 'sinComfy':
                clase = 'ck-prog-mal';
                t = '🔴 ComfyUI apagado en esta PC (abrí start_comfy.bat)';
                break;
            case 'pidiendo':
                clase = 'ck-prog-normal';
                t = '📤 Pidiendo el trabajo a ' + (S.nodo || 'la computadora') + '…';
                break;
            case 'enviado':
                clase = 'ck-prog-normal';
                t = '⏳ Enviado a ' + (S.nodo || 'la computadora') + ' — esperando que empiece…';
                break;
            case 'comfy':
                clase = 'ck-prog-normal';
                t = '⚙️ ' + (S.nodo || 'ComfyUI') + ' está generando' +
                    (S.total ? ' · paso ' + S.paso + '/' + S.total : '') +
                    (S.prompt ? ' · «' + String(S.prompt).slice(0, 42) + '»' : '');
                break;
            case 'nube':
                clase = 'ck-prog-normal';
                t = '☁️ Subiendo el resultado a Cloudflare… (según tu conexión puede tardar)' + (S.bytes ? ' · ' + (S.bytes / 1048576).toFixed(1) + ' MB' : '');
                break;
            case 'listo':
                clase = 'ck-prog-ok';
                t = '✅ Listo' + (S.archivo ? ' — ' + S.archivo : '') +
                    (esWeb ? ' (en ' + (S.nodo || 'la PC') + ' y en Cloudflare)' : '');
                break;
            case 'error':
                clase = 'ck-prog-mal';
                t = '❌ ' + (S.error || 'Error en la generación');
                break;
            case 'detenido':
                clase = 'ck-prog-ojo';
                t = '⏹ Detenido' + (S.colaApp ? ' — quedan ' + S.colaApp + ' en cola' : '');
                break;
            case 'cola':
                clase = 'ck-prog-normal';
                t = '⏳ ' + S.colaApp + ' en cola' + (S.nodo ? ' para ' + S.nodo : '') + '…';
                break;
            case 'reposo':
            default:
                clase = 'ck-prog-normal';
                if (esWeb) {
                    t = hayTrabajo() ? '⏳ Trabajando…' : '🟢 Todo tranquilo — elegí un workflow en CREATE';
                } else {
                    t = '⚙️ Listo para generar en esta PC';
                }
                break;
        }

        // el tiempo en curso
        if (S.desde && (S.etapa === 'comfy' || S.etapa === 'enviado' || S.etapa === 'nube' || S.etapa === 'pidiendo')) {
            t += ' · ' + seg(Date.now() - S.desde);
        }

        txt.textContent = t;
        txt.className = 'progress-label ' + clase;

        pintarPasos();
    }

    // mini-timeline: Nodo → Comfy → Nube (se ve TODO el proceso)
    function pintarPasos() {
        var cont = document.getElementById('ckProgPasos');
        if (!cont) {
            var caja = document.getElementById('progressContainer');
            if (!caja) return;
            cont = document.createElement('div');
            cont.id = 'ckProgPasos';
            cont.className = 'ck-prog-pasos';
            caja.appendChild(cont);
        }
        if (!esWeb) { cont.style.display = 'none'; return; }
        cont.style.display = 'flex';
        cont.innerHTML = PASOS.map(function (p) {
            var est = S.pasos[p] || 'espera';
            var icono = est === 'ok' ? '✅' : (est === 'haciendo' ? '⏳' : '•');
            return '<span class="ck-paso ck-paso-' + est + '">' + icono + ' ' + p + '</span>';
        }).join('<span class="ck-paso-flecha">→</span>');
    }

    function etapa(nombre, datos) {
        datos = datos || {};
        S.etapa = nombre;
        if (datos.nodo !== undefined) S.nodo = datos.nodo;
        if (datos.pct !== undefined) S.pct = datos.pct;
        if (datos.prompt !== undefined) S.prompt = datos.prompt;
        if (datos.archivo !== undefined) S.archivo = datos.archivo;
        if (datos.error !== undefined) S.error = datos.error;
        if (datos.paso !== undefined) S.paso = datos.paso;
        if (datos.total !== undefined) S.total = datos.total;
        if (datos.desde !== undefined) S.desde = datos.desde;

        // los pasos del pipeline según la etapa
        if (nombre === 'pidiendo' || nombre === 'enviado') {
            S.pasos.Nodo = 'haciendo'; S.pasos.Comfy = 'espera'; S.pasos.Nube = 'espera';
            S.pct = Math.max(S.pct, 10);
        } else if (nombre === 'comfy') {
            S.pasos.Nodo = 'ok'; S.pasos.Comfy = 'haciendo'; S.pasos.Nube = 'espera';
        } else if (nombre === 'nube') {
            S.pasos.Nodo = 'ok'; S.pasos.Comfy = 'ok'; S.pasos.Nube = 'haciendo';
            S.pct = Math.max(S.pct, 94);
        } else if (nombre === 'listo') {
            S.pasos.Nodo = 'ok'; S.pasos.Comfy = 'ok'; S.pasos.Nube = 'ok';
            S.pct = 100; S.desde = 0;
        } else if (nombre === 'sinNodo') {
            S.pasos = { Nodo: 'espera', Comfy: 'espera', Nube: 'espera' };
            S.pct = 0; S.desde = 0;
        }
        if (nombre !== 'listo' && !S.desde && (nombre === 'pidiendo' || nombre === 'enviado' || nombre === 'comfy')) {
            S.desde = Date.now();
        }
        pintar();
    }

    // ---------- mensajes del WebSocket ----------
    function msg(m) {
        if (!m || !m.type) return;
        var nodo = nodoElegido();
        var nombreNodo = (nodo && nodo.nombre) || S.nodo;

        if (m.type === 'progress') {
            var p = (m.max ? (m.value / m.max) * 100 : 0);
            // la barra va del 20% (arrancó) al 92% (terminó de muestrear)
            etapa('comfy', {
                nodo: nombreNodo,
                paso: m.value, total: m.max,
                pct: 22 + (p * 0.70),
                desde: S.desde || Date.now()
            });
            return;
        }
        if (m.type === 'executing') {
            if (m.node) {
                etapa('comfy', { nodo: nombreNodo, desde: S.desde || Date.now(), pct: Math.max(S.pct, 22) });
            }
            return;
        }
        if (m.type === 'prompt_queued' || m.type === 'queued') {
            etapa('enviado', { nodo: nombreNodo, pct: 18, desde: S.desde || Date.now() });
            return;
        }
        if (m.type === 'execution_start') {
            etapa('comfy', { nodo: nombreNodo, pct: 22, desde: Date.now() });
            return;
        }
        if (m.type === 'execution_error' || m.type === 'generation_error') {
            etapa('error', { error: m.error || m.message || 'error del motor' });
            return;
        }
        if (m.type === 'executed' || m.type === 'execution_success') {
            // el motor terminó: si el trabajo es de la web, ahora se sube a la nube
            var deLaWeb = (m.origen === 'web' || m.origen === 'red');
            etapa(deLaWeb ? 'nube' : 'listo', { nodo: nombreNodo, pct: deLaWeb ? 94 : 100 });
            return;
        }
        if (m.type === 'storyboard_generated' || m.type === 'video_generated') {
            if (m.filename) S.archivo = m.filename;
            // urlNube presente = ya está en Cloudflare; si no y el trabajo es de
            // la web, todavía se está subiendo.
            if (m.urlNube) etapa('listo', { nodo: nombreNodo, archivo: m.filename });
            else if (m.origen === 'web' || m.origen === 'red') etapa('nube', { nodo: nombreNodo, archivo: m.filename });
            else etapa('listo', { nodo: nombreNodo, archivo: m.filename });
            return;
        }
        if (m.type === 'generation_timeout') {
            etapa('error', { error: 'el motor tardó demasiado' });
            return;
        }
    }

    // ---------- estado de las colas (app + ComfyUI) ----------
    function colas(d) {
        d = d || {};
        if (d.app !== undefined) S.colaApp = Number(d.app) || 0;
        if (d.comfy !== undefined) S.colaComfy = Number(d.comfy) || 0;
        // si no hay nada en ninguna cola y no hay una etapa activa, volvemos a reposo
        var activa = (S.etapa === 'comfy' || S.etapa === 'nube' || S.etapa === 'pidiendo' || S.etapa === 'enviado');
        if (!activa && !hayTrabajo()) {
            if (esWeb) etapa(nodoElegido() ? 'reposo' : 'sinNodo');
            else etapa('reposo');
            return;
        }
        if (!activa && hayTrabajo()) etapa('cola', { nodo: (nodoElegido() || {}).nombre || S.nodo });
    }

    function pedido(datos) {
        var nodo = nodoElegido();
        if (esWeb && !nodo) {
            etapa('sinNodo');
            return false;
        }
        etapa('pidiendo', {
            nodo: (nodo && nodo.nombre) || '',
            pct: 8,
            desde: Date.now(),
            prompt: (datos && datos.prompt) || ''
        });
        return true;
    }

    function detenido() { etapa('detenido'); }

    // cada segundo: el reloj y el estado de conexión
    setInterval(function () {
        if (esWeb) {
            var n = nodoElegido();
            var activa = (S.etapa === 'comfy' || S.etapa === 'nube' || S.etapa === 'pidiendo' || S.etapa === 'enviado');
            if (!n && !activa) { etapa('sinNodo'); return; }
            if (n && S.etapa === 'sinNodo') { etapa('reposo', { nodo: n.nombre, pct: 0 }); return; }
        }
        pintar();
    }, 1000);

    window.CKProgreso = {
        etapa: etapa,
        msg: msg,
        colas: colas,
        pedido: pedido,
        detenido: detenido,
        // para depurar desde la consola: CKProgreso.estado()
        estado: function () { return JSON.parse(JSON.stringify(S)); }
    };

    // primer pintado
    pintar();
})();
