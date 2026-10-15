// ============================================================
// COMFYLATAM — entorno (WEB / LOCAL), panel izquierdo, SETTINGS y
// la barra de energía ciberpunk mientras genera.
// ------------------------------------------------------------
// 1. Píldora en el header que dice DÓNDE está corriendo: 🌐 WEB o 💻 LOCAL.
// 2. Bloque en el panel izquierdo con: entorno, ComfyUI en uso, estado y
//    un acceso directo a SETTINGS.
// 3. Pestaña SETTINGS: se le pone la dirección del ComfyUI (local, red o
//    RunPod). Se guarda en la app (que reconecta sola).
// 4. La barra de progreso se convierte en barra de energía cuando genera.
// ============================================================
(function () {
    'use strict';

    if (!window.JPI) return;
    var API = window.JPI.API_BASE;
    var esWeb = !window.JPI.esServidor;

    function api(ruta, opciones) {
        return fetch(API + ruta, opciones).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (d) {
                return { ok: r.ok, status: r.status, data: d };
            });
        });
    }

    // --- 1) píldora de entorno en el header --------------------------------
    function pintarEntorno() {
        var pill = document.createElement('span');
        pill.id = 'ckEntornoPill';
        pill.className = 'ck-entorno-pill ' + (esWeb ? 'ck-web' : 'ck-local');
        pill.innerHTML = esWeb ? '🌐 WEB' : '💻 LOCAL';
        pill.title = esWeb
            ? 'Corriendo en la web: genera la PC conectada, a través del VPS.'
            : 'Corriendo en tu máquina: usa el ComfyUI de esta PC.';

        var ancla = document.getElementById('jpiEstado');
        if (ancla && ancla.parentNode) ancla.parentNode.insertBefore(pill, ancla);
        else {
            var h1 = document.querySelector('header h1, .sectionheader h1, h1');
            if (h1 && h1.parentNode) h1.parentNode.insertBefore(pill, h1.nextSibling);
            else document.body.appendChild(pill);
        }
    }

    // --- 2) bloque en el panel izquierdo ----------------------------------
    function pintarPanelIzq() {
        var sidebar = document.querySelector('.sidebar-left') || document.querySelector('aside');
        if (!sidebar) return;
        var caja = document.createElement('div');
        caja.className = 'ck-panel-izq';
        caja.innerHTML =
            '<div class="ck-pi-titulo">⚡ COMFYLATAM</div>' +
            '<div class="ck-pi-fila"><span class="ck-pi-clave">Entorno</span><span class="ck-pi-valor" id="ckPiEntorno">—</span></div>' +
            '<div class="ck-pi-fila"><span class="ck-pi-clave">ComfyUI</span><span class="ck-pi-valor" id="ckPiComfy">—</span></div>' +
            '<div class="ck-pi-fila"><span class="ck-pi-clave">Estado</span><span class="ck-pi-valor" id="ckPiEstado">—</span></div>' +
            '<button id="ckPiSettings">⚙️ Configurar ComfyUI</button>';
        sidebar.insertBefore(caja, sidebar.firstChild);
        document.getElementById('ckPiSettings').addEventListener('click', function () {
            var b = document.getElementById('tabSettingsBtn');
            if (b) b.click();
        });
    }

    function actualizarVistas() {
        var piEnt = document.getElementById('ckPiEntorno');
        var piComfy = document.getElementById('ckPiComfy');
        var piEstado = document.getElementById('ckPiEstado');
        if (piEnt) piEnt.textContent = esWeb ? '🌐 WEB' : '💻 LOCAL';

        api('/api/config/comfy').then(function (r) {
            var d = r.data || {};
            if (piComfy) piComfy.textContent = d.base || '—';
            var inp = document.getElementById('ckComfyAddress');
            if (inp && !inp.value) inp.value = d.address || '';
            var est = document.getElementById('ckComfyEstado');
            if (est) {
                est.innerHTML =
                    '<div><b>Dirección:</b> ' + (d.address || '—') + '</div>' +
                    '<div><b>Base HTTP:</b> ' + (d.base || '—') + '</div>' +
                    '<div><b>WebSocket:</b> ' + (d.ws || '—') + '</div>' +
                    '<div><b>Tipo:</b> ' + (d.esLocal ? 'local (esta máquina)' : 'remoto (red / nube)') + '</div>' +
                    '<div><b>Conectado:</b> ' + (d.conectado ? '✅ sí' : '❌ no') + '</div>';
            }
        }).catch(function () { });

        api('/api/status').then(function (r) {
            var d = r.data || {};
            if (piEstado) piEstado.textContent = d.comfy ? '🟢 conectado' : '🔴 sin ComfyUI';
            var det = document.getElementById('ckSetDetalle');
            if (det) {
                det.innerHTML =
                    '<div><b>Entorno:</b> ' + (esWeb ? '🌐 WEB (genera la PC conectada, vía VPS)' : '💻 LOCAL (esta máquina)') + '</div>' +
                    '<div><b>Estado:</b> ' + (d.mensaje || '—') + '</div>' +
                    '<div><b>ComfyUI:</b> ' + (d.comfyBase || '—') + '</div>';
            }
            var se = document.getElementById('ckSetEntorno');
            if (se) se.textContent = esWeb ? 'la web' : 'esta máquina';
        }).catch(function () { });
    }

    // --- 3) SETTINGS: guardar / probar ------------------------------------
    function conectarSettings() {
        var inp = document.getElementById('ckComfyAddress');
        var btn = document.getElementById('ckComfyGuardar');
        var btnProbar = document.getElementById('ckComfyProbar');
        var msg = document.getElementById('ckComfyMsg');
        if (!inp || !btn) return;

        function decir(txt, tipo) {
            if (!msg) return;
            msg.className = 'ck-set-msg ' + (tipo || '');
            msg.textContent = txt;
        }

        btn.addEventListener('click', function () {
            var dir = (inp.value || '').trim();
            if (!dir) { decir('Escribí una dirección.', 'err'); return; }
            btn.disabled = true;
            decir('Guardando…');
            api('/api/config/comfy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address: dir })
            }).then(function (r) {
                btn.disabled = false;
                if (!r.ok) { decir((r.data && r.data.message) || 'No se pudo guardar.', 'err'); return; }
                decir('✅ Guardado: ' + r.data.base + ' — reconectando…', 'ok');
                setTimeout(actualizarVistas, 1500);
            }).catch(function () {
                btn.disabled = false;
                decir('No se pudo contactar la app.', 'err');
            });
        });

        if (btnProbar) {
            btnProbar.addEventListener('click', function () {
                decir('Probando…');
                api('/api/status').then(function (r) {
                    var d = r.data || {};
                    decir(d.comfy
                        ? '✅ ComfyUI responde en ' + (d.comfyBase || '')
                        : '❌ No responde: ' + (d.mensaje || ''), d.comfy ? 'ok' : 'err');
                }).catch(function () { decir('No se pudo contactar la app.', 'err'); });
            });
        }
    }

    // --- 4) barra de energía ----------------------------------------------
    function energia() {
        var bg = document.querySelector('.progress-bar-bg');
        if (!bg) return;

        // La chispa/glow de la barra se sacó a pedido (aparecía en posiciones
        // raras). Se deja un elemento oculto por compatibilidad con el CSS.
        var chispa = document.createElement('div');
        chispa.className = 'ck-chispa';
        chispa.style.display = 'none';

        function tick() {
            var generando = false;
            try {
                var e = window.jpiColaEstado && window.jpiColaEstado();
                generando = !!(e && (e.generando || e.enCurso > 0));
            } catch (err) { }
            document.body.classList.toggle('ck-generando', generando);

            var fill = document.getElementById('progressFill');
            if (fill) {
                var w = fill.style.width || fill.getBoundingClientRect().width + 'px';
                chispa.style.left = (fill.getBoundingClientRect().right - 5) + 'px';
            }
        }

        setInterval(tick, 700);
        tick();
    }

    function init() {
        pintarEntorno();
        // El bloque de ENTORNO ya no va en el panel izquierdo: vive en la
        // pestaña RED (ver red.js → bloqueEquipo). El panel izq queda limpio.
        /* pintarPanelIzq(); -> movido a la pestaña RED */
        conectarSettings();
        energia();
        actualizarVistas();
        setInterval(actualizarVistas, 15000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
