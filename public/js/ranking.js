// ============================================================
// IACOMFY - RANKING DE LOS FIERROS
// ------------------------------------------------------------
// Programa de incentivos: muestra quién puso el fierro que más tiempo estuvo
// prendido, quién proveyó más generaciones y quién sumó más computadoras.
// Y "Mi cuenta": los assets que creaste, tus computadoras con su uptime y tus
// generaciones (todo lo que guarda la base IACOMFY en MongoDB).
// ============================================================
(function () {
    'use strict';

    var J = window.JPI || {};
    // La URL del hub se resuelve EN EL MOMENTO (y con respaldo): si el front
    // carga antes de config-jpi.js venía vacía y las llamadas daban 404.
    function baseApi() {
        var j = window.JPI || {};
        return (j.API_BASE && j.API_BASE.indexOf('/comfylatam') >= 0)
            ? j.API_BASE
            : 'https://vps-4455523-x.dattaweb.com/comfylatam';
    }
    var orden = 'tiempo';
    var cargando = false;

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    // '3 d 4 h' / '51 min'
    function tiempo(seg) {
        seg = Number(seg || 0);
        if (seg < 60) return seg + ' s';
        var m = Math.floor(seg / 60);
        if (m < 60) return m + ' min';
        var h = Math.floor(m / 60);
        if (h < 24) return h + ' h ' + (m % 60) + ' min';
        return Math.floor(h / 24) + ' d ' + (h % 24) + ' h';
    }
    function mb(bytes) {
        var b = Number(bytes || 0);
        if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
        if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
        return (b / 1073741824).toFixed(2) + ' GB';
    }
    function avatar(u) {
        if (u && u.avatar) return '<img class="rank-avatar" src="' + esc(u.avatar) + '" alt="">';
        var ini = String((u && (u.username || u.displayName)) || '?').trim().charAt(0).toUpperCase();
        return '<span class="rank-avatar rank-avatar-inicial">' + esc(ini) + '</span>';
    }
    function medalla(p) {
        return p === 1 ? '🥇' : p === 2 ? '🥈' : p === 3 ? '🥉' : p;
    }

    // --------------------------- rankings ---------------------------
    function pedirRanking(cual) {
        if (cargando) return;
        cargando = true;
        var cont = document.getElementById('rankTabla');
        if (cont) cont.innerHTML = '<div class="rank-vacio">cargando…</div>';
        fetch(baseApi() + '/api/ranking/fierros?orden=' + encodeURIComponent(cual), { headers: tokenHeaders() })
            .then(function (r) {
                return r.text().then(function (txt) {
                    try {
                        return JSON.parse(txt);
                    } catch (err) {
                        throw new Error('El servidor respondió sin datos válidos (HTTP ' + r.status + ')');
                    }
                });
            })
            .then(function (d) {
                cargando = false;
                if (!d || !d.success) { pintarError(d && d.message); return; }
                pintarRanking(d);
            })
            .catch(function (e) {
                cargando = false;
                pintarError(e.message);
            });
    }

    function pintarError(msg) {
        var cont = document.getElementById('rankTabla');
        if (cont) cont.innerHTML = '<div class="rank-vacio">No pude leer el ranking' + (msg ? ': ' + esc(msg) : '') + '</div>';
    }

    // El tiempo "prendida seguido" avanza solo: se guarda el valor que vino del
    // servidor y se le suman los segundos que pasan, sin volver a pedir todo.
    var seguidos = {};
    var ultimaLectura = 0;
    setInterval(function () {
        if (!ultimaLectura) return;
        var delta = Math.floor((Date.now() - ultimaLectura) / 1000);
        Object.keys(seguidos).forEach(function (k) {
            var celda = document.querySelector('[data-seguido="' + k + '"]');
            if (celda && seguidos[k] > 0) celda.innerHTML = '🔥 ' + tiempo(seguidos[k] + delta);
        });
    }, 1000);

    function pintarRanking(d) {
        var cont = document.getElementById('rankTabla');
        if (!cont) return;
        if (!d.filas || !d.filas.length) {
            cont.innerHTML = '<div class="rank-vacio">Todavía no hay datos. En cuanto haya computadoras conectadas generando, aparece el podio.</div>';
            return;
        }
        var cabecera, celda;
        if (d.orden === 'generaciones') {
            cabecera = '<th>#</th><th>Usuario</th><th>Generaciones provistas</th><th>Pidió</th><th>Fierros</th><th>Tiempo de sus fierros</th><th>Prendida seguido</th>';
            celda = function (f) {
                return '<td><b>' + f.generacionesProvistas + '</b></td><td>' + (f.generacionesPedidas || 0) + '</td>' +
                    '<td>' + (f.computadoras || 0) + '</td><td>' + tiempo(f.segundosComputadora) + '</td>' +
                    '<td>' + (f.seguido ? '🔥 ' + tiempo(f.seguido) : '—') + '</td>';
            };
        } else if (d.orden === 'fierros') {
            cabecera = '<th>#</th><th>Usuario</th><th>Fierros en la red</th><th>Tiempo total</th><th>Prendida seguido</th><th>Generaciones provistas</th><th>Última vez</th>';
            celda = function (f) {
                return '<td><b>' + (f.computadoras || 0) + '</b></td><td>' + tiempo(f.segundosComputadora) + '</td>' +
                    '<td data-seguido="' + esc(f.email || '') + '">' + (f.seguido ? '🔥 ' + tiempo(f.seguido) : '—') + '</td>' +
                    '<td>' + (f.generacionesProvistas || 0) + '</td><td>' + fecha(f.ultimoVisto) + '</td>';
            };
        } else {
            cabecera = '<th>#</th><th>Usuario</th><th>Tiempo total</th><th>Prendida seguido</th><th>Fierros</th><th>Sesiones</th><th>Generaciones provistas</th><th>Pidió</th>';
            celda = function (f) {
                return '<td><b>' + tiempo(f.segundosComputadora) + '</b></td>' +
                    '<td data-seguido="' + esc(f.email || '') + '">' + (f.seguido ? '🔥 ' + tiempo(f.seguido) : '—') + '</td>' +
                    '<td>' + (f.computadoras || 0) + '</td>' +
                    '<td>' + (f.sesiones || 0) + '</td><td>' + (f.generacionesProvistas || 0) + '</td><td>' + (f.generacionesPedidas || 0) + '</td>';
            };
        }
        var filas = d.filas.map(function (f) {
            var yo = esMio(f.email) ? ' rank-yo' : '';
            return '<tr class="' + yo.trim() + '">' +
                '<td class="rank-puesto">' + medalla(f.puesto) + '</td>' +
                '<td class="rank-user">' + avatar(f) + '<span>' +
                '<span class="rank-punto' + (f.enLinea ? ' on' : '') + '" title="' + (f.enLinea ? 'conectada ahora' : 'no está conectada') + '"></span>' +
                '<b>@' + esc(f.usuario || f.email) + '</b>' +
                (esMio(f.email) ? ' <span class="rank-chip">vos</span>' : '') +
                (f.enLinea ? ' <span class="rank-estado on">🟢 conectada</span>' : ' <span class="rank-estado off">⚪ desconectada</span>') +
                '</span></td>' +
                celda(f) + '</tr>';
        }).join('');
        // guardo los "seguido" y marco la hora de lectura para que el reloj sume
        seguidos = {};
        (d.filas || []).forEach(function (f) { if (f.seguido) seguidos[f.email || ''] = f.seguido; });
        ultimaLectura = Date.now();
        cont.innerHTML = '<table class="rank-tabla"><thead><tr>' + cabecera + '</tr></thead><tbody>' + filas + '</tbody></table>';
    }

    function fecha(v) {
        if (!v) return '—';
        try { return new Date(v).toLocaleDateString('es-AR'); } catch (e) { return '—'; }
    }

    // --------------------------- mi cuenta ---------------------------
    function tokenHeaders() {
        var t = '';
        try { t = localStorage.getItem('fsc_token_jpi') || ''; } catch (e) { }
        return t ? { Authorization: 'Bearer ' + t } : {};
    }

    function miClave() {
        try {
            var u = JSON.parse(localStorage.getItem('fsc_user_jpi') || 'null');
            if (u && (u.email || u.username)) return u.email || u.username;
        } catch (e) { }
        return null;
    }

    function pedirMia() {
        var cont = document.getElementById('rankMia');
        if (!cont) return;
        cont.innerHTML = '<div class="rank-vacio">cargando…</div>';
        var clave = miClave();
        var url = baseApi() + '/api/estadisticas/mia' + (clave ? '?usuario=' + encodeURIComponent(clave) : '');
        fetch(url, { headers: tokenHeaders() })
            .then(function (r) {
                return r.text().then(function (txt) {
                    try { return JSON.parse(txt); } catch (e) { throw new Error('HTTP ' + r.status); }
                });
            })
            .then(function (d) {
                if (d && d.success === false && !clave) {
                    // sin sesión y sin clave: le pedimos la identidad a la app local
                    fetch('api/red/estado').then(function (r) { return r.json(); }).then(function (e) {
                        var p = (e && (e.propietario || e.usuario)) || {};
                        var k = p.email || p.username;
                        if (!k) { cont.innerHTML = '<div class="rank-vacio">Iniciá sesión (👤 Perfil) para ver tus estadísticas.</div>'; return; }
                        fetch(baseApi() + '/api/estadisticas/mia?usuario=' + encodeURIComponent(k), { headers: tokenHeaders() })
                            .then(function (r) {
                                return r.text().then(function (txt) {
                                    try { return JSON.parse(txt); } catch (e) { throw new Error('HTTP ' + r.status); }
                                });
                            })
                            .then(pintarMia).catch(function (err) { cont.innerHTML = '<div class="rank-vacio">' + esc(err.message) + '</div>'; });
                    }).catch(function () { cont.innerHTML = '<div class="rank-vacio">Iniciá sesión (👤 Perfil) para ver tus estadísticas.</div>'; });
                    return;
                }
                pintarMia(d);
            })
            .catch(function (e) { cont.innerHTML = '<div class="rank-vacio">' + esc(e.message) + '</div>'; });
    }

    function pintarMia(d) {
        var cont = document.getElementById('rankMia');
        if (!cont) return;
        if (!d || d.success === false) {
            cont.innerHTML = '<div class="rank-vacio">' + esc((d && d.message) || 'la base no está disponible') + '</div>';
            return;
        }
        var u = d.usuario || {}, t = d.totales || {};
        var fierros = (d.computadoras || []).map(function (c) {
            var on = !!c.conectada;
            return '<div class="rank-fierro">' +
                '<div class="rank-fierro-nombre">' +
                '<span class="rank-punto' + (on ? ' on' : '') + '"></span>' +
                '<b>' + esc(c.nombre || c.peerId) + '</b> ' +
                '<span class="rank-estado ' + (on ? 'on' : 'off') + '">' +
                (on ? '🟢 conectada ahora' : '⚪ desconectada · última vez ' + fecha(c.ultimoVisto)) + '</span>' +
                (c.compartir ? ' <span class="rank-chip verde">comparte</span>' : ' <span class="rank-chip">no comparte</span>') + '</div>' +
                '<div class="rank-fierro-datos">' +
                '<span>⏱️ <b>' + tiempo(c.segundosTotal) + '</b> prendida</span>' +
                '<span>⚡ <b>' + (c.generaciones || 0) + '</b> generaciones</span>' +
                '<span>🔁 ' + (c.sesiones || 0) + ' sesiones</span>' +
                (c.gpu ? '<span>🎛️ ' + esc(c.gpu) + '</span>' : '') +
                '</div></div>';
        }).join('') || '<div class="rank-vacio">Todavía no hay computadoras registradas con esta cuenta.</div>';

        var assets = (d.assets || []).slice(0, 24).map(function (a) {
            var esVideo = a.tipo === 'video';
            return '<a class="rank-asset" href="' + esc(a.url) + '" target="_blank" rel="noopener" title="' + esc(a.prompt || a.publicId) + '">' +
                (esVideo
                    ? '<video src="' + esc(a.url) + '" muted preload="metadata"></video><span class="rank-asset-tag">🎬</span>'
                    : '<img src="' + esc(a.url) + '" loading="lazy" alt="">') +
                '<span class="rank-asset-pie">' + esc(mb(a.bytes)) + '</span></a>';
        }).join('') || '<div class="rank-vacio">Todavía no subiste ningún asset.</div>';

        cont.innerHTML =
            '<div class="rank-perfil">' + avatar(u) + '<div><div class="rank-perfil-nombre">@' + esc(u.username || u.displayName || '—') + '</div>' +
            '<div class="rank-perfil-mail">' + esc(u.email || '') + '</div></div></div>' +
            '<div class="rank-metricas">' +
            '<div class="rank-metrica"><b>' + (t.assets || 0) + '</b><span>assets creados</span></div>' +
            '<div class="rank-metrica"><b>' + mb(t.bytes) + '</b><span>en la nube</span></div>' +
            '<div class="rank-metrica"><b>' + (t.computadoras || 0) + '</b><span>computadoras</span></div>' +
            '<div class="rank-metrica"><b>' + tiempo(t.segundosComputadora) + '</b><span>tiempo aportado</span></div>' +
            '<div class="rank-metrica"><b>' + (t.generacionesProvistas || 0) + '</b><span>generaciones provistas</span></div>' +
            '<div class="rank-metrica"><b>' + (t.generacionesPedidas || 0) + '</b><span>generaciones pedidas</span></div>' +
            '</div>' +
            '<h4 class="rank-h4">🖥️ Tus computadoras</h4>' + fierros +
            '<h4 class="rank-h4">☁️ Tus assets (' + (t.assets || 0) + ')</h4><div class="rank-assets">' + assets + '</div>';
    }

    function esMio(email) {
        var clave = miClave();
        return !!(clave && email && String(email).toLowerCase() === String(clave).toLowerCase());
    }

    // --------------------------- arranque ---------------------------
    function wireSubTabs() {
        document.querySelectorAll('#tabRanking .sub-tab-btn-std').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var cual = btn.dataset.orden;
                if (cual) { orden = cual; pedirRanking(orden); }
            });
        });
        var b = document.getElementById('rankRefrescar');
        if (b) b.addEventListener('click', function () { pedirRanking(orden); });
        var b2 = document.getElementById('rankRefrescar2');
        if (b2) b2.addEventListener('click', function () { pedirMia(); });
    }

    function arrancar() {
        var tab = document.getElementById('tabRanking');
        if (!tab) return;
        wireSubTabs();
        pedirRanking(orden);
        pedirMia();
        // refresco suave cuando la pestaña está abierta
        setInterval(function () {
            if (tab.classList.contains('active')) { pedirRanking(orden); }
        }, 60000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar);
    else arrancar();

    window.IACOMFY = { ranking: pedirRanking, mia: pedirMia };
})();
