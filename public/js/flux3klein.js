// ============================================================
// FLUX 3 Klein - Edit (Image to Image)
// ------------------------------------------------------------
// Edición de imagen con FLUX 3 Image Klein (int8): hasta 10
// imágenes de referencia, sectores (bounding boxes) y prompt
// upsampler (Qwen3.5-9B) SIEMPRE activo. El server elige
// base (50 steps, CFG 4) o distilled (16 steps, sin CFG).
// ============================================================
(function () {
    'use strict';

    var MAX_REFS = 10;

    var PRESETS = [
        { cols: 1, rows: 1, label: '1×1' },
        { cols: 2, rows: 1, label: '2×1' },
        { cols: 1, rows: 2, label: '1×2' },
        { cols: 2, rows: 2, label: '2×2' },
        { cols: 2, rows: 3, label: '2×3' },
        { cols: 3, rows: 2, label: '3×2' },
        { cols: 3, rows: 3, label: '3×3' }
    ];
    var estado = { cols: 2, rows: 2 };

    // cada slot = { filename, label, slotEl }; índice 0 = imagen principal
    var refs = [];

    function q(id) { return document.getElementById(id); }

    function frac(v) {
        var n = Number(v);
        if (!isFinite(n)) return 0;
        return Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;
    }

    // ---------- Grilla de sectores ----------
    function contenedor() { return q('fkGrid'); }
    function contenedorPresets() { return q('fkGridPresets'); }

    function leerSectores() {
        var out = [];
        var cont = contenedor();
        if (!cont) return out;
        var celdas = cont.querySelectorAll('.ideo-cell');
        for (var i = 0; i < celdas.length; i++) {
            var celda = celdas[i];
            var tipo = celda.querySelector('.ideo-cell-type');
            var texto = celda.querySelector('.ideo-cell-prompt');
            var type = tipo ? tipo.value : 'obj';
            var valor = texto ? texto.value.trim() : '';
            if (!valor) continue;
            var r = Number(celda.dataset.row);
            var c = Number(celda.dataset.col);
            out.push({
                type: type,
                desc: type === 'obj' ? valor : '',
                text: type === 'text' ? valor : '',
                x: frac(c / estado.cols),
                y: frac(r / estado.rows),
                w: frac(1 / estado.cols),
                h: frac(1 / estado.rows)
            });
        }
        return out;
    }

    function pintarGrilla() {
        var cont = contenedor();
        if (!cont) return;
        var html = '';
        for (var r = 0; r < estado.rows; r++) {
            for (var c = 0; c < estado.cols; c++) {
                var n = r * estado.cols + c + 1;
                html +=
                    '<div class="ideo-cell" data-row="' + r + '" data-col="' + c + '">' +
                    '<div class="ideo-cell-head">' +
                    '<span class="ideo-cell-badge">' + n + '</span>' +
                    '<select class="ideo-cell-type">' +
                    '<option value="obj">objeto</option>' +
                    '<option value="text">texto</option>' +
                    '</select>' +
                    '</div>' +
                    '<textarea class="ideo-cell-prompt" placeholder="Prompt del sector ' + n + '…"></textarea>' +
                    '</div>';
            }
        }
        cont.innerHTML = html;
        cont.style.gridTemplateColumns = 'repeat(' + estado.cols + ', 1fr)';

        cont.querySelectorAll('.ideo-cell').forEach(function (celda) {
            var sel = celda.querySelector('.ideo-cell-type');
            var ta = celda.querySelector('.ideo-cell-prompt');
            var n = celda.querySelector('.ideo-cell-badge').textContent;
            sel.addEventListener('change', function () {
                ta.placeholder = sel.value === 'text'
                    ? 'Texto exacto en el sector ' + n + '…'
                    : 'Prompt del sector ' + n + '…';
            });
        });
    }

    function pintarPresets() {
        var bar = contenedorPresets();
        if (!bar) return;
        bar.innerHTML = '';
        PRESETS.forEach(function (p) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'ideo-preset';
            b.textContent = p.label;
            if (p.cols === estado.cols && p.rows === estado.rows) b.classList.add('active');
            b.addEventListener('click', function () {
                estado.cols = p.cols;
                estado.rows = p.rows;
                pintarGrilla();
                pintarPresets();
            });
            bar.appendChild(b);
        });
    }

    // ---------- Carga de referencias ----------
    function subir(file, slot, cb) {
        var formData = new FormData();
        formData.append('image', file);
        fetch(window.JPI.API_BASE + '/api/upload-image', { method: 'POST', body: formData })
            .then(function (r) { return r.json(); })
            .then(function (result) {
                if (result.success) cb(result.filename);
                else appendConsoleLine('❌ Upload error: ' + (result.error || 'unknown'), 'error');
            })
            .catch(function (err) { appendConsoleLine('❌ Upload error: ' + err.message, 'error'); });
    }

    function pintarSlot(slot) {
        var el = slot.slotEl;
        el.classList.add('has-image');
        el.innerHTML =
            '<div class="fk-ref-label"><span>' + slot.label + '</span></div>' +
            '<img class="fk-ref-thumb" src="' + window.JPI.API_BASE + '/uploads/' + slot.filename + '" alt="">' +
            '<button type="button" class="fk-ref-remove" title="Quitar">×</button>';
        el.querySelector('.fk-ref-remove').addEventListener('click', function (e) {
            e.stopPropagation();
            quitarRef(slot);
        });
    }

    function quitarRef(slot) {
        var i = refs.indexOf(slot);
        if (i >= 0) refs.splice(i, 1);
        if (slot.slotEl && slot.slotEl.parentNode) slot.slotEl.parentNode.removeChild(slot.slotEl);
        renumerar();
        refrescarBotonAdd();
    }

    function renumerar() {
        refs.forEach(function (r, i) {
            r.label = i === 0 ? 'Imagen a editar' : 'Referencia ' + (i + 1);
            if (r.slotEl && r.slotEl.classList.contains('has-image')) {
                var lab = r.slotEl.querySelector('.fk-ref-label span');
                if (lab) lab.textContent = r.label;
            }
        });
    }

    function crearSlot(label) {
        var slot = { filename: null, label: label, slotEl: null };
        var div = document.createElement('div');
        div.className = 'fk-ref-slot';
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.hidden = true;

        div.addEventListener('click', function () {
            if (!div.classList.contains('has-image')) input.click();
        });
        div.addEventListener('dragover', function (e) { e.preventDefault(); div.classList.add('dragover'); });
        div.addEventListener('dragleave', function () { div.classList.remove('dragover'); });
        div.addEventListener('drop', function (e) {
            e.preventDefault();
            div.classList.remove('dragover');
            if (e.dataTransfer.files.length > 0) subir(e.dataTransfer.files[0], slot, function (fn) {
                slot.filename = fn;
                pintarSlot(slot);
                refrescarBotonAdd();
            });
        });
        input.addEventListener('change', function (e) {
            if (e.target.files.length > 0) subir(e.target.files[0], slot, function (fn) {
                slot.filename = fn;
                pintarSlot(slot);
                refrescarBotonAdd();
            });
        });

        div.appendChild(input);
        var ph = document.createElement('div');
        ph.className = 'fk-ref-placeholder';
        ph.textContent = 'Drop imagen';
        div.appendChild(ph);
        slot.slotEl = div;
        return slot;
    }

    function refrescarBotonAdd() {
        var b = q('fkAddRef');
        if (!b) return;
        var usados = refs.length;
        b.disabled = usados >= MAX_REFS;
        b.textContent = usados >= MAX_REFS
            ? 'Máximo ' + MAX_REFS + ' referencias'
            : '+ Agregar referencia (' + usados + '/' + MAX_REFS + ')';
    }

    function initUpload() {
        var area = q('fkUploadArea');
        if (area) {
            var primario = crearSlot('Imagen a editar');
            primario.slotEl = area;
            refs.push(primario);
            area.classList.add('fk-ref-slot');
            area.addEventListener('click', function () {
                if (!area.classList.contains('has-image')) {
                    var inp = area.querySelector('input[type="file"]');
                    if (inp) inp.click();
                }
            });
            area.addEventListener('dragover', function (e) { e.preventDefault(); area.classList.add('dragover'); });
            area.addEventListener('dragleave', function () { area.classList.remove('dragover'); });
            area.addEventListener('drop', function (e) {
                e.preventDefault();
                area.classList.remove('dragover');
                if (e.dataTransfer.files.length > 0) subir(e.dataTransfer.files[0], primario, function (fn) {
                    primario.filename = fn;
                    pintarSlot(primario);
                    refrescarBotonAdd();
                });
            });
            var inpPrimario = area.querySelector('input[type="file"]');
            if (inpPrimario) {
                inpPrimario.addEventListener('change', function (e) {
                    if (e.target.files.length > 0) subir(e.target.files[0], primario, function (fn) {
                        primario.filename = fn;
                        pintarSlot(primario);
                        refrescarBotonAdd();
                    });
                });
            }
        }

        var add = q('fkAddRef');
        if (add) {
            add.addEventListener('click', function () {
                var cont = q('fkExtraRefs');
                if (!cont) return;
                var slot = crearSlot('Referencia ' + (refs.length + 1));
                refs.push(slot);
                cont.appendChild(slot.slotEl);
                refrescarBotonAdd();
            });
        }
    }

    // ---------- Generar ----------
    function modelInfo() {
        var m = q('fkModel') ? q('fkModel').value : 'distilled';
        return m === 'base'
            ? { id: 'base', steps: 50, cfg: 4.0 }
            : { id: 'distilled', steps: 16, cfg: 1.0 };
    }

    window.generateFlux3Klein = function () {
        var prompt = q('fkPrompt') ? q('fkPrompt').value.trim() : '';
        if (!prompt) { appendConsoleLine('⚠️ Escribí el prompt de edición', 'warning'); return; }
        var filenames = refs.filter(function (r) { return r && r.filename; }).map(function (r) { return r.filename; });
        if (!filenames.length) { appendConsoleLine('⚠️ Cargá al menos la imagen a editar', 'warning'); return; }

        var m = modelInfo();
        var sectores = leerSectores();

        addToQueue(prompt, filenames[0], {
            modelo: 'flux3klein',
            params: {
                modelo: 'flux3klein',
                fkModel: m.id,
                imageFilenames: filenames,
                aspectRatio: q('fkAspect') ? q('fkAspect').value : 'auto',
                resolution: q('fkResolution') ? q('fkResolution').value : '1K',
                samplerSteps: getSliderVal('fkSteps') || m.steps,
                seed: getSeed('fk'),
                sectores: sectores
            }
        });

        appendConsoleLine('🎨 FLUX 3 Klein encolado (' + m.id + ', ' + filenames.length + ' ref' + (filenames.length === 1 ? '' : 's') + (sectores.length ? ', ' + sectores.length + ' sectores' : '') + ')', 'system');
        if (document.getElementById('tabOutputBtn')) document.getElementById('tabOutputBtn').click();
    };

    function init() {
        pintarPresets();
        pintarGrilla();
        initUpload();
        refrescarBotonAdd();

        var sel = q('fkModel');
        if (sel) {
            sel.addEventListener('change', function () {
                var m = modelInfo();
                var slider = document.querySelector('.wf-param-slider[data-bind="fkSteps"]');
                if (slider) {
                    slider.value = m.steps;
                    var val = slider.parentElement.querySelector('.wf-val');
                    if (val) val.textContent = m.steps;
                }
            });
        }

        var btn = document.querySelector('.wf-gen-btn[data-workflow="flux3klein"]');
        if (btn) btn.addEventListener('click', window.generateFlux3Klein);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
