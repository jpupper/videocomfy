// ============================================================
// COMFYLATAM - boton PAUSA / PLAY de la cola
// ------------------------------------------------------------
// Pedido: ademas de STOP (que corta), un boton PAUSA que:
//   - deja TERMINAR el item que esta generando ahora,
//   - NO procesa el resto del batch,
//   - NO lo borra: queda ahi listo (ready) esperando,
//   - y al reanudar sigue por donde estaba.
// El motor de la cola vive en js/script.js (checkGlobalQueue): ahi se consulta
// window.JPI_COLA_PAUSADA. Este archivo solo pinta el boton y maneja el estado.
//
// DOS BOTONES, UN SOLO ESTADO (pedido del usuario 20-Oct):
//   1) el de la columna izquierda, junto a guardar proyecto (si existe);
//   2) el de STAGE, en la cabecera de la cola, junto a STOP ALL. Antes el PLAY
//      vivia SOLO a la izquierda y en el celular ese panel ni se ve: desde
//      STAGE no habia forma de reanudar.
// La cola ARRANCA EN PLAY: al entrar no queda en pausa (ver script.js).
// ============================================================
(function () {
    'use strict';

    window.JPI_COLA_PAUSADA = false;

    var btn = null;        // el de la izquierda (compatibilidad)
    var btnStage = null;   // el de STAGE

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

    // En STAGE el numero que importa son los pedidos "pedida" del registro
    // (los que estan en espera de verdad), no la cola del navegador.
    function enEsperaRegistro() {
        try {
            var st = window.CKPedidos;
            if (st && typeof st.contar === 'function') {
                var c = st.contar();
                return Number(c.enEspera || 0);
            }
        } catch (e) { }
        return 0;
    }

    function pintarBoton(b, esStage) {
        if (!b) return;
        var n = esStage ? enEsperaRegistro() : pendientes();
        var enPausa = !!window.JPI_COLA_PAUSADA;

        b.classList.add('jpi-pausa');
        b.classList.toggle('pausado', enPausa);

        if (enPausa) {
            b.textContent = '▶ PLAY COLA' + (n ? ' (' + n + ')' : '');
            b.title = 'Cola en pausa: ' + n + ' pedido(s) esperando.\n' +
                'Lo que estaba generando termina solo; el resto NO se borró.';
        } else {
            b.textContent = (n ? '⏸ PAUSA (' + n + ')' : '⏸ PAUSA');
            b.title = 'Termina lo que está generando y deja el resto en espera (no borra nada).';
        }

        var info = document.getElementById('jpiStagePlayInfo');
        if (info && esStage) {
            if (enPausa) {
                info.textContent = n
                    ? 'cola en pausa · ' + n + ' en espera'
                    : 'cola en pausa';
                info.classList.add('en-pausa');
            } else {
                info.textContent = n
                    ? 'cola andando · ' + n + ' en espera'
                    : 'cola andando';
                info.classList.remove('en-pausa');
            }
        }
    }

    function pintar() {
        var enPausa = !!window.JPI_COLA_PAUSADA;
        document.body.classList.toggle('jpi-cola-pausada', enPausa);

        pintarBoton(btn, false);
        pintarBoton(btnStage, true);

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
                enEsperaRegistro() + ' en espera (sin borrar). Reanudá con ▶ PLAY COLA.';
        } else if (chip) {
            chip.remove();
        }
    }

    function alternar() {
        window.JPI_COLA_PAUSADA = !window.JPI_COLA_PAUSADA;
        window.JPI_PAUSA_AVISADA = false;
        pintar();
        try { window.dispatchEvent(new CustomEvent('jpi-cola-actualizada')); } catch (e) { }
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
        setTimeout(pintar, 500);
    }

    // El boton del panel IZQUIERDO (#piBtnPausar, de panel-izquierdo.js) ya
    // escribe el mismo estado (JPI_COLA_PAUSADA): no se crea otro al lado de
    // guardar proyecto. Tener tres botones iguales en la misma pantalla confunde
    // (habia uno en el header, otro en STAGE y otro en el panel).
    function engancharIzquierdo() {
        var b = document.getElementById('piBtnPausar');
        if (!b || b.__ckPlay) return;
        b.__ckPlay = true;
        b.addEventListener('click', function () { setTimeout(pintar, 60); });
    }

    // ---------- boton de STAGE ----------
    // Va en el HTML (dentro de #progressContainer) para que este SIEMPRE a la
    // vista en la pestaña Stage, haya o no pedidos en la cola: la tarjeta de la
    // cola se oculta cuando esta vacia y el boton desaparecia con ella.
    function crearStage() {
        var b = document.getElementById('jpiStagePlayBtn');
        if (!b) return;
        if (b !== btnStage) {
            btnStage = b;
            btnStage.classList.add('jpi-pausa');
            btnStage.addEventListener('click', alternar);
        }
        pintar();
    }

    function arrancar() {
        engancharIzquierdo();
        crearStage();
        // La cabecera de la cola la mueve batch-pedidos.js: si todavia no estaba,
        // se reintenta un par de veces (no se crea duplicado: se chequea el id).
        setTimeout(crearStage, 800);
        setTimeout(crearStage, 3000);
        setInterval(pintar, 5000);
    }

    // Para que cualquier otro boton (panel izquierdo, atajos) use el MISMO toggle.
    window.JPIColaToggle = alternar;
    window.JPIColaPintar = pintar;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', arrancar);
    } else {
        arrancar();
    }
})();
