// ============================================================
// jpiassets - configuracion del front (VideoComfy Studio en la web)
// ------------------------------------------------------------
// El editor es el MISMO de videocomfy: cuando se sirve desde el VPS o
// desde el FTP, no puede hablar con 127.0.0.1:5634 (esta en la PC de
// Julian). Apunta al backend jpiassets, que relayea todo (HTTP + socket)
// hacia el videocomfy local a traves del agente.
// ============================================================
(function () {
    var h = location.hostname;
    var esServidor = (h === 'localhost' || h === '127.0.0.1' ||
                      h.indexOf('localhost') !== -1 ||
                      h === 'vps-4455523-x.dattaweb.com');
    // La app se llama COMFYLATAM: en la web vive en /comfylatam (y sigue
    // aceptando la ruta vieja /jpiassets para no romper enlaces guardados).
    var BASE = location.pathname.indexOf('/comfylatam') === 0 ? '/comfylatam'
             : location.pathname.indexOf('/jpiassets') === 0 ? '/jpiassets'
             : '';

    var ORIGIN = esServidor
        ? (location.protocol + '//' + location.host)
        : 'https://vps-4455523-x.dattaweb.com';

    // Token de la sesión FSC (lo guarda js/auth-jpi.js al entrar). En la app
    // local no hay sesión: queda vacío y nada cambia.
    var TOKEN = '';
    try {
        // La sesión del ecosistema puede estar en 'fsc_token' (login unificado
        // jpconnect/fscauth) o en 'token'; la app local usa 'fsc_token_jpi'.
        // Antes leía UNA sola y por eso la web mandaba todo sin token: 401 en
        // todos los endpoints y el WebSocket sin ?token=.
        var CLAVES_TOK = ['fsc_token_jpi', 'fsc_token', 'token'];
        for (var i = 0; i < CLAVES_TOK.length; i++) {
            var t = localStorage.getItem(CLAVES_TOK[i]);
            if (t && String(t).split('.').length === 3) { TOKEN = t; break; }
        }
    } catch (e) { }

    // Una URL de media puede venir relativa ('/uploads/x.png'): en la web eso lo
    // resuelve el navegador contra fullscreencode.com y da 404. Esta la vuelve
    // absoluta contra el backend (que redirige al CDN de Cloudflare). Si ya es el
    // link de Cloudflare, la deja como está.
    window.ckMediaUrl = function (u) {
        var s = String(u == null ? '' : u);
        if (!s) return '';
        if (/^(https?:|data:|blob:)/i.test(s)) return s;
        var base = String((window.JPI || {}).API_BASE || '').replace(/\/+$/, '');
        return base + (s.charAt(0) === '/' ? s : '/' + s);
    };

    window.JPI = {
        BASE: BASE,
        ORIGIN: ORIGIN,
        // Para fetch: api, uploads, videos, audio, todo pasa por aca
        API_BASE: ORIGIN + BASE,
        // WebSocket crudo del editor (el protocolo de videocomfy).
        // En la web el token viaja como ?token= porque el backend lo pide.
        WS: ORIGIN.replace(/^http/, 'ws') + BASE + '/ws' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''),
        FSCAUTH_URL: 'https://fullscreencode.com/jpconnect',   // login unificado del ecosistema
        esServidor: esServidor,
        TOKEN: TOKEN
    };
})();
