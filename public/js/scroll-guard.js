// ============================================================
// JPiAssets - guardián de scroll
// ------------------------------------------------------------
// Bug reportado: en CREATE, escribiendo en el textarea y despues moviendo un
// slider, la pagina "reseteaba" el scroll (saltaba de lugar). Con eventos
// sinteticos no se reproduce en ningun viewport, asi que en vez de adivinar el
// culpable exacto se protege el scroll: antes de cualquier re-render se guarda
// la posicion (documento + contenedores scrollables) y se restaura si el
// navegador la movio. Ademas se apaga el "scroll anchoring" de Chrome, que es
// la causa tipica de estos saltos cuando cambia el alto de algo de arriba.
// ============================================================
(function () {
    'use strict';

    var activo = true;
    var ultimoSalto = 0;      // para el log de diagnostico

    function scrollers() {
        var lista = [];
        var doc = document.scrollingElement;
        if (doc) lista.push(doc);
        var nodos = document.querySelectorAll('.wf-panel-scroll, .sidebar-left, .sidebar-right, .tab-content, .storyboard-grid-container, .editor-panel');
        for (var i = 0; i < nodos.length; i++) lista.push(nodos[i]);
        return lista;
    }

    function guardar() {
        return scrollers().map(function (el) { return { el: el, top: el.scrollTop }; });
    }

    function restaurar(snap, motivo) {
        if (!activo) return;
        snapshot = null;
        var restaurados = 0;
        snap.forEach(function (s) {
            if (s.el && Math.abs(s.el.scrollTop - s.top) > 4) {
                s.el.scrollTop = s.top;
                restaurados++;
            }
        });
        if (restaurados) {
            var ahora = Date.now();
            // el usuario no interactua a 1,5 s de distancia: si pasa, es un salto
            if (ahora - ultimoSalto > 1500) {
                ultimoSalto = ahora;
                console.log('[scroll-guard] scroll restaurado tras', motivo, '(', restaurados, 'contenedor/es)');
            }
        }
    }

    // ── 1) El scroll no tiene que moverse cuando cambia el contenido ──────────
    var snapshot = null;
    var observador = new MutationObserver(function () {
        // Si el usuario movio el scroll, guardamos esa posicion nueva: solo se
        // restaura cuando el cambio de DOM es lo que la movio.
        setTimeout(function () { snapshot = guardar(); }, 0);
    });
    observador.observe(document.body, { childList: true, subtree: true });

    // Antes de tocar los sliders (input/change) fijamos la posicion: mover un
    // slider solo debe cambiar su etiqueta, no el scroll.
    // Dato del usuario (clave): el salto pasa cuando el TEXTAREA DEL PROMPT
    // SIGUE CON FOCO. Con el campo activo, el navegador vuelve a arrastrar la
    // vista hacia el elemento enfocado cuando el layout cambia (y en celular,
    // al cerrarse el teclado). Solucion: al interactuar con un slider se saca
    // el foco del campo de texto y se restaura la posicion.
    function esCampoDeTexto(el) {
        if (!el || !el.tagName) return false;
        if (el.tagName === 'TEXTAREA') return true;
        var t = (el.getAttribute && el.getAttribute('type')) || '';
        return el.tagName === 'INPUT' && ['text', 'search', 'number', 'url', 'email'].indexOf(t) !== -1;
    }

    function esSlider(el) {
        return !!(el && el.tagName === 'INPUT' && el.getAttribute('type') === 'range');
    }

    ['pointerdown', 'touchstart', 'mousedown'].forEach(function (ev) {
        document.addEventListener(ev, function (e) {
            if (!esSlider(e.target)) return;
            var activo = document.activeElement;
            if (!esCampoDeTexto(activo)) return;
            var snap = guardar();
            activo.blur();
            [0, 60, 200, 450].forEach(function (ms) {
                setTimeout(function () { restaurar(snap, 'slider con textfield enfocado'); }, ms);
            });
        }, true);
    });

    document.addEventListener('input', function (e) {
        if (!e.target || !e.target.classList) return;
        if (!e.target.classList.contains('wf-param-slider') && e.target.type !== 'range') return;
        var snap = guardar();
        [0, 120, 350].forEach(function (ms) {
            setTimeout(function () { restaurar(snap, 'slider'); }, ms);
        });
    }, true);

    document.addEventListener('change', function (e) {
        if (!e.target || e.target.type !== 'range') return;
        var snap = guardar();
        setTimeout(function () { restaurar(snap, 'slider(change)'); }, 0);
    }, true);

    // Al escribir en un textarea/prompt tampoco queremos que salte
    document.addEventListener('input', function (e) {
        if (!e.target || !e.target.matches || !e.target.matches('textarea, input[type=text], input[type=number]')) return;
        var el = e.target;
        var cont = el.closest('.wf-panel-scroll, .tab-content');
        if (!cont) return;
        var top = cont.scrollTop;
        setTimeout(function () { if (Math.abs(cont.scrollTop - top) > 4) cont.scrollTop = top; }, 0);
    }, true);

    // ── 2) Apagar el "scroll anchoring" (saltos al cambiar el alto de arriba) ─
    var estilo = document.createElement('style');
    estilo.textContent =
        'html, body, .tab-content, .wf-panel-scroll, .sidebar-left, .sidebar-right,' +
        ' .storyboard-grid-container, .editor-panel, .asset-gallery-grid { overflow-anchor: none; }';
    document.head.appendChild(estilo);
})();
