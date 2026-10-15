// ============================================================
// COMFYLATAM - 🎛️ COLA DE COMFYUI (separada de la cola de la app)
// ------------------------------------------------------------
// Son dos cosas distintas y hay que verlas por separado:
//
//   📋 COLA DE LA APP   -> lo que pediste vos (js/script.js, globalGenerationQueue)
//   🎛️ COLA DE COMFYUI  -> lo que el motor tiene de verdad: lo que está
//                          ejecutando ahora + lo que tiene en espera. Puede
//                          incluir trabajo de corridas ANTERIORES que la app ya
//                          no recuerda (por eso a veces "terminó todo" y ComfyUI
//                          seguía). La app la lee de /queue cada 5 s.
//
// Este archivo sólo pinta esa segunda tarjeta y el botón de vaciarla.
// ============================================================
(function () {
    'use strict';

    var caja = null;
    var ultimo = { pendientes: -1, ejecutando: -1 };

    function cola() {
        var c = window.JPI_COMFY_COLA || { pendientes: 0, ejecutando: 0, total: 0 };
        return {
            pendientes: Number(c.pendientes || 0),
            ejecutando: Number(c.ejecutando || 0),
            total: Number(c.total || 0)
        };
    }

    function appPendientes() {
        // items que la app todavía tiene sin completar
        if (typeof window.jpiColaEstado === 'function') {
            try { var e = window.jpiColaEstado(); return Number(e.pendientes || 0) + Number(e.enCurso || 0); } catch (err) { }
        }
        try {
            return globalGenerationQueue.filter(function (i) { return i.status !== 'completed'; }).length;
        } catch (e) { return 0; }
    }

    function pintar() {
        if (!caja) return;
        var c = cola();

        document.getElementById('colaComfyEjecutando').textContent = c.ejecutando;
        document.getElementById('colaComfyPendientes').textContent = c.pendientes;
        document.getElementById('colaComfyTotal').textContent = c.total;

        // ¿Hay algo "ejecutando" pero el motor no da señales de vida? Un trabajo
        // colgado en queue_running traba TODA la cola (los demás nunca arrancan).
        // OJO: si todavía no hubo ninguna señal, el reloj arranca ahora (si no,
        // Date.now() - 0 daba un número absurdo y avisaba de un cuelgue falso).
        if (!window.JPI_COMFY_ACTIVIDAD) window.JPI_COMFY_ACTIVIDAD = Date.now();
        var hace = Date.now() - window.JPI_COMFY_ACTIVIDAD;
        // Si la propia cola cambió, el motor está vivo.
        if (ultimo.pendientes !== c.pendientes || ultimo.ejecutando !== c.ejecutando) {
            window.JPI_COMFY_ACTIVIDAD = Date.now();
            hace = 0;
        }
        var colgado = c.ejecutando > 0 && hace > 60000;

        var aviso = document.getElementById('colaComfyAviso');
        if (c.total === 0) {
            caja.classList.add('hidden');
            if (aviso) aviso.textContent = '';
        } else {
            caja.classList.remove('hidden');
            if (aviso) {
                if (colgado) {
                    aviso.className = 'cola-comfy-aviso ojo';
                    aviso.textContent = '⚠️ Hay un trabajo COLGADO en el motor (hace ' + Math.round(hace / 1000) +
                        's que no da señales). Traba el resto de la cola: vaciala y, si sigue, reiniciá el motor con start_network.bat.';
                } else if (appPendientes() === 0) {
                    // la app no tiene nada: esto es trabajo viejo del motor
                    aviso.className = 'cola-comfy-aviso ojo';
                    aviso.textContent = '⚠️ Estos ' + c.total + ' no son de tu lista: son trabajos que quedaron en el motor ' +
                        '(de una corrida anterior). Vacialos si no los querés.';
                } else {
                    aviso.className = 'cola-comfy-aviso ok';
                    aviso.textContent = '✅ Corriendo lo que pediste en la 📋 cola de la app.';
                }
            }
        }
        ultimo = c;
    }
    window.jpiPintarColaComfy = pintar;

    function limpiar() {
        var b = document.getElementById('colaComfyLimpiar');
        if (!b) return;
        b.disabled = true;
        var previo = b.textContent;
        b.textContent = '⏳ Vaciando...';
        fetch('api/comfy/cola/limpiar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ que: 'todo' })
        })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (typeof appendConsoleLine === 'function') {
                    appendConsoleLine(d.success
                        ? '🧹 Cola de ComfyUI vaciada (quedan ' + (d.pendientes || 0) + ')'
                        : '⚠️ No pude vaciarla: ' + (d.message || ''), 'system');
                }
            })
            .catch(function (e) {
                if (typeof appendConsoleLine === 'function') appendConsoleLine('⚠️ ' + e.message, 'system');
            })
            .then(function () { b.disabled = false; b.textContent = previo; pintar(); });
    }

    function arrancar() {
        caja = document.getElementById('queueColaComfy');
        if (!caja) return;
        // La cola de ComfyUI sólo existe en la app local (en la web el Comfy
        // vive en la máquina de otra persona): ahí la tarjeta no se muestra.
        var esLocal = !!(window.JPI && window.JPI.esServidor);
        if (!esLocal) { caja.classList.add('hidden'); return; }

        var b = document.getElementById('colaComfyLimpiar');
        if (b) b.addEventListener('click', limpiar);

        // primer valor por REST (por si el socket todavía no mandó nada)
        fetch('api/comfy/cola').then(function (r) { return r.json(); }).then(function (d) {
            window.JPI_COMFY_COLA = { pendientes: d.pendientes || 0, ejecutando: d.ejecutando || 0, total: d.total || 0 };
            pintar();
        }).catch(function () { });

        pintar();
        setInterval(pintar, 3000);   // mantiene el número al día
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar);
    else arrancar();
})();
