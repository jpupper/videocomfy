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

    // ¿Hay sesión? Es LA pregunta que gobierna todo lo visible: sin sesión la
    // app dice LOGIN (nunca "mi cuenta") y el botón lleva a JPCONNECT.
    // Se mira el localStorage en el momento (no la copia en memoria): si otra
    // pestaña entró o salió, el botón tiene que reflejarlo.
    function haySesion() {
        try {
            var t = localStorage.getItem(CLAVE) || localStorage.getItem('token') || '';
            return tokenSano(t);
        } catch (e) { return false; }
    }
    function usuarioGuardado() {
        try { return JSON.parse(localStorage.getItem(CLAVE_USER) || 'null'); } catch (e) { return null; }
    }

    // true sólo en el arranque que vuelve del login (lo usa init para abrir el
    // perfil sin que el usuario tenga que buscarlo).
    var volviendoDelLogin = false;
    var abrirPerfilPendiente = false;
    function guardarToken(t) {
        token = t || '';
        try { t ? localStorage.setItem(CLAVE, t) : localStorage.removeItem(CLAVE); } catch (e) { }
    // El resto del ecosistema (medición, perfil, otras apps) busca la sesión en
    // 'token': se guarda igual para que el login sirva en todo fullscreencode.
    try { t ? localStorage.setItem('token', t) : localStorage.removeItem('token'); } catch (e) { }
    }
    function guardarUsuario(u) {
        usuario = u || null;
        try { u ? localStorage.setItem(CLAVE_USER, JSON.stringify(u)) : localStorage.removeItem(CLAVE_USER); } catch (e) { }
    try {
        if (u) {
            localStorage.setItem('username', u.username || '');
            localStorage.setItem('userId', u.id || u._id || '');
            localStorage.setItem('role', u.role || 'USER');
        } else { ['username', 'userId', 'role'].forEach(function (k) { localStorage.removeItem(k); }); }
    } catch (e) { }
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
        volviendoDelLogin = true;
        // El flag sobrevive al replace() que limpia la URL (si no, se pierde con
        // el documento y el perfil no se abre solo al volver del login).
        try { sessionStorage.setItem('ck_volviendo_login', '1'); } catch (e) { }
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

    // --- 2) sin sesión NO se rebota solo -------------------------------------
    // La app se abre igual y el botón de arriba del menú dice LOGIN. Al tocarlo
    // se va al login unificado de JPCONNECT y se vuelve a esta misma pantalla
    // con el perfil ya cargado. Es igual en la versión local y en la web: antes
    // la web rebotaba sola al login y nunca se veía el estado sin sesión.

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
            // Sin sesión, el botón NO abre nada: te lleva al login de JPCONNECT.
            if (!haySesion()) { yendo = false; irAlLoginUnificado(); return; }
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
        var u = usuario || usuarioGuardado() || {};
        var logueado = haySesion();

        if (!logueado) {
            panel.innerHTML = [
                '<div class="cuenta-caja">',
                '  <h2>👤 PERFIL</h2>',
                '  <p class="cuenta-sub">' + (esLocal
                    ? 'Todavía no iniciaste sesión en esta computadora. Entrá con tu cuenta de fullscreencode: tu perfil se ve acá y tu nodo publica tu nombre y tu avatar en la red.'
                    : 'Entrá con tu cuenta de fullscreencode para usar COMFYLATAM.') + '</p>',
                '  <button class="red-btn" id="cuentaEntrar">LOG IN CON JPCONNECT</button>',
                '  <p class="cuenta-nota">Se abre JPCONNECT (el centro de conexiones del ecosistema) y volvés a esta misma pantalla ya logueado.</p>',
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

        document.getElementById('cuentaRefrescar').addEventListener('click', function () { traerPerfil(true); });
        var bPerfil = document.getElementById('cuentaPerfil');
        if (bPerfil) bPerfil.addEventListener('click', function () { window.open(PERFIL_FSC, '_blank'); });
        document.getElementById('cuentaSalir').addEventListener('click', function () {
            guardarToken('');
            guardarUsuario(null);
            fetch(FSCAUTH + '/api/auth/logout', { method: 'POST' }).catch(function () { });
            if (esLocal) pintar();
            else location.reload();
        });
    }

    // --- el botón del menú: TU FOTO + TU NOMBRE, o LOGIN si no hay sesión ----
    // Sin sesión dice LOGIN (nunca "mi cuenta") y su click va a JPCONNECT.
    function pintarBoton(u) {
        var btn = document.getElementById('jpiCuentaBtn');
        if (!btn) return;
        btn.classList.add('ck-perfil-btn');

        if (!haySesion()) {
            btn.dataset.estado = 'sin-sesion';
            btn.title = 'Entrá con tu cuenta de fullscreencode (te lleva a JPCONNECT)';
            btn.innerHTML = '<span class="ck-perfil-foto ck-perfil-inicial ck-login-icono">👤</span>' +
                '<span class="ck-perfil-nombre">LOGIN</span>';
            return;
        }

        btn.dataset.estado = 'con-sesion';
        var uu = u || usuario || usuarioGuardado() || {};
        var nom = uu.displayName || uu.username || '…';
        btn.title = 'Tu perfil de ComfyLatam';
        btn.innerHTML = '';
        if (uu.avatar) {
            var img = document.createElement('img');
            img.className = 'ck-perfil-foto';
            img.src = uu.avatar;
            img.alt = '';
            img.onerror = function () { img.replaceWith(inicialDe(nom)); };
            btn.appendChild(img);
        } else {
            btn.appendChild(inicialDe(nom));
        }
        var sp = document.createElement('span');
        sp.className = 'ck-perfil-nombre';
        sp.textContent = nom;
        btn.appendChild(sp);
    }

    function inicialDe(nom) {
        var s = document.createElement('span');
        s.className = 'ck-perfil-foto ck-perfil-inicial';
        s.textContent = String(nom || '?').trim().charAt(0).toUpperCase();
        return s;
    }

    // --- 6) traer el perfil del servidor ------------------------------------
    function traerPerfil(manual) {
        if (!haySesion()) { pintar(); return; }
        var t = token;
        try { t = localStorage.getItem(CLAVE) || localStorage.getItem('token') || t; } catch (e) { }
        fetch(API + '/api/me', { headers: { Authorization: 'Bearer ' + t }, cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                var per = d && (d.user || d.usuario || null);
                if (per) {
                    usuario = per;
                    guardarUsuario(per);
                    publicarPerfil();
                    pintarBoton(usuario);
                    pintar();
                    // si veníamos del login, dejo el perfil abierto con los datos ya cargados
                    if (abrirPerfilPendiente) { abrirPerfilPendiente = false; abrir(); }
                } else if (manual) {
                    pintar();
                }
            })
            .catch(function () { if (manual) pintar(); });
    }

    function init() {
        crearPestana();
        pintarBoton(usuario || usuarioGuardado());   // pinta ya, con la sesión guardada (sin parpadeo)
        pintar();
        // Si este arranque es el que vuelve de JPCONNECT, abro el perfil:
        // el usuario entra y ve su ficha sin buscarla.
        var volvio = false;
        // OJO: si el token lo acabo de guardar YO en este mismo documento
        // (volviendoDelLogin), esta página ya va a ser reemplazada por la limpia:
        // no hay que consumir la marca acá, la consume el documento siguiente.
        if (!volviendoDelLogin) {
            try {
                if (sessionStorage.getItem('ck_volviendo_login') === '1') {
                    volvio = true;
                    sessionStorage.removeItem('ck_volviendo_login');
                }
            } catch (e) { }
        }
        if (volvio && haySesion()) {
            abrirPerfilPendiente = true;
            // El editor sigue armándose después del DOMContentLoaded (y varios
            // caminos hacen .click() en STAGE): abro el perfil y lo sostengo unos
            // segundos, pero sólo si otro no lo cambió y sólo hasta que el usuario
            // toque una pestaña (ahí manda él).
            var restantes = 12;
            var seg = setInterval(function () {
                if (--restantes <= 0) { clearInterval(seg); return; }
                var p = document.getElementById('tabCuenta');
                if (p && !p.classList.contains('active')) abrir();
            }, 600);
            document.querySelectorAll('.tab-button').forEach(function (b) {
                b.addEventListener('click', function () { restantes = 0; clearInterval(seg); }, true);
            });
        }
        setTimeout(function () { pintarBoton(usuario || usuarioGuardado()); pintar(); }, 1200);
        traerPerfil(false);
    }

    // API pública del módulo: la usa perfil-ck.js para no pintar el botón por
    // su cuenta (antes los dos módulos lo pisaban y aparecía "Mi cuenta").
    window.comfyAuth = {
        haySesion: haySesion,
        pintarBoton: pintarBoton,
        pintarPanel: pintar,
        abrir: abrir,
        entrar: function () { yendo = false; irAlLoginUnificado(); },
        salir: function () {
            guardarToken(''); guardarUsuario(null);
            try { fetch(FSCAUTH + '/api/auth/logout', { method: 'POST' }).catch(function () { }); } catch (e) { }
            pintarBoton(); pintar();
        },
        usuario: function () { return usuario || usuarioGuardado(); },
        // diagnóstico rápido (consola): qué estado ve el módulo de sesión
        debug: function () {
            return {
                volviendoDelLogin: volviendoDelLogin,
                abrirPerfilPendiente: abrirPerfilPendiente,
                haySesion: haySesion(),
                usuario: usuario || usuarioGuardado(),
                cuentaActiva: !!(document.getElementById('tabCuenta') || {}).classList &&
                    document.getElementById('tabCuenta').classList.contains('active'),
                boton: (document.getElementById('jpiCuentaBtn') || {}).textContent
            };
        }
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
