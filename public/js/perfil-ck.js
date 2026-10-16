// ============================================================
// PERFIL COMFYLATAM
// ------------------------------------------------------------
// · Vista unificada del perfil de ComfyLatam:
//     - foto, nombre, @username y bio (desde fullscreencode / base central)
//     - botones de acción: Actualizar datos y CERRAR SESIÓN
//     - enlace a gestión de cuenta en fullscreencode
//     - TUS ASSETS (imágenes y videos) y TUS FIERROS (computadoras y uptime)
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



    var perfil = null;
    var datosFsc = null;

    function baseApi() {
        var j = window.JPI || {};
        return j.API_BASE || '';
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    function normalizarFoto(url) {
        if (!url || typeof url !== 'string') return '';
        url = url.trim();
        if (!url) return '';
        if (/^https?:\/\//i.test(url)) return url;
        if (url.startsWith('/')) return 'https://fullscreencode.com' + url;
        return 'https://fullscreencode.com/' + url;
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
        if (window.comfyAuth && typeof window.comfyAuth.token === 'function') {
            var ct = window.comfyAuth.token();
            if (ct) return ct;
        }
        var claves = ['fsc_token_jpi', 'fsc_token', 'token'];
        for (var i = 0; i < claves.length; i++) {
            try {
                var t = localStorage.getItem(claves[i]);
                if (t && t.length > 40 && t.split('.').length === 3) return t;
            } catch (e) { }
        }
        return '';
    }

    function usuarioLocal() {
        if (window.comfyAuth && typeof window.comfyAuth.usuario === 'function') {
            var au = window.comfyAuth.usuario();
            if (au && (au.username || au.displayName)) return au;
        }
        var claves = ['fsc_user_jpi', 'fsc_user', 'usuario'];
        for (var i = 0; i < claves.length; i++) {
            try {
                var raw = localStorage.getItem(claves[i]);
                if (raw) {
                    var obj = JSON.parse(raw);
                    if (obj && (obj.username || obj.displayName)) return obj;
                }
            } catch (e) { }
        }
        return null;
    }

    function haySesion() {
        if (window.comfyAuth && window.comfyAuth.haySesion) {
            try { return window.comfyAuth.haySesion(); } catch (e) { }
        }
        return !!token();
    }

    function pintarBoton() {
        if (window.comfyAuth && window.comfyAuth.pintarBoton) {
            window.comfyAuth.pintarBoton();
            return;
        }
        var btn = document.getElementById('jpiCuentaBtn');
        if (!btn) return;
        // UN SOLO PINTOR: el botón lo pinta auth-jpi (foto + displayName). Con dos
        // módulos pintándolo, el que corría último borraba la FOTO y dejaba sólo
        // la inicial ("M mi cuenta").
        if (window.comfyAuth && window.comfyAuth.pintarBoton) {
            window.comfyAuth.pintarBoton(window.comfyAuth.usuario ? window.comfyAuth.usuario() : null);
            return;
        }
        btn.classList.add('ck-perfil-btn');
        if (!haySesion()) {
            btn.innerHTML = '<span class="ck-perfil-nombre">LOGIN</span>';
            return;
        }
        var u = usuarioLocal();
        var nom = (u && (u.displayName || u.username)) || '…';
        btn.innerHTML = '<span class="ck-perfil-nombre">' + esc(nom) + '</span>';
    }

    function panel() {
        return document.getElementById('tabCuenta');
    }

    function pintar(datos) {
        var p = panel();
        if (!p) return;

        if (!haySesion()) {
            if (window.comfyAuth && window.comfyAuth.pintarPanel) {
                window.comfyAuth.pintarPanel();
            }
            return;
        }

        datosFsc = datosFsc || (window.JPI && window.JPI.USUARIO) || null;
        var uBase = usuarioLocal() || {};
        var uDatos = (datos && datos.usuario) || {};
        var u = ckMezclarPerfil(uBase, datosFsc || {}, uDatos);

        u.descripcion = u.descripcion || u.description || u.bio || u.about || '';
        var t = (datos && datos.totales) || {};
        var nombre = u.displayName || u.username || 'Usuario';
        var fotoUrl = normalizarFoto(u.avatar || u.avatarUrl || uBase.avatar);
        var inicial = esc(String(nombre || '?').trim().charAt(0).toUpperCase());

        var fotoHtml = fotoUrl
            ? '<img class="ckp-foto" src="' + esc(fotoUrl) + '" alt="" onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),{className:\'ckp-foto ckp-inicial\',textContent:\'' + inicial + '\'}))">'
            : '<span class="ckp-foto ckp-inicial">' + inicial + '</span>';

        var cab = '<div class="ckp-cabecera">' +
            fotoHtml +
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
            '<button type="button" class="red-btn secundario chico" id="ckActualizar">Actualizar datos</button>' +
            '<button type="button" class="red-btn secundario chico ck-logout-btn" id="ckCerrarSesion">CERRAR SESIÓN</button>' +
            '<a class="ckp-link" href="https://fullscreencode.com/jpconnect/profile.html" target="_blank" rel="noopener">mi cuenta en fullscreencode ↗</a>' +
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

        var act = document.getElementById('ckActualizar');
        if (act) act.addEventListener('click', function () {
            traer();
        });
    }

    function traer() {
        if (!haySesion()) {
            if (window.comfyAuth && window.comfyAuth.pintarPanel) window.comfyAuth.pintarPanel();
            return Promise.resolve(null);
        }

        var u = usuarioLocal();
        var clave = (u && (u.email || u.username)) || null;
        var api = baseApi();
        var urlEstadisticas = api + '/api/estadisticas/mia' + (clave ? '?usuario=' + encodeURIComponent(clave) : '');
        var tok = token();
        var cabeceras = tok ? { Authorization: 'Bearer ' + tok } : {};

        // 1) Pedir perfil actualizado
        fetch(api + '/api/me', { headers: cabeceras })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (me) {
                var per = (me && (me.user || me.usuario)) || null;
                if (per) {
                    perfil = per;
                    datosFsc = per;
                    try {
                        localStorage.setItem('fsc_user_jpi', JSON.stringify(per));
                        window.JPI = window.JPI || {};
                        window.JPI.USUARIO = per;
                    } catch (e) { }
                    if (window.comfyAuth && window.comfyAuth.pintarBoton) {
                        window.comfyAuth.pintarBoton(per);
                    }
                    pintar({ usuario: per });
                }
            })
            .catch(function () { });

        // 2) Pedir métricas y computadoras
        return fetch(urlEstadisticas, { headers: cabeceras })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                pintar(d || { usuario: perfil || usuarioLocal() });
                return d;
            })
            .catch(function () {
                pintar({ usuario: perfil || usuarioLocal() });
            });
    }

    function arrancar() {
        pintarBoton();
        document.addEventListener('click', function (e) {
            var b = e.target.closest && e.target.closest('#jpiCuentaBtn');
            if (b && haySesion()) {
                setTimeout(traer, 100);
            }
        });
        setTimeout(function () {
            if (haySesion()) traer();
        }, 1500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', arrancar);
    } else {
        arrancar();
    }

    window.PERFIL_CK = {
        traer: traer,
        pintar: pintar,
        pintarBoton: pintarBoton,
        normalizarFoto: normalizarFoto
    };
})();
