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
                if (contiene(hijo, ['a dónde va', 'última generación', 'registro'])) bloques.push({ nodo: hijo, tipo: 'community' });
                else if (contiene(hijo, ['tu batch local', 'completed history', 'nothing to generate', 'en cola', 'pendientes'])) bloques.push({ nodo: hijo, tipo: 'batch' });
                else juntar(hijo);
            });
        })(stage);

        if (!bloques.length) return;

        var community = document.createElement('div');
        community.id = 'stageCommunity';
        community.className = 'sub-tab-content active';
        var batch = document.createElement('div');
        batch.id = 'stageBatch';
        batch.className = 'sub-tab-content';

        bloques.forEach(function (b) {
            (b.tipo === 'community' ? community : batch).appendChild(b.nodo);
        });

        var barra = document.createElement('div');
        barra.id = 'stageSubTabs';
        barra.className = 'sub-tabs-container';
        barra.innerHTML =
            '<button class="sub-tab-btn sub-tab-btn-std active" data-sub="stageCommunity">🌎 COMMUNITY</button>' +
            '<button class="sub-tab-btn sub-tab-btn-std" data-sub="stageBatch">🏠 BATCH</button>';

        stage.appendChild(barra);
        stage.appendChild(community);
        stage.appendChild(batch);
        enganchar(barra);
    }

    // ---------- 2) botones a su lugar ----------
    function moverBotones() {
        var fila = document.querySelector('.tabs-container');
        var barra = document.getElementById('projectTabsNav');
        // RED, usuario y versión -> menú de arriba (junto a las pestañas)
        ['redBtn', 'jpiRedBtn', 'perfilBtn', 'jpiPerfilBtn', 'ckVersionChip'].forEach(function (id) {
            var b = document.getElementById(id);
            if (b && fila && b.parentElement !== fila) fila.appendChild(b);
        });
        // los botones de RED/perfil que no tengan id conocido: por su texto
        if (barra) {
            Array.prototype.slice.call(barra.querySelectorAll('button')).forEach(function (b) {
                var t = texto(b).toLowerCase();
                if (t.indexOf('red') >= 0 || t.indexOf('perfil') >= 0 || t.indexOf('cuenta') >= 0) {
                    if (fila) fila.appendChild(b);
                }
            });
        }
        // NEW SESSION (+) y SAVE (💾) -> dentro de CREATE
        var crear = document.getElementById('tabPrompts');
        var nuevo = document.getElementById('newProjectBtn');
        var guardar = document.getElementById('saveProjectBtn');
        if (crear && nuevo && guardar) {
            var caja = document.getElementById('crearAcciones') || document.createElement('div');
            caja.id = 'crearAcciones';
            caja.className = 'crear-acciones';
            caja.appendChild(nuevo);
            caja.appendChild(guardar);
            crear.insertBefore(caja, crear.firstChild);
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
                if (destino === 'crearEditor' || destino === 'stageCommunity') {
                    document.body.classList.add('tab-editor-active');
                } else {
                    document.body.classList.remove('tab-editor-active');
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
    }

    function arrancar() {
        armarStage();
        refrescar();
        setInterval(refrescar, 3000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(arrancar, 1200); });
    else setTimeout(arrancar, 1200);

    window.UI2 = { refrescar: refrescar };
})();
