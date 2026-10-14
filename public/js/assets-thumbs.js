// ============================================================
// COMFYLATAM - miniaturas de video en STUDIO ASSETS
// ------------------------------------------------------------
// Ejemplo del problema: con `preload="none"` (necesario para no disparar 460
// pedidos al abrir) las tarjetas quedaban como cajas oscuras, sin frame.
// Aca se observan solo los videos que entran en pantalla (+300px de margen) y
// a esos se les pone `preload="metadata"`: el navegador pide apenas el indice
// del archivo y muestra el primer frame. Fuera de pantalla siguen en none.
// ============================================================
(function () {
    'use strict';

    if (!('IntersectionObserver' in window)) return;

    var observador = new IntersectionObserver(function (entradas) {
        entradas.forEach(function (e) {
            if (!e.isIntersecting) return;
            var v = e.target;
            observador.unobserve(v);
            if (v.getAttribute('preload') === 'none') {
                v.setAttribute('preload', 'metadata');
                // Algunos navegadores recien pintan el frame con un seek minimo
                v.addEventListener('loadeddata', function () {
                    try { if (v.currentTime === 0) v.currentTime = 0.1; } catch (err) { }
                }, { once: true });
            }
        });
    }, { rootMargin: '300px 0px' });

    function vigilar(raiz) {
        var videos = (raiz || document).querySelectorAll('video[preload="none"]');
        for (var i = 0; i < videos.length; i++) observador.observe(videos[i]);
    }

    function init() {
        var panel = document.querySelector('.sidebar-right') || document.body;
        vigilar(document);

        // La galeria se re-renderiza al cambiar de pestaña o al recargar la
        // lista: hay que volver a observar los videos nuevos.
        var mo = new MutationObserver(function (ms) {
            var hayVideos = false;
            ms.forEach(function (m) {
                if (m.addedNodes && m.addedNodes.length) hayVideos = true;
            });
            if (hayVideos) vigilar(panel);
        });
        mo.observe(panel, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
