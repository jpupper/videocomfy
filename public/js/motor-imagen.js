// ============================================================
// Motor de imagen del pipeline (imagen -> video)
// ------------------------------------------------------------
// El select #imgEngineSelect elige con que modelo se genera LA IMAGEN de esta
// etapa: Z-Image Turbo, Qwen-Image 2.1 o Flux (el de siempre). Aca se guarda
// la eleccion (localStorage), se restaura al abrir y se actualiza la etiqueta
// del prompt para que se vea cual esta activo.
// El valor viaja al server dentro de params.modelo (js/script.js lo lee).
// ============================================================
(function () {
    'use strict';

    var CLAVE = 'jpi.motorImagen';
    var NOMBRES = { zimage: 'Z-Image Turbo', qwen21: 'Qwen-Image 2.1', flux: 'FLUX' };

    function labelImagen() {
        // La etiqueta "Image Prompt (...)" del panel del pipeline
        return document.querySelector('[data-panel="t2i2v"] .wf-dual-prompt .wf-label');
    }

    function pintarEtiqueta(valor) {
        var lab = labelImagen();
        if (lab) lab.textContent = 'Image Prompt (' + (NOMBRES[valor] || valor) + ')';
    }

    function init() {
        var sel = document.getElementById('imgEngineSelect');
        if (!sel) return;

        var guardado = null;
        try { guardado = localStorage.getItem(CLAVE); } catch (e) { }
        if (guardado && Array.prototype.some.call(sel.options, function (o) { return o.value === guardado; })) {
            sel.value = guardado;
        }
        pintarEtiqueta(sel.value);

        sel.addEventListener('change', function () {
            try { localStorage.setItem(CLAVE, sel.value); } catch (e) { }
            pintarEtiqueta(sel.value);
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
