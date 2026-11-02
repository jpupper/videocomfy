// ============================================================
// CREATE: qué modelo usa la tarjeta activa (nombre legible)
// ------------------------------------------------------------
// Muestra un cartel con el MODELO que se va a usar. Ya no se
// muestran nombres de archivo .json (confundían).
// ============================================================
(function () {
    'use strict';

    var NOMBRES = {
        t2i: 'FLUX dev fp8 (imagen)',
        t2v: 'LTX 2.5 (texto→video)',
        t2i2v: 'FLUX + LTX 2.5 (imagen→video)',
        i2v: 'LTX 2.5 (imagen→video)',
        fasth3: 'FAST H3 (MiniMax OmniRef)',
        storyboard: 'FLUX dev full (storyboard)',
        ideogram4: 'Ideogram 4 (sectores)',
        flux3klein: 'FLUX 3 Klein Edit (edición)',
        zimage: 'Z-Image Turbo',
        qwen21: 'Qwen 2.1'
    };

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    function tarjetaActiva() {
        var b = document.querySelector('.wf-card.active');
        return b ? b.getAttribute('data-workflow') : null;
    }

    function cartel() {
        var c = document.getElementById('wfArchivoActual');
        if (c) return c;
        var cards = document.querySelector('.wf-cards-container') || document.querySelector('.wf-card');
        if (!cards) return null;
        var cont = cards.closest('.wf-cards-container') || cards.parentElement;
        c = document.createElement('div');
        c.id = 'wfArchivoActual';
        c.className = 'wf-archivo-actual';
        if (cont && cont.parentElement) cont.parentElement.insertBefore(c, cont.nextSibling);
        else if (cont) cont.appendChild(c);
        return c;
    }

    function pintar() {
        var c = cartel();
        if (!c) return;
        var t = tarjetaActiva();
        var nombre = NOMBRES[t] || '';
        c.innerHTML = nombre
            ? '🎯 Se va a usar: <b>' + esc(nombre) + '</b>'
            : '';
        c.style.display = nombre ? 'flex' : 'none';
    }

    function arrancar() {
        pintar();
        document.addEventListener('click', function (e) {
            if (e.target.closest && e.target.closest('.wf-card')) setTimeout(pintar, 60);
        });
        setInterval(pintar, 4000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(arrancar, 1500); });
    else setTimeout(arrancar, 1500);
})();
