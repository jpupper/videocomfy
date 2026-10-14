// ============================================================
// COMFYLATAM - comportamiento mobile
// ------------------------------------------------------------
// En el celular los dos paneles laterales (parametros y assets)
// pasan a ser cajones: aca se crean los botones que los abren/cierran
// (nada de handlers inline; todo createElement + addEventListener).
// En escritorio no se crea nada: el CSS los deja en display:none.
// ============================================================
(function () {
    'use strict';

    var MQ = window.matchMedia('(max-width: 1024px)');
    var creado = false;

    function btn(texto, accion) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = texto;
        b.setAttribute('data-jpi-action', accion);
        return b;
    }

    function crearUI() {
        if (creado) return;

        var scrim = document.createElement('div');
        scrim.className = 'jpi-scrim';
        scrim.addEventListener('click', cerrarPaneles);

        var barra = document.createElement('div');
        barra.className = 'jpi-mobile-bar';
        // El panel de parametros viejos se saco de la UI (todo esta en CREATE):
        // en la barra inferior solo queda el acceso a los assets.
        var bAssets = btn('📦 Assets', 'right');
        bAssets.addEventListener('click', function () { togglePanel('panel-right-open'); });
        barra.appendChild(bAssets);

        ['.sidebar-left', '.sidebar-right'].forEach(function (sel) {
            var panel = document.querySelector(sel);
            if (!panel || panel.querySelector('.jpi-panel-close')) return;
            var x = document.createElement('button');
            x.type = 'button';
            x.className = 'jpi-panel-close';
            x.textContent = '✕';
            x.setAttribute('aria-label', 'Cerrar panel');
            x.addEventListener('click', cerrarPaneles);
            panel.appendChild(x);
        });

        document.body.appendChild(scrim);
        document.body.appendChild(barra);
        creado = true;
    }

    function togglePanel(clase) {
        var abierto = document.body.classList.contains(clase);
        cerrarPaneles();
        if (!abierto) document.body.classList.add(clase);
    }

    function cerrarPaneles() {
        document.body.classList.remove('panel-left-open');
        document.body.classList.remove('panel-right-open');
    }

    // Al elegir una pestaña se cierran los cajones (si no, tapan el contenido).
    function vigilarTabs() {
        document.addEventListener('click', function (e) {
            var t = e.target && e.target.closest ? e.target.closest('.tab-button, .project-tab-item, .project-tab') : null;
            if (t) cerrarPaneles();
        }, true);
    }

    // Si se agranda la ventana (o rota el celular), no dejar cajones abiertos.
    if (MQ.addEventListener) MQ.addEventListener('change', function (ev) { if (!ev.matches) cerrarPaneles(); });

    function init() {
        if (MQ.matches) crearUI();
        vigilarTabs();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
