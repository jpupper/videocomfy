// ============================================================
// UI 2: STAGE en COMMUNITY + BATCH, botones en su lugar y SUBMENUS unificados
// ------------------------------------------------------------
// 1) STAGE: dos pestañas -> COMMUNITY (a dónde va + última generación +
//    registro) y BATCH (tu batch local + historial de completados).
// 2) RED, el usuario y la versión van al menú de arriba (con las pestañas).
//    NEW SESSION (+) y SAVE PROJECT (💾) se mudan al menú de CREATE.
// 3) Todos los submenús usan la misma clase -> mismo estilo y mismo
//    comportamiento (uno solo visible a la vez).
// ============================================================
(function () {
    'use strict';

    function texto(el) { return (el && el.textContent || '').replace(/\s+/g, ' ').trim(); }
    function contiene(el, palabras) {
        var t = texto(el).toLowerCase();
        return palabras.some(function (p) { return t.indexOf(p) >= 0; });
    }

    // ---------- 1) STAGE: COMMUNITY + BATCH ----------
    function armarStage() {
        var stage = document.getElementById('tabOutput');
        if (!stage || document.getElementById('stageSubTabs')) return;

        // junto TODOS los bloques del stage y los clasifico por su contenido
        var bloques = [];
        (function juntar(nodo) {
            Array.prototype.slice.call(nodo.children || []).forEach(function (hijo) {
                if (hijo.id === 'stageSubTabs') return;
                // 🎬 ÚLTIMA GENERACIÓN: pedido explícito — se elimina, todo va al GLOBAL
                if (contiene(hijo, ['última generación'])) { hijo.style.display = 'none'; hijo.setAttribute('data-ck-oculto', '1'); return; }
                if (contiene(hijo, ['a dónde va'])) bloques.push({ nodo: hijo, tipo: 'batch' });
                // el REGISTRO local del STAGE lo reemplaza el GLOBAL (VPS)
                else if (contiene(hijo, ['registro'])) { hijo.style.display = 'none'; hijo.setAttribute('data-ck-oculto', '1'); }
                else if (contiene(hijo, ['tu batch local', 'completed history', 'nothing to generate', 'en cola', 'pendientes', 'pedidos de la red', 'pedidos que llegan'])) bloques.push({ nodo: hijo, tipo: 'batch' });
                else juntar(hijo);
            });
        })(stage);

        if (!bloques.length) return;

        var community = document.createElement('div');
        community.id = 'stageCommunity';
        community.className = 'sub-tab-content active';
        // cabecera del registro GLOBAL (lo llena js/registro-global.js)
        var cab = document.createElement('div');
        cab.id = 'regGlobalCaja';
        community.appendChild(cab);
        var batch = document.createElement('div');
        batch.id = 'stageBatch';
        batch.className = 'sub-tab-content';

        bloques.forEach(function (b) {
            (b.tipo === 'community' ? community : batch).appendChild(b.nodo);
        });

        // COMFYSTAGE: consola + estado del motor. SOLO en la app local (la web
        // no tiene ComfyUI propio: ahí no se muestra la pestaña).
        var esWebAqui = (function () {
            try {
                var h = location.hostname;
                return h !== 'localhost' && h !== '127.0.0.1' && h.indexOf('localhost') === -1;
            } catch (e) { return false; }
        })();

        var barra = document.createElement('div');
        barra.id = 'stageSubTabs';
        barra.className = 'sub-tabs-container';
        barra.innerHTML =
            '<button class="sub-tab-btn sub-tab-btn-std active" data-sub="stageCommunity">🌐 GLOBAL</button>' +
            '<button class="sub-tab-btn sub-tab-btn-std" data-sub="stageBatch">🖥️ DEVICE</button>' +
            (esWebAqui ? '' : '<button class="sub-tab-btn sub-tab-btn-std" data-sub="stageComfy">🖥️ COMFYSTAGE</button>');

        stage.appendChild(barra);
        stage.appendChild(community);
        stage.appendChild(batch);
        if (!esWebAqui) {
            var comfy = document.createElement('div');
            comfy.id = 'stageComfy';
            comfy.className = 'sub-tab-content';
            stage.appendChild(comfy);
        }
        enganchar(barra);
    }

    // ---------- 2) botones a su lugar ----------
    // Los botones (PAUSAR, usuario, RED, versión) los crean otros módulos y los
    // cuelgan de #projectTabsNav. Acá se reubican: PAUSAR a STAGE, y el usuario,
    // RED y la versión al menú de arriba. La fila queda sólo para las sesiones.
    function moverBotones() {
        var arriba = document.querySelector('.tabs-container');
        var fila = document.getElementById('projectTabsNav');
        var stage = document.getElementById('tabOutput');
        if (!arriba) return;

        // Los busco por ID en TODO el documento: el usuario (#jpiCuentaBtn) y RED
        // (#redBtn) los cuelga cada módulo donde quiere, no siempre en la misma fila.
        var botones = [];
        ['jpiCuentaBtn', 'tabRedBtn', 'redBtn', 'ckVersionChip', 'newProjectBtn', 'saveProjectBtn', 'jpiPausaBtn'].forEach(function (id) {
            var b = document.getElementById(id);
            if (b) botones.push(b);
        });
        // OJO: acá había un barrido que agarraba CUALQUIER botón que dijera
        // perfil/cuenta/red/pausar (incluidos los de otros paneles) y los
        // movía a la barra de arriba: por eso aparecían repetidos y en
        // cualquier lugar. Ahora sólo se mueven los botones con ID conocido.

        botones.forEach(function (b) {
            var t = texto(b).toLowerCase();
            var id = b.id || '';
            if (id === 'newProjectBtn' || id === 'saveProjectBtn') return;   // ya van a CREATE
            if (t.indexOf('pausar') >= 0 || t.indexOf('reanudar') >= 0 || id === 'jpiPausaBtn') {
                // se mueve UNA sola vez y se marca: antes el bucle cada 3 s lo
                // volvía a mover, se duplicaba y titilaba.
                if (b.dataset.ckPausar) return;
                b.dataset.ckPausar = '1';
                if (stage && !stage.contains(b)) stage.insertBefore(b, stage.firstChild);
                b.classList.add('btn-pausar-stage');
                return;
            }
            // el chip de versión va SIEMPRE primero: a la izquierda de PREVIZ
            if (id === 'ckVersionChip') {
                if (arriba.firstChild !== b) arriba.insertBefore(b, arriba.firstChild);
                return;
            }
            if (id === 'jpiCuentaBtn' || id === 'tabRedBtn' || id === 'redBtn') {
                if (b.parentElement !== arriba) arriba.appendChild(b);
            }
        });

        // NEW SESSION (+) y SAVE (💾) -> EN LÍNEA con WORKFLOWS / EDITOR / STORYBOARD
        // (pedido del usuario: antes quedaban en una fila aparte, arriba del menú).
        var crear = document.getElementById('tabPrompts');
        var nuevo = document.getElementById('newProjectBtn');
        var guardar = document.getElementById('saveProjectBtn');
        if (crear && nuevo && guardar) {
            var barraSub = document.getElementById('crearSubTabs') || crear.querySelector('.sub-tabs-container');
            if (barraSub) {
                // al final de la misma fila, pegados a la derecha
                if (nuevo.parentElement !== barraSub) barraSub.appendChild(nuevo);
                if (guardar.parentElement !== barraSub) barraSub.appendChild(guardar);
                nuevo.classList.add('ck-btn-nav-inline');
                guardar.classList.add('ck-btn-nav-inline');
            } else {
                var caja = document.getElementById('crearAcciones') || document.createElement('div');
                caja.id = 'crearAcciones';
                caja.className = 'crear-acciones';
                caja.appendChild(nuevo);
                caja.appendChild(guardar);
                crear.insertBefore(caja, crear.firstChild);
            }
        }

        // si hay dos botones de pausa (uno viejo creado de nuevo), se saca el duplicado
        var pausas = [];
        document.querySelectorAll('button').forEach(function (b) {
            var t = texto(b).toLowerCase();
            if (t.indexOf('pausar') >= 0 || t.indexOf('reanudar') >= 0) pausas.push(b);
        });
        pausas.slice(1).forEach(function (b) { b.remove(); });

        // si la fila quedó sin nada (ni sesiones), se esconde
        if (fila) {
            var lista = document.getElementById('projectTabsList');
            var tieneSesiones = !!(lista && lista.children.length);
            var sueltos = Array.prototype.slice.call(fila.children).filter(function (c) {
                return c !== lista && !c.classList.contains('project-tabs-list');
            });
            fila.style.display = (tieneSesiones || sueltos.length) ? '' : 'none';
        }
    }

    // ---------- 3) submenús: mismo comportamiento ----------
    function enganchar(cont) {
        if (!cont || cont.dataset.ckListo) return;
        cont.dataset.ckListo = '1';
        cont.querySelectorAll('.sub-tab-btn-std').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var destino = btn.getAttribute('data-sub');
                var panel = cont.parentElement;
                // sólo uno visible
                panel.querySelectorAll(':scope > .sub-tab-content').forEach(function (c) {
                    c.classList.remove('active');
                });
                var activo = document.getElementById(destino);
                if (activo) activo.classList.add('active');
                // OJO: el modo editor (con el timeline abajo) es SÓLO del editor.
                // Antes estaba también en stageCommunity y el timeline aparecía en
                // STAGE, que no tiene nada que ver.
                if (destino === 'crearEditor') {
                    document.body.classList.add('tab-editor-active');
                } else {
                    document.body.classList.remove('tab-editor-active');
                    if (typeof stopTimelinePlayback === 'function') { try { stopTimelinePlayback(); } catch (e) { } }
                }
                setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 100);
            });
        });
    }

    function engancharTodos() {
        document.querySelectorAll('.sub-tabs-container').forEach(enganchar);
        // regla dura: en CREATE y STAGE sólo se ve el sub-tab activo
        ['tabPrompts', 'tabOutput'].forEach(function (id) {
            var p = document.getElementById(id);
            if (!p) return;
            Array.prototype.slice.call(p.children).forEach(function (c) {
                if (c.classList.contains('sub-tab-content')) {
                    c.style.display = c.classList.contains('active') ? '' : 'none';
                }
            });
        });
    }

    function refrescar() {
        moverBotones();
        engancharTodos();
        // si estás en STAGE (y no en el editor), el timeline no tiene por qué estar
        var stage = document.getElementById('tabOutput');
        var crear = document.getElementById('tabPrompts');
        var enEditor = crear && crear.classList.contains('active')
            && document.getElementById('crearEditor') && document.getElementById('crearEditor').classList.contains('active');
        if (stage && stage.classList.contains('active') && !enEditor) {
            document.body.classList.remove('tab-editor-active');
            var tl = document.querySelector('.timeline-container, #timeline, .timeline');
            if (tl && stage.contains(tl) === false) { /* el timeline vive fuera del tab: lo oculta la clase */ }
        }
    }

    function arrancar() {
        armarStage();
        refrescar();
        setInterval(refrescar, 6000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(arrancar, 1200); });
    else setTimeout(arrancar, 1200);

    window.UI2 = { refrescar: refrescar };
})();
