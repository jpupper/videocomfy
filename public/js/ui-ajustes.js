// ============================================================
// AJUSTES DE INTERFAZ
// ------------------------------------------------------------
// 1) Saca el título COMFYLATAM y el cartel T2V ACTIVE del encabezado.
// 2) Renombra ENGINE LOGS -> CONSOLE.
// 3) Deja WORKFLOWS / EDITOR / STORYBOARD como sub-pestañas DENTRO de CREATE
//    (antes EDITOR y STORYBOARD eran pestañas sueltas arriba).
// El contenido de EDITOR y STORYBOARD se mueve tal cual, no se reescribe: sólo
// cambia de lugar y de clase (tab-content -> sub-tab-content).
// ============================================================
(function () {
    'use strict';

    // ---------- 1) encabezado ----------
    function limpiarEncabezado() {
        // el título grande "COMFYLATAM"
        document.querySelectorAll('.sectionheader h1, header h1').forEach(function (h) {
            if (/^\s*COMFYLATAM\s*$/i.test(h.textContent || '')) h.remove();
        });
        // el cartel de modo ("T2V ACTIVE" y sus hermanos)
        var modo = document.getElementById('modeText');
        if (modo) {
            var cont = modo.closest('div') || modo.parentElement;
            if (cont) cont.style.display = 'none'; else modo.style.display = 'none';
        }
    }

    // ---------- 2) ENGINE LOGS -> CONSOLE ----------
    function renombrarConsola() {
        var b = document.getElementById('tabLogsBtn');
        if (b) b.textContent = 'CONSOLE';
    }

    // ---------- 3) sub-pestañas dentro de CREATE ----------
    function armarSubPestanias() {
        var crear = document.getElementById('tabPrompts');
        var editor = document.getElementById('tabEditor');
        var story = document.getElementById('tabStoryboard');
        if (!crear || !editor || !story) return false;
        if (document.getElementById('crearSubTabs')) return true;   // ya armado

        // a) todo lo que había en CREATE pasa a ser la sub-pestaña "WORKFLOWS"
        var wf = document.createElement('div');
        wf.id = 'crearWorkflows';
        wf.className = 'sub-tab-content active';
        while (crear.firstChild) wf.appendChild(crear.firstChild);
        crear.appendChild(wf);

        // b) las dos pestañas que se mudan
        [['crearEditor', editor], ['crearStoryboard', story]].forEach(function (par) {
            var id = par[0], nodo = par[1];
            nodo.classList.remove('tab-content');
            nodo.classList.remove('active');
            nodo.classList.add('sub-tab-content');
            nodo.id = id;                       // se renombra: ya no son pestañas de arriba
            crear.appendChild(nodo);
        });

        // c) la barra de sub-pestañas, arriba de todo
        var barra = document.createElement('div');
        barra.id = 'crearSubTabs';
        barra.className = 'sub-tabs-container';
        barra.innerHTML =
            '<button class="sub-tab-btn sub-tab-btn-std active" data-sub="crearWorkflows">🔧 WORKFLOWS</button>' +
            '<button class="sub-tab-btn sub-tab-btn-std" data-sub="crearEditor">✂️ EDITOR</button>' +
            '<button class="sub-tab-btn sub-tab-btn-std" data-sub="crearStoryboard">🎞️ STORYBOARD</button>';
        crear.insertBefore(barra, wf);

        // d) al cambiar de sub-pestaña, avisar al editor (necesita recalcular su
        //    tamaño porque antes no estaba visible)
        barra.querySelectorAll('.sub-tab-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var cual = btn.getAttribute('data-sub');
                if (cual === 'crearEditor') {
                    document.body.classList.add('tab-editor-active');
                    setTimeout(function () {
                        window.dispatchEvent(new Event('resize'));
                        var c = document.querySelector('#crearEditor canvas');
                        if (c && c.parentElement) window.dispatchEvent(new Event('resize'));
                    }, 120);
                } else {
                    document.body.classList.remove('tab-editor-active');
                    if (typeof stopTimelinePlayback === 'function') { try { stopTimelinePlayback(); } catch (e) { } }
                }
            });
        });

        // e) sacar los botones de arriba (EDITOR y STORYBOARD ya no son pestañas)
        ['tabEditorBtn', 'tabStoryboardBtn'].forEach(function (id) {
            var b = document.getElementById(id);
            if (b) b.remove();
        });
        return true;
    }

    function arrancar() {
        limpiarEncabezado();
        renombrarConsola();
        armarSubPestanias();
        // por si el front se re-renderiza
        setTimeout(function () { limpiarEncabezado(); renombrarConsola(); armarSubPestanias(); }, 2500);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(arrancar, 900); });
    else setTimeout(arrancar, 900);

    window.UI_AJUSTES = { arrancar: arrancar };
})();
