// ============================================================
// COMFYLATAM - estado de la cadena, a la vista
// ------------------------------------------------------------
// El navegador NO puede saber por si solo si el nodo (la PC que da su
// Comfy) esta conectado, si la app local esta levantada o si ComfyUI
// responde. El hub lo expone en /api/status y esto lo muestra en un
// badge del encabezado.
//
// Si esta app corre en LOCAL no hay ninguna "PC" de la que dependa:
// el badge muestra el estado de SU Comfy y listo.
// ============================================================
(function () {
    'use strict';

    var btn = document.getElementById('jpiEstado');
    if (!btn) return;

    var URL_ESTADO = window.JPI.API_BASE + '/api/status';
    var ultimo = null;

    function pintar(d) {
        if (!d) return;

        // --- app local: solo importa que ComfyUI responda ---
        if (d.entorno === 'local') {
            if (d.comfy) {
                btn.className = 'jpi-estado bien';
                btn.textContent = '🟢 Comfy listo · local';
            } else {
                btn.className = 'jpi-estado ojo';
                btn.textContent = '🟡 Sin ComfyUI';
            }
            btn.title = 'App local · ComfyUI: ' + (d.comfyAddress || '127.0.0.1') +
                (d.comfy ? ' (conectado)' : ' (no responde — revisá SETTINGS)');
            return;
        }

        // --- versión web: el editor funciona contra los nodos de la red ---
        if (!d.agente) {
            btn.className = 'jpi-estado ojo';
            btn.textContent = '🌐 Esperando nodos de la red';
        } else if (!d.videocomfy) {
            btn.className = 'jpi-estado ojo';
            btn.textContent = '🟡 Nodo sin app local';
        } else if (!d.comfy) {
            btn.className = 'jpi-estado ojo';
            btn.textContent = '🟡 Nodo sin ComfyUI';
        } else {
            btn.className = 'jpi-estado bien';
            btn.textContent = '🟢 Nodo listo · Comfy OK';
        }
        btn.title = (d.mensaje || '') +
            (d.host ? ' — nodo: ' + d.host : '') +
            (d.reporteHaceSegundos != null ? ' (reporte hace ' + d.reporteHaceSegundos + 's)' : '');
    }

    function consultar() {
        fetch(URL_ESTADO, { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                ultimo = d;
                pintar(d);
            })
            .catch(function () {
                btn.className = 'jpi-estado ojo';
                btn.textContent = '🟡 Sin respuesta del servidor';
                btn.title = 'No se pudo consultar /api/status';
            });
    }

    btn.addEventListener('click', function () {
        btn.textContent = '⏳ Verificando…';
        consultar();
    });

    // Los mensajes comfy_status del websocket son al instante: si la app dice
    // que Comfy se cayó, no esperamos al próximo poll.
    document.addEventListener('jpi-comfy-status', function (e) {
        if (!ultimo) return;
        ultimo.comfy = !!e.detail.conectado;
        pintar(ultimo);
    });

    consultar();
    setInterval(consultar, 8000);
})();
