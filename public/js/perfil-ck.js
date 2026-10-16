// ============================================================
// PERFIL COMFYLATAM (reemplaza la ventana vieja del perfil)
// ------------------------------------------------------------
// · El botón del menú pasa a ser TU FOTO + TU NOMBRE (nada de "👤 Perfil").
// · Al hacer clic abre el perfil DE COMFYLATAM (no el de fullscreencode):
//     - foto, nombre y descripción que vienen de fscauth
//     - tus datos de la cuenta (email, rol, desde cuándo)
//     - TUS ASSETS: todo lo que creaste (imágenes y videos, servidos por R2)
//     - tus fierros con el tiempo que aportaron
// · Saca los botones repetidos y el cartel gigante "VER MI PERFIL EN FULLSCREENCODE".
// ============================================================
(function () {
    'use strict';

    var J = window.JPI || {};
    // La URL del hub se resuelve EN EL MOMENTO (y con respaldo): si el front
    // carga antes de config-jpi.js venía vacía y las llamadas daban 404.
    function baseApi() {
        var j = window.JPI || {};
        return (j.API_BASE && j.API_BASE.indexOf('/comfylatam') >= 0)
            ? j.API_BASE
            : 'https://vps-4455523-x.dattaweb.com/comfylatam';
    }
    var perfil = null;          // datos de fscauth (foto, descripción, rol)
    var datosFsc = null;

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }
    function tiempo(seg) {
        seg = Number(seg || 0);
        if (seg < 60) return seg + ' s';
        var m = Math.floor(seg / 60);
        if (m < 60) return m + ' min';
        var h = Math.floor(m / 60);
        if (h < 24) return h + ' h ' + (m % 60) + ' min';
        return Math.floor(h / 24) + ' d ' + (h % 24) + ' h';
    }
    function mb(bytes) {
        var b = Number(bytes || 0);
        if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
        if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
        return (b / 1073741824).toFixed(2) + ' GB';
    }
    function token() {
        try { return localStorage.getItem('fsc_token_jpi') || ''; } catch (e) { return ''; }
    }
    function usuarioLocal() {
        try { return JSON.parse(localStorage.getItem('fsc_user_jpi') || 'null'); } catch (e) { return null; }
    }
    // ¿Hay sesión? Sin sesión esta app NO inventa un perfil (antes mostraba el
    // "dueño de esta computadora" y el botón decía "Mi cuenta"): ahora el panel
    // queda en estado LOGIN y el botón del menú dice LOGIN.
    function haySesion() {
        if (window.comfyAuth && window.comfyAuth.haySesion) {
            try { return window.comfyAuth.haySesion(); } catch (e) { }
        }
        try {
            var t = localStorage.getItem('fsc_token_jpi') || localStorage.getItem('token') || '';
            return t.length > 40 && t.split('.').length === 3;
        } catch (e) { return false; }
    }

    // ---------- el botón del menú: foto + nombre, o LOGIN ----------
    // UN solo módulo pinta el botón (auth-jpi.js): antes lo pintaban los dos y
    // el que perdía la carrera dejaba "Mi cuenta" a la vista.
    function pintarBoton() {
        if (window.comfyAuth && window.comfyAuth.pintarBoton) { window.comfyAuth.pintarBoton(); return; }
        var btn = document.getElementById('jpiCuentaBtn');
        if (!btn) return;
        btn.classList.add('ck-perfil-btn');
        if (!haySesion()) {
            btn.innerHTML = '<span class="ck-perfil-nombre">LOGIN</span>';
            return;
        }
        var u = usuarioLocal();
        var nom = (u && (u.displayName || u.username)) || '…';
        btn.innerHTML = '<span class="ck-perfil-nombre">' + esc(nom) + '</span>';
    }

    // ---------- limpieza: duplicados y cartel gigante ----------
    function limpiar() {
        // el cartel enorme del perfil viejo
        var grande = document.getElementById('cuentaPerfil');
        if (grande) grande.remove();
        // botones repetidos (mismo texto, mismo destino)
        var vistos = {};
        document.querySelectorAll('.tabs-container button, #projectTabsNav button, .project-tabs-nav button').forEach(function (b) {
            var k = (b.id || '') + '|' + b.textContent.trim().toLowerCase();
            if (vistos[k]) { b.remove(); return; }
            vistos[k] = 1;
        });
        // dos botones que digan lo mismo (ej. dos "MI CUENTA")
        var porTexto = {};
        document.querySelectorAll('.tabs-container button').forEach(function (b) {
            var t = b.textContent.trim().toLowerCase();
            if (!t) return;
            if (porTexto[t]) { b.remove(); return; }
            porTexto[t] = 1;
        });
    }

    // ---------- el panel del perfil ----------
    function panel() {
        return document.getElementById('tabCuenta');
    }

    function pintar(datos) {
        var p = panel();
        if (!p) return;
        datosFsc = datosFsc || (window.JPI && window.JPI.USUARIO) || null;
        var u = Object.assign({}, (datos && datos.usuario) || {}, usuarioLocal() || {}, datosFsc || {});
        // la descripción puede venir con distintos nombres según el endpoint
        u.descripcion = u.descripcion || u.description || u.bio || u.about || '';
        var t = (datos && datos.totales) || {};
        var nombre = u.displayName || u.username || 'Perfil';

        var cab = '<div class="ckp-cabecera">' +
            (u.avatar
                ? '<img class="ckp-foto" src="' + esc(u.avatar) + '" alt="">'
                : '<span class="ckp-foto ckp-inicial">' + esc(String(nombre).charAt(0).toUpperCase()) + '</span>') +
            '<div class="ckp-datos">' +
            '<div class="ckp-nombre">' + esc(nombre) + '</div>' +
            (u.username ? '<div class="ckp-user">@' + esc(u.username) + '</div>' : '') +
            (u.email ? '<div class="ckp-mail">' + esc(u.email) + '</div>' : '') +
            (u.descripcion ? '<div class="ckp-bio">' + esc(u.descripcion) + '</div>' : '') +
            '<div class="ckp-chips">' +
            '<span class="ckp-chip">' + esc(perfil && perfil.origen === 'carloskernel' ? 'bot' : 'cuenta fullscreencode') + '</span>' +
            (u.role ? '<span class="ckp-chip">' + esc(u.role) + '</span>' : '') +
            (t.segundosComputadora ? '<span class="ckp-chip verde">⏱️ ' + tiempo(t.segundosComputadora) + ' aportados</span>' : '') +
            '</div></div>' +
            '<div class="ckp-acciones">' +
            '<a class="ckp-link" href="https://fullscreencode.com/jpconnect/profile.html" target="_blank" rel="noopener">mi cuenta ↗</a>' +
            '</div>' +
            '</div>';

        var metricas = '<div class="rank-metricas">' +
            '<div class="rank-metrica"><b>' + (t.assets || 0) + '</b><span>assets creados</span></div>' +
            '<div class="rank-metrica"><b>' + mb(t.bytes) + '</b><span>en la nube</span></div>' +
            '<div class="rank-metrica"><b>' + (t.assets || 0) + '</b><span>totales (nube + tu PC)</span></div>' +
            '<div class="rank-metrica"><b>' + (t.generacionesProvistas || 0) + '</b><span>generaciones provistas</span></div>' +
            '<div class="rank-metrica"><b>' + (t.generacionesPedidas || 0) + '</b><span>generaciones pedidas</span></div>' +
            '</div>';

        var fierros = (datos && datos.computadoras || []).map(function (c) {
            return '<div class="rank-fierro">' +
                '<div class="rank-fierro-nombre"><span class="rank-punto' + (c.conectada ? ' on' : '') + '"></span>' +
                '<b>' + esc(c.nombre || c.peerId) + '</b> ' +
                '<span class="rank-estado ' + (c.conectada ? 'on' : 'off') + '">' + (c.conectada ? '🟢 conectada ahora' : '⚪ desconectada') + '</span></div>' +
                '<div class="rank-fierro-datos"><span>⏱️ <b>' + tiempo(c.segundosTotal) + '</b></span>' +
                '<span>⚡ <b>' + (c.generaciones || 0) + '</b> generaciones</span>' +
                (c.gpu ? '<span>🎛️ ' + esc(c.gpu) + '</span>' : '') + '</div></div>';
        }).join('') || '<div class="rank-vacio">todavía no hay computadoras registradas con esta cuenta</div>';

        var assets = (datos && datos.assets || []).slice(0, 40).map(function (a) {
            var esVideo = a.tipo === 'video';
            var enNube = (a.ubicacion || (a.url ? 'nube' : 'local')) === 'nube' && a.url;
            if (!enNube) {
                // vive en la PC de quien lo creó: se muestra igual, con su etiqueta
                return '<span class="rank-asset rank-asset-local" title="' + esc(a.prompt || a.publicId) + '">' +
                    (esVideo ? '<span class="rank-asset-icono">🎬</span>' : '<span class="rank-asset-icono">🖼️</span>') +
                    '<span class="rank-asset-pie">📍 en tu PC · ' + esc(mb(a.bytes)) + '</span></span>';
            }
            return '<a class="rank-asset" href="' + esc(a.url) + '" target="_blank" rel="noopener" title="' + esc(a.prompt || a.publicId) + '">' +
                (esVideo ? '<video src="' + esc(a.url) + '" muted preload="metadata"></video><span class="rank-asset-tag">🎬</span>'
                    : '<img src="' + esc(a.url) + '" loading="lazy" alt="">') +
                '<span class="rank-asset-pie">☁️ ' + esc(mb(a.bytes)) + '</span></a>';
        }).join('') || '<div class="rank-vacio">' + (token() ? 'todavía no creaste assets' : 'iniciá sesión para ver tus assets') + '</div>';

        p.innerHTML = cab + metricas +
            '<h4 class="rank-h4">🖥️ Tus computadoras</h4>' + fierros +
            '<h4 class="rank-h4">☁️ Tus assets (' + (t.assets || 0) + ') — servidos por Cloudflare</h4>' +
            '<div class="rank-assets">' + assets + '</div>';

        var salir = document.getElementById('ckCerrarSesion');
        if (salir) salir.addEventListener('click', function () {
            if (window.comfyAuth && window.comfyAuth.salir) window.comfyAuth.salir();
        });
    }

    function traer() {
        // Sin sesión no hay perfil que mostrar: el panel queda en estado LOGIN
        // (lo pinta auth-jpi.js) y el botón del menú dice LOGIN.
        if (!haySesion()) {
            if (window.comfyAuth && window.comfyAuth.pintarPanel) window.comfyAuth.pintarPanel();
            return Promise.resolve(null);
        }
        var u = usuarioLocal();
        var clave = (u && (u.email || u.username)) || null;
        var url = baseApi() + '/api/estadisticas/mia' + (clave ? '?usuario=' + encodeURIComponent(clave) : '');
        var cabeceras = token() ? { Authorization: 'Bearer ' + token() } : {};
        // primero el perfil que da fscauth (foto, descripción, datos)
        fetch(baseApi() + '/api/me', { headers: cabeceras })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (me) {
                perfil = (me && (me.user || me.usuario)) || null;
                if (!perfil) perfil = usuarioLocal();
                datosFsc = perfil || null;
                if (perfil) {
                    try {
                        localStorage.setItem('fsc_user_jpi', JSON.stringify(perfil));
                        window.JPI = window.JPI || {};
                        window.JPI.USUARIO = perfil;
                    } catch (e) { }
                    pintar({ usuario: perfil, totales: (perfil.totales || {}) });   // pinta ya con la foto
                }
                pintarBoton();
            })
            .catch(function () { });
        return fetch(url, { headers: cabeceras })
            .then(function (r) { return r.json(); })
            .then(function (d) { pintar(d); return d; })
            .catch(function () { pintar(null); });
    }

    function arrancar() {
        pintarBoton();
        limpiar();
        // cuando aparece el panel del perfil, se llena
        document.addEventListener('click', function (e) {
            var b = e.target.closest && e.target.closest('#jpiCuentaBtn');
            if (b) setTimeout(traer, 300);
        });
        setInterval(function () { pintarBoton(); limpiar(); }, 3000);
        setTimeout(traer, 4000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(arrancar, 1500); });
    else setTimeout(arrancar, 1500);

    window.PERFIL_CK = { traer: traer, pintarBoton: pintarBoton };
})();
