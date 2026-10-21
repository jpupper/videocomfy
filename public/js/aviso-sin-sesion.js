/* ============================================================
 * WEB SIN SESIÓN: cartel claro para entrar con la cuenta
 * ------------------------------------------------------------
 * En la web (no en la app local) si no hay token del ecosistema se muestra un
 * aviso abajo al centro: "estás viendo COMFYLATAM sin cuenta". Se puede cerrar
 * y no vuelve por 2 horas; si aparece el token, se va solo.
 * ============================================================ */
(function () {
    'use strict';

    function esWeb() {
        var h = String(location.hostname || '');
        return !/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(h);
    }
    function hayToken() {
        var claves = ['fsc_token_jpi', 'fsc_token', 'token'];
        for (var i = 0; i < claves.length; i++) {
            try {
                var t = localStorage.getItem(claves[i]);
                if (t && String(t).split('.').length === 3) return true;
            } catch (e) { }
        }
        return false;
    }
    function cerrado() {
        try { return Number(localStorage.getItem('ck_aviso_sesion_off') || 0) > Date.now(); } catch (e) { return false; }
    }

    var capa = null;
    function mostrar() {
        if (!esWeb() || hayToken() || cerrado() || document.getElementById('ckSinSesion')) return;
        capa = document.createElement('div');
        capa.id = 'ckSinSesion';
        capa.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:9999;' +
            'display:flex;align-items:center;gap:12px;padding:11px 16px;border-radius:12px;' +
            'background:rgba(10,20,28,.96);border:1px solid rgba(245,158,11,.55);' +
            'box-shadow:0 12px 30px rgba(0,0,0,.45);color:#fef3c7;font:inherit;max-width:92vw';
        capa.innerHTML =
            '<span style="font-size:1.15rem">🔑</span>' +
            '<div style="display:flex;flex-direction:column;line-height:1.3">' +
            '  <b style="font-size:.85rem">Estás viendo COMFYLATAM sin cuenta</b>' +
            '  <span style="font-size:.75rem;opacity:.85">Entrá para generar, ver tus assets y tu registro.</span>' +
            '</div>' +
            '<button id="ckSinSesionLogin" style="cursor:pointer;border:0;border-radius:8px;padding:7px 12px;' +
            'background:#f59e0b;color:#1a1206;font-weight:700;font-size:.8rem">ENTRAR</button>' +
            '<button id="ckSinSesionCerrar" title="Cerrar" style="cursor:pointer;background:none;border:0;' +
            'color:#fef3c7;opacity:.7;font-size:1rem">✕</button>';
        document.body.appendChild(capa);
        document.getElementById('ckSinSesionLogin').addEventListener('click', function () {
            var b = document.getElementById('jpiCuentaBtn') || document.getElementById('loginBtn') ||
                [...document.querySelectorAll('button')].find(function (x) { return /LOGIN/i.test(x.textContent || ''); });
            if (b) b.click(); else alert('Usá el botón LOGIN de arriba.');
        });
        document.getElementById('ckSinSesionCerrar').addEventListener('click', function () {
            try { localStorage.setItem('ck_aviso_sesion_off', String(Date.now() + 2 * 60 * 60 * 1000)); } catch (e) { }
            if (capa) capa.remove();
        });
    }

    setTimeout(mostrar, 2500);
    setInterval(function () {
        var c = document.getElementById('ckSinSesion');
        if (c && hayToken()) c.remove();
        if (!c) mostrar();
    }, 8000);
})();
