// ============================================================
// BATCH — lista ÚNICA de pedidos del STAGE
// ------------------------------------------------------------
// Antes decía "🏠 TU BATCH LOCAL" y sólo mostraba la cola del navegador, así
// que un pedido hecho desde la WEB no aparecía en la PC que lo tenía que
// generar. Ahora la lista sale del registro de pedidos de la app (/api/pedidos),
// que incluye:
//   · local: lo que pediste en esta PC + lo que llega de la web
//   · web:   lo de TODAS las máquinas conectadas (el hub las junta)
// Cada fila dice quién la pidió, desde dónde salió, en qué máquina se hace y en
// qué estado está (⏳ pedida → ⚙️ en ComfyUI → 📥 volvió → ☁️ subiendo → ✅ lista).
// También está el botón 🧹 LIMPIAR BATCH: lo que no se generó queda cancelado
// (con su cruz en el registro).
// ============================================================
(function () {
    'use strict';

    var J = window.JPI || {};
    var BASE = J.API_BASE || '';
    var esLocal = !!J.esServidor;

    var ICONO = {
        pedida: '⏳', en_comfy: '⚙️', devuelta: '📥', subiendo: '☁️',
        listo: '✅', cancelada: '✖', interrumpida: '⚠️', error: '⚠️', sin_nube: '💾'
    };
    var TEXTO = {
        pedida: 'pedida', en_comfy: 'en ComfyUI', devuelta: 'volvió al local',
        subiendo: 'subiendo a la nube', listo: 'lista', cancelada: 'cancelada',
        interrumpida: 'interrumpida', error: 'error', sin_nube: 'lista (quedó local)'
    };
    var EN_CURSO = ['pedida', 'en_comfy', 'devuelta', 'subiendo'];

    // los datos vienen del store único (js/pedidos-store.js): el panel izquierdo,
    // el BATCH y el REGISTRO leen SIEMPRE lo mismo
    function S() { return window.CKPedidos || { lista: [], maquinas: [], ICONO: {}, TEXTO: {}, contar: function () { return { enCurso: 0 }; } }; }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }
    function hace(ts) {
        if (!ts) return '';
        var d = Math.max(0, Date.now() - Number(ts)) / 1000;
        if (d < 60) return 'hace ' + Math.round(d) + 's';
        if (d < 3600) return 'hace ' + Math.round(d / 60) + 'm';
        if (d < 86400) return 'hace ' + Math.round(d / 3600) + 'h';
        return new Date(Number(ts)).toLocaleDateString('es-AR');
    }

    // ---------- la tarjeta ----------
    function montar() {
        var caja = document.getElementById('globalQueueContainer');
        if (!caja) return;
        // la tarjeta tiene que vivir DENTRO de la pestaña BATCH (antes quedaba
        // como hijo suelto de STAGE y se veía también en COMMUNITY)
        var batch = document.getElementById('stageBatch');
        if (batch && caja.parentElement !== batch) batch.appendChild(caja);
        // en la web la tarjeta venía oculta y script.js la vuelve a ocultar
        // cuando la cola del navegador está vacía: acá manda el registro real
        caja.classList.remove('hidden');
        caja.style.display = 'block';
        if (document.getElementById('batchPedidos')) return;

        var titulo = caja.querySelector('.inline-queue-title');
        if (titulo) titulo.textContent = '📦 BATCH';
        var sub = caja.querySelector('.inline-queue-badge');
        if (sub) sub.textContent = (esLocal
            ? 'lo que pediste acá + lo que llega de la web'
            : 'de todas las computadoras conectadas');

        // la cola vieja del navegador queda oculta: la lista es esta
        var vieja = document.getElementById('queueList');
        if (vieja) vieja.style.display = 'none';

        var lista = document.createElement('div');
        lista.id = 'batchPedidos';
        lista.className = 'batch-pedidos';
        caja.appendChild(lista);

        // botón para limpiar el batch
        var header = caja.querySelector('.inline-queue-header');
        if (header && !document.getElementById('limpiarBatchBtn')) {
            var b = document.createElement('button');
            b.id = 'limpiarBatchBtn';
            b.className = 'danger-btn-outline';
            b.style.cssText = 'padding: 6px 16px; font-size: 0.8em; font-weight: 700; margin-left: 8px;';
            b.textContent = '🧹 LIMPIAR BATCH';
            b.title = 'Cancela lo que falta generar (queda con una cruz en el registro)';
            b.addEventListener('click', limpiar);
            var stop = document.getElementById('stopQueueBtn');
            if (stop && stop.parentElement === header) header.insertBefore(b, stop.nextSibling);
            else header.appendChild(b);
        }
    }

    // ---------- pintar ----------
    function pintar() {
        var cont = document.getElementById('batchPedidos');
        if (!cont) return;
        var store = S();
        var PEDIDOS = store.lista || [];
        var enCurso = PEDIDOS.filter(function (p) { return EN_CURSO.indexOf(p.estado) >= 0; });
        var terminadas = PEDIDOS.filter(function (p) { return EN_CURSO.indexOf(p.estado) < 0; }).slice(0, 6);
        var cuenta = document.getElementById('queueCount');
        if (cuenta) cuenta.textContent = String(enCurso.length);

        var fila = function (p) {
            var maq = (p.maquina && p.maquina.nombre) || (p.computadora && p.computadora.nombre) || '—';
            var av = p.avatar ? '<img class="red-avatar" src="' + esc(p.avatar) + '" alt="">' : '👤';
            var est = p.estado || 'pedida';
            return '<div class="batch-fila" data-estado="' + esc(est) + '">' +
                '<span class="batch-estado" title="' + esc(store.TEXTO[est] || TEXTO[est] || est) + '">' +
                    (store.ICONO[est] || ICONO[est] || '•') + '</span>' +
                '<div class="batch-cuerpo">' +
                    '<div class="batch-prompt">“' + esc(String(p.prompt || '').slice(0, 120)) + '”</div>' +
                    '<div class="batch-meta">' +
                        av + ' <b>@' + esc(p.usuario || '?') + '</b>' +
                        ' <span class="batch-chip ' + (p.origen === 'web' ? 'web' : 'local') + '">' +
                            (p.origen === 'web' ? '🌐 pedida en la web' : '🏠 pedida acá') + '</span>' +
                        ' <span class="batch-chip">🖥️ ' + esc(maq) + '</span>' +
                        ' <span class="batch-chip">' + esc(p.modelo || 'auto') + '</span>' +
                        ' <span class="batch-cuando">' + hace(p.cuando) + '</span>' +
                    '</div>' +
                    '<div class="batch-estado-txt">' + esc(store.ICONO[est] || ICONO[est] || '') + ' ' + esc(store.TEXTO[est] || TEXTO[est] || est) +
                        (p.archivo ? ' · 📄 ' + esc(p.archivo) : '') + '</div>' +
                '</div>' +
            '</div>';
        };

        var html = '';
        if (enCurso.length) html += enCurso.map(fila).join('');
        else html += '<div class="batch-vacio">no hay nada pendiente de generar</div>';
        if (terminadas.length) {
            html += '<div class="batch-subtitulo">últimas</div>' + terminadas.map(fila).join('');
        }
        cont.innerHTML = html;
    }

    // ---------- datos ----------
    function traer() {
        if (window.CKPedidos) { window.CKPedidos.traer(); return; }
    }

    function limpiar() {
        var b = document.getElementById('limpiarBatchBtn');
        if (b) { b.disabled = true; b.textContent = 'limpiando…'; }
        (window.CKPedidos ? window.CKPedidos.limpiar() : Promise.resolve(null))
            .then(function (d) {
                // también se vacía la cola del navegador (si quedaba algo sin enviar)
                try { localStorage.setItem('globalGenerationQueue', '[]'); } catch (e) { }
                if (typeof renderQueue === 'function') { try { renderQueue(); } catch (e) { } }
                console.log('🧹 batch limpiado', d);
                traer();
                setTimeout(traer, 800);
            })
            .catch(function () { })
            .then(function () { if (b) { b.disabled = false; b.textContent = '🧹 LIMPIAR BATCH'; } });
    }

    function arrancar() {
        montar();
        if (window.CKPedidos) window.CKPedidos.suscribir(function () { montar(); pintar(); });
        setInterval(function () { montar(); }, 3000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar);
    else arrancar();
})();
