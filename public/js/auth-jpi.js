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

// Mezcla de perfiles: COMPLETA, nunca pisa. Un perfil que llega con
// displayName/avatar en null NO puede borrar el que ya teníamos (ese era el
// flash: aparecía la foto y el perfil vacío la tapaba con el placeholder).
function ckMezclarPerfil() {
    var out = {};
    for (var i = 0; i < arguments.length; i++) {
        var f = arguments[i];
        if (!f || typeof f !== 'object') continue;
        Object.keys(f).forEach(function (k) {
            var v = f[k];
            // Nunca se pisa un dato bueno con uno VACÍO (null/undefined/''),
            // pero el ÚLTIMO con valor sí gana: así el perfil fresco reemplaza
            // al cacheado viejo (antes quedaba pegajoso y la foto rota no se
            // arreglaba nunca).
            if (v === null || v === undefined || v === '') return;
            out[k] = v;
        });
    }
    return out;
}



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

    function normalizarFoto(url) {
        if (!url || typeof url !== 'string') return '';
        url = url.trim();
        if (!url) return '';
        if (/^https?:\/\//i.test(url)) return url;
        if (url.startsWith('/')) return 'https://fullscreencode.com' + url;
        return 'https://fullscreencode.com/' + url;
    }

    // ¿Hay sesión? Es LA pregunta que gobierna todo lo visible: sin sesión la
    // app dice LOGIN (nunca "mi cuenta") y el botón lleva a JPCONNECT.
    // Se mira el localStorage en el momento (no la copia en memoria): si otra
    // pestaña entró o salió, el botón tiene que reflejarlo.
    // La sesión puede vivir en la clave de la app ('fsc_token_jpi'), en la del
    // login unificado del ecosistema ('fsc_token') o en 'token'. Se miran TODAS:
    // antes se miraba una sola y en la web la app no veía la sesión.
    var CLAVES_TOKENS = ['fsc_token_jpi', 'fsc_token', 'token'];
    var CLAVES_USUARIO = ['fsc_user_jpi', 'fsc_user', 'usuario'];
    function leerToken() {
        try {
            for (var i = 0; i < CLAVES_TOKENS.length; i++) {
                var t = localStorage.getItem(CLAVES_TOKENS[i]);
                if (tokenSano(t)) return t;
            }
        } catch (e) { }
        return '';
    }
    function haySesion() { return !!leerToken(); }
    function usuarioGuardado() {
        try {
            for (var i = 0; i < CLAVES_USUARIO.length; i++) {
                var u = localStorage.getItem(CLAVES_USUARIO[i]);
                if (u) { var d = JSON.parse(u); if (d) return d; }
            }
        } catch (e) { }
        return null;
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

    token = leerToken();
    usuario = usuarioGuardado();

    // --- 2) sin sesión NO se rebota solo -------------------------------------
    // La app se abre igual y el botón de arriba del menú dice LOGIN. Al tocarlo
    // se va al login unificado de JPCONNECT y se vuelve a esta misma pantalla
    // con el perfil ya cargado. Es igual en la versión local y en la web: antes
    // la web rebotaba sola al login y nunca se veía el estado sin sesión.

    // --- 3) fetch de la API con el token (+ rebote al login si venció) -------
    var fetchOriginal = window.fetch.bind(window);
    function esDeLaApi(url) {
        try {
            var s = String(url || '');
            if (!s) return false;
            if (s.indexOf('/api/') !== -1 || s.indexOf('/comfylatam/api/') !== -1 || s.indexOf('/jpiassets/api/') !== -1) return true;
            if (J.ORIGIN && s.indexOf(J.ORIGIN) === 0) return true;
            if (FSCAUTH && s.indexOf(FSCAUTH) === 0) return true;
            if (s.indexOf('vps-4455523-x.dattaweb.com') !== -1 || s.indexOf('fullscreencode.com') !== -1) return true;
            return false;
        } catch (e) { return false; }
    }
    window.fetch = function (url, opciones) {
        opciones = opciones || {};
        if (esDeLaApi(url)) {
            var vivo = leerToken() || token;      // siempre el de la sesión real
            token = vivo;
            var h = new Headers(opciones.headers || {});
            if (vivo && !h.has('Authorization')) h.set('Authorization', 'Bearer ' + vivo);
            opciones.headers = h;
        }
        return fetchOriginal(url, opciones).then(function (r) {
            // 401 = "tu sesión venció" SÓLO si era un endpoint de autenticación (/api/me, /auth/profile)
            // y SÓLO si había sesión. Jamás borrar la sesión ni rebotar por un 401 en videos o ejemplos.
            var sUrl = String(url || '');
            var esAuthEndpoint = sUrl.indexOf('/api/me') !== -1 || sUrl.indexOf('/auth/profile') !== -1 || sUrl.indexOf('/auth/verify') !== -1;
            if (r.status === 401 && !esLocal && esAuthEndpoint && haySesion()) {
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
        // SÓLO en la app local. La identidad de una PC la fija su dueño: si se
        // publicara desde la web, un usuario web le cambiaría el perfil a otra
        // persona (y el túnel del nodo lo bloquea con razón, ensuciando la
        // consola con "POST /api/red/perfil BLOQUEADO").
        if (!esLocal) return;
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
                '  <p class="ck-aviso-login">Entrá con tu cuenta de fullscreencode desde la pestaña <b>LOGIN</b> de arriba.</p>',
                '  <p class="cuenta-nota">Se abre JPCONNECT (el centro de conexiones del ecosistema) y volvés a esta misma pantalla ya logueado.</p>',
                '</div>'
            ].join('\n');
            // (el boton de login del panel se sacó: la app tiene UN solo login, la pestaña)
            return;
        }

        // SI ESTÁ LOGUEADO: delegar a PERFIL_CK para tener un solo diseño rico y unificado
        if (window.PERFIL_CK && typeof window.PERFIL_CK.pintar === 'function') {
            window.PERFIL_CK.pintar({ usuario: u });
            return;
        }

        var inicial = String(u.displayName || u.username || '?').trim().charAt(0).toUpperCase();
        var foto = normalizarFoto(u.avatar || '');
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

        // SIN SESIÓN: flecha de login. Nunca puntitos ni un icono suelto.
        if (!haySesion()) {
            btn.dataset.estado = 'sin-sesion';
            btn.title = 'Entrá con tu cuenta de fullscreencode (te lleva a JPCONNECT)';
            btn.innerHTML = '<span class="ck-perfil-nombre">LOGIN</span>' +
                '<span class="ck-perfil-flecha">\u2192</span>';
            return;
        }

        // CON SESIÓN: la FOTO y tu NOMBRE (displayName). Nunca "@usuario", nunca
        // el mail y nunca el texto "mi cuenta": eso se veía cuando el perfil
        // local llegaba vacío (displayName/avatar en null) y pisaba al del login.
        btn.dataset.estado = 'con-sesion';
        var uu = u || usuario || usuarioGuardado() || {};
        var nom = String(uu.displayName || '').trim() || String(uu.username || '').trim();
        btn.title = (nom ? nom + ' \u2014 ' : '') + 'tu perfil de ComfyLatam';
        btn.innerHTML = '';
        var fotoUrl = normalizarFoto(uu.avatar);
        if (fotoUrl) {
            var img = document.createElement('img');
            img.className = 'ck-perfil-foto';
            img.src = fotoUrl;
            img.alt = '';
            img.onerror = function () { img.replaceWith(inicialDe(nom)); };
            btn.appendChild(img);
        } else {
            btn.appendChild(inicialDe(nom));
        }
        if (nom) {
            var sp = document.createElement('span');
            sp.className = 'ck-perfil-nombre';
            sp.textContent = nom;
            btn.appendChild(sp);
        }
    }

    function inicialDe(nom) {
        var s = document.createElement('span');
        s.className = 'ck-perfil-foto ck-perfil-inicial';
        s.textContent = String(nom || '?').trim().charAt(0).toUpperCase();
        return s;
    }

    // --- 6) traer el perfil del servidor ------------------------------------
    // El perfil de la app puede volver SIN displayName ni foto (el nodo no
    // conoce al usuario todavía). El del ECOSISTEMA sí los tiene, así que se
    // COMPLETA lo que falte: lo bueno nunca se pisa con un null.
    var PERFIL_ECO = 'https://vps-4455523-x.dattaweb.com/jpconnect/api/auth/profile';
    function completarConEcosistema(u) {
        u = u || {};
        var t = '';
        try { t = localStorage.getItem('token') || localStorage.getItem(CLAVE) || token || ''; } catch (e) { t = t || token || ''; }
        if (!t) return Promise.resolve(u);
        return fetch(PERFIL_ECO, { headers: { Authorization: 'Bearer ' + t }, cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                var p = d && (d.user || d.usuario || d.data || null);
                if (!p) return u;
                var out = {};
                ['username', 'displayName', 'avatar', 'email', 'role', 'id', 'bio'].forEach(function (k) { out[k] = u[k]; });
                ['username', 'displayName', 'avatar', 'email', 'role', 'id', 'bio'].forEach(function (k) {
                    if (!out[k] && p[k]) out[k] = p[k];   // completa sólo lo que falta
                });
                return out;
            })
            .catch(function () { return u; });
    }

    function traerPerfil(manual) {
        if (!haySesion()) { pintar(); return; }
        var t = token;
        try { t = localStorage.getItem(CLAVE) || localStorage.getItem('token') || t; } catch (e) { }
        fetch(API + '/api/me', { headers: { Authorization: 'Bearer ' + t }, cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                var per = d && (d.user || d.usuario || null);
                return completarConEcosistema(per || usuarioGuardado() || {});
            })
            .then(function (per) {
                if (per && (per.username || per.displayName || per.avatar || per.email)) {
                    usuario = ckMezclarPerfil(usuario, per);   // completa, no pisa (si no, la foto desaparece)
                    guardarUsuario(per);
                    publicarPerfil();
                    pintarBoton(usuario);
                    if (window.PERFIL_CK && window.PERFIL_CK.pintar) {
                        window.PERFIL_CK.pintar({ usuario: per });
                    } else {
                        pintar();
                    }
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
        // Con sesión, traer el perfil: es lo que completa el NOMBRE real y la FOTO
        // (el login sólo devuelve usuario+id, la foto vive en el perfil del ecosistema).
        // Se hace ACÁ, directo, sin depender de la respuesta de /api/me (el nodo
        // puede no conocer al usuario todavía y devolver vacío).
        if (haySesion()) {
            completarConEcosistema(usuario || usuarioGuardado() || {}).then(function (per) {
                if (per && (per.displayName || per.username || per.avatar)) {
                    usuario = ckMezclarPerfil(usuario, per);   // completa, no pisa (si no, la foto desaparece)
                    guardarUsuario(per);
                    pintarBoton(per);
                    if (window.PERFIL_CK && window.PERFIL_CK.pintar) {
                        window.PERFIL_CK.pintar({ usuario: per });
                    }
                }
            });
            traerPerfil(false);
        }
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
            if (!esLocal) location.reload();
        },
        token: function () { return token || leerToken(); },
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
