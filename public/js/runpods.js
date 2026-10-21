/* CONEXIÓN → MIS RUNPODS
 * Cada cuenta guarda sus ComfyUI remotos (RunPod y similares) en su perfil.
 * Se pueden agregar, ver si están vivos y (en la app local) apuntar el motor
 * a ese RunPod para generar ahí.
 */
(function () {
    'use strict';

    function base() {
        return (window.JPI && (window.JPI.API_BASE || '')) || '';
    }
    function esc(t) {
        return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
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
    }

    function pintar() {
        var caja = document.getElementById('redRunpods');
        if (!caja) return;
        if (!LS.length) {
            caja.innerHTML = '<div class="red-sub-chico">Todavía no agregaste ningún RunPod.</div>';
            return;
        }
        caja.innerHTML = LS.map(function (r) {
            var vivo = r.enLinea;
            return '<div class="rp-fila">' +
                '<span class="red-punto ' + (vivo ? 'verde' : 'gris') + '"></span>' +
                '<span class="rp-nombre">' + esc(r.nombre || 'RunPod') + '</span>' +
                '<span class="rp-url">' + esc(r.url) + '</span>' +
                (r.gpu ? '<span class="rp-gpu">' + esc(r.gpu) + (r.vram ? ' · ' + r.vram + ' GB' : '') + '</span>' : '') +
                (vivo ? '' : '<span class="rp-gpu">sin respuesta</span>') +
                (esLocal() ? '<button class="red-btn secundario chico" data-usar="' + esc(r.url) + '">USAR EN MI APP</button>' : '') +
                '<button class="red-btn secundario chico" data-borrar="' + esc(r.id) + '" title="borrar">✕</button>' +
                '</div>';
        }).join('\n');

        caja.querySelectorAll('[data-borrar]').forEach(function (b) {
            b.addEventListener('click', function () {
                var id = b.getAttribute('data-borrar');
                fetch(base() + '/api/red/runpods/borrar', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: id })
                }).then(cargar).catch(function () { });
            });
        });
        caja.querySelectorAll('[data-usar]').forEach(function (b) {
            b.addEventListener('click', function () {
                var url = b.getAttribute('data-usar');
                aviso('apuntando el motor al RunPod…');
                // Comfy EXTERNO: es el carril que ya existe para RunPod/nube.
                fetch(base() + '/api/config/comfy-externo', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: url, activo: true })
                }).then(function (r) { return r.json(); }).then(function (d) {
                    if (d && d.success === false) { aviso(d.message || 'no se pudo cambiar', true); return; }
                    aviso('✅ esta PC ahora usa ese RunPod como motor (Comfy externo activo).');
                }).catch(function (e) { aviso(e.message, true); });
            });
        });
    }

    function cargar() {
        fetch(base() + '/api/red/runpods?_=' + Date.now(), { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                LS = (d && d.runpods) || [];
                if (d && d.success === false && d.message) aviso('⚠️ ' + d.message, true);
                pintar();
            })
            .catch(function () { });
    }

    function agregar() {
        var nombre = (document.getElementById('rpNombre') || {}).value || '';
        var url = (document.getElementById('rpUrl') || {}).value || '';
        if (!url.trim()) { aviso('pegá la URL del RunPod (la de ComfyUI, con el puerto 8188)', true); return; }
        aviso('guardando…');
        fetch(base() + '/api/red/runpods', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombre: nombre.trim(), url: url.trim() })
        }).then(function (r) { return r.json(); }).then(function (d) {
            if (!d || d.success === false) { aviso((d && d.message) || 'no se pudo guardar', true); return; }
            aviso(d.repetido ? 'ya lo tenías guardado' : '✅ RunPod guardado en tu perfil');
            var n = document.getElementById('rpNombre'), u = document.getElementById('rpUrl');
            if (n) n.value = '';
            if (u) u.value = '';
            cargar();
        }).catch(function (e) { aviso(e.message, true); });
    }

    function enganchar() {
        var b = document.getElementById('rpAgregar');
        if (b && !b.__ck) { b.__ck = 1; b.addEventListener('click', agregar); }
        var r = document.getElementById('rpRefrescar');
        if (r && !r.__ck) { r.__ck = 1; r.addEventListener('click', cargar); }
        var u = document.getElementById('rpUrl');
        if (u && !u.__ck) {
            u.__ck = 1;
            u.addEventListener('keydown', function (e) { if (e.key === 'Enter') agregar(); });
        }
    }

    window.CK_runpods = { cargar: cargar };
    setInterval(function () {
        if (document.getElementById('redRunpods')) { enganchar(); }
    }, 1500);
    setTimeout(function () { enganchar(); cargar(); }, 2000);
})();
