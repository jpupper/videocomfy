// ============================================================
// Ideogram 4 — editor de sectores (dividir la imagen en regiones
// y darle un prompt a cada una). Genera una imagen con el modelo
// local ideogram4 (nvfp4) pasando el JSON caption que Ideogram 4
// entiende: background + elements con bbox, desc y, si es texto,
// el texto exacto a renderizar.
//
// Los sectores se definen como una grilla (cols x rows). Cada celda
// es un sector con su tipo (objeto / texto) y su prompt.
// ============================================================
(function () {
    'use strict';

    var PRESETS = [
        { cols: 1, rows: 1, label: '1×1' },
        { cols: 2, rows: 1, label: '2×1' },
        { cols: 1, rows: 2, label: '1×2' },
        { cols: 2, rows: 2, label: '2×2' },
        { cols: 2, rows: 3, label: '2×3' },
        { cols: 3, rows: 2, label: '3×2' },
        { cols: 3, rows: 3, label: '3×3' }
    ];
    var estado = { cols: 2, rows: 2 };

    function q(id) { return document.getElementById(id); }

    function contenedor() { return q('ideoGrid'); }
    function contenedorPresets() { return q('ideoGridPresets'); }

    // Normaliza una fracción a [0,1] y redondea a 4 decimales
    function frac(v) {
        var n = Number(v);
        if (!isFinite(n)) return 0;
        return Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;
    }

    // Lee las celdas del DOM y arma la lista de sectores.
    // Coordenadas normalizadas (0-1) respecto del ancho/alto total.
    function leerSectores() {
        var out = [];
        var cont = contenedor();
        if (!cont) return out;
        var celdas = cont.querySelectorAll('.ideo-cell');
        for (var i = 0; i < celdas.length; i++) {
            var celda = celdas[i];
            var tipo = celda.querySelector('.ideo-cell-type');
            var texto = celda.querySelector('.ideo-cell-prompt');
            var type = tipo ? tipo.value : 'obj';
            var valor = texto ? texto.value.trim() : '';
            if (!valor) continue;                       // sector vacío: se omite
            var r = Number(celda.dataset.row);
            var c = Number(celda.dataset.col);
            out.push({
                type: type,
                desc: type === 'obj' ? valor : '',
                text: type === 'text' ? valor : '',
                x: frac(c / estado.cols),
                y: frac(r / estado.rows),
                w: frac(1 / estado.cols),
                h: frac(1 / estado.rows)
            });
        }
        return out;
    }

    // Re-renderiza la grilla de sectores con la config actual
    function pintarGrilla() {
        var cont = contenedor();
        if (!cont) return;
        var html = '';
        for (var r = 0; r < estado.rows; r++) {
            for (var c = 0; c < estado.cols; c++) {
                var n = r * estado.cols + c + 1;
                html +=
                    '<div class="ideo-cell" data-row="' + r + '" data-col="' + c + '">' +
                    '<div class="ideo-cell-head">' +
                    '<span class="ideo-cell-badge">' + n + '</span>' +
                    '<select class="ideo-cell-type">' +
                    '<option value="obj">objeto</option>' +
                    '<option value="text">texto</option>' +
                    '</select>' +
                    '</div>' +
                    '<textarea class="ideo-cell-prompt" placeholder="Prompt del sector ' + n + '…"></textarea>' +
                    '</div>';
            }
        }
        cont.innerHTML = html;
        cont.style.gridTemplateColumns = 'repeat(' + estado.cols + ', 1fr)';

        // al cambiar el tipo se ajusta el placeholder
        cont.querySelectorAll('.ideo-cell').forEach(function (celda) {
            var sel = celda.querySelector('.ideo-cell-type');
            var ta = celda.querySelector('.ideo-cell-prompt');
            var n = celda.querySelector('.ideo-cell-badge').textContent;
            sel.addEventListener('change', function () {
                ta.placeholder = sel.value === 'text'
                    ? 'Texto exacto a mostrar en el sector ' + n + '…'
                    : 'Prompt del sector ' + n + '…';
            });
        });
    }

    // Actualiza el aspecto de la grilla según los sliders de ancho/alto
    function actualizarAspecto() {
        var cont = contenedor();
        if (!cont) return;
        var w = getSliderVal ? getSliderVal('ideoWidth') : null;
        var h = getSliderVal ? getSliderVal('ideoHeight') : null;
        w = w || 1024; h = h || 1024;
        cont.style.aspectRatio = w + ' / ' + h;
    }

    function pintarPresets() {
        var bar = contenedorPresets();
        if (!bar) return;
        bar.innerHTML = '';
        PRESETS.forEach(function (p) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'ideo-preset';
            b.textContent = p.label;
            if (p.cols === estado.cols && p.rows === estado.rows) b.classList.add('active');
            b.addEventListener('click', function () {
                estado.cols = p.cols;
                estado.rows = p.rows;
                pintarGrilla();
                pintarPresets();
            });
            bar.appendChild(b);
        });
    }

    // === GENERAR ==============================================
    window.generateIdeogram4 = function () {
        var background = (q('ideoBackground') ? q('ideoBackground').value : '').trim();
        var highLevel = (q('ideoHigh') ? q('ideoHigh').value : '').trim();
        var sectores = leerSectores();
        var haySector = sectores.length > 0;

        if (!background && !haySector) {
            appendConsoleLine('⚠️ Escribí un background o al menos el prompt de un sector', 'warning');
            return;
        }

        addToQueue(highLevel || background || 'Ideogram 4 (sectores)', '', {
            modelo: 'ideogram4',
            params: {
                modelo: 'ideogram4',
                videoWidth: getSliderVal('ideoWidth') || 1024,
                videoHeight: getSliderVal('ideoHeight') || 1024,
                samplerSteps: getSliderVal('ideoSteps') || 28,
                seed: getSeed('ideo'),
                background: background,
                highLevel: highLevel,
                style: q('ideoStyle') ? q('ideoStyle').value : 'none',
                styleValue: q('ideoStyleValue') ? q('ideoStyleValue').value.trim() : '',
                aesthetics: q('ideoAesthetics') ? q('ideoAesthetics').value.trim() : '',
                lighting: q('ideoLighting') ? q('ideoLighting').value.trim() : '',
                medium: q('ideoMedium') ? q('ideoMedium').value.trim() : '',
                sectores: sectores
            }
        });

        appendConsoleLine('🎯 Ideogram 4 encolado (' + sectores.length + ' sector' + (sectores.length === 1 ? '' : 'es') + ')', 'system');
        document.getElementById('tabOutputBtn')?.click();
    };

    function init() {
        pintarPresets();
        pintarGrilla();
        actualizarAspecto();
        // si cambian ancho/alto se re-acomoda la grilla
        document.querySelectorAll('.wf-param-slider[data-bind="ideoWidth"], .wf-param-slider[data-bind="ideoHeight"]')
            .forEach(function (s) { s.addEventListener('input', actualizarAspecto); });
        // el botón GENERATE de la tarjeta ideogram4
        var btn = document.querySelector('.wf-gen-btn[data-workflow="ideogram4"]');
        if (btn) btn.addEventListener('click', window.generateIdeogram4);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
