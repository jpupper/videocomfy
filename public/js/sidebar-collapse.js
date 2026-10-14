// ============================================================
// Colapsado de paneles laterales (escritorio)
// ------------------------------------------------------------
// Toggle para comprimir/expandir Studio Generator y Studio Assets.
// En mobile no hace nada: los paneles ya son cajones (mobile.js).
// ============================================================
(function () {
    'use strict';

    var LS_LEFT = 'vc.sidebarLeftCollapsed';
    var LS_RIGHT = 'vc.sidebarRightCollapsed';

    var leftBtn = document.getElementById('collapseLeftBtn');
    var rightBtn = document.getElementById('collapseRightBtn');
    var leftArrow = leftBtn ? leftBtn.querySelector('.collapse-arrow') : null;
    var rightArrow = rightBtn ? rightBtn.querySelector('.collapse-arrow') : null;

    function lee(nombre) {
        try { return localStorage.getItem(nombre) === '1'; } catch (e) { return false; }
    }
    function guarda(nombre, valor) {
        try { localStorage.setItem(nombre, valor ? '1' : '0'); } catch (e) {}
    }

    function actualizaFlechas() {
        if (leftArrow) {
            leftArrow.textContent = document.body.classList.contains('sidebar-left-collapsed') ? '»' : '«';
        }
        if (rightArrow) {
            rightArrow.textContent = document.body.classList.contains('sidebar-right-collapsed') ? '«' : '»';
        }
    }

    function toggle(clase, ls) {
        var activo = document.body.classList.toggle(clase);
        guarda(ls, activo);
        actualizaFlechas();
    }

    function init() {
        if (!leftBtn && !rightBtn) return;

        // Estado inicial (persistido entre recargas)
        if (lee(LS_LEFT)) document.body.classList.add('sidebar-left-collapsed');
        if (lee(LS_RIGHT)) document.body.classList.add('sidebar-right-collapsed');

        if (leftBtn) leftBtn.addEventListener('click', function () { toggle('sidebar-left-collapsed', LS_LEFT); });
        if (rightBtn) rightBtn.addEventListener('click', function () { toggle('sidebar-right-collapsed', LS_RIGHT); });

        actualizaFlechas();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
