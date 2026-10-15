// ============================================================
// COMFYLATAM - sesión FSC + pestaña PERFIL
// ------------------------------------------------------------
// WEB (fullscreencode.com/comfylatam): sin sesión NO se puede usar, así que se
// va directo al login unificado y se vuelve a esta misma página:
//   https://fullscreencode.com/fscauth/login.html?redirect=<app>&origin=comfylatam
//
// LOCAL (videocomfy :5634): la sesión es OPCIONAL. Se puede iniciar desde la
// pestaña PERFIL (mismo login unificado) y sirve para que el nodo publique tu
// identidad (nombre + avatar) en la red.
//
// La cuenta se muestra como una PESTAÑA más del sistema (no como un modal).
// ============================================================
(function () {
    'use strict';

    var CLAVE = 'fsc_token_jpi';
    var CLAVE_USER = 'fsc_user_jpi';
    var J = window.JPI || {};
    var esLocal = !!J.esServidor;
    var API = J.API_BASE || '';
    var FSCAUTH = (J.FSCAUTH_URL || 'https://fullscreencode.com/fscauth').replace(/\/+$/, '');
    var PERFIL_FSC = FSCAUTH + '/profile.html';

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
        publicarPerfil();
    }

    function urlVuelta() {
        try { return new URL(location.origin + location.pathname).toString(); }
        catch (e) { return location.href.split('?')[0]; }
    }

    function irAlLoginUnificado(aviso) {
        if (yendo) return;
        yendo = true;
        var dest = FSCAUTH + '/login.html?redirect=' + encodeURIComponent(urlVuelta()) + '&origin=comfylatam';
        if (aviso) dest += '&aviso=' + encodeURIComponent(aviso);
        location.href = dest;
    }

    // --- 1) ¿volvió del login con ?token=...? --------------------------------
    (function leerRetorno() {
        var u;
        try { u = new URL(location.href); } catch (e) { return; }
        var t = u.searchParams.get('token');
        if (!t) return;
        guardarToken(t);
        var nom = u.searchParams.get('username') || u.searchParams.get('user');
        var id = u.searchParams.get('userId');
        if (nom || id) guardarUsuario({ username: nom || null, id: id || null });
        ['token', 'username', 'userId', 'ssoset', 'aviso'].forEach(function (k) { u.searchParams.delete(k); });
        try { location.replace(u.toString()); } catch (e) { }
    })();

    try {
        token = localStorage.getItem(CLAVE) || '';
        usuario = JSON.parse(localStorage.getItem(CLAVE_USER) || 'null');
    } catch (e) { }

    // --- 2) WEB: sin sesión no se entra --------------------------------------
    if (!esLocal && !tokenSano()) { irAlLoginUnificado(); return; }

    // --- 3) fetch de la API con el token (+ rebote al login si venció) -------
    var fetchOriginal = window.fetch.bind(window);
    function esDeLaApi(url) {
        try { return String(url).indexOf(J.ORIGIN) === 0 || String(url).indexOf(FSCAUTH) === 0; } catch (e) { return false; }
    }
    window.fetch = function (url, opciones) {
        opciones = opciones || {};
        if (esDeLaApi(url)) {
            var h = new Headers(opciones.headers || {});
            if (token && !h.has('Authorization')) h.set('Authorization', 'Bearer ' + token);
            opciones.headers = h;
        }
        return fetchOriginal(url, opciones).then(function (r) {
            if (r.status === 401 && !esLocal && esDeLaApi(url)) {
                r.clone().json().then(function (d) {
                    if (d && (d.requiereLogin || d.success === false)) { guardarToken(''); irAlLoginUnificado('vencida'); }
                }).catch(function () { });
            }
            return r;
        });
    };

    // --- 4) el nodo publica tu identidad (nombre + avatar) -------------------
    function publicarPerfil() {
        if (!usuario) return;
        fetch(API + '/api/red/perfil', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' },
                token ? { Authorization: 'Bearer ' + token } : {}),
            body: JSON.stringify({
                username: usuario.username || null,
                displayName: usuario.displayName || usuario.username || null,
                email: usuario.email || null,
                avatar: usuario.avatar || null,
                id: usuario.id || null
            })
        }).catch(function () { });
    }

    // --- 5) la pestaña PERFIL (como las otras, no un modal) ------------------
    function crearPestana() {
        var btn = document.getElementById('jpiCuentaBtn');
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'jpiCuentaBtn';
            btn.className = 'tab-button tab-button-std cuenta-tab-btn ck-perfil-btn';
            btn.setAttribute('data-target', 'tabCuenta');
            btn.textContent = '👤 Perfil';
            btn.title = 'Tu perfil de fullscreencode';
            var arriba = document.querySelector('.tabs-container');
            if (arriba) {
                arriba.appendChild(btn);
            } else {
                var barra = document.getElementById('projectTabsNav');
                var red = document.getElementById('tabRedBtn');
                if (barra) {
                    if (red && red.parentNode === barra) barra.insertBefore(btn, red.nextSibling);
                    else barra.appendChild(btn);
                } else document.body.appendChild(btn);
            }
        }

        var panel = document.getElementById('tabCuenta');
        if (!panel) {
            var cont = document.querySelector('.workspace-content') || document.querySelector('main') || document.body;
            panel = document.createElement('div');
            panel.className = 'tab-content cuenta-panel';
            panel.id = 'tabCuenta';
            cont.appendChild(panel);
        }

        btn.addEventListener('click', function (e) {
            e.preventDefault();
            abrir();
        });
        // el editor capturó sus .tab-content al cargar: al tocar otra pestaña,
        // escondo la mía a mano
        document.querySelectorAll('.workspace-header .tab-button, #projectTabsNav .tab-button').forEach(function (b) {
            if (b.id === 'jpiCuentaBtn' || b.id === 'tabRedBtn') return;
            b.addEventListener('click', function () {
                var p = document.getElementById('tabCuenta');
                if (p) p.classList.remove('active');
            });
        });
    }

    function abrir() {
        var panel = document.getElementById('tabCuenta');
        if (!panel) return;
        document.querySelectorAll('.tab-button').forEach(function (b) {
            b.classList.toggle('active', b.id === 'jpiCuentaBtn');
        });
        document.querySelectorAll('.tab-content').forEach(function (c) {
            c.classList.toggle('active', c === panel);
        });
        document.body.classList.remove('tab-editor-active');
        if (typeof window.cerrarCajonesMobile === 'function') { try { window.cerrarCajonesMobile(); } catch (e) { } }
        pintar();
    }
    window.comfyCuenta = { abrir: abrir, usuario: function () { return usuario; } };

    function pintar() {
        var panel = document.getElementById('tabCuenta');
        if (!panel) return;
        var u = usuario || {};
        var logueado = tokenSano() && !!u.username;

        if (!logueado) {
            panel.innerHTML = [
                '<div class="cuenta-caja">',
                '  <h2>👤 PERFIL</h2>',
                '  <p class="cuenta-sub">' + (esLocal
                    ? 'En local la sesión es <b>opcional</b>. Si entrás con tu cuenta de fullscreencode, tu nodo publica tu nombre y tu avatar en la red.'
                    : 'Entrá con tu cuenta de fullscreencode para usar COMFYLATAM.') + '</p>',
                '  <button class="red-btn" id="cuentaEntrar">INICIAR SESIÓN CON FULLSCREENCODE</button>',
                '  <p class="cuenta-nota">Se abre el login unificado del ecosistema y volvés a esta misma pantalla.</p>',
                '</div>'
            ].join('\n');
            var b = document.getElementById('cuentaEntrar');
            if (b) b.addEventListener('click', function () { yendo = false; irAlLoginUnificado(); });
            return;
        }

        var inicial = String(u.displayName || u.username || '?').trim().charAt(0).toUpperCase();
        // el avatar puede venir como ruta relativa (/uploads/...) -> la completamos
        var foto = u.avatar || '';
        if (foto && !/^https?:\/\//i.test(foto)) {
            foto = foto.charAt(0) === '/' ? (FSCAUTH + foto) : (FSCAUTH + '/' + foto);
        }
        var avatar = foto
            ? '<img src="' + foto + '" alt="" onerror="this.replaceWith(Object.assign(document.createElement(\'div\'),{className:\'cuenta-avatar-inicial\',textContent:\'' + inicial + '\'}))">'
            : '<div class="cuenta-avatar-inicial">' + inicial + '</div>';

        panel.innerHTML = [
            '<div class="cuenta-caja">',
            '  <h2>👤 PERFIL</h2>',
            '  <div class="cuenta-ficha">',
            '    <div class="cuenta-avatar">' + avatar + '</div>',
            '    <div class="cuenta-datos">',
            '      <div class="cuenta-nombre">' + (u.displayName || u.username) + '</div>',
            '      <div class="cuenta-linea">@' + (u.username || '—') + ' · ' + (u.role || 'USER') + '</div>',
            '      <div class="cuenta-linea">' + (u.email || '') + '</div>',
            '      <div class="cuenta-linea estado">' + (esLocal
                ? 'Sesión local: tu nodo publica tu nombre y avatar en la red.'
                : 'Sesión de fullscreencode activa.') + '</div>',
            '    </div>',
            '  </div>',
            '  <div class="cuenta-acciones">',
            '    <button class="red-btn secundario" id="cuentaRefrescar">Actualizar datos</button>',
            '    <button class="red-btn secundario" id="cuentaSalir">CERRAR SESIÓN</button>',
            '  </div>',
            '</div>'
        ].join('\n');

        document.getElementById('cuentaPerfil').addEventListener('click', function () {
            window.open(PERFIL_FSC, '_blank');
        });
        document.getElementById('cuentaRefrescar').addEventListener('click', function () { traerPerfil(true); });
        document.getElementById('cuentaSalir').addEventListener('click', function () {
            guardarToken('');
            guardarUsuario(null);
            fetch(FSCAUTH + '/api/auth/logout', { method: 'POST' }).catch(function () { });
            if (esLocal) pintar();
            else location.reload();
        });
    }

    // --- 6) traer el perfil del servidor ------------------------------------
    function traerPerfil(manual) {
        if (!tokenSano()) return;
        fetch(API + '/api/me', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                if (d && d.user) {
                    usuario = d.user;
                    try { localStorage.setItem(CLAVE_USER, JSON.stringify(usuario)); } catch (e) { }
                    publicarPerfil();
                    var btn = document.getElementById('jpiCuentaBtn');
                    if (btn) btn.textContent = '👤 ' + (usuario.displayName || usuario.username || 'Perfil');
                    pintar();
                } else if (manual) {
                    pintar();
                }
            })
            .catch(function () { if (manual) pintar(); });
    }

    function init() {
        crearPestana();
        pintar();
        traerPerfil(false);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
