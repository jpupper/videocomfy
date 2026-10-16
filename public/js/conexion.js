// ============================================================
// COMFYLATAM — ¿A QUÉ COMPUTADORA ESTOY CONECTADO Y QUÉ PUEDO USAR?
// ------------------------------------------------------------
// Reglas (pedido explícito del usuario):
//   1. Al entrar, en la WEB no estás conectado a ningún nodo.
//   2. Sin nodo: TODOS los workflows de CREATE van en gris Y no se pueden tocar.
//   3. Con nodo elegido: en color SÓLO los workflows que ese fierro comparte y
//      tiene instalados; el resto sigue gris y bloqueado.
//   4. En algún lado tiene que decir a qué computadora estás conectado (o que no
//      estás conectado a ninguna).
//
// La lista de workflows del nodo la publica la propia PC en la red (la app sólo
// ofrece los que comparte Y tiene instalados), así que acá no se adivina nada.
// ============================================================
(function () {
    'use strict';

    var esWeb = false;
    try {
        var h = location.hostname;
        esWeb = (h !== 'localhost' && h !== '127.0.0.1' && h.indexOf('localhost') === -1);
    } catch (e) { }

    // ---------- qué archivo(s) de workflows/ necesita cada tarjeta ----------
    // 'todos': hacen falta todos.  'alguno': alcanza con uno (variantes del mismo motor).
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
    // nombre lindo de cada archivo (para decir POR QUÉ no se puede)
    var NOMBRE_WF = {
        'z_image_turbo_api.json': 'Z-Image Turbo',
        'qwen_image_21_api.json': 'Qwen-Image 2.1',
        'ideogram4_api.json': 'Ideogram 4',
        'flux_dev_fp8_api.json': 'FLUX dev',
        'flux_dev_full_text_to_image_api.json': 'FLUX dev (full)',
        'video_ltx2_t2v_api.json': 'LTX-2 texto→video',
        'video_ltx2_i2v_api.json': 'LTX-2 imagen→video',
        'video_ltx25_i2v_api.json': 'LTX-2.5 imagen→video',
        'video_wan2_2_14B_flf2v_api.json': 'Wan 2.2 (chain)'
    };

    // ---------- estado de la red ----------
    function red() {
        try { return (window.comfyRed && window.comfyRed.estado) || null; } catch (e) { return null; }
    }
    function nodo() {
        var e = red();
        if (!e || !e.elegido) return null;
        var peers = e.peers || [];
        for (var i = 0; i < peers.length; i++) if (peers[i].id === e.elegido) return peers[i];
        if (e.yo && e.yo.peerId === e.elegido) {
            return { id: e.elegido, nombre: e.yo.nombre || 'esta PC', gpu: '', workflows: e.yo.workflows || [], propio: true };
        }
        return { id: e.elegido, nombre: e.elegido, workflows: [], desconocido: true };
    }

    // ¿este fierro puede correr esta tarjeta?
    function puede(card) {
        if (!card) return false;
        if (!esWeb) return true;                    // en local siempre (es tu Comfy)
        var n = nodo();
        if (!n) return false;                       // sin nodo, nada
        if (n.propio) return true;                  // es tu propia PC: puede todo
        var wfs = n.workflows || [];
        if (!wfs.length) return false;              // el nodo no publicó nada todavía
        var regla = ARCHIVOS[card];
        if (!regla) return true;                    // tarjeta sin regla: no la tocamos
        if (regla.alguno) return regla.alguno.some(function (f) { return wfs.indexOf(f) >= 0; });
        return (regla.todos || []).every(function (f) { return wfs.indexOf(f) >= 0; });
    }

    // por qué no se puede (para el tooltip)
    function motivo(card) {
        if (!esWeb) return '';
        var n = nodo();
        if (!n) return 'No estás conectado a ninguna computadora: elegí una en la pestaña RED.';
        var regla = ARCHIVOS[card] || {};
        var faltan = (regla.todos || regla.alguno || []).filter(function (f) {
            return (n.workflows || []).indexOf(f) < 0;
        }).map(function (f) { return NOMBRE_WF[f] || f; });
        return 'En ' + (n.nombre || 'esa computadora') + ' no está disponible: ' + faltan.join(', ') +
            '. Poné en color otra opción o conectate a un fierro que lo tenga.';
    }

    // ---------- pintado ----------
    function pintarBanner() {
        var cont = document.getElementById('tabPrompts') || document.querySelector('.wf-cards-container');
        if (!cont) return;
        var b = document.getElementById('ckConexionBanner');
        if (!b) {
            b = document.createElement('div');
            b.id = 'ckConexionBanner';
            b.className = 'ck-conexion-banner';
            if (cont.id === 'tabPrompts') cont.insertBefore(b, cont.firstChild);
            else cont.parentElement.insertBefore(b, cont);
        }
        var n = nodo();
        if (n && !n.desconocido) {
            b.className = 'ck-conexion-banner ok';
            b.innerHTML = '🟢 <b>Conectado a ' + esc(n.nombre) + '</b>' +
                (n.gpu ? ' · ' + esc(n.gpu) : '') +
                ' — sólo se pueden usar los workflows que esa computadora tiene' +
                ' <span class="ck-conexion-ir" data-ir="red">cambiar en RED</span>';
        } else if (n && n.desconocido) {
            b.className = 'ck-conexion-banner ojo';
            b.innerHTML = '🟡 Elegiste <b>' + esc(n.nombre) + '</b> pero no está publicando sus datos todavía…' +
                ' <span class="ck-conexion-ir" data-ir="red">ver en RED</span>';
        } else {
            b.className = 'ck-conexion-banner ojo';
            b.innerHTML = '🔌 <b>No estás conectado a ninguna computadora</b>' +
                ' — elegí una en <span class="ck-conexion-ir" data-ir="red">RED</span> para poder generar';
        }
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    function pintarTarjetas() {
        var cards = document.querySelectorAll('.wf-card');
        if (!cards.length) return;
        var primeroOk = null;
        Array.prototype.forEach.call(cards, function (c) {
            var wf = c.getAttribute('data-workflow');
            if (!wf) return;
            var ok = puede(wf);
            if (ok && !primeroOk) primeroOk = c;
            c.classList.toggle('ck-no-disp', !ok);
            c.setAttribute('aria-disabled', ok ? 'false' : 'true');
            c.title = ok ? '' : motivo(wf);
            // el botón de generar de esta tarjeta
            var btns = c.querySelectorAll('.wf-gen-btn, .generate-btn-main, button');
            Array.prototype.forEach.call(btns, function (b) {
                if (b.classList.contains('wf-card')) return;
                b.disabled = !ok;
                b.classList.toggle('ck-no-disp', !ok);
                if (!ok) b.title = motivo(wf);
                else b.removeAttribute('title');
            });
        });
        // si la tarjeta activa no se puede usar, pasar a la primera que sí
        var activa = document.querySelector('.wf-card.active');
        var activaOk = activa && !activa.classList.contains('ck-no-disp');
        if (esWeb && !activaOk && primeroOk) {
            Array.prototype.forEach.call(cards, function (c) { c.classList.remove('active'); });
            primeroOk.classList.add('active');
            try { primeroOk.click(); } catch (e) { }
        }
    }

    // Los botones de generar que NO están dentro de una tarjeta (storyboard, chain…)
    function pintarBotonesSueltos() {
        var ids = ['generateVidsFromStoryboardBtn', 'chainEnhanceBtn', 'confirmRegenBtn'];
        ids.forEach(function (id) {
            var b = document.getElementById(id);
            if (!b || b.closest('.wf-card')) return;
            var ok = !esWeb || !!nodo();
            b.disabled = !ok;
            b.classList.toggle('ck-no-disp', !ok);
            b.title = ok ? '' : 'No estás conectado a ninguna computadora: elegí una en RED.';
        });
    }

    // Red de seguridad: si por lo que sea un click llega a una tarjeta gris, no pasa nada.
    function bloquear() {
        document.addEventListener('click', function (ev) {
            var el = ev.target;
            while (el && el !== document.body) {
                if (el.classList && el.classList.contains('ck-no-disp')) {
                    if (ev.preventDefault) ev.preventDefault();
                    if (ev.stopPropagation) ev.stopPropagation();
                    var c = el.closest ? el.closest('.wf-card') : null;
                    var wf = c ? c.getAttribute('data-workflow') : null;
                    avisar(wf ? motivo(wf) : 'No estás conectado a ninguna computadora: elegí una en RED.');
                    return false;
                }
                el = el.parentElement;
            }
        }, true);
    }

    var ultimoAviso = 0;
    function avisar(txt) {
        if (Date.now() - ultimoAviso < 3000) return;
        ultimoAviso = Date.now();
        try { if (typeof appendConsoleLine === 'function') appendConsoleLine('⚠️ ' + txt, 'warning'); } catch (e) { }
    }

    function pintar() {
        pintarBanner();
        pintarTarjetas();
        pintarBotonesSueltos();
    }

    // el botón "RED" del banner
    document.addEventListener('click', function (ev) {
        var ir = ev.target && ev.target.closest && ev.target.closest('.ck-conexion-ir');
        if (!ir) return;
        var t = document.getElementById('tabRedBtn');
        if (t) t.click();
    });

    if (!window.CKConexion) {
        window.CKConexion = { puede: puede, nodo: nodo, pintar: pintar, motivo: motivo };
        bloquear();
        setInterval(pintar, 1200);
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pintar);
        else pintar();
    }
})();
