// ============================================================
// WORKFLOWS QUE COMPARTÍS (sólo en la app local)
// ------------------------------------------------------------
// 1) Muestra qué workflows tiene esta PC y cuáles NO se pueden usar porque
//    faltan modelos (lo detecta la app preguntándole a ComfyUI /object_info).
// 2) Deja elegir con un tilde cuáles compartís con la red.
// Lo que no compartís (o no tenés instalado) NO se ofrece: nadie desde la web
// ni desde otra PC puede mandar un trabajo con ese workflow a este fierro.
// ============================================================
(function () {
    'use strict';

    var J = window.JPI || {};
    var esLocal = !!J.esServidor;

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    function contenedor() {
        var caja = document.getElementById('redWorkflowsCaja');
        if (caja) return caja;
        // se engancha dentro del panel de RED, arriba de los nodos conectados
        var ancla = document.getElementById('redDisponibles');
        var panel = ancla ? ancla.parentElement : document.getElementById('redPanel');
        if (!panel) return null;
        caja = document.createElement('div');
        caja.id = 'redWorkflowsCaja';
        caja.className = 'red-workflows';
        if (ancla && ancla.parentElement === panel) panel.insertBefore(caja, ancla);
        else panel.appendChild(caja);
        return caja;
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
            var estado = w.disponible === false
                ? '<span class="red-wf-falta" title="' + esc((w.falta || []).join(' · ')) + '">⚠️ faltan modelos' + ((w.falta || []).length ? ': ' + esc((w.falta || [])[0]) + ((w.falta || []).length > 1 ? ' (+' + ((w.falta || []).length - 1) + ')' : '') : '') + '</span>'
                : (w.disponible === null ? '<span class="red-wf-duda">❔ no pude chequear ComfyUI</span>' : '<span class="red-wf-ok">✅ instalado</span>');
            var noSePuede = w.disponible === false;
            return '<label class="red-wf' + (noSePuede ? ' deshabilitado' : '') + '">' +
                '<input type="checkbox" data-wf="' + esc(w.archivo) + '"' + (w.compartido && !noSePuede ? ' checked' : '') + (noSePuede ? ' disabled' : '') + '>' +
                '<span class="red-wf-nombre">' + esc(w.nombre) + '</span>' +
                '<span class="red-wf-archivo">' + esc(w.archivo) + '</span>' +
                estado +
                '</label>';
        }).join('');
        var compartidos = lista.filter(function (w) { return w.compartido && w.disponible !== false; }).length;
        var rotos = lista.filter(function (w) { return w.disponible === false; }).length;
        caja.innerHTML = '<h3 class="red-titulo">🔧 WORKFLOWS QUE COMPARTÍS ' +
            '<span class="red-badge">' + compartidos + ' de ' + lista.length + '</span>' +
            '<button class="red-btn secundario" id="redWfRefrescar" style="margin-left:8px">Revisar</button></h3>' +
            '<div class="red-aviso">Tildá los que querés ofrecer a la red. Lo que no tildás (o lo que no tenés instalado) no se le puede pedir a esta PC.</div>' +
            '<div class="red-wf-lista">' + filas + '</div>' +
            (rotos ? '<div class="red-aviso">⚠️ ' + rotos + ' workflow(s) no se pueden usar en esta PC porque faltan modelos: quedan desactivados automáticamente.</div>' : '');

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
        api('/api/red/workflows' + (forzar ? '?forzar=1' : ''))
            .then(pintar)
            .catch(function () { });
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
