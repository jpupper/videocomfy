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
            total: Number(c.total || 0),
            enEjecucion: c.enEjecucion || []
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
        // guardamos el detalle para el aviso de "colgado"
        c.enEjecucion = (window.JPI_COMFY_COLA && window.JPI_COMFY_COLA.enEjecucion) || [];
        document.getElementById('colaComfyPendientes').textContent = c.pendientes;
        document.getElementById('colaComfyTotal').textContent = c.total;

        // Armar el detalle de lo que el motor tiene en ejecución (para poder decir
        // CUÁL es el trabajo colgado, no sólo que hay uno).
        var enEjec = c.enEjecucion || [];
        var detalle = '';
        if (enEjec.length) {
            var j = enEjec[0];
            detalle = j.conocido
                ? '🎯 es tu trabajo: “' + String(j.prompt || '').slice(0, 60) + '” · pedido por @' + (j.de || 'vos') +
                  (j.origen === 'red' ? ' (de la red)' : ' (local)')
                : '🤔 no es de esta app (' + String(j.promptId || '').slice(0, 8) + '…) — quedó de otra corrida o lo mandó otro programa';
        }

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
                    aviso.textContent = '⚠️ Trabajo COLGADO en el motor (hace ' + Math.round(hace / 1000) + 's que no da señales).\n' +
                        detalle + '\nTraba el resto de la cola: vaciala y, si sigue, reiniciá el motor con start_network.bat.';
                } else if (detalle && appPendientes() === 0) {
                    aviso.className = 'cola-comfy-aviso ojo';
                    aviso.textContent = 'El motor tiene trabajo que no está en tu lista.\n' + detalle;
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

    // --- 📥 pedidos que llegan de la RED (van aparte del batch propio) ------
    function pintarVuelo() {
        var caja = document.getElementById('queueRedVuelo');
        if (!caja) return;
        var lista = window.JPI_RED_VUELO || [];
        if (typeof window.JPI_RED_VUELO === 'undefined') return;   // todavía no llegó info
        var cant = document.getElementById('redVueloCantidad');
        if (cant) cant.textContent = lista.length ? '(' + lista.length + ')' : '';
        if (!lista.length) { caja.classList.add('hidden'); return; }
        caja.classList.remove('hidden');
        var cont = document.getElementById('redVueloLista');
        if (cont) {
            // --- LÍNEA DE TIEMPO -------------------------------------------------
            // Cada pedido que llega de la web (o de otra PC) muestra en qué paso
            // va: pedido -> ComfyUI (paso x/N) -> subida a Cloudflare -> listo.
            // Antes desaparecía apenas arrancaba a generar y no se veía el proceso.
            var hora = function (t) {
                if (!t) return '';
                var d = new Date(t);
                return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
            };
            var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (m) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]; }); };
            cont.innerHTML = lista.map(function (j) {
                var est = j.estado || 'pedido';
                var pasos = j.pasos || {};
                var web = (j.origen === 'web') || j.tipo === 'web';
                // qué paso está en curso / hecho
                var orden = ['pedido', 'comfy', 'subiendo', 'listo'];
                var idx = orden.indexOf(est);
                if (est === 'sin_nube') idx = 3;
                var clase = function (i) { return i < idx ? 'hecho' : (i === idx ? 'actual' : ''); };
                var comfyTxt = '⚙️ ComfyUI';
                if (est === 'comfy' && j.total) comfyTxt += ' · paso ' + (j.paso || 0) + '/' + j.total;
                var nubeTxt = '☁️ Cloudflare';
                if (est === 'subiendo') nubeTxt = '☁️ Subiendo a Cloudflare…';
                else if (j.urlNube && est === 'listo') nubeTxt = '☁️ En Cloudflare';
                else if (est === 'sin_nube') nubeTxt = '☁️ No se pudo subir';
                else if (est === 'listo' && !j.urlNube) nubeTxt = '💾 Quedó en esta PC';
                var finTxt = (est === 'listo' && j.urlNube) ? '✅ Ya se ve en la web' : '✅ Terminado';
                return '<div class="red-tl-card" data-estado="' + esc(est) + '">' +
                    '<div class="red-tl-head">' +
                        '<span class="red-tl-origen ' + (web ? 'web' : 'red') + '">' +
                            (web ? '🌐 PEDIDO DESDE LA WEB' : '🖧 PEDIDO DE OTRA PC') + '</span>' +
                        '<b class="red-tl-user">@' + esc(j.usuario || j.de || '?') + '</b>' +
                        '<span class="red-tl-hora">' + hora(j.desde) + '</span>' +
                    '</div>' +
                    '<div class="red-tl-prompt">“' + esc(String(j.prompt || '').slice(0, 110)) + '”' +
                        ' <span class="red-tl-modelo">' + esc(j.modelo || 'auto') + '</span></div>' +
                    '<div class="red-tl-pasos">' +
                        '<span class="red-tl-paso ' + clase(0) + '">① Pedido <i>' + hora(pasos.pedido || j.desde) + '</i></span>' +
                        '<span class="red-tl-flecha">→</span>' +
                        '<span class="red-tl-paso ' + clase(1) + '">' + comfyTxt + ' <i>' + hora(pasos.comfy) + '</i></span>' +
                        '<span class="red-tl-flecha">→</span>' +
                        '<span class="red-tl-paso ' + clase(2) + '">' + nubeTxt + ' <i>' + hora(pasos.subiendo) + '</i></span>' +
                        '<span class="red-tl-flecha">→</span>' +
                        '<span class="red-tl-paso ' + clase(3) + '">' + finTxt + ' <i>' + hora(pasos.listo) + '</i></span>' +
                    '</div>' +
                    (j.archivo ? '<div class="red-tl-archivo">📄 ' + esc(j.archivo) + '</div>' : '') +
                '</div>';
            }).join('');
        }
    }
    window.jpiPintarVuelo = pintarVuelo;

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
