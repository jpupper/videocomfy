// ============================================================
// COMFYLATAM - comportamiento mobile
// ------------------------------------------------------------
// En el celular los dos paneles laterales (parametros a la izquierda y
// assets a la derecha) pasan a ser cajones: aca se crean los botones que
// los abren/cierran (nada de handlers inline; todo createElement + addEventListener).
// En escritorio no se crea nada: el CSS los deja en display:none.
//
// PEDIDO DEL USUARIO (20-Oct): "el inspector de la derecha y la izquierda en
// la version mobile ni se ven". Habia UN solo boton (Assets) y el panel
// IZQUIERDO no tenia como abrirse nunca: quedaba siempre fuera de pantalla.
// Ahora van los dos, con la barra fija abajo.
// ============================================================
(function () {
    'use strict';

    var MQ = window.matchMedia('(max-width: 1024px)');
    var creado = false;

    function btn(texto, accion, titulo) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = texto;
        b.setAttribute('data-jpi-action', accion);
        if (titulo) b.title = titulo;
        return b;
    }

    function crearUI() {
        if (creado) return;

        var scrim = document.createElement('div');
        scrim.className = 'jpi-scrim';
        scrim.addEventListener('click', cerrarPaneles);

        var barra = document.createElement('div');
        barra.className = 'jpi-mobile-bar';

        // IZQUIERDA: parametros / cola / conexion
        var bPanel = btn('☰ PANEL', 'left', 'Abrir el panel de la izquierda (parámetros y cola)');
        bPanel.addEventListener('click', function () { togglePanel('panel-left-open'); });
        barra.appendChild(bPanel);

        // DERECHA: studio assets
        var bAssets = btn('📦 ASSETS', 'right', 'Abrir Studio Assets (derecha)');
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
        if (!abierto) {
            document.body.classList.add(clase);
            // el panel entra desde el costado: que arranque desde arriba
            var panel = document.querySelector(clase === 'panel-left-open' ? '.sidebar-left' : '.sidebar-right');
            if (panel) { try { panel.scrollTop = 0; } catch (e) { } }
        }
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
    // Y si ENTRA en modo celular despues de cargar (rotar, achicar la ventana),
    // la barra tiene que aparecer igual: antes solo se creaba si ya era chico.
    if (MQ.addEventListener) {
        MQ.addEventListener('change', function (ev) {
            if (ev.matches) crearUI();
            else cerrarPaneles();
        });
    }
    window.addEventListener('orientationchange', function () {
        if (MQ.matches) crearUI();
        cerrarPaneles();
    });

    function init() {
        if (MQ.matches) crearUI();
        vigilarTabs();
        setTimeout(function () { if (MQ.matches) crearUI(); }, 1500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
