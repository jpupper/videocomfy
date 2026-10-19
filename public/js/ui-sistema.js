// ============================================================================
// SISTEMA CENTRAL DE UI — pestañas y sub-pestañas de TODA la app
// ----------------------------------------------------------------------------
// PROBLEMA QUE RESUELVE
// Cada menú estaba programado a su manera: `.tabs-container` (arriba),
// `.sub-tabs-container` (PREVIZ, RANKING), barras creadas por JS (STAGE, CREATE)
// y `.asset-tabs-container` (STUDIO ASSETS). Cada uno prendía/apagaba distinto:
// el handler de STAGE/CREATE cambiaba el panel pero NO movía la clase `active`,
// así que quedaban dos botones "prendidos" (COMMUNITY + BATCH, WORKFLOWS + EDITOR).
//
// CÓMO FUNCIONA AHORA
// 1. Descubre todas las barras (por selector conocido o con [data-ck-tabs]) y las
//    normaliza: la barra recibe `.ck-tabs`, cada botón `.ck-tab` (sin borrar sus
//    clases originales, para no romper nada de lo que ya existía).
// 2. Un ÚNICO listener delegado decide: en la barra tocada queda UN solo `.active`.
// 3. Si los botones traen `data-sub` y los paneles son `.sub-tab-content`
//    hermanos de la barra, el sistema también muestra/oculta el panel.
// 4. Avisa con el evento `ck:tab` (detalle: { barra, boton, destino }) para que
//    los módulos que necesitan reaccionar (editor, resize) no dupliquen lógica.
// 5. Verifica al arrancar y cada tanto que ninguna barra quede con 0 o 2 activos.
// El estilo vive en css/ui-sistema.css (se carga último): una sola apariencia
// para categorías y subcategorías.
// ============================================================================
(function () {
    'use strict';

    // Selectores de las barras que existen hoy. [data-ck-tabs] es la vía para
    // cualquier barra nueva: alcanza con ponerle ese atributo.
    var SELECTORES_BARRA = [
        '.tabs-container',          // categorías: PREVIZ / STAGE / CREATE / ...
        '.sub-tabs-container',      // PREVIZ (VIDEO/DATA), RANKING, y las que crea JS
        '.asset-tabs-container',    // STUDIO ASSETS (EJEMPLOS/VIDEOS/IMAGES/...)
        '.red-subtabs',             // RED: LA RED / MI EQUIPO (data-redsub, panel propio)
        '[data-ck-tabs]'            // futuras
    ];

    // Botones que NUNCA son pestañas aunque vivan en la barra.
    var NO_ES_PESTANIA = /(^|\s)(ck-version-chip|ck-perfil-btn|new-project-btn-nav|save-project-btn-nav|sidebar-collapse-btn|close-tab-btn|jpi-pausa|pause-btn)(\s|$)/;

    function esBotonPestania(b) {
        if (!b || b.tagName !== 'BUTTON') return false;
        if (NO_ES_PESTANIA.test(String(b.className))) return false;
        return true;
    }

    function barras() {
        var out = [];
        SELECTORES_BARRA.forEach(function (sel) {
            document.querySelectorAll(sel).forEach(function (el) {
                if (out.indexOf(el) < 0) out.push(el);
            });
        });
        return out;
    }

    // --- 1) normalizar: marcar barra y botones ---------------------------------
    function normalizarBarra(barra) {
        if (!barra || barra.dataset.ckUiListo === '1') {
            if (barra) marcarBotones(barra);
            return;
        }
        barra.dataset.ckUiListo = '1';
        barra.classList.add('ck-tabs');
        if (!barra.getAttribute('role')) barra.setAttribute('role', 'tablist');
        // la barra de arriba son categorías; el resto, subcategorías
        barra.dataset.ckNivel = barra.classList.contains('tabs-container') ? 'categoria' : 'subcategoria';
        marcarBotones(barra);
    }

    // Saca el emoji/glifo del principio del texto (los submenús van sin iconos:
    // pedido del usuario, y además ⬢/① se ven como cuadraditos en algunos equipos).
    var RE_ICONO_INICIAL = /^[\p{Extended_Pictographic}\uFE0F\u200D\u2190-\u21FF\u2300-\u23FF\u2460-\u24FF\u25A0-\u27BF\u2B00-\u2BFF\u0020]+/u;

    function sacarIcono(b) {
        var t = (b.textContent || '');
        var limpio = t.replace(RE_ICONO_INICIAL, '').trim();
        if (limpio && limpio !== t.trim()) b.textContent = limpio;
    }

    function marcarBotones(barra) {
        var esSub = barra.dataset.ckNivel === 'subcategoria';
        Array.prototype.forEach.call(barra.children, function (b) {
            if (!esBotonPestania(b)) return;
            if (esSub) sacarIcono(b);
            // OJO: escribir una clase/atributo que YA está igual dispara un
            // MutationObserver y, con él, cualquier recentrado del scroll: esta
            // función corre cada 2 s sobre TODAS las barras, así que reescribir
            // de más sacaba la fila del celular de donde la había puesto el
            // usuario. Sólo se escribe lo que falta.
            if (!b.classList.contains('ck-tab')) b.classList.add('ck-tab');
            if (!b.getAttribute('role')) b.setAttribute('role', 'tab');
            // el estado accesible se sincroniza siempre (lo usa también el CSS)
            var aria = b.classList.contains('active') ? 'true' : 'false';
            if (b.getAttribute('aria-selected') !== aria) b.setAttribute('aria-selected', aria);
        });
    }

    // --- 2) seleccionar: UN solo activo por barra ------------------------------
    function botonesDe(barra) {
        return Array.prototype.filter.call(barra.children, esBotonPestania);
    }

    // El usuario arrastrando una barra horizontal manda: si el dedo está abajo
    // (o acaba de estar), NO se le toca el scroll. Sin esto, el recentrado
    // devolvía la fila al botón activo y en el celular no se podía llegar a los
    // últimos botones (bug reportado).
    var ultimoToque = 0;
    ['touchstart', 'touchmove', 'touchend', 'touchcancel',
     'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel'].forEach(function (ev) {
        document.addEventListener(ev, function () { ultimoToque = Date.now(); }, { passive: true, capture: true });
    });

    function activar(barra, boton, opciones) {
        var opts = opciones || {};
        var yaEraActivo = boton.classList.contains('active') &&
            botonesDe(barra).filter(function (b) { return b.classList.contains('active'); }).length === 1;
        botonesDe(barra).forEach(function (b) {
            var esEste = (b === boton);
            if (b.classList.contains('active') !== esEste) b.classList.toggle('active', esEste);
            var aria = esEste ? 'true' : 'false';
            if (b.getAttribute('aria-selected') !== aria) b.setAttribute('aria-selected', aria);
        });
        // paneles: sólo si TODOS los botones apuntan a destinos distintos
        var destinos = botonesDe(barra).map(function (b) { return b.getAttribute('data-sub'); });
        var todosDistintos = destinos.every(function (d) { return d; }) &&
            destinos.filter(function (d, i) { return destinos.indexOf(d) === i; }).length === destinos.length;
        var destino = boton.getAttribute('data-sub');
        if (destino && todosDistintos && !opts.sinPaneles) {
            var padre = barra.parentElement;
            if (padre) {
                Array.prototype.forEach.call(padre.querySelectorAll(':scope > .sub-tab-content'), function (c) {
                    c.classList.remove('active');
                });
            }
            var panel = document.getElementById(destino);
            if (panel) {
                panel.classList.add('active');
                panel.removeAttribute('hidden');
            }
        }
        // el modo "editor" (timeline abajo) es exclusivo de CREATE > EDITOR
        if (destino === 'crearEditor') {
            document.body.classList.add('tab-editor-active');
        } else if (barra.classList.contains('ck-tabs') && barra.dataset.ckNivel === 'subcategoria' &&
                   barra.closest('#tabPrompts')) {
            document.body.classList.remove('tab-editor-active');
        }
        // si la barra se desplaza, la elegida tiene que quedar a la vista.
        // OJO: scrollIntoView también mueve en VERTICAL y sacaba la fila de la
        // vista (el botón quedaba con y negativo). Se mueve sólo en horizontal,
        // y sólo cuando la pestaña activa CAMBIA de verdad: recentrar la misma
        // en cada verificación (cada 2 s) le sacaba la fila de las manos al que
        // la estaba arrastrando en el celular.
        try {
            var sinDedo = (Date.now() - ultimoToque) > 700;
            if (!yaEraActivo && sinDedo && barra.scrollWidth > barra.clientWidth + 4) {
                barra.scrollTop = 0;
                var izq = boton.offsetLeft - (barra.clientWidth - boton.offsetWidth) / 2;
                barra.scrollLeft = Math.max(0, izq);
            }
        } catch (e) { }
        try {
            document.dispatchEvent(new CustomEvent('ck:tab', {
                detail: { barra: barra, boton: boton, destino: destino || null, nivel: barra.dataset.ckNivel }
            }));
        } catch (e) { }
    }

    // --- 3) un único listener (fase de captura: gana siempre) ------------------
    document.addEventListener('click', function (ev) {
        var boton = ev.target && ev.target.closest ? ev.target.closest('.ck-tab') : null;
        if (!boton) return;
        var barra = boton.closest('.ck-tabs');
        if (!barra) return;
        // categorías: el panel lo maneja la app; acá sólo se asegura el estado
        activar(barra, boton, { sinPaneles: true });
        // y después de que corra el handler original de la app, se vuelve a
        // asegurar (algunos handlers viejos reponen `active` en otro botón)
        setTimeout(function () {
            if (!barra.isConnected) return;
            var sigueSiendo = botonesDe(barra).filter(function (b) {
                return b.classList.contains('active');
            });
            if (sigueSiendo.length !== 1 || sigueSiendo[0] !== boton) activar(barra, boton, { sinPaneles: true });
        }, 0);
    }, true);

    // --- 4) teclado: flechas entre pestañas -----------------------------------
    document.addEventListener('keydown', function (ev) {
        var boton = ev.target && ev.target.closest ? ev.target.closest('.ck-tab') : null;
        if (!boton) return;
        if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
        var barra = boton.closest('.ck-tabs');
        if (!barra) return;
        var lista = botonesDe(barra);
        var i = lista.indexOf(boton);
        if (i < 0) return;
        var siguiente = lista[(i + (ev.key === 'ArrowRight' ? 1 : lista.length - 1)) % lista.length];
        ev.preventDefault();
        siguiente.focus();
        siguiente.click();
    }, true);

    // --- 5) arranque y control: nunca 0 ni 2 activos ---------------------------
    function verificarTodas() {
        barras().forEach(function (barra) {
            normalizarBarra(barra);
            var lista = botonesDe(barra);
            if (!lista.length) return;
            var activos = lista.filter(function (b) { return b.classList.contains('active'); });
            if (activos.length === 1) return;
            if (activos.length === 0) {
                // si el panel visible es uno de los destinos, se prende ese boton
                var visible = null;
                lista.forEach(function (b) {
                    var d = b.getAttribute('data-sub');
                    var p = d ? document.getElementById(d) : null;
                    if (p && p.classList.contains('active') && !visible) visible = b;
                });
                activar(barra, visible || lista[0], { sinPaneles: !visible });
            } else {
                activar(barra, activos[0], { sinPaneles: true });
            }
        });
    }

    function arrancar() {
        verificarTodas();
        setTimeout(verificarTodas, 400);
        setTimeout(verificarTodas, 1500);
        // los módulos crean barras después (STAGE, CREATE, RED...): se revisan
        setInterval(verificarTodas, 2000);
        // y cuando el DOM cambia mucho (cambio de pestaña, panel nuevo)
        var pendiente = null;
        try {
            new MutationObserver(function () {
                clearTimeout(pendiente);
                pendiente = setTimeout(verificarTodas, 250);
            }).observe(document.body, { childList: true, subtree: true });
        } catch (e) { }
    }

    // API pública mínima (por si un módulo necesita forzar la selección)
    window.CKUI = {
        activar: function (idBoton) {
            var b = document.getElementById(idBoton);
            if (!b) return false;
            var barra = b.closest('.ck-tabs');
            if (!barra) return false;
            activar(barra, b);
            return true;
        },
        verificar: verificarTodas
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', arrancar);
    } else {
        arrancar();
    }
})();
