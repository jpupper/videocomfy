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
    var BASE = location.pathname.indexOf('/jpiassets') === 0 ? '/jpiassets' : '';

    var ORIGIN = esServidor
        ? (location.protocol + '//' + location.host)
        : 'https://vps-4455523-x.dattaweb.com';

    window.JPI = {
        BASE: BASE,
        ORIGIN: ORIGIN,
        // Para fetch: api, uploads, videos, audio, todo pasa por aca
        API_BASE: ORIGIN + BASE,
        // WebSocket crudo del editor (el protocolo de videocomfy)
        WS: ORIGIN.replace(/^http/, 'ws') + BASE + '/ws',
        esServidor: esServidor
    };
})();
