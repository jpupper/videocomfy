/* ============================================================
 * SYNC DE STUDIO ASSETS — la última generación entra sola
 * ------------------------------------------------------------
 * Problema medido: al terminar una imagen, el aviso del WS llega ANTES de que
 * el archivo esté ingerido en /api/images y (en la web) antes de que termine
 * la subida a Cloudflare. El listado se refrescaba en ese momento, no
 * encontraba la imagen nueva y quedaba viejo hasta que el usuario recargaba.
 *
 * Ahora se refresca con red: al aviso, y de nuevo a los 2,5 s / 6 s / 12 s
 * (la subida a R2 tarda unos segundos). También cuando el registro de pedidos
 * ve un pedido pasar a listo / sin_nube.
 * ============================================================ */
(function () {
    'use strict';

    var esperas = [0, 2500, 6000, 12000];
    var timers = [];
    var refrescados = {};      // archivo -> ts (para no repetir de más)

    function img() { return typeof window.loadExistingImages === 'function'; }
    function vid() { return typeof window.loadExistingVideos === 'function'; }

    function ahora() {
        if (img()) { try { window.loadExistingImages(); } catch (e) { } }
        if (vid()) { try { window.loadExistingVideos(); } catch (e) { } }
    }

    function refrescar() {
        timers.forEach(clearTimeout);
        timers = esperas.map(function (ms) { return setTimeout(ahora, ms); });
    }

    // ¿hay un archivo nuevo que todavía no sincronizamos?
    function archivoNuevo(archivo) {
        if (!archivo) return false;
        var t = refrescados[archivo];
        if (t && (Date.now() - t) < 120000) return false;
        refrescados[archivo] = Date.now();
        return true;
    }

    window.CKSyncAssets = {
        refrescar: refrescar,
        msg: function (m) {
            if (!m || !m.type) return;
            if (m.type === 'media_en_nube' || m.type === 'storyboard_generated' || m.type === 'video_generated') {
                if (archivoNuevo(m.filename)) refrescar();
                return;
            }
            if (m.type === 'pedidos') {
                var lista = m.pedidos || [];
                for (var i = 0; i < lista.length; i++) {
                    var p = lista[i] || {};
                    if (!p.archivo) continue;
                    if (p.estado !== 'listo' && p.estado !== 'sin_nube') continue;
                    if (archivoNuevo(p.archivo)) { refrescar(); return; }
                }
            }
        }
    };

    window.addEventListener('jpi-generado', function () { refrescar(); });

    // fuente de verdad: el store único de pedidos
    (function enganchar() {
        if (!window.CKPedidos || !window.CKPedidos.suscribir) { setTimeout(enganchar, 800); return; }
        window.CKPedidos.suscribir(function (store) {
            var lista = store.lista || [];
            for (var i = 0; i < lista.length; i++) {
                var p = lista[i] || {};
                if (!p.archivo) continue;
                if (p.estado !== 'listo' && p.estado !== 'sin_nube') continue;
                if (archivoNuevo(p.archivo)) { refrescar(); return; }
            }
        });
    })();
})();
