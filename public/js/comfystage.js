// ============================================================
// COMFYSTAGE — estado del motor ComfyUI + su consola (sólo local)
// ------------------------------------------------------------
// Mapea el recorrido real de ComfyUI y lo muestra en vivo:
//   apagado -> arrancando (catálogo de nodos) -> listo ->
//   cargando modelo -> generando (paso x/N) -> listo
// Los datos salen de /api/comfy/consola (log interno de ComfyUI
// + lo que manda por WebSocket).
// ============================================================
(function () {
    'use strict';

    var FASES = {
        apagado:    { txt: 'APAGADO',          color: '#ef4444', pista: 'ComfyUI no responde' },
        arrancando: { txt: 'ARRANCANDO',       color: '#f59e0b', pista: 'el motor responde, carga el catálogo de nodos' },
        listo:      { txt: 'LISTO',            color: '#10b981', pista: 'esperando trabajo' },
        modelo:     { txt: 'CARGANDO MODELO',  color: '#3b82f6', pista: 'pasando pesos a la VRAM' },
        generando:  { txt: 'GENERANDO',        color: '#8b5cf6', pista: 'trabajando' }
    };

    var construido = false;
    var seguir = true;          // auto-scroll de la consola
    var ultimoLatido = 0;
    var errores = 0;

    function esc(t) {
        return String(t == null ? '' : t).replace(/[&<>"]/g, function (m) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
        });
    }

    function construir() {
        var caja = document.getElementById('stageComfy');
        if (!caja || caja.dataset.listo) return !!caja;
        caja.dataset.listo = '1';
        caja.innerHTML = [
            '<div class="cfs-grid">',
            '  <div class="cfs-estado" id="cfsEstado">',
            '    <div class="cfs-fase-fila">',
            '      <span class="cfs-dot" id="cfsDot"></span>',
            '      <span class="cfs-fase" id="cfsFase">—</span>',
            '      <span class="cfs-hace" id="cfsHace"></span>',
            '    </div>',
            '    <div class="cfs-detalle" id="cfsDetalle">esperando datos…</div>',
            '    <div class="cfs-barra"><div class="cfs-barra-fill" id="cfsBarra"></div></div>',
            '    <div class="cfs-datos">',
            '      <div><span>Paso</span><b id="cfsPaso">—</b></div>',
            '      <div><span>Ejecutando</span><b id="cfsEjec">0</b></div>',
            '      <div><span>En espera</span><b id="cfsEspera">0</b></div>',
            '      <div><span>Modelo</span><b id="cfsModelo">—</b></div>',
            '    </div>',
            '    <div class="cfs-trabajo" id="cfsTrabajo"></div>',
            '  </div>',
            '  <div class="cfs-consola">',
            '    <div class="cfs-consola-head">',
            '      <span>CONSOLA DE COMFYUI</span>',
            '      <span class="cfs-lineas" id="cfsLineas">0 líneas</span>',
            '      <label class="cfs-seguir"><input type="checkbox" id="cfsSeguir" checked> seguir</label>',
            '    </div>',
            '    <pre class="cfs-log" id="cfsLog">conectando con ComfyUI…</pre>',
            '  </div>',
            '</div>'
        ].join('\n');
        var chk = document.getElementById('cfsSeguir');
        if (chk) {
            chk.addEventListener('change', function () { seguir = chk.checked; if (seguir) alFondo(); });
        }
        var log = document.getElementById('cfsLog');
        if (log) {
            log.addEventListener('scroll', function () {
                var abajo = (log.scrollHeight - log.scrollTop - log.clientHeight) < 40;
                if (!abajo && seguir) { seguir = false; if (chk) chk.checked = false; }
                else if (abajo && !seguir) { seguir = true; if (chk) chk.checked = true; }
            });
        }
        return true;
    }

    function alFondo() {
        var log = document.getElementById('cfsLog');
        if (log) log.scrollTop = log.scrollHeight;
    }

    function claseDeLinea(m) {
        var t = m.toLowerCase();
        if (t.indexOf('[error]') >= 0 || t.indexOf('traceback') >= 0 || t.indexOf('exception') >= 0) return 'err';
        if (t.indexOf('[warning]') >= 0 || t.indexOf('warn') >= 0) return 'warn';
        if (t.indexOf('fetch comfyregistry') >= 0 || t.indexOf('[comfyui-manager]') >= 0) return 'mg';
        if (t.indexOf('requested to load') >= 0 || t.indexOf('loaded ') >= 0) return 'pesos';
        if (t.indexOf('prompt executed') >= 0) return 'ok';
        if (t.indexOf('got prompt') >= 0) return 'pedido';
        return '';
    }

    function pintarEstado(d) {
        var f = FASES[d.fase] || FASES.apagado;
        var dot = document.getElementById('cfsDot');
        var fase = document.getElementById('cfsFase');
        var det = document.getElementById('cfsDetalle');
        var barra = document.getElementById('cfsBarra');
        var paso = document.getElementById('cfsPaso');
        var ejec = document.getElementById('cfsEjec');
        var espera = document.getElementById('cfsEspera');
        var modelo = document.getElementById('cfsModelo');
        var trabajo = document.getElementById('cfsTrabajo');
        var hace = document.getElementById('cfsHace');

        if (dot) { dot.style.background = f.color; dot.style.boxShadow = '0 0 0 3px ' + f.color + '33'; }
        if (fase) { fase.textContent = f.txt; fase.style.color = f.color; }
        if (det) det.textContent = d.detalle || f.pista;

        var t = d.trabajo || null;
        var pct = (t && t.total) ? Math.round((t.paso / t.total) * 100) : (d.fase === 'listo' ? 100 : 0);
        if (barra) {
            barra.style.width = pct + '%';
            barra.style.background = f.color;
        }
        if (paso) paso.textContent = (t && t.total) ? (t.paso + '/' + t.total) : '—';
        if (ejec) ejec.textContent = d.cola ? d.cola.ejecutando : 0;
        if (espera) espera.textContent = d.cola ? d.cola.pendientes : 0;
        if (modelo) modelo.textContent = (d.modelo && d.modelo.cargando)
            ? (d.modelo.nombre || 'sí') : '—';
        if (hace) {
            var ahora = Date.now();
            if (d.comfy && d.fase !== 'apagado') { ultimoLatido = ahora; hace.textContent = ''; }
            else if (ultimoLatido) hace.textContent = 'sin respuesta hace ' + Math.round((ahora - ultimoLatido) / 1000) + 's';
        }
        if (trabajo) {
            if (t && t.promptId) {
                trabajo.innerHTML = '<b>' + esc(String(t.prompt || '').slice(0, 120)) + '</b>' +
                    '<span>' + (t.de ? '@' + esc(t.de) : '') + (t.origen ? ' · ' + esc(t.origen) : '') + '</span>' +
                    '<code>' + esc(String(t.promptId).slice(0, 8)) + '</code>';
                trabajo.style.display = '';
            } else {
                trabajo.innerHTML = '';
                trabajo.style.display = 'none';
            }
        }
    }

    function pintarConsola(lineas) {
        var log = document.getElementById('cfsLog');
        var cont = document.getElementById('cfsLineas');
        if (!log) return;
        if (cont) cont.textContent = lineas.length + ' líneas';
        if (!lineas.length) { log.textContent = 'sin salida todavía…'; return; }
        var html = lineas.map(function (l) {
            var hora = '';
            try {
                var dd = new Date(l.t);
                hora = ('0' + dd.getHours()).slice(-2) + ':' + ('0' + dd.getMinutes()).slice(-2) + ':' + ('0' + dd.getSeconds()).slice(-2);
            } catch (e) { }
            return '<span class="cfs-ln ' + claseDeLinea(l.m) + '"><i>' + hora + '</i>' + esc(l.m) + '</span>';
        }).join('');
        log.innerHTML = html;
        if (seguir) alFondo();
    }

    function traer() {
        var caja = document.getElementById('stageComfy');
        if (!caja) return;
        // sólo consulta cuando la pestaña está visible
        if (!caja.classList.contains('active') || caja.offsetParent === null) return;
        fetch('/api/comfy/consola?limite=250', { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                errores = 0;
                pintarEstado(d || {});
                pintarConsola((d && d.lineas) || []);
            })
            .catch(function () {
                errores++;
                var log = document.getElementById('cfsLog');
                if (log && errores > 2) log.textContent = 'no pude hablar con la app local (¿se cayó el servidor?)';
            });
    }

    function ciclo() {
        if (!construir()) return;
        traer();
    }

    // primera construcción + refresco cada 1.5 s
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ciclo);
    else setTimeout(ciclo, 800);
    setInterval(ciclo, 1500);

    // al entrar a la pestaña, refresco inmediato
    document.addEventListener('ck:tab', function () { setTimeout(traer, 120); });
    document.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('[data-sub="stageComfy"]') : null;
        if (b) setTimeout(traer, 150);
    }, true);
})();
