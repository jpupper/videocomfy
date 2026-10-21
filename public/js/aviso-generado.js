/* ============================================================
 * AVISO DE GENERACIÓN TERMINADA — estallido de partículas verdes
 * ------------------------------------------------------------
 * Pedido explícito: cuando una imagen (o un video) termina de generarse,
 * sea en LOCAL o en la WEB, tiene que aparecer abajo a la IZQUIERDA un aviso
 * chico con un estallido de partículas verdes. No un cartel que tape la app.
 *
 * Se alimenta de:
 *   - CKPedidos (store único): un pedido que pasa a listo / sin_nube
 *   - mensajes del WS (media_en_nube / storyboard_generated / video_generated)
 *   - el evento 'jpi-generado'
 * Dedupe por archivo: el mismo resultado no avisa dos veces.
 * ============================================================ */
(function () {
    'use strict';

    var VERDES = ['#22c55e', '#4ade80', '#86efac', '#a3e635', '#34d399'];
    var vistos = {};          // archivo -> ts del último aviso
    var caja = null;

    function esc(t) {
        return String(t == null ? '' : t).replace(/[&<>"]/g, function (m) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
        });
    }

    function yaMostrado(clave) {
        if (!clave) return false;
        var t = vistos[clave];
        if (t && (Date.now() - t) < 90000) return true;   // 90 s: mismo archivo, un aviso
        vistos[clave] = Date.now();
        return false;
    }

    function crearCaja() {
        if (caja && document.body.contains(caja)) return caja;
        caja = document.createElement('div');
        caja.id = 'ckAvisos';
        caja.setAttribute('aria-live', 'polite');
        document.body.appendChild(caja);
        return caja;
    }

    // ---------- partículas ----------
    function estallido(host, ancho, alto) {
        var cv = document.createElement('canvas');
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        cv.width = ancho * dpr;
        cv.height = alto * dpr;
        cv.style.width = ancho + 'px';
        cv.style.height = alto + 'px';
        cv.className = 'ck-aviso-particulas';
        host.appendChild(cv);
        var ctx = cv.getContext('2d');
        ctx.scale(dpr, dpr);

        var cx = 34, cy = alto / 2;        // el estallido nace en el icono (izquierda)
        var ps = [];
        for (var i = 0; i < 30; i++) {
            var ang = (Math.PI * 2 * i / 30) + (Math.random() * 0.5 - 0.25);
            var vel = 1.4 + Math.random() * 3.2;
            ps.push({
                x: cx, y: cy,
                vx: Math.cos(ang) * vel,
                vy: Math.sin(ang) * vel - 0.6,
                r: 1.1 + Math.random() * 2.3,
                vida: 1,
                dec: 0.012 + Math.random() * 0.016,
                c: VERDES[i % VERDES.length]
            });
        }

        var corriendo = true;
        function frame() {
            if (!corriendo) return;
            ctx.clearRect(0, 0, ancho, alto);
            var vivos = 0;
            for (var i = 0; i < ps.length; i++) {
                var p = ps[i];
                if (p.vida <= 0) continue;
                vivos++;
                p.x += p.vx; p.y += p.vy;
                p.vy += 0.075;            // gravedad suave
                p.vx *= 0.985; p.vy *= 0.985;
                p.vida -= p.dec;
                ctx.globalAlpha = Math.max(0, p.vida);
                ctx.fillStyle = p.c;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
            if (vivos > 0) requestAnimationFrame(frame);
            else { corriendo = false; try { cv.remove(); } catch (e) { } }
        }
        requestAnimationFrame(frame);
    }

    // ---------- aviso ----------
    function avisar(d) {
        d = d || {};
        var archivo = d.archivo || '';
        var clave = archivo || ('gen-' + Math.round(Date.now() / 5000));
        if (yaMostrado(clave)) return;

        var host = crearCaja();
        var esVideo = /\.(mp4|webm|mov|mkv)$/i.test(archivo);
        var el = document.createElement('div');
        el.className = 'ck-aviso';
        el.innerHTML =
            '<div class="ck-aviso-icono">' + (esVideo ? '🎬' : '🖼️') + '</div>' +
            '<div class="ck-aviso-txt">' +
            '  <b>' + (esVideo ? 'Video listo' : 'Imagen lista') + '</b>' +
            '  <span>' + esc(archivo || 'recién generada') + '</span>' +
            (d.nodo ? '  <em>' + esc(d.nodo) + '</em>' : '') +
            '</div>';
        host.appendChild(el);
        estallido(el, el.offsetWidth || 300, el.offsetHeight || 58);

        // máximo 3 avisos a la vez: el más viejo se va
        while (host.children.length > 3) host.removeChild(host.firstChild);

        requestAnimationFrame(function () { el.classList.add('ck-aviso-in'); });
        setTimeout(function () {
            el.classList.add('ck-aviso-out');
            setTimeout(function () { try { el.remove(); } catch (e) { } }, 450);
        }, 4200);
    }

    // ---------- estilos (una sola vez) ----------
    (function estilos() {
        if (document.getElementById('ckAvisoEstilos')) return;
        var st = document.createElement('style');
        st.id = 'ckAvisoEstilos';
        st.textContent = [
            '#ckAvisos{position:fixed;left:18px;bottom:18px;z-index:9998;display:flex;flex-direction:column;gap:8px;pointer-events:none;max-width:min(78vw,380px)}',
            '.ck-aviso{position:relative;display:flex;align-items:center;gap:10px;padding:9px 14px 9px 10px;',
            'background:rgba(8,20,14,.94);border:1px solid rgba(34,197,94,.55);border-left:3px solid #22c55e;',
            'border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.45),0 0 18px rgba(34,197,94,.18);',
            'color:#e8fff1;font-family:inherit;transform:translateY(14px);opacity:0;transition:transform .28s ease,opacity .28s ease}',
            '.ck-aviso.ck-aviso-in{transform:translateY(0);opacity:1}',
            '.ck-aviso.ck-aviso-out{transform:translateY(10px);opacity:0}',
            '.ck-aviso-icono{font-size:1.15rem;line-height:1;filter:drop-shadow(0 0 6px rgba(34,197,94,.8))}',
            '.ck-aviso-txt{display:flex;flex-direction:column;line-height:1.25;min-width:0}',
            '.ck-aviso-txt b{font-size:.82rem;color:#bbf7d0;letter-spacing:.02em}',
            '.ck-aviso-txt span{font-size:.76rem;color:#dcfce7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '.ck-aviso-txt em{font-size:.68rem;color:#86efac;font-style:normal;opacity:.85}',
            '.ck-aviso-particulas{position:absolute;left:0;top:0;pointer-events:none}'
        ].join('');
        document.head.appendChild(document.createElement('style')).textContent = st.textContent;
    })();

    // ---------- de dónde salen los avisos ----------
    window.CKAviso = {
        avisar: avisar,
        msg: function (m) {
            if (!m || !m.type) return;
            if (m.type === 'media_en_nube') {
                avisar({ archivo: m.filename, nodo: m.nodo || '' });
                return;
            }
            if (m.type === 'storyboard_generated' || m.type === 'video_generated') {
                // en la web todavía falta subirlo (el aviso llega con media_en_nube);
                // en local lo generado ya está en el disco: este ES el final.
                var deLaWeb = (m.origen === 'web' || m.origen === 'red');
                if (!deLaWeb) avisar({ archivo: m.filename, nodo: m.nodo || '' });
            }
        }
    };

    window.addEventListener('jpi-generado', function (ev) {
        // si el WS no trajo el archivo, el store de pedidos lo resuelve abajo
        var d = (ev && ev.detail) || {};
        if (d.archivo) avisar({ archivo: d.archivo, nodo: d.nodo || '' });
    });

    // Red de seguridad: el registro de pedidos es la fuente de verdad.
    (function engancharStore() {
        if (!window.CKPedidos || !window.CKPedidos.suscribir) { setTimeout(engancharStore, 800); return; }
        var conocidos = {};
        window.CKPedidos.suscribir(function (store) {
            (store.lista || []).forEach(function (p) {
                if (!p || !p.archivo) return;
                if (p.estado !== 'listo' && p.estado !== 'sin_nube') return;
                if (conocidos[p.id]) return;
                conocidos[p.id] = 1;
                avisar({ archivo: p.archivo, nodo: (p.computadora && p.computadora.nombre) || '' });
            });
        });
    })();
})();
