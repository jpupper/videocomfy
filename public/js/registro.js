// ============================================================
// COMFYLATAM - STAGE: quién pidió la generación + REGISTRO
// ------------------------------------------------------------
// En el STAGE (Stage/Output) se agrega:
//   1. 🎯 A DÓNDE VA: a qué computadora está dirigida la próxima generación
//      (el nodo elegido en la pestaña RED) y quién es su dueño.
//   2. 🎬 ÚLTIMA GENERACIÓN: quién la pidió (con su avatar), el prompt, en qué
//      computadora se hizo y a quién está registrada esa PC.
//   3. 📋 REGISTRO: la tabla de las últimas generaciones con esos tres datos.
//
// Local: los datos salen de la propia app (/api/registro).
// Web: del nodo que generó, a través del relay (/comfylatam/p/<nodo>/api/registro).
// ============================================================
(function () {
    'use strict';

    var J = window.JPI || {};
    var BASE = J.API_BASE || '';
    var esLocal = !!J.esServidor;
    var CLAVE_NODO = 'comfylatam_nodo_elegido';
    var CLAVE_USER = 'fsc_user_jpi';

    var ultimo = null;

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }
    function hora(ts) {
        if (!ts) return '—';
        try { return new Date(Number(ts)).toLocaleString('es-AR'); } catch (e) { return '—'; }
    }
    function usuarioLocal() {
        try { return JSON.parse(localStorage.getItem(CLAVE_USER) || 'null'); } catch (e) { return null; }
    }

    // ---------- 1) montar las tarjetas en el STAGE ----------
    function montar() {
        var stage = document.getElementById('tabOutput') || document.getElementById('previz-monitor');
        if (!stage || document.getElementById('regStage')) return;
        var cont = document.createElement('div');
        cont.id = 'regStage';
        cont.innerHTML = [
            '<div class="reg-card" id="regDestino"></div>',
            '<div class="reg-card" id="regUltima"></div>',
            '<div class="reg-card" id="regTabla"></div>'
        ].join('');
        stage.insertBefore(cont, stage.firstChild);
    }

    // ---------- 2) a qué computadora está dirigida ----------
    function pintarDestino() {
        var caja = document.getElementById('regDestino');
        if (!caja) return;
        var yo = usuarioLocal();
        var elegido = '';
        try { elegido = localStorage.getItem(CLAVE_NODO) || ''; } catch (e) { }
        if (!elegido || elegido === (window.JPI && window.JPI.PEER_ID)) {
            caja.innerHTML = '<h3>🎯 A DÓNDE VA ESTA GENERACIÓN</h3>' +
                '<div class="reg-datos"><span>🖥️ <b>esta PC</b> (genera tu propio ComfyUI)</span>' +
                (yo ? '<span>👤 pedido por <b>@' + esc(yo.username || yo.displayName) + '</b></span>' : '') +
                '<span>elegí otra computadora en la pestaña 🌎 RED si querés usar la de alguien más</span></div>';
            return;
        }
        fetch(BASE + '/api/red/peers').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
            .then(function (d) {
                var p = (d && (d.peers || []).filter(function (x) { return x.id === elegido; })[0]) || null;
                if (!p) {
                    caja.innerHTML = '<h3>🎯 A DÓNDE VA ESTA GENERACIÓN</h3><div class="reg-datos"><span>⚠️ el nodo elegido no está conectado</span></div>';
                    return;
                }
                caja.innerHTML = '<h3>🎯 A DÓNDE VA ESTA GENERACIÓN</h3>' +
                    '<div class="reg-datos">' +
                    '<span>🖥️ <b>' + esc(p.nombre) + '</b>' + (p.usuario ? ' · de @' + esc(p.usuario) : '') + '</span>' +
                    '<span>' + (p.ocupado ? '🟡 ocupada (' + (p.encolados || 0) + ' en cola)' : '🟢 libre') + ' · ' + esc(p.gpu || 'sin GPU') + '</span>' +
                    (yo ? '<span>👤 la pedís vos: <b>@' + esc(yo.username || yo.displayName) + '</b></span>' : '') +
                    '</div>';
            });
    }

    // ---------- 3) última generación + registro ----------
    function pintarRegistros(datos) {
        var regs = (datos && datos.registros) || [];
        var ult = document.getElementById('regUltima');
        var tab = document.getElementById('regTabla');

        if (ult) {
            if (!regs.length) {
                ult.innerHTML = '<h3>🎬 ÚLTIMA GENERACIÓN</h3><div class="reg-datos"><span>todavía no generaste nada</span></div>';
            } else {
                var r = regs[0];
                var foto = r.avatar ? '<img class="red-avatar" src="' + esc(r.avatar) + '" alt="">' : '👤';
                ult.innerHTML = '<h3>🎬 ÚLTIMA GENERACIÓN</h3>' +
                    '<div class="reg-ultima">' +
                    '  <div class="reg-quien">' + foto + ' <span>@' + esc(r.pedidoPorUsuario || r.pedidoPor) + '</span>' +
                    '   <span class="rule-origen ' + (r.origen === 'red' ? 'rule-red' : 'rule-local') + '">' +
                    (r.origen === 'red' ? 'pedido de la red' : 'tu batch local') + '</span></div>' +
                    '  <div class="reg-datos">' +
                    '    <span>💬 <b>' + esc(String(r.prompt || '').slice(0, 140)) + '</b></span>' +
                    '    <span>🖥️ generada en <b>' + esc(r.computadora) + '</b></span>' +
                    '    <span>🔑 esa computadora está registrada a <b>@' + esc(r.dueno) + '</b></span>' +
                    '    <span>📄 ' + esc(r.archivo) + ' · ' + hora(r.fecha) + '</span>' +
                    '  </div>' +
                    '</div>';
            }
        }

        if (tab) {
            var filas = regs.slice(0, 15).map(function (r) {
                return '<tr>' +
                    '<td>' + esc(r.archivo) + '</td>' +
                    '<td>' + esc(String(r.prompt || '').slice(0, 46)) + '</td>' +
                    '<td>@' + esc(r.pedidoPorUsuario || r.pedidoPor) + '</td>' +
                    '<td>' + esc(r.computadora) + ' <span style="color:var(--text-muted)">(@' + esc(r.dueno) + ')</span></td>' +
                    '<td>' + (r.origen === 'red' ? '🌎 red' : '🏠 local') + '</td>' +
                    '<td>' + hora(r.fecha) + '</td>' +
                    '</tr>';
            }).join('');
            tab.innerHTML = '<h3>📋 REGISTRO — quién pidió, qué computadora lo hizo, a quién pertenece</h3>' +
                (filas
                    ? '<table class="reg-tabla"><thead><tr><th>Archivo</th><th>Prompt</th><th>Lo pidió</th><th>Computadora (dueño)</th><th>Origen</th><th>Cuándo</th></tr></thead><tbody>' + filas + '</tbody></table>'
                    : '<div class="reg-datos"><span>sin registros todavía</span></div>');
        }
    }

    function traer() {
        if (esLocal) {
            fetch('api/registro').then(function (r) { return r.ok ? r.json() : null; })
                .then(function (d) { if (d) { ultimo = d; pintarRegistros(d); } })
                .catch(function () { });
            return;
        }
        // En la web el registro vive en la PC que generó: se pide por el relay.
        // Si no hay nodo elegido, se usa el principal (así el STAGE se ve igual
        // que en local y no queda vacío).
        var elegido = '';
        try { elegido = localStorage.getItem(CLAVE_NODO) || ''; } catch (e) { }
        var pedir = function (id) {
            fetch(BASE + '/p/' + encodeURIComponent(id) + '/api/registro')
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (d) { if (d) { ultimo = d; pintarRegistros(d); } })
                .catch(function () { });
        };
        if (elegido) { pedir(elegido); return; }
        fetch(BASE + '/api/red/peers').then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                var peers = (d && d.peers) || [];
                var principal = peers.filter(function (p) { return p.principal; })[0] || peers[0];
                if (principal) pedir(principal.id);
            })
            .catch(function () { });
    }

    function arrancar() {
        montar();
        pintarDestino();
        traer();
        setInterval(pintarDestino, 8000);
        setInterval(traer, 7000);
        // cuando el editor genera algo, refrescamos el registro enseguida
        window.addEventListener('jpi-generado', function () { setTimeout(traer, 1500); });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar);
    else arrancar();
})();
