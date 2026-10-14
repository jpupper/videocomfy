// ============================================================
// jpiassets - sesión FSC en la versión WEB
// ------------------------------------------------------------
// La web (fullscreencode.com/jpiassets) sólo se usa logueado con la cuenta
// de fullscreencode: el backend rechaza la API y el websocket sin sesión, y
// acá se muestra la pantalla de login + la pestaña CUENTA.
//
// En la app LOCAL (videocomfy :5634) NO se activa nada: ahí no hay login.
//
// Piezas:
//   1. envoltorio de fetch: agrega Authorization a las llamadas a la API y
//      si el server contesta 401 muestra el login (una sola vez).
//   2. pantalla de login (usuario/email + contraseña) contra /api/auth/login.
//   3. pestaña CUENTA en el header: quién está logueado + cerrar sesión.
// ============================================================
(function () {
    'use strict';

    var CLAVE = 'fsc_token_jpi';
    if (!window.JPI || window.JPI.esServidor) return;   // local: sin login

    var API = window.JPI.API_BASE;
    var token = '';
    try { token = localStorage.getItem(CLAVE) || ''; } catch (e) { }
    var usuario = null;
    var gateMostrado = false;

    function guardarToken(t) {
        token = t || '';
        try { t ? localStorage.setItem(CLAVE, t) : localStorage.removeItem(CLAVE); } catch (e) { }
    }

    function esDeLaApi(url) {
        try { return String(url).indexOf(window.JPI.ORIGIN) === 0; } catch (e) { return false; }
    }

    // --- 1) fetch con token -------------------------------------------------
    var fetchOriginal = window.fetch.bind(window);
    window.fetch = function (url, opciones) {
        opciones = opciones || {};
        if (esDeLaApi(url)) {
            var headers = new Headers(opciones.headers || {});
            if (token && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);
            opciones.headers = headers;
        }
        return fetchOriginal(url, opciones).then(function (r) {
            if (r.status === 401 && esDeLaApi(url)) {
                var copia = r.clone();
                copia.json().then(function (d) {
                    if (d && d.requiereLogin) { guardarToken(''); mostrarLogin('Tu sesión venció. Entrá de nuevo.'); }
                }).catch(function () { });
            }
            return r;
        });
    };

    // --- 2) pantalla de login ----------------------------------------------
    function mostrarLogin(mensaje) {
        if (gateMostrado) return;
        gateMostrado = true;

        var overlay = document.createElement('div');
        overlay.id = 'jpiLoginGate';
        overlay.innerHTML =
            '<div class="jpi-login-card">' +
            '  <div class="jpi-login-logo">JPiAssets</div>' +
            '  <div class="jpi-login-sub">VideoComfy Studio · fullscreencode.com</div>' +
            '  <div class="jpi-login-msg" id="jpiLoginMsg">' + (mensaje || 'Entrá con tu cuenta de fullscreencode para usar el editor.') + '</div>' +
            '  <label>Usuario o email</label>' +
            '  <input id="jpiLoginUser" type="text" autocomplete="username" placeholder="usuario o email">' +
            '  <label>Contraseña</label>' +
            '  <input id="jpiLoginPass" type="password" autocomplete="current-password" placeholder="contraseña">' +
            '  <button id="jpiLoginBtn">ENTRAR</button>' +
            '  <a class="jpi-login-link" href="https://fullscreencode.com/artedigitaldata/login.html">¿Olvidaste la contraseña?</a>' +
            '</div>';
        document.body.appendChild(overlay);

        var user = document.getElementById('jpiLoginUser');
        var pass = document.getElementById('jpiLoginPass');
        var btn = document.getElementById('jpiLoginBtn');
        var msg = document.getElementById('jpiLoginMsg');
        user.focus();

        function entrar() {
            var u = (user.value || '').trim();
            var p = pass.value || '';
            if (!u || !p) { msg.textContent = 'Completá usuario y contraseña.'; return; }
            btn.disabled = true;
            btn.textContent = 'ENTRANDO...';
            fetchOriginal(API + '/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: u, password: p })
            }).then(function (r) { return r.json().catch(function () { return {}; }); })
                .then(function (d) {
                    if (d && d.token) {
                        guardarToken(d.token);
                        msg.textContent = 'Listo, entrando...';
                        location.reload();          // recarga con el token puesto
                    } else {
                        msg.textContent = (d && d.message) || 'No se pudo entrar.';
                        btn.disabled = false; btn.textContent = 'ENTRAR';
                    }
                })
                .catch(function () {
                    msg.textContent = 'No se pudo contactar el servidor.';
                    btn.disabled = false; btn.textContent = 'ENTRAR';
                });
        }

        btn.addEventListener('click', entrar);
        pass.addEventListener('keydown', function (e) { if (e.key === 'Enter') entrar(); });
        user.addEventListener('keydown', function (e) { if (e.key === 'Enter') pass.focus(); });
    }

    // --- 3) pestaña CUENTA --------------------------------------------------
    function crearPestana() {
        var barra = document.querySelector('.tab-nav, .tabs-nav, .main-tabs, #tabStoryboardBtn');
        var btn = document.createElement('button');
        btn.id = 'jpiCuentaBtn';
        btn.className = 'tab-button tab-button-std';
        btn.textContent = '👤 CUENTA';
        btn.title = 'Tu sesión de fullscreencode';

        if (barra && barra.parentNode) barra.parentNode.insertBefore(btn, barra.nextSibling);
        else (document.querySelector('header') || document.body).appendChild(btn);

        btn.addEventListener('click', function () { abrirPanelCuenta(btn); });
    }

    function abrirPanelCuenta(ancla) {
        var previo = document.getElementById('jpiCuentaPanel');
        if (previo) { previo.remove(); return; }

        var u = usuario || {};
        var inicial = (u.displayName || u.username || '?').trim().charAt(0).toUpperCase();
        var avatar = u.avatar
            ? '<img src="' + u.avatar + '" alt="" style="width:56px;height:56px;border-radius:50%;object-fit:cover;">'
            : '<div style="width:56px;height:56px;border-radius:50%;background:#a855f7;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800;color:#fff;">' + inicial + '</div>';

        var panel = document.createElement('div');
        panel.id = 'jpiCuentaPanel';
        panel.innerHTML =
            '<div style="display:flex;gap:12px;align-items:center;margin-bottom:10px;">' + avatar +
            '  <div>' +
            '    <div style="font-weight:800;font-size:15px;">' + (u.displayName || u.username || '—') + '</div>' +
            '    <div style="opacity:.7;font-size:12px;">@' + (u.username || '—') + ' · ' + (u.role || 'USER') + '</div>' +
            '    <div style="opacity:.55;font-size:12px;">' + (u.email || '') + '</div>' +
            '  </div>' +
            '</div>' +
            '<div style="opacity:.6;font-size:11px;line-height:1.5;margin-bottom:10px;">' +
            '  Estás logueado con fullscreencode. El editor genera en la PC de Julián a través del VPS.' +
            '</div>' +
            '<button id="jpiCuentaSalir" style="width:100%;padding:8px;border-radius:8px;border:1px solid rgba(248,113,113,.5);background:rgba(248,113,113,.12);color:#f87171;font-weight:700;cursor:pointer;">CERRAR SESIÓN</button>';

        panel.className = 'jpi-cuenta-panel';
        document.body.appendChild(panel);
        var r = (ancla || document.getElementById('jpiCuentaBtn')).getBoundingClientRect();
        panel.style.top = (r.bottom + 8) + 'px';
        panel.style.right = Math.max(12, window.innerWidth - r.right) + 'px';

        document.getElementById('jpiCuentaSalir').addEventListener('click', function () {
            fetchOriginal(API + '/api/auth/logout', { method: 'POST' }).catch(function () { });
            guardarToken('');
            location.reload();
        });
    }

    // --- arranque: ¿hay sesión? --------------------------------------------
    function init() {
        crearPestana();
        fetchOriginal(API + '/api/me', { headers: token ? { Authorization: 'Bearer ' + token } : {} })
            .then(function (r) {
                if (r.status === 401) { mostrarLogin('Entrá con tu cuenta de fullscreencode para usar el editor.'); return null; }
                return r.json();
            })
            .then(function (d) {
                if (!d || !d.user) return;
                usuario = d.user;
                var btn = document.getElementById('jpiCuentaBtn');
                if (btn) btn.textContent = '👤 ' + (usuario.displayName || usuario.username || 'CUENTA');
            })
            .catch(function () { });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
