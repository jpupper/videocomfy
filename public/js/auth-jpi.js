// ============================================================
// COMFYLATAM - sesión FSC en la versión WEB
// ------------------------------------------------------------
// La web (fullscreencode.com/comfylatam) se usa logueado con la cuenta de
// fullscreencode. NO hay formulario propio: se va SIEMPRE al login unificado
// del ecosistema y se vuelve a esta misma página (igual que artedigitaldata
// y jpshadereditor):
//
//   https://fullscreencode.com/fscauth/login.html?redirect=<esta app>&origin=comfylatam
//
// El centralizador vuelve con ?token=<jwt>&username=&userId= y acá se guarda.
// En la app LOCAL (videocomfy :5634) esto no se activa: ahí no hay login.
// ============================================================
(function () {
    'use strict';

    var CLAVE = 'fsc_token_jpi';
    var CLAVE_USER = 'fsc_user_jpi';
    if (!window.JPI || window.JPI.esServidor) return;   // local: sin login

    var J = window.JPI;
    var API = J.API_BASE;
    var FSCAUTH = (J.FSCAUTH_URL || 'https://fullscreencode.com/fscauth').replace(/\/+$/, '');
    var token = '';
    var usuario = null;
    var yendo = false;

    function tokenSano(t) {
        if (typeof t !== 'string' || !t) t = token;
        return typeof t === 'string' && t.length > 40 && t.split('.').length === 3;
    }

    function guardarToken(t) {
        token = t || '';
        try { t ? localStorage.setItem(CLAVE, t) : localStorage.removeItem(CLAVE); } catch (e) { }
    }

    function guardarUsuario(u) {
        usuario = u || null;
        try { u ? localStorage.setItem(CLAVE_USER, JSON.stringify(u)) : localStorage.removeItem(CLAVE_USER); } catch (e) { }
    }

    // --- URL de vuelta (esta app, sin parámetros de SSO) ---------------------
    function urlVuelta() {
        var u = new URL(location.origin + location.pathname);
        return u.toString();
    }

    function irAlLoginUnificado(aviso) {
        if (yendo) return;
        yendo = true;
        var dest = FSCAUTH + '/login.html?redirect=' + encodeURIComponent(urlVuelta()) + '&origin=comfylatam';
        if (aviso) dest += '&aviso=' + encodeURIComponent(aviso);
        location.replace(dest);
    }

    // --- 1) ¿volvió del login con ?token=...? --------------------------------
    function leerRetorno() {
        var u;
        try { u = new URL(location.href); } catch (e) { return false; }
        var t = u.searchParams.get('token');
        if (!t) return false;
        guardarToken(t);
        var nom = u.searchParams.get('username') || u.searchParams.get('user');
        var id = u.searchParams.get('userId');
        if (nom || id) guardarUsuario({ username: nom || null, id: id || null });
        ['token', 'username', 'userId', 'ssoset', 'aviso'].forEach(function (k) { u.searchParams.delete(k); });
        try { location.replace(u.toString()); } catch (e) { }
        return true;      // se está recargando limpio
    }

    if (leerRetorno()) return;

    try {
        token = localStorage.getItem(CLAVE) || '';
        usuario = JSON.parse(localStorage.getItem(CLAVE_USER) || 'null');
    } catch (e) { }

    // --- 2) sin sesión: al login unificado ----------------------------------
    if (!tokenSano()) {
        irAlLoginUnificado();
        return;
    }

    // --- 3) fetch de la API con el token (+ rebote al login si venció) ------
    var fetchOriginal = window.fetch.bind(window);

    function esDeLaApi(url) {
        try { return String(url).indexOf(J.ORIGIN) === 0; } catch (e) { return false; }
    }

    window.fetch = function (url, opciones) {
        opciones = opciones || {};
        if (esDeLaApi(url)) {
            var headers = new Headers(opciones.headers || {});
            if (token && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);
            opciones.headers = headers;
        }
        return fetchOriginal(url, opciones).then(function (r) {
            if (r.status === 401 && esDeLaApi(url)) {
                r.clone().json().then(function (d) {
                    if (d && (d.requiereLogin || d.success === false)) {
                        guardarToken('');
                        irAlLoginUnificado('vencida');
                    }
                }).catch(function () { });
            }
            return r;
        });
    };

    // --- 4) pestaña CUENTA --------------------------------------------------
    function crearPestana() {
        if (document.getElementById('jpiCuentaBtn')) return;
        var barra = document.querySelector('.tab-nav, .tabs-nav, .main-tabs, #projectTabsNav');
        var btn = document.createElement('button');
        btn.id = 'jpiCuentaBtn';
        btn.className = 'tab-button';
        btn.textContent = '👤 CUENTA';
        btn.title = 'Tu sesión de fullscreencode';
        if (barra) barra.appendChild(btn);
        else (document.querySelector('header') || document.body).appendChild(btn);
        btn.addEventListener('click', function () { abrirPanelCuenta(btn); });
    }

    function abrirPanelCuenta(ancla) {
        var previo = document.getElementById('jpiCuentaPanel');
        if (previo) { previo.remove(); return; }

        var u = usuario || {};
        var inicial = String(u.displayName || u.username || '?').trim().charAt(0).toUpperCase();
        var avatar = u.avatar
            ? '<img src="' + u.avatar + '" alt="" style="width:56px;height:56px;border-radius:50%;object-fit:cover;">'
            : '<div style="width:56px;height:56px;border-radius:50%;background:#a855f7;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800;color:#fff;">' + inicial + '</div>';

        var panel = document.createElement('div');
        panel.id = 'jpiCuentaPanel';
        panel.className = 'jpi-cuenta-panel';
        panel.innerHTML =
            '<div style="display:flex;gap:12px;align-items:center;margin-bottom:10px;">' + avatar +
            '  <div>' +
            '    <div style="font-weight:800;font-size:15px;">' + (u.displayName || u.username || '—') + '</div>' +
            '    <div style="opacity:.7;font-size:12px;">@' + (u.username || '—') + ' · ' + (u.role || 'USER') + '</div>' +
            '    <div style="opacity:.55;font-size:12px;">' + (u.email || '') + '</div>' +
            '  </div>' +
            '</div>' +
            '<div style="opacity:.6;font-size:11px;line-height:1.5;margin-bottom:10px;">' +
            '  Sesión de fullscreencode. El editor genera en el nodo de la red que elijas.' +
            '</div>' +
            '<button id="jpiCuentaSalir" style="width:100%;padding:8px;border-radius:8px;border:1px solid rgba(248,113,113,.5);background:rgba(248,113,113,.12);color:#f87171;font-weight:700;cursor:pointer;">CERRAR SESIÓN</button>';
        document.body.appendChild(panel);
        var r = (ancla || document.getElementById('jpiCuentaBtn')).getBoundingClientRect();
        panel.style.top = (r.bottom + 8) + 'px';
        panel.style.right = Math.max(12, window.innerWidth - r.right) + 'px';

        document.getElementById('jpiCuentaSalir').addEventListener('click', function () {
            guardarToken('');
            guardarUsuario(null);
            fetchOriginal(FSCAUTH + '/api/auth/logout', { method: 'POST' }).catch(function () { });
            location.reload();      // al recargar, sin token, rebota al login unificado
        });
    }

    // --- arranque: traer el perfil ------------------------------------------
    function init() {
        crearPestana();
        fetchOriginal(API + '/api/me', { headers: { Authorization: 'Bearer ' + token } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                if (!d || !d.user) return;
                guardarUsuario(d.user);
                var btn = document.getElementById('jpiCuentaBtn');
                if (btn) btn.textContent = '👤 ' + (d.user.displayName || d.user.username || 'CUENTA');
            })
            .catch(function () { });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
