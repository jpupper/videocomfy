/* ============================================================
 * PREVIZ: botón de PANTALLA COMPLETA + datos reales de la generación
 * ------------------------------------------------------------
 * 1) Abajo del monitor va el botón ⛶ para ver la imagen en fullscreen.
 * 2) En la pestaña DATA se agrega el bloque "PARÁMETROS DE GENERACIÓN" con lo que
 *    REALMENTE ejecutó ComfyUI (cfg, steps, sampler, scheduler, seed, denoise,
 *    tamaño, modelo, loras, prompt positivo y negativo), leído de
 *    /api/generacion-detalle (el historial de ComfyUI, no el formulario).
 * Se refresca solo cada vez que cambia la imagen del PREVIZ (lo dispara el
 * REGISTRO: el ojito abre la imagen acá).
 * ============================================================ */
(function () {
    'use strict';

    function base() { return (window.JPI && window.JPI.API_BASE) || ''; }
    function esc(t) {
        return String(t == null ? '' : t).replace(/[&<>"]/g, function (m) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
        });
    }

    // ---------- botón fullscreen ----------
    function botonFullscreen() {
        var cont = document.getElementById('previz-monitor');
        if (!cont || document.getElementById('ckPrevizFs')) return;
        var b = document.createElement('button');
        b.id = 'ckPrevizFs';
        b.title = 'Ver en pantalla completa';
        b.textContent = '⛶';
        b.style.cssText = 'position:absolute;right:10px;bottom:10px;z-index:20;width:34px;height:34px;' +
            'border-radius:8px;border:1px solid var(--border,#2a3f4f);background:rgba(8,18,26,.72);' +
            'color:var(--foreground,#e6f1f7);font-size:16px;line-height:1;cursor:pointer;backdrop-filter:blur(4px)';
        b.addEventListener('click', function (e) {
            e.stopPropagation();
            var img = document.getElementById('previzImage');
            var vid = document.getElementById('previzVideo');
            var el = (img && !img.classList.contains('hidden') && img.src) ? img
                : ((vid && !vid.classList.contains('hidden')) ? vid : cont);
            try {
                if (document.fullscreenElement) document.exitFullscreen();
                else if (el.requestFullscreen) el.requestFullscreen();
                else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
            } catch (err) { }
        });
        cont.style.position = cont.style.position || 'relative';
        cont.appendChild(b);
    }

    // ---------- bloque de datos en DATA ----------
    function cajaDatos() {
        var panel = document.getElementById('previz-data');
        if (!panel) return null;
        var caja = document.getElementById('previzComfy');
        if (caja) return caja;
        caja = document.createElement('div');
        caja.id = 'previzComfy';
        caja.className = 'ck-comfy-data';
        caja.style.cssText = 'margin-top:14px;padding:12px;border:1px solid var(--border,#22323f);' +
            'border-radius:10px;background:var(--card,rgba(12,22,30,.55))';
        panel.appendChild(caja);
        return caja;
    }

    function fila(k, v) {
        if (v === null || v === undefined || v === '') return '';
        return '<div style="display:flex;gap:8px;justify-content:space-between;padding:3px 0;border-bottom:1px dashed rgba(127,127,127,.18)">' +
            '<span style="opacity:.65;font-size:.74rem;text-transform:uppercase;letter-spacing:.04em">' + esc(k) + '</span>' +
            '<b style="font-size:.82rem;text-align:right;word-break:break-word">' + esc(v) + '</b></div>';
    }

    function pintar(d) {
        var caja = cajaDatos();
        if (!caja) return;
        if (!d || !d.archivo) { caja.innerHTML = ''; return; }
        var c = d.comfy || {};
        var html = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
            '<b style="font-size:.78rem;letter-spacing:.06em;color:#86efac">⚙️ PARÁMETROS DE GENERACIÓN</b>' +
            '<span style="font-size:.7rem;opacity:.6">' + (d.desdeComfy ? 'de ComfyUI' : 'del formulario') + '</span></div>';
        if (d.desdeComfy) {
            html += fila('Modelo', c.modelo || d.modelo);
            html += fila('Sampler', c.sampler);
            html += fila('Scheduler', c.scheduler);
            html += fila('Steps', c.steps);
            html += fila('CFG', c.cfg);
            html += fila('Seed', c.seed);
            html += fila('Denoise', c.denoise);
            html += fila('Tamaño', (c.ancho && c.alto) ? (c.ancho + ' × ' + c.alto) : '');
            html += fila('Nodos', c.nodos);
            if (c.loras && c.loras.length) {
                html += fila('LoRAs', c.loras.map(function (l) { return l.nombre + (l.fuerza != null ? ' (' + l.fuerza + ')' : ''); }).join(', '));
            }
            html += fila('Prompt', c.positivo);
            html += fila('Negativo', c.negativo);
            if (d.promptId) html += fila('Prompt ID', String(d.promptId).slice(0, 13) + '…');
        } else {
            var f = d.paramsFront || {};
            html += fila('Modelo', d.modelo);
            html += fila('Steps', f.samplerSteps || f.storyboardSteps);
            html += fila('CFG', f.cfgScale);
            html += fila('Seed', f.seed);
            html += fila('Tamaño', (f.videoWidth && f.videoHeight) ? (f.videoWidth + ' × ' + f.videoHeight) : '');
            html += fila('Negativo', f.negativePrompt);
            html += '<div style="font-size:.72rem;opacity:.6;margin-top:6px">' +
                (d.errorComfy ? 'ComfyUI no tiene este trabajo en su historial (' + esc(d.errorComfy) + ').' :
                    (d.promptId ? 'leyendo el historial…' : 'esta imagen no tiene prompt_id guardado')) + '</div>';
        }
        caja.innerHTML = html;
    }

    var ultimo = '';
    function pedir(archivo) {
        if (!archivo || archivo === ultimo) return;
        ultimo = archivo;
        var caja = cajaDatos();
        if (caja) caja.innerHTML = '<span style="font-size:.75rem;opacity:.6">leyendo los parámetros de ComfyUI…</span>';
        fetch(base() + '/api/generacion-detalle?archivo=' + encodeURIComponent(archivo) + '&_=' + Date.now(), { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(pintar)
            .catch(function (e) { pintar({ archivo: archivo, desdeComfy: false, errorComfy: e.message, paramsFront: {} }); });
    }

    function archivoActual() {
        var img = document.getElementById('previzImage');
        if (!img || !img.src) return '';
        try { return decodeURIComponent(String(img.src).split('/').pop().split('?')[0]); } catch (e) { return ''; }
    }

    window.CKPreviz = { pedir: pedir, refrescar: function () { ultimo = ''; pedir(archivoActual()); } };

    function init() {
        botonFullscreen();
        cajaDatos();
        var img = document.getElementById('previzImage');
        if (img) {
            new MutationObserver(function () { pedir(archivoActual()); })
                .observe(img, { attributes: true, attributeFilter: ['src'] });
            if (img.src) pedir(archivoActual());
        }
        document.addEventListener('click', function (ev) {
            var b = ev.target && ev.target.closest ? ev.target.closest('[data-sub="previz-data"]') : null;
            if (b) { pedir(archivoActual()); }
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
