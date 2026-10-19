// ============================================================
// WORKFLOWS QUE COMPARTÍS (sólo en la app local)
// ------------------------------------------------------------
// 1) Muestra qué workflows tiene esta PC y cuáles NO se pueden usar porque
//    faltan modelos (lo detecta la app preguntándole a ComfyUI /object_info).
// 2) Deja elegir con un tilde cuáles compartís con la red.
// 3) ACCESOS: cada workflow se puede dejar para TODOS o habilitarlo sólo a
//    algunas cuentas. El que no está habilitado no lo ve ni lo puede pedir.
// Lo que no compartís (o no tenés instalado) NO se ofrece: nadie desde la web
// ni desde otra PC puede mandar un trabajo con ese workflow a este fierro.
// ============================================================
(function () {
    'use strict';

    var J = window.JPI || {};
    var esLocal = !!J.esServidor;

    var ACCESO = {};      // { archivo: { modo: 'todos'|'lista', usuarios: [] } }
    var USUARIOS = [];    // [{ usuario, displayName, avatar }]
    var abiertos = {};    // qué workflow tiene el selector de usuarios desplegado

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    function contenedor() {
        var caja = document.getElementById('redWorkflowsCaja');
        if (caja) return caja;
        // Vive en la sub-pestaña ⚙️ MI EQUIPO de RED (antes estaba arriba de los
        // nodos, mezclado con LA RED, que es otra cosa).
        var slot = document.getElementById('redWfSlot')
            || document.getElementById('redDisponibles');
        var ancla = document.getElementById('redDisponibles');
        var panel = slot || (ancla ? ancla.parentElement : document.getElementById('redPanel'));
        if (!panel) return null;
        caja = document.createElement('div');
        caja.id = 'redWorkflowsCaja';
        caja.className = 'red-workflows';
        panel.appendChild(caja);
        return caja;
    }

    function accesoDe(archivo) {
        var a = ACCESO[archivo] || {};
        return {
            modo: a.modo === 'lista' ? 'lista' : 'todos',
            usuarios: Array.isArray(a.usuarios) ? a.usuarios : []
        };
    }

    // ---- fila de accesos de un workflow ------------------------------------
    function filaAcceso(w) {
        var a = accesoDe(w.archivo);
        var abierto = !!abiertos[w.archivo];
        var cuantos = a.usuarios.length;
        var etiqueta = a.modo === 'todos'
            ? '👥 TODOS'
            : ('🔒 SÓLO ' + cuantos + (cuantos === 1 ? ' USUARIO' : ' USUARIOS'));
        var chips = USUARIOS.map(function (u) {
            var marcado = a.usuarios.some(function (x) { return String(x).toLowerCase() === String(u.usuario).toLowerCase(); });
            return '<button type="button" class="red-acc-user' + (marcado ? ' on' : '') + '"' +
                ' data-acc-user="' + esc(w.archivo) + '" data-user="' + esc(u.usuario) + '">' +
                (marcado ? '✓ ' : '') + '@' + esc(u.usuario) + '</button>';
        }).join('') || '<span class="red-acc-vacio">todavía no hay usuarios registrados</span>';

        return '<div class="red-wf-acceso" data-acc-caja="' + esc(w.archivo) + '">' +
            '<button type="button" class="red-acc-modo' + (a.modo === 'lista' ? ' lista' : '') + '"' +
            ' data-acc-modo="' + esc(w.archivo) + '" data-modo="' + (a.modo === 'todos' ? 'lista' : 'todos') + '"' +
            ' title="' + (a.modo === 'todos' ? 'Habilitarlo sólo a algunos usuarios' : 'Habilitarlo para todos otra vez') + '">' +
            etiqueta + '</button>' +
            (a.modo === 'lista' && abierto ? '<div class="red-acc-lista">' + chips +
                '<span class="red-acc-pista">tocá los usuarios que SÍ pueden usar este workflow</span></div>' : '') +
            '</div>';
    }

    function pintar(d) {
        var caja = contenedor();
        if (!caja) return;
        var lista = (d && d.workflows) || [];
        if (!lista.length) {
            caja.innerHTML = '<h3 class="red-titulo">🔧 WORKFLOWS</h3><div class="red-aviso">no encontré workflows en la carpeta <b>workflows/</b></div>';
            return;
        }
        var filas = lista.map(function (w) {
            // Instalado = el archivo existe Y todos sus modelos/nodos están.
            var noInstalado = w.disponible === false;
            var estado = noInstalado
                ? '<span class="red-wf-falta" title="' + esc((w.falta || []).join(' · ')) + '">⚠️ NO instalado' + ((w.falta || []).length ? ': ' + esc((w.falta || [])[0]) + ((w.falta || []).length > 1 ? ' (+' + ((w.falta || []).length - 1) + ')' : '') : '') + '</span>'
                : (w.disponible === null ? '<span class="red-wf-duda">❔ no pude chequear ComfyUI</span>' : '<span class="red-wf-ok">✅ instalado</span>');
            // El tilde SIEMPRE se puede tocar (pedido explícito): así podés dejar
            // apagado un workflow aunque hoy no lo tengas instalado, para que la
            // web no lo use cuando lo instales.
            return '<div class="red-wf-bloque">' +
                '<label class="red-wf' + (noInstalado ? ' deshabilitado' : '') + '">' +
                '<input type="checkbox" data-wf="' + esc(w.archivo) + '"' + (w.compartido ? ' checked' : '') + '>' +
                '<span class="red-wf-nombre">' + esc(w.nombre) + '</span>' +
                '<span class="red-wf-archivo">' + esc(w.archivo) + '</span>' +
                estado +
                '</label>' +
                (w.compartido ? filaAcceso(w) : '') +
                '</div>';
        }).join('');
        var compartidos = lista.filter(function (w) { return w.compartido && w.disponible !== false; }).length;
        var rotos = lista.filter(function (w) { return w.disponible === false; }).length;
        caja.innerHTML = '<h3 class="red-titulo">🔧 WORKFLOWS QUE COMPARTÍS ' +
            '<span class="red-badge">' + compartidos + ' de ' + lista.length + '</span>' +
            '<button class="red-btn secundario" id="redWfRefrescar" style="margin-left:8px">Revisar</button></h3>' +
            '<div class="red-aviso">Tildá los que querés ofrecer a la red. Destildado = la web NO lo puede usar en tu PC. ' +
            'Con <b>👥 TODOS / 🔒 SÓLO N</b> elegís quién puede usarlo: el resto no lo ve ni lo puede pedir.</div>' +
            '<div class="red-wf-lista">' + filas + '</div>' +
            (rotos ? '<div class="red-aviso">⚠️ ' + rotos + ' workflow(s) no se pueden usar todavía en esta PC (falta un modelo o un nodo): quedan fuera de la red hasta que los instales.</div>' : '');

        var ref = document.getElementById('redWfRefrescar');
        if (ref) ref.addEventListener('click', function () { traer(true); });

        caja.querySelectorAll('input[data-wf]').forEach(function (chk) {
            chk.addEventListener('change', function () {
                var archivo = chk.getAttribute('data-wf');
                chk.disabled = true;
                api('/api/red/workflows', { method: 'POST', json: { archivo: archivo, compartido: chk.checked } })
                    .then(function (r) { if (r && r.workflows) pintar(r); else traer(true); })
                    .catch(function () { chk.disabled = false; });
            });
        });

        // cambiar TODOS <-> SÓLO ALGUNOS
        caja.querySelectorAll('[data-acc-modo]').forEach(function (b) {
            b.addEventListener('click', function () {
                var archivo = b.getAttribute('data-acc-modo');
                var modo = b.getAttribute('data-modo');
                if (modo === 'lista') {
                    abiertos[archivo] = true;
                    pintar(d);   // despliega la lista de usuarios
                    return;
                }
                guardar(archivo, 'todos', []);
            });
        });

        // tildar/destildar un usuario
        caja.querySelectorAll('[data-acc-user]').forEach(function (b) {
            b.addEventListener('click', function () {
                var archivo = b.getAttribute('data-acc-user');
                var user = b.getAttribute('data-user');
                var a = accesoDe(archivo);
                var lista = a.usuarios.slice();
                var i = lista.findIndex(function (x) { return String(x).toLowerCase() === user.toLowerCase(); });
                if (i >= 0) lista.splice(i, 1); else lista.push(user);
                if (!lista.length) {
                    // sin nadie elegido vuelve a TODOS (no se puede dejar vacío)
                    guardar(archivo, 'todos', []);
                    return;
                }
                guardar(archivo, 'lista', lista);
            });
        });
    }

    function guardar(archivo, modo, usuarios) {
        api('/api/wf/acceso', { method: 'POST', json: { archivo: archivo, modo: modo, usuarios: usuarios } })
            .then(function (r) {
                if (r && r.success && r.acceso) {
                    ACCESO = r.acceso;
                    if (modo === 'todos') abiertos[archivo] = false;
                    traer(false);
                } else {
                    alert('No pude guardar: ' + ((r && r.message) || 'error'));
                }
            })
            .catch(function (e) { alert('No pude guardar: ' + e.message); });
    }

    function api(ruta, opciones) {
        var opt = opciones || {};
        var init = { method: opt.method || 'GET', headers: { 'Content-Type': 'application/json' } };
        if (opt.json) init.body = JSON.stringify(opt.json);
        return fetch(ruta, init).then(function (r) { return r.json(); });
    }

    function traer(forzar) {
        if (!esLocal) {
            var c = contenedor();
            if (c) c.innerHTML = '';
            return;
        }
        Promise.all([
            api('/api/red/workflows' + (forzar ? '?forzar=1' : '')),
            api('/api/wf/acceso').catch(function () { return {}; }),
            api('/api/wf/usuarios').catch(function () { return {}; })
        ]).then(function (r) {
            ACCESO = (r[1] && r[1].acceso) || {};
            USUARIOS = (r[2] && r[2].usuarios) || [];
            pintar(r[0]);
        }).catch(function () { });
    }

    function arrancar() {
        if (!esLocal) return;
        traer(false);
        // cada 2 minutos (y cuando se abre la pestaña de RED, vía el refresco de red.js)
        setInterval(function () { traer(false); }, 120000);
        document.addEventListener('click', function (e) {
            if (e.target && e.target.id === 'redRefrescar') setTimeout(function () { traer(false); }, 400);
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(arrancar, 3000); });
    else setTimeout(arrancar, 3000);

    window.WORKFLOWS_RED = { traer: traer, pintar: pintar };
})();
