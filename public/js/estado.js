// ============================================================
// COMFYLATAM - estado de la cadena, a la vista
// ------------------------------------------------------------
// El navegador NO puede saber por si solo si la PC de Julian esta conectada,
// si el videocomfy local esta levantado o si ComfyUI esta prendido. El agente
// local lo reporta al VPS y el VPS lo expone en /api/status: esto lo consulta
// cada pocos segundos y lo muestra en un badge del encabezado.
// ============================================================
(function () {
    'use strict';

    var btn = document.getElementById('jpiEstado');
    if (!btn) return;

    var URL_ESTADO = window.JPI.API_BASE + '/api/status';
    var ultimo = null;

    function pintar(d) {
        if (!d) return;
        if (!d.agente) {
            btn.className = 'jpi-estado mal';
            btn.textContent = '🔴 PC desconectada';
        } else if (!d.videocomfy) {
            btn.className = 'jpi-estado ojo';
            btn.textContent = '🟡 Videocomfy apagado';
        } else if (!d.comfy) {
            btn.className = 'jpi-estado ojo';
            btn.textContent = '🟡 ComfyUI apagado';
        } else {
            btn.className = 'jpi-estado bien';
            btn.textContent = '🟢 Conectado · Comfy listo';
        }
        btn.title = (d.mensaje || '') +
            (d.host ? ' — PC: ' + d.host : '') +
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
                btn.className = 'jpi-estado mal';
                btn.textContent = '🔴 Sin respuesta del servidor';
                btn.title = 'No se pudo consultar /api/status';
            });
    }

    // Reconsultar al tocar el badge (util despues de prender ComfyUI)
    btn.addEventListener('click', function () {
        btn.textContent = '⏳ Verificando…';
        consultar();
    });

    // Los mensajes comfy_status que llegan por el websocket son al instante:
    // si el videocomfy dice que Comfy se cayo, no esperamos al proximo poll.
    document.addEventListener('jpi-comfy-status', function (e) {
        if (!ultimo) return;
        ultimo.comfy = !!e.detail.conectado;
        pintar(ultimo);
    });

    consultar();
    setInterval(consultar, 8000);
})();
