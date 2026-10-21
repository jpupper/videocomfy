/* ÚNICA FUENTE DE LOS ESTADOS DE UN PEDIDO
 * Antes cada panel (REGISTRO, BATCH, cola de ComfyUI, panel izquierdo) tenía su
 * propia copia de emojis, textos y listas de estados; se desincronizaban
 * (por ejemplo "en curso" incluía o no "pedida" según el archivo).
 *
 * Ciclo: pedida → en_comfy → devuelta → subiendo → listo
 *        y los finales raros: sin_nube | cancelada | interrumpida | error
 */
(function () {
    'use strict';

    var ICONO = {
        pedida: '⏳', en_comfy: '⚙️', devuelta: '📥', subiendo: '☁️',
        listo: '✅', cancelada: '✖', interrumpida: '⚠️', error: '⚠️', sin_nube: '💾'
    };
    var TEXTO = {
        pedida: 'pedida', en_comfy: 'en ComfyUI', devuelta: 'volvió al local',
        subiendo: 'subiendo a la nube', listo: 'lista', cancelada: 'cancelada',
        interrumpida: 'interrumpida', error: 'error', sin_nube: 'lista (quedó local)'
    };

    // el trabajo ocupa el motor ahora
    var EN_CURSO = ['en_comfy', 'devuelta', 'subiendo'];
    // esperando turno
    var EN_ESPERA = ['pedida'];
    // todo lo que sigue vivo (para contadores de "en el batch")
    var ACTIVOS = ['pedida'].concat(EN_CURSO);
    // terminaron bien
    var HECHAS = ['listo', 'sin_nube'];
    // terminaron mal
    var CANCELADAS = ['cancelada', 'interrumpida', 'error'];

    // orden de avance en la línea de tiempo
    var ORDEN = ['pedida', 'en_comfy', 'devuelta', 'subiendo', 'listo'];

    function icono(estado) { return ICONO[estado] || '·'; }
    function texto(estado) { return TEXTO[estado] || estado || ''; }
    function esActivo(estado) { return ACTIVOS.indexOf(estado) >= 0; }
    function esEnCurso(estado) { return EN_CURSO.indexOf(estado) >= 0; }
    function esFinal(estado) { return HECHAS.indexOf(estado) >= 0 || CANCELADAS.indexOf(estado) >= 0; }

    window.CKEstados = {
        ICONO: ICONO, TEXTO: TEXTO,
        EN_CURSO: EN_CURSO, EN_ESPERA: EN_ESPERA, ACTIVOS: ACTIVOS,
        HECHAS: HECHAS, CANCELADAS: CANCELADAS, ORDEN: ORDEN,
        icono: icono, texto: texto, esActivo: esActivo, esEnCurso: esEnCurso, esFinal: esFinal
    };
})();
