/* STAGE → mapa "DÓNDE ESTÁ LA PELOTA"
 * Dibuja la cadena real del trabajo:
 *   WEB → EQUIPO (la PC que genera) → MOTOR (Comfy local o RunPod)
 * Cada tramo se prende cuando el trabajo está ahí, y abajo va el estado exacto.
 * No inventa nada: lee /api/status, /api/pedidos, el comfy externo y CKProgreso.
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
    function esWeb() {
        var h = String(location.hostname || '');
        return !/127\.0\.0\.1|localhost|0\.0\.0\.0/i.test(h) && /fullscreencode|dattaweb|vps-/i.test(h);
    }
    function get(ruta) {
        return fetch(base() + ruta + (ruta.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now(), { cache: 'no-store' })
            .then(function (r) { return r.json(); }).catch(function () { return {}; });
    }

    var D = { status: {}, pedidos: [], externo: {}, ultimaCarga: 0 };

    function pedidoActual() {
        var lista = D.pedidos || [];
        // el que está en curso gana; si no, el último que terminó
        var enCurso = lista.filter(function (p) {
            return ['pedida', 'en_comfy', 'devuelta', 'subiendo'].indexOf(p.estado) >= 0;
        })[0];
        return enCurso || lista[0] || null;
    }

    function faseMotor() {
        var f = String(D.status.comfyFase || '');
        var p = (window.CKProgreso && window.CKProgreso.estado) ? window.CKProgreso.estado() : {};
        var enCurso = p && (p.etapa === 'comfy' || p.etapa === 'nube');
        if (!D.status.comfy) {
            if (D.status.comfyArrancando) return { txt: 'arrancando el motor…', clase: 'espera' };
            return { txt: 'apagado', clase: 'mal' };
        }
        if (f === 'generando' || enCurso) {
            var paso = (p && p.total) ? ' · paso ' + p.paso + '/' + p.total : '';
            return { txt: 'generando' + paso, clase: 'ok' };
        }
        if (f === 'modelo') return { txt: 'cargando modelo en VRAM', clase: 'ok' };
        if (f === 'arrancando') return { txt: 'arrancando', clase: 'espera' };
        if (f === 'sin_respuesta') {
            return { txt: 'sin respuesta' + (D.status.comfySilencioSegundos ? ' hace ' + D.status.comfySilencioSegundos + 's' : ''), clase: 'espera' };
        }
        return { txt: D.status.comfyDetalle || 'listo', clase: 'ok' };
    }

    function caja(titulo, subtitulo, estado, clase, icono) {
        return '<div class="fl-caja ' + clase + '">' +
            '<div class="fl-icono">' + icono + '</div>' +
            '<div class="fl-texto">' +
            '  <div class="fl-titulo">' + esc(titulo) + '</div>' +
            (subtitulo ? '  <div class="fl-sub">' + esc(subtitulo) + '</div>' : '') +
            '  <div class="fl-estado">' + esc(estado) + '</div>' +
            '</div></div>';
    }

    function flecha(activa) {
        return '<div class="fl-flecha' + (activa ? ' on' : '') + '">→</div>';
    }

    function pintar() {
        var host = document.getElementById('ckFlujo');
        if (!host) return;
        var p = pedidoActual();
        var m = faseMotor();
        var externoActivo = !!(D.externo && D.externo.activo && D.externo.url);

        // ── tramo 1: de dónde salió ────────────────────────────────────────
        var web = esWeb() || (p && p.origen === 'web');
        var origenTxt = web ? 'fullscreencode.com' : 'esta PC';
        var EST = {
            pedida: web ? 'pedido enviado' : 'en cola',
            en_comfy: web ? 'la PC lo aceptó' : 'generando acá',
            devuelta: 'volviendo el resultado',
            subiendo: 'subiendo a la nube',
            listo: 'terminado',
            sin_nube: 'terminado (quedó local)',
            error: 'error',
            interrumpida: 'interrumpido',
            cancelada: 'cancelado'
        };
        var origenEstado = p ? (EST[p.estado] || p.estado) : 'sin trabajo';
        var origenClase = p ? (p.estado === 'error' || p.estado === 'interrumpida' || p.estado === 'cancelada' ? 'mal' : (p.estado === 'listo' || p.estado === 'sin_nube' ? 'hecho' : 'ok')) : '';

        // ── tramo 2: el equipo ─────────────────────────────────────────────
        var pc = (p && p.computadora && (p.computadora.nombre || p.computadora.peerId)) || D.status.host || 'esta PC';
        var estadoPc = 'esperando trabajo';
        var clasePc = '';
        if (p) {
            if (p.estado === 'pedida') { estadoPc = 'recibió el pedido · en cola'; clasePc = 'espera'; }
            else if (p.estado === 'en_comfy') { estadoPc = 'trabajando'; clasePc = 'ok'; }
            else if (p.estado === 'devuelta') { estadoPc = 'volvió el resultado'; clasePc = 'ok'; }
            else if (p.estado === 'subiendo') { estadoPc = 'subiendo a la nube'; clasePc = 'ok'; }
            else if (p.estado === 'listo') { estadoPc = 'terminado'; clasePc = 'hecho'; }
            else if (p.estado === 'error') { estadoPc = 'error'; clasePc = 'mal'; }
            else if (p.estado === 'interrumpida' || p.estado === 'cancelada') { estadoPc = p.estado; clasePc = 'mal'; }
        } else if (!D.status.comfy) {
            estadoPc = 'sin motor';
            clasePc = 'mal';
        }

        // ── tramo 3: el motor ──────────────────────────────────────────────
        var motorTitulo, motorSub;
        if (externoActivo) {
            motorTitulo = 'RunPod';
            motorSub = String(D.externo.url || '').replace(/^https?:\/\//, '');
        } else {
            motorTitulo = 'Comfy local';
            motorSub = D.status.comfyAddress || '127.0.0.1';
        }
        var motorClase = m.clase;
        if (p && p.estado === 'listo') motorClase = 'hecho';
        if (p && p.estado === 'error') motorClase = 'mal';

        var activo = !!(p && ['pedida', 'en_comfy', 'devuelta', 'subiendo'].indexOf(p.estado) >= 0);
        var activoMotor = activo && (p.estado === 'en_comfy' || p.estado === 'devuelta' || p.estado === 'subiendo');

        host.innerHTML =
            '<div class="fl-titulo-panel">🎯 DÓNDE ESTÁ LA PELOTA' +
            (p && p.archivo ? ' <span class="fl-archivo">' + esc(p.archivo) + '</span>' : '') + '</div>' +
            '<div class="fl-cadena">' +
            caja(web ? 'Web' : 'Esta app', origenTxt, origenEstado, activo ? 'ok' : origenClase, web ? '🌐' : '🏠') +
            flecha(activo) +
            caja('Equipo', pc, estadoPc, clasePc, '💻') +
            flecha(activoMotor) +
            caja(motorTitulo, motorSub, m.txt, motorClase, externoActivo ? '☁️' : '⚙️') +
            '</div>' +
            '<div class="fl-nota">' + (p && p.prompt
                ? '«' + esc(String(p.prompt).slice(0, 90)) + (String(p.prompt).length > 90 ? '…' : '') + '»'
                : 'Sin trabajo en curso: la cadena se prende cuando pedís algo.') + '</div>';
    }

    function cargar() {
        Promise.all([
            get('/api/status'),
            get('/api/pedidos'),
            get('/api/config/comfy-externo')
        ]).then(function (r) {
            D.status = r[0] || {};
            var pd = r[1] || {};
            D.pedidos = pd.pedidos || pd.lista || [];
            D.externo = r[2] || {};
            pintar();
        });
    }

    window.CKFlujo = { cargar: cargar, pintar: pintar };

    setInterval(function () {
        if (document.getElementById('ckFlujo')) { cargar(); }
    }, 2500);
    // el paso x/N cambia más rápido: repintar seguido con lo que ya tenemos
    setInterval(function () {
        if (document.getElementById('ckFlujo')) { pintar(); }
    }, 700);
    setTimeout(cargar, 1200);
})();
