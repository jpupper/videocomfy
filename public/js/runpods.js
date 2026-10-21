/* CONEXIÓN → MIS RUNPODS
 * Los RunPods del usuario se guardan en su perfil y se pintan COMO UN NODO MÁS
 * en la lista de conexión (los dibuja red.js con tarjetaRunpod()).
 * Acá sólo vive: el alta, la carga y los botones de cada tarjeta.
 */
(function () {
    'use strict';

    function base() {
        return (window.JPI && (window.JPI.API_BASE || '')) || '';
    }
    function esLocal() {
        return !/vps-4455523|dattaweb|fullscreencode\.com/i.test(location.hostname);
    }

    var LS = [];
    function aviso(t, malo) {
        var a = document.getElementById('rpAviso');
        if (!a) return;
        a.textContent = t || '';
        a.style.color = malo ? '#f59e0b' : '';
        if (t) setTimeout(function () { if (a.textContent === t) a.textContent = ''; }, 6000);
    }

    function repintar() {
        // la grilla de nodos la pinta red.js
        try {
            if (window.comfyRed && typeof window.comfyRed.repintar === 'function') window.comfyRed.repintar();
        } catch (e) { }
    }

    function cargar() {
        return fetch(base() + '/api/red/runpods?_=' + Date.now(), { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                LS = (d && d.runpods) || [];
                if (d && d.success === false && d.message) aviso('⚠️ ' + d.message, true);
                repintar();
            })
            .catch(function () { });
    }

    function agregar() {
        var nombre = (document.getElementById('rpNombre') || {}).value || '';
        var url = (document.getElementById('rpUrl') || {}).value || '';
        if (!url.trim()) { aviso('pegá la URL del ComfyUI del RunPod (con el puerto 8188)', true); return; }
        aviso('guardando…');
        fetch(base() + '/api/red/runpods', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombre: nombre.trim(), url: url.trim() })
        }).then(function (r) { return r.json(); }).then(function (d) {
            if (!d || d.success === false) { aviso((d && d.message) || 'no se pudo guardar', true); return; }
            aviso(d.repetido ? 'ya lo tenías guardado' : '✅ guardado: ya aparece arriba como un nodo');
            var n = document.getElementById('rpNombre'), u = document.getElementById('rpUrl');
            if (n) n.value = '';
            if (u) u.value = '';
            cargar();
        }).catch(function (e) { aviso(e.message, true); });
    }

    function borrar(id) {
        fetch(base() + '/api/red/runpods/borrar', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id })
        }).then(function () { cargar(); }).catch(function () { });
    }

    // los botones de las tarjetas los maneja red.js (un solo camino de conexión:
    // la misma tarjeta, el mismo CONECTAR/DESCONECTAR que una PC). Acá sólo el alta.
    function enganchar() {
        var b = document.getElementById('rpAgregar');
        if (b && !b.__ck) { b.__ck = 1; b.addEventListener('click', agregar); }
        var u = document.getElementById('rpUrl');
        if (u && !u.__ck) {
            u.__ck = 1;
            u.addEventListener('keydown', function (e) { if (e.key === 'Enter') agregar(); });
        }
    }

    window.CK_runpods = {
        cargar: cargar,
        borrar: borrar,
        lista: function () { return LS; },
        esLocal: esLocal
    };

    setInterval(enganchar, 1500);
    setTimeout(function () { enganchar(); cargar(); }, 1800);
    setInterval(function () { if (document.getElementById('redNodos')) cargar(); }, 45000);
})();
