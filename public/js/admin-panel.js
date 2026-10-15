// ============================================================
// PANEL DE ADMINISTRACIÓN (sólo en la WEB)
// ------------------------------------------------------------
// En la app local NO existe: el panel es para el dueño del sistema y vive en
// la versión que se sirve desde la nube. Hoy maneja el CUPO DE LA NUBE por
// cuenta (los administradores no tienen tope).
// ============================================================
(function () {
    'use strict';

    var J = window.JPI || {};
    // Sólo en la versión WEB (dominio real). En la app local no existe:
    // esServidor también es true en localhost, así que no sirve como filtro.
    var h = location.hostname;
    var esWebDeVerdad = h !== 'localhost' && h !== '127.0.0.1' && h.indexOf('localhost') === -1;
    if (!esWebDeVerdad) return;
    if (!token()) return;                    // sin sesión no se muestra ni pregunta

    function token() { try { return localStorage.getItem('fsc_token_jpi') || localStorage.getItem('token') || ''; } catch (e) { return ''; } }
    function baseApi() {
        var j = window.JPI || {};
        return (j.API_BASE && j.API_BASE.indexOf('/comfylatam') >= 0) ? j.API_BASE : 'https://vps-4455523-x.dattaweb.com/comfylatam';
    }
    function pedir(ruta, opciones) {
        var o = opciones || {};
        var h = { 'Content-Type': 'application/json' };
        if (token()) h.Authorization = 'Bearer ' + token();
        return fetch(baseApi() + ruta, { method: o.method || 'GET', headers: h, body: o.json ? JSON.stringify(o.json) : undefined })
            .then(function (r) { return r.json().then(function (d) { d._status = r.status; return d; }); });
    }

    function montar() {
        if (document.getElementById('adminPanel')) return;
        var wrap = document.querySelector('#tabSettings .ck-set-wrap') || document.getElementById('tabSettings');
        if (!wrap) return;
        var caja = document.createElement('div');
        caja.id = 'adminPanel';
        caja.className = 'admin-panel';
        caja.innerHTML = '<h3 class="rank-h4">🛡️ PANEL DE ADMINISTRACIÓN</h3><div class="rank-vacio">cargando…</div>';
        wrap.insertBefore(caja, wrap.firstChild);
        // sólo si esta cuenta es administradora
        pedir('/api/admin/limite').then(function (d) {
            if (!d || d._status === 403 || d.success === false) { caja.remove(); return; }
            caja.innerHTML =
                '<h3 class="rank-h4">🛡️ PANEL DE ADMINISTRACIÓN</h3>' +
                '<div class="admin-fila">' +
                '<label>Cupo de la nube por cuenta</label>' +
                '<input type="number" id="adminLimite" min="1" max="100000" value="' + (d.limiteMB || 20) + '" class="admin-input">' +
                '<span class="admin-unidad">MB</span>' +
                '<button id="adminGuardar" class="rank-btn">Guardar</button>' +
                '</div>' +
                '<div class="admin-nota">Cuánto puede guardar en Cloudflare cada cuenta. Los administradores no tienen tope. ' +
                'La media generada en local NO se sube: queda en la computadora de cada uno.</div>';
            document.getElementById('adminGuardar').addEventListener('click', function () {
                var v = Number(document.getElementById('adminLimite').value) || 20;
                pedir('/api/admin/limite', { method: 'POST', json: { limiteMB: v } }).then(function (r) {
                    caja.querySelector('.admin-nota').innerHTML = r && r.success
                        ? '✅ guardado: ' + r.limiteMB + ' MB por cuenta'
                        : '⚠️ no se pudo guardar (' + ((r && r.message) || 'error') + ')';
                });
            });
        }).catch(function () { caja.remove(); });
    }

    function arrancar() { setTimeout(montar, 2500); setInterval(montar, 8000); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar);
    else arrancar();
})();
