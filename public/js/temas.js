// ============================================================
// COMFYLATAM · TEMAS  (el generador de temas y el fondo animado)
// ------------------------------------------------------------
// Un solo lugar decide los colores de TODA la app: los tokens de css/tema.css.
// Acá sólo se elige el tema (data-tema en <html>), el fondo y el velo; todo se
// guarda en localStorage y se aplica antes del primer pintado.
//
// Para una caja nueva NO se escribe un color a mano: class="ck-caja" y
// var(--ck-*) (ver css/GUIA-DE-ESTILOS.md).
// ============================================================
(function () {
    'use strict';

    var CLAVE = 'ck_tema';
    var CLAVE_FONDO = 'ck_tema_fondo';
    var CLAVE_VELO = 'ck_tema_velo';

    var TEMAS = [
        { id: 'noche',  nombre: 'NOCHE',  desc: 'el de siempre: azul profundo y turquesa', c: ['#04121a', '#08161f', '#00ffd5'] },
        { id: 'matrix', nombre: 'MATRIX', desc: 'negro puro y verde fósforo', c: ['#000000', '#05100a', '#39ff88'] },
        { id: 'amoled', nombre: 'AMOLED', desc: 'negro absoluto, para OLED', c: ['#000000', '#0c0c0c', '#7c9cff'] },
        { id: 'cyber',  nombre: 'CYBER',  desc: 'violeta con magenta y cian', c: ['#0b0616', '#150c26', '#ff2fd0'] },
        { id: 'brasa',  nombre: 'BRASA',  desc: 'rojo y naranja de horno', c: ['#140a06', '#21100a', '#ff7a1a'] }
        // (falta un tema CLARO: el CSS viejo tiene textos blancos fijos y se
        //  rompe la legibilidad. Se agrega cuando se migren esos estilos.)
    ];

    // Fondos shader: los que se pueden poner detrás de la app.
    // El include (jpshadereditor) pinta un canvas con z-index:-1.
    var BASE_SHADER = 'https://vps-4455523-x.dattaweb.com/jpshadereditor';
    var FONDOS = [
        { id: '',               nombre: 'SIN FONDO',   desc: 'el color del tema, nada más' },
        { id: 'neon-matrix-v6', nombre: 'NEON MATRIX', desc: 'líneas verticales y horizontales que se conectan' }
    ];

    function leer(k, def) { try { var v = localStorage.getItem(k); return v === null ? def : v; } catch (e) { return def; } }
    function guardar(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }

    function actual() {
        var t = document.documentElement.getAttribute('data-tema') || leer(CLAVE, 'noche');
        return TEMAS.some(function (x) { return x.id === t; }) ? t : 'noche';
    }

    function aplicar(id) {
        if (!TEMAS.some(function (x) { return x.id === id; })) id = 'noche';
        document.documentElement.setAttribute('data-tema', id);
        guardar(CLAVE, id);
        pintarActivo();
    }

    function veloActual() {
        var v = parseFloat(leer(CLAVE_VELO, '0.62'));
        return isNaN(v) ? 0.62 : v;
    }

    function aplicarVelo(v) {
        v = Math.max(0.15, Math.min(0.95, Number(v) || 0.62));
        document.documentElement.style.setProperty('--ck-velo', String(v));
        guardar(CLAVE_VELO, String(v));
    }

    // ---- fondo animado: se inyecta el include de jpshadereditor ------------
    function quitarFondo() {
        document.documentElement.classList.remove('ck-shader');
        var s = document.getElementById('ckShaderInclude');
        if (s) s.parentNode.removeChild(s);
        var cv = document.querySelectorAll('canvas[data-jpsi], #jpsi-bg, canvas.jpsi-bg');
        cv.forEach(function (c) { try { c.remove(); } catch (e) { } });
    }

    function ponerFondo(shader) {
        quitarFondo();
        if (!shader) { guardar(CLAVE_FONDO, ''); return; }
        document.documentElement.classList.add('ck-shader');
        aplicarVelo(veloActual());
        var s = document.createElement('script');
        s.id = 'ckShaderInclude';
        s.src = BASE_SHADER + '/include.js?b=' + Date.now();
        s.setAttribute('data-shader', shader);
        s.setAttribute('data-base', BASE_SHADER);
        s.setAttribute('data-auth', '0');          // acá no hace falta el panel
        s.setAttribute('data-page', 'comfylatam-tema');
        document.head.appendChild(s);
        guardar(CLAVE_FONDO, shader);
    }

    function fondoActual() { return leer(CLAVE_FONDO, ''); }

    // ---- modal -------------------------------------------------------------
    var modal = null;

    function construir() {
        if (modal) return modal;
        modal = document.createElement('div');
        modal.id = 'ckTemaModal';
        modal.innerHTML =
            '<div id="ckTemaCaja" class="ck-caja" style="margin:0">' +
            '  <div class="ck-tema-hd">' +
            '    <h3 class="ck-titulo">🎨 TEMAS · COMFYLATAM</h3>' +
            '    <button class="ck-btn" id="ckTemaCerrar">CERRAR</button>' +
            '  </div>' +
            '  <div class="ck-tema-body">' +
            '    <p class="ck-sub">El tema cambia TODA la app. Los contenedores nuevos ya usan estos colores ' +
            '    (var(--ck-*)), así que no hay que tocar nada más.</p>' +
            '    <div class="ck-tema-grid" id="ckTemaGrid" style="margin-top:10px"></div>' +
            '    <div class="ck-sep"></div>' +
            '    <div class="ck-caja-hd"><h4 class="ck-titulo">FONDO ANIMADO</h4>' +
            '      <span class="ck-chip" id="ckFondoEstado">—</span></div>' +
            '    <p class="ck-sub">Se dibuja con el include de JP Shader Editor (canvas detrás de la app). ' +
            '    Si la PC va lenta, dejalo en SIN FONDO.</p>' +
            '    <div id="ckFondoGrid" class="ck-tema-grid" style="margin-top:10px"></div>' +
            '    <div style="display:flex;align-items:center;gap:10px;margin-top:12px">' +
            '      <label class="ck-sub" style="min-width:86px;margin:0">VELO</label>' +
            '      <input type="range" id="ckVelo" min="0.15" max="0.95" step="0.01" style="flex:1">' +
            '      <span class="ck-sub" id="ckVeloVal" style="min-width:36px;text-align:right;margin:0">—</span>' +
            '    </div>' +
            '  </div>' +
            '</div>';
        document.body.appendChild(modal);

        modal.addEventListener('click', function (e) { if (e.target === modal) cerrar(); });
        modal.querySelector('#ckTemaCerrar').addEventListener('click', cerrar);

        var velo = modal.querySelector('#ckVelo');
        velo.addEventListener('input', function () {
            aplicarVelo(velo.value);
            modal.querySelector('#ckVeloVal').textContent = Number(velo.value).toFixed(2);
        });
        return modal;
    }

    function pintarActivo() {
        if (!modal) return;
        var act = actual();
        modal.querySelectorAll('[data-tema-id]').forEach(function (b) {
            b.classList.toggle('activo', b.getAttribute('data-tema-id') === act);
        });
        var f = fondoActual();
        modal.querySelectorAll('[data-fondo-id]').forEach(function (b) {
            b.classList.toggle('activo', b.getAttribute('data-fondo-id') === f);
        });
        var chip = modal.querySelector('#ckFondoEstado');
        if (chip) {
            if (!f) { chip.className = 'ck-chip'; chip.textContent = 'SIN FONDO'; }
            else { chip.className = 'ck-chip ok'; chip.textContent = 'ACTIVO · ' + f; }
        }
        var v = veloActual();
        var vi = modal.querySelector('#ckVelo');
        if (vi) vi.value = v;
        var vv = modal.querySelector('#ckVeloVal');
        if (vv) vv.textContent = v.toFixed(2);
    }

    function abrir() {
        construir();
        var g = modal.querySelector('#ckTemaGrid');
        if (g && !g.childNodes.length) {
            TEMAS.forEach(function (t) {
                var b = document.createElement('button');
                b.className = 'ck-tema-card';
                b.setAttribute('data-tema-id', t.id);
                b.innerHTML = '<span class="ck-tema-muestra">' +
                    '<i style="background:' + t.c[0] + '"></i>' +
                    '<i style="background:' + t.c[1] + '"></i>' +
                    '<i style="background:' + t.c[2] + '"></i></span>' +
                    '<span class="ck-tema-nombre">' + t.nombre + '</span>' +
                    '<span class="ck-tema-desc">' + t.desc + '</span>';
                b.addEventListener('click', function () { aplicar(t.id); });
                g.appendChild(b);
            });
        }
        var gf = modal.querySelector('#ckFondoGrid');
        if (gf && !gf.childNodes.length) {
            FONDOS.forEach(function (f) {
                var b = document.createElement('button');
                b.className = 'ck-tema-card';
                b.setAttribute('data-fondo-id', f.id);
                b.innerHTML = '<span class="ck-tema-nombre">' + f.nombre + '</span>' +
                    '<span class="ck-tema-desc">' + f.desc + '</span>';
                b.addEventListener('click', function () { ponerFondo(f.id); pintarActivo(); });
                gf.appendChild(b);
            });
        }
        pintarActivo();
        modal.classList.add('abierto');
    }

    function cerrar() { if (modal) modal.classList.remove('abierto'); }

    // ---- botón en la barra de pestañas -------------------------------------
    function montarBoton() {
        if (document.getElementById('ckTemaBtn')) return;
        var cont = document.querySelector('.tabs-container') || document.querySelector('.ck-tabs');
        if (!cont) { setTimeout(montarBoton, 800); return; }
        var b = document.createElement('button');
        b.id = 'ckTemaBtn';
        b.className = 'tab-button tab-button-std ck-tab';
        b.title = 'Temas: color de toda la app y fondo animado';
        b.textContent = '🎨 TEMAS';
        b.addEventListener('click', abrir);
        cont.appendChild(b);
    }

    // ---- arranque ----------------------------------------------------------
    aplicar(actual());
    aplicarVelo(veloActual());
    if (fondoActual()) ponerFondo(fondoActual());
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', montarBoton);
    else montarBoton();

    window.CKtema = {
        aplicar: aplicar, actual: actual, temas: TEMAS,
        ponerFondo: ponerFondo, quitarFondo: quitarFondo, fondoActual: fondoActual,
        abrir: abrir, cerrar: cerrar
    };
})();
