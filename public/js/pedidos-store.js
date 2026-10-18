// ============================================================
// PEDIDOS — FUENTE ÚNICA de la cola / el batch / el registro
// ------------------------------------------------------------
// PROBLEMA QUE RESUELVE
// La "Cola de Trabajo" del panel IZQUIERDO se armaba con la cola del navegador
// (localStorage) y el BATCH del STAGE con el registro de la app (/api/pedidos).
// Eran dos versiones de lo mismo, desfasadas: la izquierda decía una cosa y el
// STAGE otra.
//
// AHORA hay UN solo lugar de donde leen los tres (panel izquierdo, BATCH y
// REGISTRO): este store. Un único pedido a /api/pedidos, un único timer y todos
// los que se suscriben reciben exactamente la misma lista y los mismos números.
//
// Estados: pedida -> en_comfy -> devuelta -> subiendo -> listo
//          + cancelada | interrumpida | error | sin_nube
// ============================================================
(function () {
    'use strict';

    var J = window.JPI || {};
    var BASE = J.API_BASE || '';

    var EN_CURSO = ['en_comfy', 'devuelta', 'subiendo'];
    var EN_ESPERA = ['pedida'];
    var HECHAS = ['listo', 'sin_nube'];
    var CANCELADAS = ['cancelada', 'interrumpida', 'error'];

    var store = {
        lista: [],
        maquinas: [],
        cargado: false,
        error: null,
        _subs: [],
        _t: null,
        EN_CURSO: EN_CURSO, EN_ESPERA: EN_ESPERA, HECHAS: HECHAS, CANCELADAS: CANCELADAS,

        ICONO: {
            pedida: '⏳', en_comfy: '⚙️', devuelta: '📥', subiendo: '☁️',
            listo: '✅', cancelada: '✖', interrumpida: '⚠️', error: '⚠️', sin_nube: '💾'
        },
        TEXTO: {
            pedida: 'pedida', en_comfy: 'en ComfyUI', devuelta: 'volvió al local',
            subiendo: 'subiendo a la nube', listo: 'lista', cancelada: 'cancelada',
            interrumpida: 'interrumpida', error: 'error', sin_nube: 'lista (quedó local)'
        },

        // ---- suscripción: todos los paneles se enteran del mismo dato ----
        suscribir: function (fn) {
            if (typeof fn !== 'function') return function () { };
            store._subs.push(fn);
            if (store.cargado) { try { fn(store); } catch (e) { } }
            return function () {
                var i = store._subs.indexOf(fn);
                if (i >= 0) store._subs.splice(i, 1);
            };
        },

        avisar: function () {
            store._subs.forEach(function (fn) { try { fn(store); } catch (e) { } });
        },

        traer: function () {
            return fetch(BASE + '/api/pedidos', { cache: 'no-store' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (d) {
                    if (!d) { store.error = 'sin respuesta'; return store; }
                    store.lista = d.pedidos || [];
                    store.maquinas = d.maquinas || [];
                    store.cargado = true;
                    store.error = null;
                    store.avisar();
                    return store;
                })
                .catch(function (e) { store.error = String(e); return store; });
        },

        // ---- números (los mismos para todos) ----
        contar: function () {
            var c = { enCurso: 0, enEspera: 0, hechas: 0, canceladas: 0, total: store.lista.length };
            store.lista.forEach(function (p) {
                var e = p.estado || 'pedida';
                if (EN_CURSO.indexOf(e) >= 0) c.enCurso++;
                else if (EN_ESPERA.indexOf(e) >= 0) c.enEspera++;
                else if (HECHAS.indexOf(e) >= 0) c.hechas++;
                else if (CANCELADAS.indexOf(e) >= 0) c.canceladas++;
            });
            return c;
        },

        // las que están en curso o esperando (para las listas)
        activas: function () {
            return store.lista.filter(function (p) {
                var e = p.estado || 'pedida';
                return EN_CURSO.indexOf(e) >= 0 || EN_ESPERA.indexOf(e) >= 0;
            });
        },

        limpiar: function () {
            return fetch(BASE + '/api/pedidos/limpiar', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
            }).then(function (r) { return r.ok ? r.json() : null; })
                .then(function (d) { return store.traer().then(function () { return d; }); });
        },

        arrancar: function () {
            if (store._t) return;
            store.traer();
            store._t = setInterval(function () { store.traer(); }, 4000);
            window.addEventListener('jpi-generado', function () { setTimeout(store.traer, 800); });
        }
    };

    window.CKPedidos = store;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', store.arrancar);
    else store.arrancar();
})();
