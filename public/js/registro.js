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
    // OJO (pedido explícito del usuario): en la WEB no existe "esta PC" — esa es
    // la app local. Antes, sin nodo elegido, la web decía "🖥️ esta PC (genera tu
    // propio ComfyUI)", que es falso y confunde. Acá se distingue de verdad:
    //   local            -> esta PC (tu ComfyUI)
    //   web, sin nodo    -> ☁️ la nube (servidor COMFYLATAM): falta elegir fierro
    //   web, con nodo    -> esa computadora
    function pintarDestino() {
        var caja = document.getElementById('regDestino');
        if (!caja) return;
        var yo = usuarioLocal();
        var elegido = '';
        try { elegido = localStorage.getItem(CLAVE_NODO) || ''; } catch (e) { }

        // ---- LOCAL: el motor es el ComfyUI de esta máquina ----
        if (esLocal) {
            caja.innerHTML = '<h3>🎯 A DÓNDE VA ESTA GENERACIÓN</h3>' +
                '<div class="reg-datos"><span>🖥️ <b>esta PC</b> (genera tu propio ComfyUI)</span>' +
                (yo ? '<span>👤 pedido por <b>@' + esc(yo.username || yo.displayName) + '</b></span>' : '') +
                '<span>elegí otra computadora en la pestaña 🌎 RED si querés usar la de alguien más</span></div>';
            return;
        }

        // ---- WEB: siempre pasa por el servidor (la nube) ----
        var cabeza = '<h3>🎯 A DÓNDE VA ESTA GENERACIÓN</h3>' +
            '<div class="reg-datos"><span>☁️ <b>a la nube</b> (servidor COMFYLATAM → la computadora conectada)</span>';
        if (yo) cabeza += '<span>👤 la pedís vos: <b>@' + esc(yo.username || yo.displayName) + '</b></span>';

        if (!elegido) {
            caja.innerHTML = cabeza +
                '<span>⚠️ todavía no elegiste qué computadora lo hace: elegila en la pestaña 🌎 RED</span></div>';
            return;
        }
        fetch(BASE + '/api/red/peers').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
            .then(function (d) {
                var p = (d && (d.peers || []).filter(function (x) { return x.id === elegido; })[0]) || null;
                if (!p) {
                    caja.innerHTML = cabeza + '<span>⚠️ la computadora elegida no está conectada</span></div>';
                    return;
                }
                caja.innerHTML = cabeza +
                    '<span>🖥️ lo hace <b>' + esc(p.nombre) + '</b>' + (p.usuario ? ' · de @' + esc(p.usuario) : '') + '</span>' +
                    '<span>' + (p.ocupado ? '🟡 ocupada (' + (p.encolados || 0) + ' en cola)' : '🟢 libre') + ' · ' + esc(p.gpu || 'sin GPU') + '</span>' +
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
                    '    <span>🖥️ se generó en <b>' + esc(r.computadora) + '</b> (dueño: @' + esc(r.dueno) + ')</span>' +
                    '    <span>📨 el pedido salió de <b>' + esc(r.pedidoDesde || 'esta app (local)') + '</b></span>' +
                    '    <span>📄 ' + esc(r.archivo) + ' · ' + hora(r.fecha) + '</span>' +
                    '  </div>' +
                    '</div>';
            }
        }

        if (tab) {
            // ---- REGISTRO: primero los PEDIDOS (incluye los que nunca se generaron
            // y los cancelados, con su estado) y después las imágenes viejas que no
            // tengan pedido asociado.
            var ped = (window.CK_PEDIDOS || []).slice(0, 40);
            var archivosConPedido = {};
            ped.forEach(function (p) { if (p.archivo) archivosConPedido[p.archivo] = 1; });

            var E_ICONO = { pedida: '⏳', en_comfy: '⚙️', devuelta: '📥', subiendo: '☁️', listo: '✅',
                            cancelada: '✖', interrumpida: '⚠️', error: '⚠️', sin_nube: '💾' };
            var E_TEXTO = { pedida: 'pedida · esperando', en_comfy: 'en ComfyUI', devuelta: 'volvió al local',
                            subiendo: 'subiendo a la nube', listo: 'lista', cancelada: 'cancelada',
                            interrumpida: 'interrumpida', error: 'error', sin_nube: 'lista (quedó local)' };

            // dueño de la computadora del pedido (para la columna SE HIZO EN)
            var duenoDe = function (p) {
                var c = p.computadora || {};
                var m = p.maquina || {};
                return c.dueno || c.duenoNombre || m.dueno || m.duenoNombre || m.usuario ||
                       p.dueno || p.duenoNombre || '';
            };

            var filasPedidos = ped.map(function (p) {
                var est = p.estado || 'pedida';
                var foto = p.avatar ? '<img class="red-avatar" src="' + esc(p.avatar) + '" alt="">' : '👤 ';
                var maq = (p.maquina && p.maquina.nombre) || (p.computadora && p.computadora.nombre) || '—';
                var puedeVer = (est === 'listo' || est === 'sin_nube') && (p.url || p.archivo);
                var ojo = puedeVer
                    ? '<button class="reg-ojo" data-url="' + esc(p.url || '') + '" data-arch="' + esc(p.archivo || '') + '" title="Ver la imagen">👁️</button>'
                    : '';
                return '<tr data-estado="' + esc(est) + '">' +
                    '<td>' + (E_ICONO[est] || '•') + ' <span class="reg-estado-txt">' + esc(E_TEXTO[est] || est) + '</span></td>' +
                    '<td>' + esc(p.archivo || '—') + '</td>' +
                    '<td>' + esc(String(p.prompt || '').slice(0, 40)) + '</td>' +
                    '<td>' + foto + '@' + esc(p.usuario || '?') + '</td>' +
                    '<td>' + (p.origen === 'web' ? '🌐 la web' : '🏠 esta app') + '</td>' +
                    '<td>🖥️ <b>' + esc(maq) + '</b>' +
                        (duenoDe(p) ? '<br><span style="color:var(--text-muted)">dueño: @' + esc(duenoDe(p)) + '</span>' : '') + '</td>' +
                    '<td>' + hora(p.cuando) + '</td>' +
                    '<td>' + ojo + '</td>' +
                    '</tr>';
            });

            var filas = regs.filter(function (r) { return !archivosConPedido[r.archivo]; }).slice(0, 15).map(function (r) {
                var foto = r.avatar ? '<img class="red-avatar" src="' + esc(r.avatar) + '" alt="">' : '👤 ';
                // '≈' = generación vieja, anotada antes de que el pedido viajara
                // con cada trabajo: el usuario puede no ser el correcto.
                var dudoso = '';
                return '<tr data-estado="listo">' +
                    '<td>✅ <span class="reg-estado-txt">lista</span></td>' +
                    '<td>' + esc(r.archivo) + '</td>' +
                    '<td>' + esc(String(r.prompt || '').slice(0, 40)) + '</td>' +
                    '<td>' + foto + '@' + esc(r.pedidoPorUsuario || r.pedidoPor) + dudoso + '</td>' +
                    '<td>' + (r.pedidoDesde === 'esta app (local)' ? '🏠' : (r.pedidoDesde === 'la web' ? '🌐' : '🖥️')) + ' ' + esc(r.pedidoDesde || '—') + '</td>' +
                    '<td>🖥️ <b>' + esc(r.computadora) + '</b><br><span style="color:var(--text-muted)">dueño: @' + esc(r.dueno) + '</span></td>' +
                    '<td>' + hora(r.fecha) + '</td>' +
                    '<td><button class="reg-ojo" data-arch="' + esc(r.archivo) + '" title="Ver la imagen">👁️</button></td>' +
                    '</tr>';
            }).join('');
            filas = filasPedidos.concat(filas).join('');
            tab.innerHTML = '<h3>📋 REGISTRO</h3>' +
                (filas
                    ? '<table class="reg-tabla"><thead><tr><th>Estado</th><th>Archivo</th><th>Prompt</th><th>Lo pidió</th><th>Salió de</th><th>Se hizo en</th><th>Cuándo</th><th></th></tr></thead><tbody>' + filas + '</tbody></table>'
                    : '<div class="reg-datos"><span>sin registros todavía</span></div>');
        }
    }

    // trae el registro de imágenes Y el de pedidos (que incluye lo que nunca se
    // generó y lo cancelado: eso es lo que da el ESTADO de cada fila)
    function traerAmbos(urlRegistro) {
        // los pedidos salen del store ÚNICO (el mismo que usa el panel izquierdo)
        var pedidosP = (window.CKPedidos && window.CKPedidos.traer())
            ? window.CKPedidos.traer()
            : Promise.resolve(null);
        return Promise.all([
            (urlRegistro
                ? fetch(urlRegistro, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
                : Promise.resolve(null)),
            pedidosP
        ]).then(function (res) {
            var d = res[0];
            var p = (window.CKPedidos && window.CKPedidos.lista && window.CKPedidos.lista.length)
                ? { pedidos: window.CKPedidos.lista } : res[1];
            if (p && p.pedidos) window.CK_PEDIDOS = p.pedidos;
            if (d || p) { if (d) ultimo = d; pintarRegistros(d || { registros: [] }); }
        });
    }

    function traer() {
        if (esLocal) { traerAmbos('api/registro'); return; }
        // En la web el registro vive en la PC que generó: se pide por el relay.
        // Si no hay nodo elegido, se usa el principal (así el STAGE se ve igual
        // que en local y no queda vacío).
        var elegido = '';
        try { elegido = localStorage.getItem(CLAVE_NODO) || ''; } catch (e) { }
        var pedir = function (id) { traerAmbos(BASE + '/api/registro'); };
        if (elegido) { pedir(elegido); return; }
        fetch(BASE + '/api/red/peers').then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                var peers = (d && d.peers) || [];
                var principal = peers.filter(function (p) { return p.principal; })[0] || peers[0];
                if (principal) pedir(principal.id);
                // sin sesión (401) o sin nodos: igual se pinta el registro de PEDIDOS,
                // que es público y ya trae estado, archivo y URL de cada generación
                else traerAmbos(null);
            })
            .catch(function () { traerAmbos(null); });
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

// ---------------------------------------------------------------------------
// OJO del REGISTRO: abre la imagen (o el video) de una generación terminada.
// Sólo aparece en las que se generaron bien (las canceladas tienen cruz y no
// tienen nada que abrir).
// ---------------------------------------------------------------------------
(function () {
    'use strict';
    var J = window.JPI || {};
    var BASE = J.API_BASE || '';

    function urlDe(boton) {
        var u = boton.getAttribute('data-url');
        if (u) return u;
        var arch = boton.getAttribute('data-arch') || '';
        var esVideo = /\.(mp4|webm|mov|mkv)$/i.test(arch);
        return BASE + '/' + (esVideo ? 'videos' : 'uploads') + '/' + encodeURIComponent(arch);
    }

    function abrir(src, esVideo) {
        cerrar();
        var capa = document.createElement('div');
        capa.id = 'regVisor';
        capa.innerHTML = '<button id="regVisorCerrar" title="Cerrar">✕</button>' +
            (esVideo ? '<video src="' + src + '" controls autoplay loop></video>'
                     : '<img src="' + src + '" alt="">');
        capa.addEventListener('click', function (e) {
            if (e.target === capa || e.target.id === 'regVisorCerrar') cerrar();
        });
        document.body.appendChild(capa);
        document.addEventListener('keydown', escCerrar);
    }
    function escCerrar(e) { if (e.key === 'Escape') cerrar(); }
    function cerrar() {
        var v = document.getElementById('regVisor');
        if (v) v.remove();
        document.removeEventListener('keydown', escCerrar);
    }

    document.addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('.reg-ojo') : null;
        if (!b) return;
        var src = urlDe(b);
        abrir(src, /\.(mp4|webm|mov|mkv)(\?|$)/i.test(src));
    });
})();
