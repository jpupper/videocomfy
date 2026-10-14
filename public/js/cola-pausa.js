// ============================================================
// COMFYLATAM - boton PAUSA de la cola
// ------------------------------------------------------------
// Pedido: ademas de STOP (que corta), un boton PAUSA que:
//   - deja TERMINAR el item que esta generando ahora,
//   - NO procesa el resto del batch,
//   - NO lo borra: queda ahi listo (ready) esperando,
//   - y al reanudar sigue por donde estaba.
// El motor de la cola vive en js/script.js (checkGlobalQueue): ahi se consulta
// window.JPI_COLA_PAUSADA. Este archivo solo pinta el boton y maneja el estado.
// ============================================================
(function () {
    'use strict';

    window.JPI_COLA_PAUSADA = false;

    var btn = null;

    function estado() {
        // El estado real vive dentro de script.js (exponia en window por si el
        // dia de mañana el front pasa a modulo). Fallback: leer la cola/flag.
        if (typeof window.jpiColaEstado === 'function') {
            try { return window.jpiColaEstado(); } catch (e) { }
        }
        var cola = [];
        try { cola = globalGenerationQueue; } catch (e) { }
        return {
            pausada: !!window.JPI_COLA_PAUSADA,
            generando: false,
            enCurso: cola.filter(function (i) { return i.status === 'generating'; }).length,
            pendientes: cola.filter(function (i) { return i.status === 'pending'; }).length,
            total: cola.length
        };
    }

    function pendientes() { return estado().pendientes; }

    function enCurso() { return estado().enCurso; }

    function pintar() {
        if (!btn) return;
        var n = pendientes();
        var enPausa = !!window.JPI_COLA_PAUSADA;

        document.body.classList.toggle('jpi-cola-pausada', enPausa);

        if (enPausa) {
            btn.className = 'jpi-pausa pausado';
            btn.textContent = '▶ REANUDAR' + (n ? ' (' + n + ')' : '');
            btn.title = 'Cola en pausa: ' + n + ' item(s) listos (ready) esperando.\n' +
                'Lo que estaba generando termina solo; el resto NO se borró.';
        } else {
            btn.className = 'jpi-pausa';
            btn.textContent = (n ? '⏸ PAUSAR (' + n + ')' : '⏸ PAUSAR');
            btn.title = 'Termina lo que está generando y deja el resto del batch en ready (no borra nada).';
        }

        // Cartel arriba de la cola mientras esta pausada
        var chip = document.getElementById('jpiPausaChip');
        if (enPausa) {
            if (!chip) {
                chip = document.createElement('div');
                chip.id = 'jpiPausaChip';
                chip.className = 'jpi-pausa-chip';
                var ancla = document.getElementById('globalQueueContainer') || document.body;
                ancla.parentNode.insertBefore(chip, ancla);
            }
            var cur = enCurso();
            chip.textContent = '⏸ COLA EN PAUSA — ' +
                (cur ? 'terminando lo que está en curso, ' : '') +
                n + ' en espera (ready, sin borrar). Reanudá con ▶ REANUDAR.';
        } else if (chip) {
            chip.remove();
        }
    }

    function alternar() {
        window.JPI_COLA_PAUSADA = !window.JPI_COLA_PAUSADA;
        window.JPI_PAUSA_AVISADA = false;
        pintar();
        if (!window.JPI_COLA_PAUSADA) {
            try {
                if (typeof appendConsoleLine === 'function') {
                    appendConsoleLine('▶ Cola reanudada: sigo con lo que estaba listo.', 'system');
                }
                if (typeof window.jpiColaReanudar === 'function') {
                    window.jpiColaReanudar();      // arranca el proximo item
                } else {
                    checkGlobalQueue();
                }
            } catch (e) { }
        }
    }

    function crear() {
        var ref = document.getElementById('saveProjectBtn');
        if (!ref || document.getElementById('jpiPausaBtn')) return;

        btn = document.createElement('button');
        btn.id = 'jpiPausaBtn';
        btn.type = 'button';
        btn.addEventListener('click', alternar);
        ref.parentNode.insertBefore(btn, ref.nextSibling);

        pintar();
        setInterval(pintar, 2000);   // mantiene el contador de ready al dia
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', crear);
    } else {
        crear();
    }
})();
