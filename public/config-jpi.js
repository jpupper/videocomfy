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
    try { TOKEN = localStorage.getItem('fsc_token_jpi') || ''; } catch (e) { }

    window.JPI = {
        BASE: BASE,
        ORIGIN: ORIGIN,
        // Para fetch: api, uploads, videos, audio, todo pasa por aca
        API_BASE: ORIGIN + BASE,
        // WebSocket crudo del editor (el protocolo de videocomfy).
        // En la web el token viaja como ?token= porque el backend lo pide.
        WS: ORIGIN.replace(/^http/, 'ws') + BASE + '/ws' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''),
        FSCAUTH_URL: 'https://vps-4455523-x.dattaweb.com/jpconnect'   // login unificado del ecosistema (jpconnect),   // login unificado del ecosistema
        esServidor: esServidor,
        TOKEN: TOKEN
    };
})();
