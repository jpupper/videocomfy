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

        var esWeb = (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1' && location.hostname.indexOf('localhost') === -1);

        // --- app local: solo importa que ComfyUI responda ---
        if (d.entorno === 'local' || !esWeb) {
            if (d.comfy) {
                btn.className = 'jpi-estado bien';
                btn.textContent = '🟢 Comfy listo · local';
            } else {
                btn.className = 'jpi-estado mal';
                btn.textContent = '🔴 ComfyUI apagado';
            }
            btn.title = 'App local · ComfyUI: ' + (d.comfyAddress || '127.0.0.1') +
                (d.comfy ? ' (conectado)' : ' (no responde — revisá si start_comfy.bat está abierto)');
            return;
        }

        // --- versión web: el editor funciona contra los nodos de la red ---
        if (!d.agente) {
            btn.className = 'jpi-estado ojo';
            btn.textContent = '🔴 Tu PC desconectada del VPS';
        } else if (!d.videocomfy) {
            btn.className = 'jpi-estado ojo';
            btn.textContent = '🟡 PC sin videocomfy local';
        } else if (!d.comfy) {
            btn.className = 'jpi-estado mal';
            btn.textContent = '🔴 ComfyUI apagado en tu PC';
        } else {
            btn.className = 'jpi-estado bien';
            btn.textContent = '🟢 Nodo listo · Comfy OK';
        }
        btn.title = (d.mensaje || '') +
            (d.reporteHaceSegundos != null ? ' (reporte hace ' + d.reporteHaceSegundos + 's)' : '');
    }

    function consultar() {
        var esWeb = (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1' && location.hostname.indexOf('localhost') === -1);
        fetch(URL_ESTADO, { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (d) {
                ultimo = d;
                pintar(d);
            })
            .catch(function () {
                btn.className = 'jpi-estado mal';
                btn.textContent = esWeb ? '🔴 Servidor VPS sin respuesta' : '🔴 Servidor Local sin respuesta';
                btn.title = 'No se pudo contactar el backend en /api/status';
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
