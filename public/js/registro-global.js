/* STAGE → GLOBAL
 * Registro GLOBAL de pedidos: vive en el VPS (Mongo), no en el navegador.
 * Cada CREATE —de la web o de cualquier app local— queda anotado ahí.
 * Si el VPS no está (sin internet), la pestaña dice "no disponible":
 * no se inventa ni se muestra un registro local como si fuera global.
 */
(function () {
    'use strict';

    function base() {
        return (window.JPI && (window.JPI.API_BASE || '')) || '';
    }
    function esc(t) {
        return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function E() { return window.CKEstados || { icono: function (e) { return '·'; }, texto: function (e) { return e; } }; }
    function hora(ts) {
        if (!ts) return '—';
        try { return new Date(Number(ts)).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
        catch (e) { return '—'; }
    }

    var ESTADO = { pedidos: [], disponible: null, error: '', cargado: 0 };

    function fila(p) {
        var e = E();
        var quien = (p.pedidoPor && (p.pedidoPor.usuario || p.pedidoPor.displayName)) || p.de || '';
        var pc = p.peerNombre || (p.computadora && p.computadora.nombre) || '';
        var origen = p.origen === 'web' ? '🌐 la web' : (p.origen === 'red' ? '🔗 la red' : '🏠 local');
        return '<tr>' +
            '<td class="rg-estado">' + e.icono(p.estado) + ' ' + esc(e.texto(p.estado)) + '</td>' +
            '<td class="rg-archivo">' + esc(p.archivo || '—') + '</td>' +
            '<td class="rg-prompt" title="' + esc(p.prompt || '') + '">' + esc(String(p.prompt || '').slice(0, 60)) + '</td>' +
            '<td>' + (quien ? '@' + esc(quien) : '—') + '</td>' +
            '<td>' + origen + '</td>' +
            '<td>' + esc(pc) + '</td>' +
            '<td class="rg-hora">' + hora(p.ts) + '</td>' +
            '</tr>';
    }

    function pintar() {
        var caja = document.getElementById('regGlobalCaja');
        if (!caja) return;

        var cab = '<div class="rg-cab">' +
            '<h3 class="rg-titulo">🌐 REGISTRO GLOBAL <span class="rg-badge">VPS</span></h3>' +
            '<span class="rg-info">' + (ESTADO.disponible === false
                ? '🔴 no disponible'
                : (ESTADO.cargado ? ESTADO.pedidos.length + ' pedido(s)' : 'cargando…')) + '</span>' +
            '<button class="red-btn secundario" id="rgRefrescar">Actualizar</button>' +
            '</div>';

        if (ESTADO.disponible === false) {
            caja.innerHTML = cab +
                '<div class="rg-off">' +
                '<b>Registro global no disponible.</b><br>' +
                'El registro global vive en el VPS: sin conexión no hay forma de mostrarlo. ' +
                'El trabajo local sigue funcionando y se anota acá cuando vuelve la conexión.' +
                (ESTADO.error ? '<div class="rg-err">' + esc(ESTADO.error) + '</div>' : '') +
                '</div>';
            enganchar();
            return;
        }

        if (!ESTADO.pedidos.length) {
            caja.innerHTML = cab + '<div class="rg-off">Todavía no hay pedidos en el registro global. ' +
                'Cada vez que alguien aprieta CREATE aparece acá.</div>';
            enganchar();
            return;
        }

        caja.innerHTML = cab +
            '<div class="rg-tabla-caja"><table class="rg-tabla">' +
            '<thead><tr>' +
            '<th>Estado</th><th>Archivo</th><th>Prompt</th><th>Lo pidió</th>' +
            '<th>Salió de</th><th>Se hizo en</th><th>Cuándo</th>' +
            '</tr></thead><tbody>' +
            ESTADO.pedidos.map(fila).join('') +
            '</tbody></table></div>';
        enganchar();
    }

    function enganchar() {
        var b = document.getElementById('rgRefrescar');
        if (b && !b.__ck) { b.__ck = 1; b.addEventListener('click', cargar); }
    }

    function cargar() {
        var url = base() + '/api/red/pedidos-global?limite=150&_=' + Date.now();
        fetch(url, { cache: 'no-store' })
            .then(function (r) {
                if (r.status === 503) return { success: false, disponible: false, message: 'el VPS no tiene base' };
                return r.json();
            })
            .then(function (d) {
                ESTADO.disponible = (d && d.disponible !== false && d.success !== false);
                ESTADO.error = (d && d.message) || '';
                ESTADO.pedidos = (d && d.pedidos) || [];
                ESTADO.cargado = Date.now();
                pintar();
            })
            .catch(function (e) {
                ESTADO.disponible = false;
                ESTADO.error = e.message || 'sin conexión';
                pintar();
            });
    }

    window.CKRegistroGlobal = { cargar: cargar, estado: ESTADO };

    setInterval(function () {
        if (document.getElementById('regGlobalCaja') && document.visibilityState !== 'hidden') cargar();
    }, 4000);
    setTimeout(cargar, 1500);
})();
