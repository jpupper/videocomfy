// ============================================================
// COMFYLATAM - paneles laterales estirables
// ------------------------------------------------------------
// El layout es un grid: var(--sidebar-left-w) 1fr var(--sidebar-right-w).
// Acá se agregan dos manijas invisibles en el borde interior de cada panel:
// arrastrás y cambia el ancho (se guarda en localStorage). Doble click =
// vuelve al ancho por defecto. Si un panel está colapsado, la manija se esconde.
// ============================================================
(function () {
    'use strict';

    var CLAVE_L = 'comfylatam_w_izq';
    var CLAVE_R = 'comfylatam_w_der';
    var MIN = 220, MAX = 780;
    var DEF_L = 340, DEF_R = 380;

    function setVar(nombre, px) {
        document.documentElement.style.setProperty(nombre, px + 'px');
    }

    function restaurar() {
        try {
            var l = parseInt(localStorage.getItem(CLAVE_L) || '0', 10);
            var r = parseInt(localStorage.getItem(CLAVE_R) || '0', 10);
            if (l >= MIN && l <= MAX) setVar('--sidebar-left-w', l);
            if (r >= MIN && r <= MAX) setVar('--sidebar-right-w', r);
        } catch (e) { /* modo privado */ }
    }

    function panel(lado) {
        return document.querySelector(lado === 'izq' ? '.sidebar-left' : '.sidebar-right');
    }

    function ubicar() {
        [['izq', '.red-resizer.izq'], ['der', '.red-resizer.der']].forEach(function (par) {
            var el = document.querySelector(par[1]);
            var p = panel(par[0]);
            if (!el || !p) return;
            var r = p.getBoundingClientRect();
            // colapsado (tira fina) o panel oculto (mobile): sin manija
            if (r.width < 90 || r.height < 100) { el.style.display = 'none'; return; }
            el.style.display = 'block';
            el.style.top = Math.round(r.top) + 'px';
            el.style.height = Math.round(r.height) + 'px';
            el.style.left = Math.round((par[0] === 'izq' ? r.right : r.left) - 4) + 'px';
        });
    }

    function crear(lado) {
        var h = document.createElement('div');
        h.className = 'red-resizer ' + (lado === 'izq' ? 'izq' : 'der');
        h.title = 'Arrastrá para estirar · doble click para volver al tamaño original';
        document.body.appendChild(h);

        var arrastrando = false;

        h.addEventListener('mousedown', function (e) {
            e.preventDefault();
            arrastrando = true;
            document.body.classList.add('red-arrastrando');
        });

        window.addEventListener('mousemove', function (e) {
            if (!arrastrando) return;
            var p = panel(lado);
            if (!p) return;
            var r = p.getBoundingClientRect();
            var w = (lado === 'izq') ? (e.clientX - r.left) : (r.right - e.clientX);
            w = Math.max(MIN, Math.min(MAX, Math.round(w)));
            setVar(lado === 'izq' ? '--sidebar-left-w' : '--sidebar-right-w', w);
            ubicar();
        });

        window.addEventListener('mouseup', function () {
            if (!arrastrando) return;
            arrastrando = false;
            document.body.classList.remove('red-arrastrando');
            var p = panel(lado);
            if (!p) return;
            var w = Math.round(p.getBoundingClientRect().width);
            try { localStorage.setItem(lado === 'izq' ? CLAVE_L : CLAVE_R, String(w)); } catch (e2) { }
        });

        h.addEventListener('dblclick', function () {
            setVar(lado === 'izq' ? '--sidebar-left-w' : '--sidebar-right-w', lado === 'izq' ? DEF_L : DEF_R);
            ubicar();
            try { localStorage.removeItem(lado === 'izq' ? CLAVE_L : CLAVE_R); } catch (e) { }
        });

        return h;
    }

    function arrancar() {
        if (!document.querySelector('.sidebar-left') && !document.querySelector('.sidebar-right')) return;
        restaurar();
        crear('izq');
        crear('der');
        ubicar();
        window.addEventListener('resize', ubicar);
        document.addEventListener('scroll', ubicar, true);
        // rodny agregó colapsar/expandir: la manija se reacomoda sola
        setInterval(ubicar, 800);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar);
    else arrancar();

    window.comfyPaneles = { ubicar: ubicar, ancho: function (l) { var p = panel(l); return p ? Math.round(p.getBoundingClientRect().width) : 0; } };
})();
