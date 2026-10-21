/* ACCESO → PERMISOS
 * Quién puede ver y usar cada equipo de la comunidad, y qué workflows.
 * Regla del usuario: por defecto 👥 TODOS; se puede limitar a usuarios
 * concretos. Se hace cumplir en el hub (no sólo acá).
 */
(function () {
    'use strict';

    function base() {
        return (window.JPI && (window.JPI.API_BASE || '')) || '';
    }
    function getJSON(ruta) {
        return fetch(base() + ruta + (ruta.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now(), { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .catch(function () { return {}; });
    }
    function postJSON(ruta, datos) {
        return fetch(base() + ruta, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(datos || {})
        }).then(function (r) { return r.json(); }).catch(function (e) { return { success: false, message: e.message }; });
    }

    var DATOS = { mio: null, peers: [], usuarios: [] };
    var BUSCAR = '';          // texto del buscador
    var BUSCADOS = [];        // resultados de jpconnect

    function chipsHTML(tildados) {
        var t = tildados || (DATOS.mio && DATOS.mio.usuarios || []).map(function (x) { return String(x).toLowerCase(); });
        return usuariosFiltrados().map(function (u) {
            var nombre = String(u.usuario || '');
            var on = t.indexOf(nombre.toLowerCase()) >= 0;
            return '<button type="button" class="acc-chip' + (on ? ' on' : '') + '" data-usuario="' + nombre + '">' +
                (on ? '✓ ' : '') + '@' + nombre + '</button>';
        }).join('');
    }

    function usuariosFiltrados() {
        var t = String(BUSCAR || '').trim().toLowerCase();
        if (!t) return usuariosDisponibles();
        return usuariosDisponibles().filter(function (u) {
            var n = String(u.usuario || '').toLowerCase();
            var d = String(u.displayName || '').toLowerCase();
            var m = String(u.email || '').toLowerCase();
            return n.indexOf(t) >= 0 || d.indexOf(t) >= 0 || m.indexOf(t) >= 0;
        });
    }

    function usuariosDisponibles() {
        var lista = (DATOS.usuarios || []).concat(BUSCADOS || []).map(function (u) {
            return typeof u === 'string' ? { usuario: u, displayName: u } : u;
        });
        // los que ya están tildados tienen que verse aunque no estén en la lista
        var actual = (DATOS.mio && DATOS.mio.usuarios) || [];
        actual.forEach(function (n) {
            if (!lista.some(function (u) { return String(u.usuario).toLowerCase() === String(n).toLowerCase(); })) {
                lista.push({ usuario: n, displayName: n });
            }
        });
        return lista;
    }

    function pintar() {
        var slot = document.getElementById('redPermSlot');
        if (!slot) return;
        if (!DATOS.mio) { slot.innerHTML = '<p class="red-sub">Cargando permisos…</p>'; return; }

        var modo = DATOS.mio.modo === 'lista' ? 'lista' : 'todos';
        var tildados = (DATOS.mio.usuarios || []).map(function (x) { return String(x).toLowerCase(); });

        // El mismo bloque se muestra en ACCESO → PERMISOS y (compacto) en EQUIPO.
        function bloqueMio(compacto) {
            var h = [];
            h.push('<div class="acc-bloque">');
            if (!compacto) h.push('<h3 class="red-titulo">💻 MI EQUIPO <span class="red-badge">' + (DATOS.mio.nombre || 'esta PC') + '</span></h3>');
            else h.push('<h3 class="red-titulo">🔐 QUIÉN PUEDE VER Y USAR ESTA PC</h3>');
            h.push('<div class="acc-modo">');
            h.push('  <button type="button" class="acc-btn' + (modo === 'todos' ? ' activo' : '') + '" data-modo="todos">👥 TODOS</button>');
            h.push('  <button type="button" class="acc-btn' + (modo === 'lista' ? ' activo' : '') + '" data-modo="lista">🔒 SÓLO ALGUNOS</button>');
            h.push('</div>');
            if (modo === 'todos') {
                h.push('<p class="red-sub">Cualquier usuario de la comunidad puede ver esta PC y generar en ella.</p>');
            } else {
                h.push('<p class="red-sub">Sólo estos usuarios la ven en COMUNIDAD y pueden mandarle trabajos:</p>');
                h.push('<input type="text" class="acc-buscar" id="accBuscarUser"' +
                    ' placeholder="buscar usuario de la comunidad…" value="' + (BUSCAR || '') + '">');
                h.push('<div class="acc-chips">' + chipsHTML(tildados) + '</div>');
                if (!usuariosFiltrados().length) {
                    h.push('<p class="red-sub">' + (BUSCAR ? 'No encontré «' + BUSCAR + '» en jpconnect.' : 'Todavía no hay otros usuarios en la comunidad.') + '</p>');
                }
            }
            h.push('</div>');
            return h.join('\n');
        }

        var html = [];
        html.push(bloqueMio(false));

        // resto de los equipos (sólo lectura: los decide su dueño)
        html.push('<div class="acc-bloque">');
        html.push('<h3 class="red-titulo">🖥️ EQUIPOS DE LA COMUNIDAD</h3>');
        var otros = (DATOS.peers || []).filter(function (p) { return p && !p.esMio; });
        if (!otros.length) {
            html.push('<p class="red-sub">No hay otras computadoras conectadas ahora.</p>');
        } else {
            otros.forEach(function (p) {
                var a = p.acceso || {};
                var etiqueta = (a.modo === 'lista')
                    ? '🔒 ' + (a.usuarios || []).length + ' usuario(s)'
                    : '👥 todos';
                html.push('<div class="acc-fila">' +
                    '<span class="acc-nombre">🖥️ ' + (p.nombre || p.id) + '</span>' +
                    '<span class="acc-dueno">' + (p.dueno ? '@' + p.dueno : '') + '</span>' +
                    '<span class="acc-badge">' + etiqueta + '</span>' +
                    '</div>');
            });
        }
        html.push('</div>');

        slot.innerHTML = html.join('\n');
        enganchar(slot);

        // resumen en la sub-pestaña EQUIPO (para no tener que cambiar de tab)
        var cajaEquipo = document.getElementById('redMioAcceso');
        if (cajaEquipo) {
            cajaEquipo.innerHTML = bloqueMio(true);
            enganchar(cajaEquipo);
        }
    }

    function enganchar(slot) {
        if (!slot) slot = document.getElementById('redPermSlot');
        if (!slot) return;
        slot.querySelectorAll('[data-modo]').forEach(function (b) {
            b.addEventListener('click', function () {
                var modo = b.getAttribute('data-modo');
                DATOS.mio.modo = modo;
                if (modo === 'todos') DATOS.mio.usuarios = [];
                guardar();
            });
        });
        var inp = slot.querySelector('#accBuscarUser');
        if (inp && !inp.__ck) {
            inp.__ck = 1;
            inp.addEventListener('input', function () {
                BUSCAR = inp.value;
                var tildados = (DATOS.mio && DATOS.mio.usuarios || []).map(function (x) { return String(x).toLowerCase(); });
                document.querySelectorAll('.acc-chips').forEach(function (c) {
                    c.innerHTML = chipsHTML(tildados);
                });
                // reengancho los chips nuevos (en los dos bloques)
                ['redPermSlot', 'redMioAcceso'].forEach(function (id) {
                    var c = document.getElementById(id);
                    if (c) enganchar(c);
                });
                buscarEnJpconnect(inp.value);
            });
        }
        slot.querySelectorAll('[data-usuario]').forEach(function (b) {
            if (b.__ck) return;
            b.__ck = 1;
            b.addEventListener('click', function () {
                var u = b.getAttribute('data-usuario').toLowerCase();
                var arr = (DATOS.mio.usuarios || []).slice();
                var i = arr.map(function (x) { return String(x).toLowerCase(); }).indexOf(u);
                if (i >= 0) arr.splice(i, 1); else arr.push(b.getAttribute('data-usuario'));
                DATOS.mio.usuarios = arr;
                DATOS.mio.modo = 'lista';
                pintar();
                guardar(true);
            });
        });
    }

    // busca en jpconnect (todas las cuentas) y suma resultados a la lista
    var tBuscar = 0;
    function buscarEnJpconnect(texto) {
        clearTimeout(tBuscar);
        var t = String(texto || '').trim();
        if (t.length < 2) return;
        tBuscar = setTimeout(function () {
            getJSON('/api/wf/usuarios?buscar=' + encodeURIComponent(t)).then(function (d) {
                var enc = (d && d.usuarios) || [];
                if (!enc.length) return;
                var mapa = {};
                (DATOS.usuarios || []).concat(BUSCADOS || []).forEach(function (u) { mapa[String(u.usuario).toLowerCase()] = u; });
                enc.forEach(function (u) { mapa[String(u.usuario).toLowerCase()] = u; });
                BUSCADOS = Object.keys(mapa).map(function (k) { return mapa[k]; });
                var tildados = (DATOS.mio && DATOS.mio.usuarios || []).map(function (x) { return String(x).toLowerCase(); });
                document.querySelectorAll('.acc-chips').forEach(function (c) { c.innerHTML = chipsHTML(tildados); });
                ['redPermSlot', 'redMioAcceso'].forEach(function (id) {
                    var c = document.getElementById(id);
                    if (c) enganchar(c);
                });
                // ojo: NO repintar todo acá (se perdía el foco del buscador)
            });
        }, 320);
    }

    var tGuardar = 0;
    function guardar(yaEsLista) {
        clearTimeout(tGuardar);
        // Elegir "SÓLO ALGUNOS" todavía no es un cambio para guardar: se guarda
        // recién cuando hay al menos un usuario tildado (si no, el equipo
        // quedaría invisible para todos, incluso para el dueño).
        if (DATOS.mio && DATOS.mio.modo === 'lista' && !(DATOS.mio.usuarios || []).length) {
            if (!yaEsLista) pintar();
            return;
        }
        tGuardar = setTimeout(function () {
            if (!yaEsLista) pintar();
            postJSON('/api/red/acceso-nodo', {
                peerId: DATOS.mio.peerId,
                modo: DATOS.mio.modo,
                usuarios: DATOS.mio.modo === 'lista' ? (DATOS.mio.usuarios || []) : []
            }).then(function (d) {
                if (d && d.success === false) {
                    var slot = document.getElementById('redPermSlot');
                    if (slot) {
                        var av = document.createElement('p');
                        av.className = 'red-sub';
                        av.style.color = '#f59e0b';
                        av.textContent = '⚠️ ' + (d.message || 'no se pudo guardar');
                        slot.insertBefore(av, slot.firstChild);
                    }
                }
                cargar();
            });
        }, 250);
    }

    function cargar() {
        Promise.all([
            getJSON('/api/red/acceso-nodo'),
            getJSON('/api/red/peers'),
            getJSON('/api/wf/usuarios')
        ]).then(function (r) {
            var acc = r[0] || {}, peers = r[1] || {}, us = r[2] || {};
            DATOS.mio = {
                peerId: acc.peerId || '',
                nombre: (window.comfyRed && window.comfyRed.estado && window.comfyRed.estado.yo && window.comfyRed.estado.yo.nombre) || 'esta PC',
                modo: (acc.acceso && acc.acceso.modo) || 'todos',
                usuarios: (acc.acceso && acc.acceso.usuarios) || []
            };
            DATOS.peers = (peers.peers || []).map(function (p) {
                var yo = DATOS.mio.peerId;
                return {
                    id: p.id, nombre: p.nombre, dueno: p.dueno || (p.usuario && p.usuario.username) || '',
                    esMio: p.id === yo,
                    acceso: p.accesoNodo || (p.estado && p.estado.accesoNodo) || { modo: 'todos', usuarios: [] }
                };
            });
            DATOS.usuarios = us.usuarios || [];
            pintar();
        });
    }

    window.CK_acciones = { pintarPermisos: cargar, cargar: cargar };

    // si el panel ya existe (por recarga de módulos), pintamos
    if (document.getElementById('redPermSlot')) cargar();
})();
