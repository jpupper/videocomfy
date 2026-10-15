// ============================================================
// COMFYLATAM — página ARQUITECTURA
// ------------------------------------------------------------
// Sólo agrega datos EN VIVO al diagrama: en qué entorno estás y (si se puede
// consultar sin sesión) cuántos nodos hay ahora en la red. Si algo falla, la
// página queda igual: es explicativa, no depende de la API.
// ============================================================
(function () {
    'use strict';

    var host = location.hostname;
    var esLocal = host === '127.0.0.1' || host === 'localhost' || host === '';
    var API = esLocal ? '' : '/comfylatam';

    document.getElementById('arqEntorno').textContent = esLocal
        ? '💻 viendo la app LOCAL (esta PC)'
        : '🌐 viendo la versión WEB (fullscreencode.com)';

    // --- estado en vivo ------------------------------------------------------
    function pintar(datos) {
        var pie = document.getElementById('arqPieDato');
        if (pie) pie.textContent = datos;
    }

    function token() {
        try { return localStorage.getItem('fsc_token_jpi') || ''; } catch (e) { return ''; }
    }

    if (esLocal) {
        // cola real del motor + nodos de la red, sin token (es local)
        Promise.all([
            fetch('api/comfy/cola').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
            fetch('api/red/estado').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
        ]).then(function (res) {
            var cola = res[0], red = res[1];
            var partes = [];
            if (cola) partes.push('cola del motor: ' + (cola.ejecutando || 0) + ' ejecutando · ' + (cola.pendientes || 0) + ' en espera');
            if (red) partes.push('nodos en la red: ' + ((red.nodos || []).length) + ' · vos: ' + (red.conectado ? 'publicado' : 'sin publicar'));
            pintar(partes.join(' · ') || 'datos no disponibles');
        });
    } else {
        var t = token();
        fetch(API + '/api/red/peers', { headers: t ? { Authorization: 'Bearer ' + t } : {} })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                if (d && d.peers) pintar('nodos conectados ahora: ' + d.peers.length);
                else pintar('nodos conectados: necesitás iniciar sesión para verlos');
            })
            .catch(function () { pintar('no pude consultar la red (seguí igual: esto es informativo)'); });
    }

    // --- resaltar la zona del diagrama según el entorno ----------------------
    document.querySelectorAll('.arq-caja').forEach(function (g) {
        g.addEventListener('mouseenter', function () { g.style.filter = 'brightness(1.25)'; });
        g.addEventListener('mouseleave', function () { g.style.filter = ''; });
    });
})();
