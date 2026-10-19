// ============================================================
// COMFYLATAM — detalles de celular
// ------------------------------------------------------------
// En el celular las pestañas van en una fila que se desplaza: al cambiar de
// pestaña la activa tiene que quedar a la vista — si no, el usuario cambia de
// pestaña y no ve el contenido porque el botón quedó fuera del encuadre.
//
// PERO la barra es del USUARIO mientras la arrastra: cualquier `scrollLeft`
// puesto desde acá mientras el dedo está abajo la devuelve al botón activo y no
// lo deja ni ver ni tocar los que quedan afuera (bug reportado en celular).
// Por eso: (1) sólo se recentra cuando CAMBIA la pestaña activa —no con
// cualquier cambio de clase, que el sistema de pestañas reescribe cada 2 s— y
// (2) nunca dentro de los 700 ms siguientes a un toque/arrastre.
// ============================================================
(function () {
    'use strict';

    var MQ = window.matchMedia('(max-width: 1024px)');
    var cont = document.querySelector('.tabs-container');
    if (!cont) return;

    // --- el dedo manda ---------------------------------------------------------
    var ultimoToque = 0;
    function marcarToque() { ultimoToque = Date.now(); }
    ['touchstart', 'touchmove', 'touchend', 'touchcancel',
     'pointerdown', 'pointermove', 'pointerup', 'pointercancel',
     'scroll', 'wheel'].forEach(function (ev) {
        cont.addEventListener(ev, marcarToque, { passive: true });
    });

    function puedeMover(forzar) {
        if (!MQ.matches) return false;
        if (forzar) return true;
        return (Date.now() - ultimoToque) > 700;   // el dedo todavía puede estar abajo
    }

    // ¿la barra la movió el usuario? Si es así no se le toca el scroll hasta
    // que él elija una pestaña (o gire el teléfono).
    var movidaPorUsuario = false;
    var programando = false;

    cont.addEventListener('scroll', function () {
        if (!programando) movidaPorUsuario = true;
    }, { passive: true });

    function centrar(activo, forzar) {
        if (!activo || !puedeMover(forzar)) return;
        if (movidaPorUsuario && !forzar) return;
        programando = true;
        try {
            var c = cont.getBoundingClientRect();
            var b = activo.getBoundingClientRect();
            if (b.left < c.left || b.right > c.right) {
                cont.scrollLeft += (b.left - c.left) - (c.width / 2) + (b.width / 2);
            }
        } catch (e) { }
        setTimeout(function () { programando = false; }, 120);
    }

    function activa() {
        return cont.querySelector('.tab-button.active, .ck-tab.active, .tab-button[aria-selected="true"]');
    }

    // --- 1) al cambiar de pestaña, la activa a la vista (sólo si cambió) ------
    var ultima = activa();
    try {
        new MutationObserver(function () {
            var a = activa();
            if (a === ultima) return;      // mismo botón: no se toca el scroll
            ultima = a;
            centrar(a);
        }).observe(cont, { attributes: true, subtree: true, attributeFilter: ['class', 'aria-selected'] });
    } catch (e) { }

    // --- 2) el usuario tocó un botón: eso sí es un cambio elegido -------------
    cont.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('.tab-button, .ck-tab') : null;
        if (!b) return;
        ultima = b;
        movidaPorUsuario = false;
        setTimeout(function () { centrar(b, true); }, 60);
    }, true);

    setTimeout(function () { centrar(activa(), true); }, 900);

    // El celular dispara `resize` cada vez que se esconde/aparece la barra de
    // direcciones (cambia el ALTO, no el ancho). Recentrar ahí devolvía la barra
    // al botón activo en medio del arrastre: el "rebote" que reportó el usuario.
    // Sólo se reacomoda si cambió el ANCHO (rotar el teléfono).
    var ultimoAncho = cont.clientWidth;
    window.addEventListener('resize', function () {
        var ancho = cont.clientWidth;
        var cambioDeAncho = Math.abs(ancho - ultimoAncho) > 24;
        ultimoAncho = ancho;
        if (!cambioDeAncho) return;
        movidaPorUsuario = false;
        centrar(activa(), true);
    });
})();
