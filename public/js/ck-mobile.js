// ============================================================
// COMFYLATAM — detalles de celular
// ------------------------------------------------------------
// En el celular las pestañas van en una fila que se desplaza: al cambiar de
// pestaña (o al entrar), la activa tiene que quedar a la vista — si no, el
// usuario cambia de pestaña y no ve el contenido porque el botón quedó fuera
// del encuadre.
// ============================================================
(function () {
    'use strict';

    var MQ = window.matchMedia('(max-width: 1024px)');
    var cont = document.querySelector('.tabs-container');
    if (!cont) return;

    function centrar(activo) {
        if (!MQ.matches || !activo) return;
        try {
            var c = cont.getBoundingClientRect();
            var b = activo.getBoundingClientRect();
            if (b.left < c.left || b.right > c.right) {
                cont.scrollLeft += (b.left - c.left) - (c.width / 2) + (b.width / 2);
            }
        } catch (e) { }
    }

    function activa() { return cont.querySelector('.tab-button.active, .tab-button[aria-selected="true"]'); }

    // al cambiar de pestaña (la clase la pone el resto de la app)
    try {
        new MutationObserver(function () { centrar(activa()); })
            .observe(cont, { attributes: true, subtree: true, attributeFilter: ['class'] });
    } catch (e) { }

    cont.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('.tab-button') : null;
        if (b) setTimeout(function () { centrar(b); }, 60);
    }, true);

    setTimeout(function () { centrar(activa()); }, 900);
    window.addEventListener('resize', function () { centrar(activa()); });
})();
