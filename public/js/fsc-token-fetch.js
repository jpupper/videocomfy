/* ============================================================
   fsc-token-fetch.js — la sesión del ecosistema en TODA llamada a la API.

   Problema medido en comfylatam: la app "entra" (el token queda en
   localStorage y el botón dice Mi cuenta) pero sus llamadas a /api/... viajan
   SIN Authorization -> el hub contesta 401 y la pantalla queda vacía. Se lee
   como "el login no funciona" / "a veces sí y a veces no".

   Por qué no alcanza con un parche normal: `js/auth-jpi.js` REEMPLAZA
   `window.fetch` con su propio wrapper (y otros módulos capturan referencias),
   así que un parche temprano queda pisado según el orden de carga. Acá se
   intercepta la ASIGNACIÓN de `window.fetch`: cualquier función que se instale
   queda envuelta, siempre. Cubre fetch y XMLHttpRequest.
   ============================================================ */
(function () {
    'use strict';
    var CLAVES = ['token', 'fsc_token_jpi', 'fsc_token'];

    function leerToken() {
        try {
            for (var i = 0; i < CLAVES.length; i++) {
                var t = localStorage.getItem(CLAVES[i]);
                if (t && t !== 'undefined' && t !== 'null' && String(t).split('.').length === 3) return t;
            }
            var J = window.JPI || window.CONFIG || {};
            if (J.TOKEN && String(J.TOKEN).split('.').length === 3) return J.TOKEN;
        } catch (e) { }
        return '';
    }

    function esApiDeLaApp(u) {
        try {
            var url = new URL(u, location.href);
            var mismaApi = /\/api\//.test(url.pathname);
            if (!mismaApi) return false;
            if (url.origin === location.origin) return true;
            // La web vive en fullscreencode.com y su API en el VPS: es OTRO origen
            // y la cookie de sesión no viaja. Antes esta función exigía mismo
            // origen, así que el token no se mandaba y TODO daba 401 (Studio
            // Assets vacío, panel admin 403). Ahora se manda el Bearer también al
            // backend de la app.
            var api = '';
            try { api = String((window.JPI || {}).API_BASE || ''); } catch (e) { }
            if (api) { try { if (new URL(api, location.href).origin === url.origin) return true; } catch (e) { } }
            return /vps-4455523-x\.dattaweb\.com$/.test(url.hostname);
        } catch (e) { return false; }
    }

    function conToken(fn) {
        return function (input, init) {
            try {
                var url = typeof input === 'string' ? input : (input && input.url) || '';
                if (esApiDeLaApp(url)) {
                    var tok = leerToken();
                    if (tok) {
                        init = init || {};
                        var cab = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
                        if (!cab.has('Authorization')) cab.set('Authorization', 'Bearer ' + tok);
                        init.headers = cab;
                    }
                }
            } catch (e) { }
            return fn.call(this, input, init);
        };
    }

    // --- fetch: se envuelve cualquier función que se asigne a window.fetch ---
    var actual = conToken(window.fetch || function () { });
    try {
        Object.defineProperty(window, 'fetch', {
            configurable: true,
            get: function () { return actual; },
            set: function (fn) { actual = conToken(fn); }
        });
        window.__FSC_TOKEN_FETCH__ = true;
    } catch (e) {
        window.fetch = conToken(window.fetch || function () { });
    }

    // --- XMLHttpRequest ---
    try {
        var abrir = XMLHttpRequest.prototype.open;
        var enviar = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (m, u) { this.__fscUrl = u; return abrir.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function () {
            try {
                if (esApiDeLaApp(this.__fscUrl || '')) {
                    var tok = leerToken();
                    if (tok) this.setRequestHeader('Authorization', 'Bearer ' + tok);
                }
            } catch (e) { }
            return enviar.apply(this, arguments);
        };
    } catch (e) { }

    // --- último cinturón: si algo se escapó, se re-afirma el getter ---
    setTimeout(function () {
        try {
            var f = window.fetch;
            if (!f || !String(f).match(/leerToken|conToken|Authorization/)) window.fetch = f;
        } catch (e) { }
    }, 4000);
})();
