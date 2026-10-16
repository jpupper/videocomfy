// ============================================================
// COMFYLATAM — Controlador del Panel Izquierdo
// 1) Información de Entorno (Local y Web)
// 2) Servidores: Servidor VPS vs Servidor ComfyUI (especifica cuál falla)
// 3) Minipanel "Tu Computadora": prendida o apagada
// 4) Menú y métricas de Cola: cuántas quedan en cola + controles
// ============================================================
(function () {
    'use strict';

    var J = window.JPI || {};
    var API_BASE = J.API_BASE || '';
    var URL_STATUS = API_BASE + '/api/status';
    var esWeb = (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1' && location.hostname.indexOf('localhost') === -1);
    var ultimoStatus = null;
    var vpsOnline = false;

    // Elementos del DOM
    var dom = {
        entornoBox: null,
        entornoMode: null,
        entornoDesc: null,

        // Servidor VPS / Web
        vpsDot: null,
        vpsStatus: null,
        vpsDetail: null,
        vpsAlert: null,

        // Servidor ComfyUI
        comfyDot: null,
        comfyStatus: null,
        comfyDetail: null,
        comfyAlert: null,
        comfyConfigBtn: null,

        // Tu Computadora
        equipoBox: null,
        equipoDot: null,
        equipoBadge: null,
        equipoHost: null,
        equipoTitulo: null,
        equipoSub: null,
        equipoTele: null,

        // Cola de trabajo
        colaPill: null,
        colaSub: null,
        colaEjecutando: null,
        colaPendientes: null,
        colaCompletados: null,
        colaList: null,
        colaToggleBtn: null,
        btnPausar: null,
        btnStage: null
    };

    function initDom() {
        dom.entornoBox = document.getElementById('piEntornoBox');
        dom.entornoMode = document.getElementById('piEntornoMode');
        dom.entornoDesc = document.getElementById('piEntornoDesc');

        dom.vpsDot = document.getElementById('piVpsDot');
        dom.vpsStatus = document.getElementById('piVpsStatus');
        dom.vpsDetail = document.getElementById('piVpsDetail');
        dom.vpsAlert = document.getElementById('piVpsAlert');

        dom.comfyDot = document.getElementById('piComfyDot');
        dom.comfyStatus = document.getElementById('piComfyStatus');
        dom.comfyDetail = document.getElementById('piComfyDetail');
        dom.comfyAlert = document.getElementById('piComfyAlert');
        dom.comfyConfigBtn = document.getElementById('piComfyConfigBtn');

        dom.equipoBox = document.getElementById('piEquipoBox');
        dom.equipoDot = document.getElementById('piEquipoDot');
        dom.equipoBadge = document.getElementById('piEquipoBadge');
        dom.equipoHost = document.getElementById('piEquipoHost');
        dom.equipoTitulo = document.getElementById('piEquipoTituloTxt');
        dom.equipoSub = document.getElementById('piEquipoSub');
        dom.equipoTele = document.getElementById('piEquipoTele');

        dom.colaPill = document.getElementById('piColaPill');
        dom.colaSub = document.getElementById('piColaSub');
        dom.colaEjecutando = document.getElementById('piColaEjecutando');
        dom.colaPendientes = document.getElementById('piColaPendientes');
        dom.colaCompletados = document.getElementById('piColaCompletados');
        dom.colaList = document.getElementById('piColaList');
        dom.colaToggleBtn = document.getElementById('piColaToggleBtn');
        dom.btnPausar = document.getElementById('piBtnPausar');
        dom.btnStage = document.getElementById('piBtnStage');

        // Eventos
        if (dom.comfyConfigBtn) {
            dom.comfyConfigBtn.addEventListener('click', function () {
                var btnSettings = document.getElementById('tabSettingsBtn');
                if (btnSettings) btnSettings.click();
            });
        }

        if (dom.btnPausar) {
            dom.btnPausar.addEventListener('click', function () {
                if (window.JPI_COLA_PAUSADA) {
                    if (typeof window.jpiColaReanudar === 'function') window.jpiColaReanudar();
                } else {
                    if (typeof window.jpiColaPausar === 'function') window.jpiColaPausar();
                }
                actualizarCola();
            });
        }

        if (dom.btnStage) {
            dom.btnStage.addEventListener('click', function () {
                var btnStageTab = document.getElementById('tabOutputBtn');
                if (btnStageTab) btnStageTab.click();
            });
        }

        if (dom.colaToggleBtn) {
            dom.colaToggleBtn.addEventListener('click', function () {
                if (!dom.colaList) return;
                var visible = dom.colaList.style.display !== 'none';
                dom.colaList.style.display = visible ? 'none' : 'flex';
                dom.colaToggleBtn.textContent = visible ? '👁️ Ver items' : 'Ocultar items';
            });
        }
    }

    // --- 1. ENTORNO ---
    function actualizarEntorno() {
        if (!dom.entornoBox) return;
        if (esWeb) {
            dom.entornoBox.className = 'pi-entorno-box web';
            if (dom.entornoMode) dom.entornoMode.innerHTML = '🌐 MODO WEB / VPS';
            if (dom.entornoDesc) dom.entornoDesc.textContent = 'Conectado a ' + (location.host || 'vps-4455523-x.dattaweb.com');
        } else {
            dom.entornoBox.className = 'pi-entorno-box local';
            if (dom.entornoMode) dom.entornoMode.innerHTML = '💻 MODO LOCAL';
            if (dom.entornoDesc) dom.entornoDesc.textContent = 'Ejecutando en tu PC (127.0.0.1)';
        }
    }

    // --- 2. SERVIDORES (VPS vs ComfyUI) y 3. TU COMPUTADORA ---
    function actualizarServidoresYEquipo(d, errorFetch) {
        // A) SERVIDOR VPS / WEB (o Local Node)
        var serverName = esWeb ? 'Servidor VPS' : 'Servidor Local';
        var serverHost = esWeb ? (location.host || 'vps-4455523-x.dattaweb.com') : 'localhost:5634';

        if (errorFetch) {
            vpsOnline = false;
            if (dom.vpsDot) dom.vpsDot.className = 'pi-dot offline';
            if (dom.vpsStatus) {
                dom.vpsStatus.className = 'pi-server-status offline';
                dom.vpsStatus.textContent = '🔴 Sin respuesta del ' + serverName;
            }
            if (dom.vpsDetail) dom.vpsDetail.innerHTML = '<span>' + serverHost + '</span>';
            if (dom.vpsAlert) {
                dom.vpsAlert.style.display = 'flex';
                dom.vpsAlert.innerHTML = '<span>⚠️ No se pudo conectar con el <b>' + serverName + '</b>. Revisá la red o si el servidor está caído.</span>';
            }

            // Si el VPS no responde, tampoco podemos saber de ComfyUI ni de la PC
            if (dom.comfyDot) dom.comfyDot.className = 'pi-dot idle';
            if (dom.comfyStatus) {
                dom.comfyStatus.className = 'pi-server-status offline';
                dom.comfyStatus.textContent = '⚪ Desconocido';
            }
            if (dom.comfyAlert) dom.comfyAlert.style.display = 'none';

            if (dom.equipoBox) dom.equipoBox.className = 'pi-equipo-box offline';
            if (dom.equipoDot) dom.equipoDot.className = 'pi-dot offline';
            if (dom.equipoBadge) {
                dom.equipoBadge.className = 'pi-badge offline';
                dom.equipoBadge.textContent = '🔴 Desconectado';
            }
            if (dom.equipoSub) dom.equipoSub.textContent = 'Sin enlace con el ' + serverName;
            if (dom.equipoTele) dom.equipoTele.innerHTML = '<span>Sin datos</span>';
            return;
        }

        vpsOnline = true;
        if (dom.vpsDot) dom.vpsDot.className = 'pi-dot online';
        if (dom.vpsStatus) {
            dom.vpsStatus.className = 'pi-server-status online';
            dom.vpsStatus.textContent = '🟢 ' + serverName + ' Online';
        }
        if (dom.vpsDetail) dom.vpsDetail.innerHTML = '<span>' + serverHost + '</span>';
        if (dom.vpsAlert) dom.vpsAlert.style.display = 'none';

        // B) MOTOR COMFYUI
        var comfyDir = (d && (d.comfyAddress || d.comfyBase)) || '127.0.0.1:8188';
        var comfyOk = !!(d && d.comfy);

        if (dom.comfyDetail) dom.comfyDetail.innerHTML = '<span><code>' + comfyDir + '</code></span>';

        if (comfyOk) {
            if (dom.comfyDot) dom.comfyDot.className = 'pi-dot online';
            if (dom.comfyStatus) {
                dom.comfyStatus.className = 'pi-server-status online';
                dom.comfyStatus.textContent = '🟢 ComfyUI Conectado';
            }
            if (dom.comfyAlert) dom.comfyAlert.style.display = 'none';
        } else {
            if (dom.comfyDot) dom.comfyDot.className = 'pi-dot offline';
            if (dom.comfyStatus) {
                dom.comfyStatus.className = 'pi-server-status offline';
                dom.comfyStatus.textContent = '🔴 ComfyUI Apagado / Sin respuesta';
            }
            if (dom.comfyAlert) {
                dom.comfyAlert.style.display = 'flex';
                dom.comfyAlert.innerHTML = '<span>⚠️ El motor <b>ComfyUI no responde</b> en <code>' + comfyDir + '</code>. Verificá si está abierto o ejecutá <code>start_comfy.bat</code>.</span>';
            }
        }

        // C) LA COMPUTADORA DEL PANEL: en la web, la que elegiste; en local, esta.
        if (dom.equipoTitulo) dom.equipoTitulo.textContent = esWeb ? 'Nodo conectado' : 'Tu Computadora';
        var hostName = (d && d.host) || (esWeb ? 'Tu PC' : 'Esta máquina');
        if (dom.equipoHost) dom.equipoHost.textContent = hostName;

        if (!esWeb) {
            // Entorno local: la máquina es la que corre el navegador
            if (dom.equipoBox) dom.equipoBox.className = 'pi-equipo-box online';
            if (dom.equipoDot) dom.equipoDot.className = 'pi-dot online';
            if (dom.equipoBadge) {
                dom.equipoBadge.className = 'pi-badge online';
                dom.equipoBadge.textContent = '🟢 Prendida';
            }
            if (dom.equipoSub) dom.equipoSub.textContent = 'Esta máquina (Host local)';
            if (dom.equipoTele) dom.equipoTele.innerHTML = '<span>⚡ Nodo Local</span><span style="color:#34d399">Activa</span>';
        } else {
            // Entorno WEB: la app corre en el VPS y el trabajo lo hace la PC de la
            // red que el usuario elija. Si no eligió ninguna, NO se dice "tu
            // computadora": se avisa que no está conectado a ningún equipo.
            var redEst = (window.comfyRed && window.comfyRed.estado) || null;
            var elegidoId = redEst ? redEst.elegido : null;
            var peersRed = (redEst && redEst.peers) || [];
            var mioRed = (redEst && redEst.yo) || null;
            var peerSel = elegidoId ? peersRed.filter(function (x) { return x.id === elegidoId; })[0] : null;
            var esMiPc = !!(elegidoId && mioRed && elegidoId === mioRed.peerId);
            var nombreSel = peerSel ? peerSel.nombre : (esMiPc ? (mioRed.nombre || 'Esta PC') : '');
            var selVivo = !!(elegidoId && (esMiPc || (peerSel && peerSel.conectado && peerSel.compartir)));
            if (dom.equipoHost) dom.equipoHost.textContent = elegidoId ? (nombreSel || 'Ninguna') : 'Ninguna';
            if (!elegidoId) {
                if (dom.equipoBox) dom.equipoBox.className = 'pi-equipo-box vacio';
                if (dom.equipoDot) dom.equipoDot.className = 'pi-dot idle';
                if (dom.equipoBadge) { dom.equipoBadge.className = 'pi-badge idle'; dom.equipoBadge.textContent = '⚪ Sin nodo'; }
                if (dom.equipoSub) dom.equipoSub.textContent = 'No estás conectado a ningún nodo';
                if (dom.equipoTele) dom.equipoTele.innerHTML = '<span>Elegí una computadora en <b>RED</b></span><span style="color:#fbbf24">Sin nodo</span>';
            } else if (selVivo) {
                if (dom.equipoBox) dom.equipoBox.className = 'pi-equipo-box online';
                if (dom.equipoDot) dom.equipoDot.className = 'pi-dot online';
                if (dom.equipoBadge) { dom.equipoBadge.className = 'pi-badge online'; dom.equipoBadge.textContent = '🟢 Conectado'; }
                if (dom.equipoSub) dom.equipoSub.textContent = esMiPc ? 'Es tu propia computadora' : 'Generando en esta computadora';
                if (dom.equipoTele) dom.equipoTele.innerHTML = '<span>🖥️ Equipo de la red</span><span style="color:#34d399">Conectado</span>';
            } else {
                if (dom.equipoBox) dom.equipoBox.className = 'pi-equipo-box offline';
                if (dom.equipoDot) dom.equipoDot.className = 'pi-dot offline';
                if (dom.equipoBadge) { dom.equipoBadge.className = 'pi-badge offline'; dom.equipoBadge.textContent = '🔴 Desconectado'; }
                if (dom.equipoSub) dom.equipoSub.textContent = 'Esa computadora no está conectada ahora';
                if (dom.equipoTele) dom.equipoTele.innerHTML = '<span>Elegí otra en <b>RED</b></span><span style="color:#f87171">Sin respuesta</span>';
            }
        }
    }

    // --- 4. COLA DE GENERACIÓN ---
    function actualizarCola() {
        if (!dom.colaPill) return;

        var estado = { pausada: false, generando: false, enCurso: 0, pendientes: 0, total: 0 };
        if (typeof window.jpiColaEstado === 'function') {
            try { estado = window.jpiColaEstado(); } catch (e) { }
        }

        var colaApp = [];
        try {
            if (typeof globalGenerationQueue !== 'undefined' && Array.isArray(globalGenerationQueue)) {
                colaApp = globalGenerationQueue;
            }
        } catch (e) { }

        var activasApp = colaApp.filter(function (i) { return i.status !== 'completed'; });
        var completadasApp = colaApp.filter(function (i) { return i.status === 'completed'; });

        var comfyCola = window.JPI_COMFY_COLA || { total: 0, ejecutando: 0, pendientes: 0 };
        var totalEnCola = Math.max(activasApp.length, Number(comfyCola.total || 0));
        var enCurso = Math.max(estado.enCurso, Number(comfyCola.ejecutando || 0));
        var enEspera = Math.max(estado.pendientes, Number(comfyCola.pendientes || 0));

        // Actualizar badges numéricos
        if (dom.colaEjecutando) dom.colaEjecutando.textContent = enCurso;
        if (dom.colaPendientes) dom.colaPendientes.textContent = enEspera;
        if (dom.colaCompletados) dom.colaCompletados.textContent = completadasApp.length;

        // Pill del encabezado de la cola
        if (totalEnCola > 0) {
            dom.colaPill.textContent = '🔥 ' + totalEnCola + ' en cola';
            dom.colaPill.className = 'pi-cola-pill active';
        } else {
            dom.colaPill.textContent = '0 en cola';
            dom.colaPill.className = 'pi-cola-pill';
        }

        // Subtítulo de estado
        if (dom.colaSub) {
            if (estado.pausada) {
                dom.colaSub.textContent = '⏸ En pausa (' + enEspera + ' listos)';
                dom.colaSub.style.color = '#fbbf24';
            } else if (enCurso > 0) {
                dom.colaSub.textContent = '⚙️ Generando clip en curso...';
                dom.colaSub.style.color = '#34d399';
            } else if (enEspera > 0) {
                dom.colaSub.textContent = '⏳ ' + enEspera + ' en espera';
                dom.colaSub.style.color = '#93c5fd';
            } else {
                dom.colaSub.textContent = '⚪ Lista (sin tareas)';
                dom.colaSub.style.color = 'var(--text-muted)';
            }
        }

        // Botón Pausar / Reanudar
        if (dom.btnPausar) {
            if (estado.pausada) {
                dom.btnPausar.className = 'pi-cola-btn resume';
                dom.btnPausar.textContent = '▶ Reanudar';
            } else {
                dom.btnPausar.className = 'pi-cola-btn pause';
                dom.btnPausar.textContent = '⏸ Pausar';
            }
        }

        // Lista de items de la cola
        if (dom.colaList) {
            if (activasApp.length === 0) {
                dom.colaList.innerHTML = '<div class="pi-cola-empty">No hay generaciones pendientes</div>';
            } else {
                dom.colaList.innerHTML = activasApp.slice(0, 5).map(function (item, idx) {
                    var isRunning = item.status === 'generating' || (idx === 0 && enCurso > 0);
                    var isVid = item.type !== 'storyboard' && !item.type?.includes('image');
                    var tipoLabel = isVid ? '🎬 Video' : '🖼️ Imagen';
                    var tipoClass = isVid ? 'video' : 'image';
                    var promptTxt = item.prompt || (item.params && item.params.prompt) || 'Generación #' + (idx + 1);

                    return '<div class="pi-cola-item ' + (isRunning ? 'running' : '') + '">' +
                        '<div class="pi-cola-item-info">' +
                        '  <div class="pi-cola-item-type ' + tipoClass + '">' +
                        (isRunning ? '⚙️ GENERANDO · ' : '⏳ ESPERANDO · ') + tipoLabel +
                        '  </div>' +
                        '  <div class="pi-cola-item-prompt" title="' + String(promptTxt).replace(/"/g, '&quot;') + '">' +
                        String(promptTxt).slice(0, 45) + (promptTxt.length > 45 ? '…' : '') +
                        '  </div>' +
                        '</div>' +
                        '</div>';
                }).join('');
            }
        }
    }

    // Consulta periódica a /api/status
    function consultarStatus() {
        fetch(URL_STATUS, { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (d) {
                ultimoStatus = d;
                actualizarServidoresYEquipo(d, false);
            })
            .catch(function () {
                actualizarServidoresYEquipo(null, true);
            });
    }

    function init() {
        initDom();
        actualizarEntorno();
        consultarStatus();
        actualizarCola();

        // Polling de estado y cola
        setInterval(consultarStatus, 6000);
        setInterval(actualizarCola, 1500);

        // Reaccionar a cambios en vivo
        document.addEventListener('jpi-comfy-status', function (e) {
            if (ultimoStatus) {
                ultimoStatus.comfy = !!e.detail.conectado;
                actualizarServidoresYEquipo(ultimoStatus, false);
            }
        });

        window.addEventListener('jpi-cola-actualizada', actualizarCola);

        // Elegir otra computadora pasa en RED: repintamos el minipanel al toque
        // (el polling de /api/status tarda 6s y no se enteraria del cambio).
        var ultimoElegidoVisto = null;
        setInterval(function () {
            try {
                var e = (window.comfyRed && window.comfyRed.estado) ? window.comfyRed.estado.elegido : null;
                if (e !== ultimoElegidoVisto) {
                    ultimoElegidoVisto = e;
                    if (ultimoStatus) actualizarServidoresYEquipo(ultimoStatus, false);
                }
            } catch (err) { }
        }, 1200);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
