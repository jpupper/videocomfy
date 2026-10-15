// ============================================================
// COMFYLATAM - versión y actualización
// ------------------------------------------------------------
// Muestra en qué versión está la app y, si hay una nueva en el repositorio,
// ofrece un botón "Actualizar" que hace el pull y deja todo al día.
//
//   local : GET /api/version  -> commit local vs remoto + POST /api/actualizar
//   web   : lee la versión del hub (GET /health), sólo informativa
// ============================================================
(function () {
    'use strict';

    var J = window.JPI || {};
    var BASE = J.API_BASE || '';
    var esLocal = !!J.esServidor;
    var chip = null;
    var info = null;

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    function montar() {
        if (document.getElementById('ckVersionChip')) return;
        // El chip va PRIMERO en el menú de pestañas: a la izquierda de PREVIZ.
        // Antes se colgaba al final de la barra y quedaba fuera de la vista
        // (la fila de pestañas no entra completa).
        var arriba = document.querySelector('.tabs-container');
        var barra = document.getElementById('projectTabsNav');
        if (!arriba && !barra) return;
        chip = document.createElement('button');
        chip.id = 'ckVersionChip';
        chip.className = 'ck-version-chip';
        chip.type = 'button';
        chip.textContent = '· verificando versión…';
        chip.title = 'Versión de la aplicación';
        if (arriba) arriba.insertBefore(chip, arriba.firstChild);
        else barra.appendChild(chip);
        chip.addEventListener('click', function () {
            if (info && info.hayNueva) actualizar();
            else verDetalle();
        });
    }

    // ---------- local: /api/version ----------
    function traer() {
        if (!esLocal) {
            // en la web sólo mostramos la versión del hub
            fetch(BASE + '/api/version').then(function (r) { return r.ok ? r.json() : fetch(BASE + '/health').then(function (x) { return x.ok ? x.json() : null; }); }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
                if (!chip) return;
                var v = (d && (d.version || d.commit)) || null;
                chip.className = 'ck-version-chip solo-lectura';
                chip.textContent = v ? '🧩 ' + v : '🧩 versión ?';
                chip.title = 'Versión del hub (la actualiza el dueño del VPS)';
            }).catch(function () { });
            return;
        }
        fetch('api/version').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
            if (!d || !d.version) return;
            info = d;
            pintar();
        }).catch(function () { });
    }

    function pintar() {
        if (!chip || !info) return;
        var v = info.version;
        var corto = v.corto || (v.origen !== 'git' ? 'sin git' : '?');
        if (info.hayNueva) {
            chip.className = 'ck-version-chip hay-nueva';
            chip.textContent = '⬆️ Actualizar (' + (info.remoto.atras || 1) + ')';
            chip.title = 'Hay una versión nueva: ' + (v.corto || '?') + ' → ' + info.remoto.corto +
                '\nClick para actualizar (trae los últimos cambios del repositorio).';
        } else {
            chip.className = 'ck-version-chip al-dia';
            chip.textContent = '✅ ' + corto;
            chip.title = 'Estás en la última versión (' + corto + ')\n' + (v.fecha ? new Date(v.fecha).toLocaleString('es-AR') + '\n' : '') +
                (v.asunto ? '· ' + v.asunto + '\n' : '') + '\nClick para ver el detalle.';
        }
    }

    function verDetalle() {
        if (!info) return;
        var v = info.version, r = info.remoto || {};
        var txt = [
            'COMFYLATAM — versión',
            '',
            'Local  : ' + (v.corto || '?') + (v.rama ? '  (rama ' + v.rama + ')' : ''),
            v.fecha ? 'Fecha  : ' + new Date(v.fecha).toLocaleString('es-AR') : '',
            v.asunto ? 'Último : ' + v.asunto : '',
            v.origen !== 'git' ? 'Origen : ' + v.origen : '',
            '',
            'Repositorio : ' + (info.repo || '?'),
            r.corto ? 'Remoto : ' + r.corto + (r.atras ? '  (' + r.atras + ' commits nuevos)' : '  (al día)') : 'Remoto : (no consultado)',
            info.hayNueva ? '\nHay una versión nueva: usá el botón Actualizar.' : '\nEstás al día.'
        ].filter(Boolean).join('\n');
        try { alert(txt); } catch (e) { console.log(txt); }
    }

    // ---------- actualizar ----------
    function actualizar() {
        var atras = (info.remoto && info.remoto.atras) || 1;
        var ok = true;
        try {
            ok = confirm('Actualizar COMFYLATAM\n\nHay ' + atras + ' cambio(s) nuevo(s) en el repositorio.\n' +
                'Se descargan y, si hace falta, la app se reinicia sola.\n\n¿Actualizo ahora?');
        } catch (e) { }
        if (!ok) return;

        chip.disabled = true;
        chip.className = 'ck-version-chip actualizando';
        chip.textContent = '⏳ Actualizando…';

        fetch('api/actualizar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().then(function (d) { d._status = r.status; return d; }); })
            .then(function (d) {
                if (!d.success) {
                    chip.className = 'ck-version-chip error';
                    chip.textContent = '⚠️ No se pudo actualizar';
                    chip.title = d.message || '';
                    alert('No pude actualizar: ' + (d.message || 'error desconocido'));
                    chip.disabled = false;
                    return;
                }
                chip.className = 'ck-version-chip al-dia';
                chip.textContent = '✅ ' + d.despues + ' (actualizado)';
                chip.title = 'Actualizado de ' + d.antes + ' a ' + d.despues + (d.npm ? ' (con npm install)' : '');
                if (typeof appendConsoleLine === 'function') {
                    appendConsoleLine('⬆️ Actualizado ' + d.antes + ' → ' + d.despues + (d.npm ? ' (+ npm install)' : ''), 'system');
                }
                // si cambió el backend, la app se reinicia: esperamos y recargamos
                setTimeout(function () { location.reload(); }, d.reiniciar ? 9000 : 2500);
            })
            .catch(function (e) {
                chip.className = 'ck-version-chip error';
                chip.textContent = '⚠️ Error al actualizar';
                chip.title = e.message;
                chip.disabled = false;
            });
    }

    function arrancar() {
        montar();
        traer();
        // vuelve a chequear cada 30 minutos (igual que el backend)
        setInterval(traer, 30 * 60 * 1000);
        // y cada 5 minutos si el backend dice que hay algo nuevo
        setInterval(function () { if (info && info.hayNueva) traer(); }, 5 * 60 * 1000);
        // expuesto por si SETTINGS quiere el detalle
        window.comfyVersion = { info: function () { return info; }, chequear: traer, actualizar: actualizar, detalle: verDetalle };
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar);
    else arrancar();
})();
