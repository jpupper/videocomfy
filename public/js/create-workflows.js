// ============================================================
// CREATE: a qué archivo de workflow corresponde cada cosa
// ------------------------------------------------------------
// Cuando elegís un workflow (las tarjetas de CREATE) o un motor de imagen,
// acá te dice EXACTAMENTE qué archivo de workflows/ se va a usar.
// ============================================================
(function () {
    'use strict';

    // qué archivo(s) usa cada tarjeta de CREATE
    var POR_TARJETA = {
        t2i: ['flux_dev_fp8_api.json'],
        t2v: ['video_ltx2_t2v_api.json'],
        t2i2v: ['flux_dev_fp8_api.json', 'video_ltx2_t2v_api.json'],
        i2v: ['video_ltx25_i2v_api.json'],
        chainvideo: ['video_wan2_2_14B_flf2v_api.json'],
        storyboard: ['flux_dev_full_text_to_image_api.json']
    };
    // motores de imagen (el select del pipeline)
    var POR_MOTOR = {
        zimage: 'z_image_turbo_api.json',
        qwen21: 'qwen_image_21_api.json',
        flux: 'flux_dev_fp8_api.json'
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

    function motorElegido() {
        var sel = document.getElementById('imgEngineSelect');
        return sel ? sel.value : null;
    }

    // anota cada tarjeta con su archivo
    function anotarTarjetas() {
        document.querySelectorAll('.wf-card').forEach(function (c) {
            var wf = POR_TARJETA[c.getAttribute('data-workflow')];
            if (!wf || c.querySelector('.wf-card-archivo')) return;
            var s = document.createElement('span');
            s.className = 'wf-card-archivo';
            s.textContent = '🔧 ' + wf.join(' + ');
            s.title = 'Archivo(s) en la carpeta workflows/ que usa esta opción';
            c.appendChild(s);
        });
    }

    // el cartel grande con el workflow actual
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
        var archivos = POR_TARJETA[t] || [];
        var lineas = [];
        if (archivos.length) {
            lineas.push('<span class="wf-arch-tag">workflow</span> <b>' + esc(archivos.join('</b> + <b>')) + '</b>');
        }
        var m = motorElegido();
        if (m && POR_MOTOR[m]) {
            lineas.push('<span class="wf-arch-tag">imagen</span> <b>' + esc(POR_MOTOR[m]) + '</b>');
        }
        // los que la tarjeta usa pero son de video, se aclaran aparte
        if (t === 't2v') lineas.push('<span class="wf-arch-tag">imagen</span> <b>no usa</b> (video directo)');
        c.innerHTML = lineas.length
            ? '🔧 Se va a usar: ' + lineas.join(' &nbsp;·&nbsp; ') +
              '<span class="wf-arch-nota">todo desde la carpeta <b>workflows/</b></span>'
            : '';
        c.style.display = lineas.length ? 'flex' : 'none';
    }

    function refrescar() {
        anotarTarjetas();
        pintar();
    }

    function arrancar() {
        refrescar();
        // al elegir tarjeta o cambiar el motor, se actualiza
        document.addEventListener('click', function (e) {
            if (e.target.closest && e.target.closest('.wf-card')) setTimeout(refrescar, 60);
        });
        var sel = document.getElementById('imgEngineSelect');
        if (sel) sel.addEventListener('change', function () { setTimeout(refrescar, 60); });
        // por si el HTML se re-renderiza
        setInterval(refrescar, 4000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(arrancar, 1500); });
    else setTimeout(arrancar, 1500);

    window.WF_CREATE = { refrescar: refrescar, mapa: POR_TARJETA, motores: POR_MOTOR };
})();
