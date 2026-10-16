/* ============================================================
   fsc-web.js — marca el documento cuando la app corre en la WEB.

   Se mira el HOSTNAME (no JPI.esServidor: eso vale true también en
   localhost, porque significa "lo sirve un server", no "es la versión web").
   Con la clase `es-web`, fsc-web.css esconde lo que sólo tiene sentido en la
   instalación local (estado del motor ComfyUI, si tu PC está prendida).
   ============================================================ */
(function () {
    'use strict';
    try {
        var h = location.hostname;
        var esLocal = (h === 'localhost' || h === '127.0.0.1' || h.indexOf('localhost') !== -1 || /^192\.168\.|^10\./.test(h));
        if (!esLocal) {
            document.documentElement.classList.add('es-web');
            if (document.body) document.body.classList.add('es-web');
        }
    } catch (e) { }
})();
