const imageContainer = document.getElementById('imageContainer');
const videoContainer = document.getElementById('videoContainer');
const progressContainer = document.getElementById('progressContainer');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const placeholder = document.getElementById('placeholder');

// ============================================
// WEBSOCKET CONNECTION MANAGER
// ============================================
let ws = null;
let wsReconnectAttempts = 0;
const MAX_WS_RECONNECT_DELAY = 30000; // 30s max
let wsReconnectTimer = null;

// Variables de cola de generación global
let globalGenerationQueue = [];
let isGeneratingGlobal = false;
let currentExecutingId = null;

// ============================================
// QUEUE PERSISTENCE (localStorage)
// ============================================
const QUEUE_STORAGE_KEY = 'videocomfy_generation_queue';
const QUEUE_META_KEY = 'videocomfy_queue_meta';

function saveQueueState() {
    try {
        // We save non-completed items + last 20 completed for history
        const activeItems = globalGenerationQueue.filter(i => i.status !== 'completed');
        const recentCompleted = globalGenerationQueue
            .filter(i => i.status === 'completed')
            .slice(-20); // Keep only last 20 completed
        
        const state = {
            queue: [...activeItems, ...recentCompleted],
            isGenerating: isGeneratingGlobal,
            currentId: currentExecutingId,
            timestamp: Date.now()
        };
        
        // Remove functions and DOM references before serializing
        const serialized = JSON.stringify(state);
        localStorage.setItem(QUEUE_STORAGE_KEY, serialized);
    } catch (e) {
        console.warn('Failed to save queue state:', e);
    }
}

function loadQueueState() {
    try {
        const saved = localStorage.getItem(QUEUE_STORAGE_KEY);
        if (!saved) return false;
        
        const state = JSON.parse(saved);
        if (!state || !Array.isArray(state.queue)) return false;
        
        // Restore queue
        globalGenerationQueue = state.queue.map(item => {
            // Don't restore 'generating' items as 'generating' — we lost the WS connection
            // Convert them to 'pending' so they get re-sent to ComfyUI
            if (item.status === 'generating') {
                item.status = 'pending';
                item.generationStartTime = undefined;
                item._timeoutWarning = false;
                item._lastWarnedMinute = undefined;
            }
            // 'waiting' items stay waiting (they need their images first)
            // 'pending' items stay pending
            return item;
        });
        
        isGeneratingGlobal = false; // Always reset — we don't know if generation is still active
        currentExecutingId = null;
        
        console.log(`♻️ Queue restored from storage: ${globalGenerationQueue.length} items`);
        appendConsoleLine(`♻️ Queue restored: ${globalGenerationQueue.filter(i => i.status === 'pending' || i.status === 'waiting').length} pending items`, 'system');
        
        return true;
    } catch (e) {
        console.warn('Failed to load queue state:', e);
        return false;
    }
}

function clearQueueState() {
    try {
        localStorage.removeItem(QUEUE_STORAGE_KEY);
        localStorage.removeItem(QUEUE_META_KEY);
    } catch (e) {}
}

// Also save when ws reconnects — request server's queue state
function requestServerQueueState() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'request_queue_state' }));
    }
}

// Variables para modo de blending
let isBlendMode = false;
let selectedVideos = [];
let videoElements = new Map();

// Variables para image upload
let uploadedImageFilename = null;

// Variables para Storyboard
let storyboardItems = [];

// Variables para Timeline Playback (deben declararse antes de usarlas)
let isPlayingTl = false;
let tlAnimationFrame = null;
let currentTlPos = 0;
let clipCache = [];
let lastTickTime = 0;

// ============================================
// WEBSOCKET HANDLING
// ============================================

function handleWsOpen() {
    console.log('WebSocket connection established');
    wsReconnectAttempts = 0; // Reset reconnect counter on successful connection
    appendConsoleLine('[SYSTEM] WebSocket connected. Engine ready.', 'system');
    
    // Request current queue state from server (which has active prompt_ids)
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'request_queue_state' }));
    }
    
    // If we have a restored queue from localStorage, start processing it
    if (globalGenerationQueue.filter(i => i.status === 'pending').length > 0) {
        appendConsoleLine('🚀 Checking persisted queue items...', 'system');
        setTimeout(() => checkGlobalQueue(), 1500);
    }
}

function handleWsMessage(event) {
    try {
        const message = JSON.parse(event.data);
        console.log('Mensaje del servidor:', message.type, message);

        appendConsoleLine(`[${message.type.toUpperCase()}] ${JSON.stringify(message)}`, 'debug');

        if (message.type === 'progress') {
            const percentage = Math.round((message.value / message.max) * 100);
            if (progressFill) {
                progressFill.style.width = percentage + '%';
            }
            if (document.getElementById('progressPct')) {
                document.getElementById('progressPct').textContent = percentage + '%';
            }
            if (currentExecutingId) {
                const item = globalGenerationQueue.find(i => i.id === currentExecutingId);
                if (item && progressText) {
                    // Verificar si el progreso es realmente para nuestro item
                    const isOurProgress = !message.prompt_id || !item.prompt_id || message.prompt_id === item.prompt_id;
                    if (!isOurProgress) {
                        const queueRemaining = globalGenerationQueue.filter(i => i.status === 'pending' && i.batchId === item.batchId).length;
                        progressText.textContent = `⏳ En cola (${queueRemaining} adelante): ${item.prompt.substring(0, 30)}...`;
                    } else {
                        const modeLabel = item.imageFilename ? 'I2V' : (item.type === 'storyboard' ? 'FLUX' : 'T2V');
                        const stepInfo = message.value && message.max ? ` • Step ${message.value}/${message.max}` : '';
                        progressText.textContent = `⚡ [${modeLabel}] ${item.type === 'storyboard' ? 'Drawing' : 'Animating'}: ${item.prompt.substring(0, 40)}...${stepInfo}`;
                    }
                }
            }
        }

        if (message.type === 'executing' && message.node) {
            if (currentExecutingId && progressText) {
                const item = globalGenerationQueue.find(i => i.id === currentExecutingId);
                if (item) {
                    // Solo vincular prompt_id si aun no se ha vinculado via prompt_queued
                    // o si el mensaje es realmente para este item
                    if (!item.prompt_id) {
                        item.prompt_id = message.prompt_id;
                    } else if (item.prompt_id !== message.prompt_id) {
                        // Este mensaje 'executing' es para OTRO prompt en la cola de ComfyUI.
                        // No pisar nuestro prompt_id, pero mostrar que esta en espera.
                        const queueRemaining = globalGenerationQueue.filter(i => i.status === 'pending' && i.batchId === item.batchId).length;
                        progressText.textContent = `⏳ En cola (${queueRemaining} adelante): ${item.prompt.substring(0, 30)}...`;
                        return;
                    }
                    const modeLabel = item.imageFilename ? 'I2V' : (item.type === 'storyboard' ? 'FLUX' : 'T2V');
                    progressText.textContent = `⚡ [${modeLabel}] Node ${message.node}: ${item.prompt.substring(0, 40)}...`;
                }
            }
        }

        if (message.type === 'video_generated') {
            loadExistingVideos();
            if (currentExecutingId || message.prompt_id) {
                const itemIndex = globalGenerationQueue.findIndex(i =>
                    i.status !== 'completed' &&
                    (i.id === currentExecutingId || (message.prompt_id && i.prompt_id === message.prompt_id))
                );

                if (itemIndex !== -1) {
                    const item = globalGenerationQueue[itemIndex];
                    item.status = 'completed';
                    item.resultUrl = message.url;

                    // REEMPLAZO AUTOMATICO PARA REGENERACION
                    if (item.replaceClipId) {
                        const clipQuery = `.timeline-clip[data-clip-id="${item.replaceClipId}"]`;
                        const clip = document.querySelector(clipQuery);
                        if (clip) {
                            const v = clip.querySelector('video');
                            v.src = message.url + '?t=' + Date.now();
                            v.load();

                            // Actualizar etiqueta de nombre de archivo
                            const filename = message.url.split('/').pop().split('?')[0];
                            const label = clip.querySelector('.clip-info span');
                            if (label) label.textContent = filename;

                            clip.dataset.prompt = item.prompt;
                            clip.dataset.metadata = JSON.stringify(item.params);
                            appendConsoleLine(`♻️ Video replaced in timeline: ${filename}`, 'system');

                            // Refrescar cache y sincronizar
                            refreshClipCache();
                        }
                    }

                    updateGlobalQueueUI();

                    // AUTO-ASSEMBLY LOGIC
                    const batchItems = globalGenerationQueue.filter(i => i.batchId === item.batchId);
                    const autoBatch = batchItems.filter(i => i.isAutoAssemble);
                    const generationItems = batchItems.filter(i => i.type !== 'export');

                    if (autoBatch.length > 0 && generationItems.every(i => i.status === 'completed')) {
                        // All image/video items in the batch are finished! Assemble them.
                        // ONLY assemble videos, skip images (T2I storyboard items)
                        const itemsToAssemble = autoBatch.filter(i => i.type !== 'storyboard');
                        if (itemsToAssemble.length > 0) {
                            assembleBatchInTimeline(itemsToAssemble);
                        }

                        // Clean batchId from queue to avoid repeating
                        autoBatch.forEach(i => i.isAutoAssemble = false);
                    }
                }
                isGeneratingGlobal = false;
                currentExecutingId = null;
                setTimeout(() => checkGlobalQueue(), 1000);
            }
        }

        if (message.type === 'storyboard_generated') {
            handleStoryboardGenerated(message);
            loadExistingImages();

            // Show toast notification
            showToast(`🖼️ Image generated: ${(message.prompt || '').substring(0, 60)}${message.prompt?.length > 60 ? '...' : ''}`, 'success');

            // Update live preview in CREATE tab (T2I panel)
            const previewArea = document.getElementById('t2iPreview');
            const previewImg = document.getElementById('t2iPreviewImg');
            if (previewArea && previewImg && message.url) {
                previewImg.src = message.url + '?t=' + Date.now();
                previewArea.style.display = 'block';
                // Wire View button
                const viewBtn = document.getElementById('t2iPreviewViewBtn');
                if (viewBtn) {
                    viewBtn.onclick = () => {
                        loadImageToPreviz(message.url);
                        const tabPrevizBtn = document.getElementById('tabPrevizBtn');
                        if (tabPrevizBtn) tabPrevizBtn.click();
                    };
                }
                // Wire Copy Prompt button
                const copyBtn = document.getElementById('t2iPreviewCopyPromptBtn');
                if (copyBtn) {
                    copyBtn.onclick = () => {
                        navigator.clipboard.writeText(message.prompt || '');
                        showToast('Prompt copied to clipboard', 'info');
                    };
                }
            }

            // Auto-switch right sidebar to IMAGES tab
            const imagesTabBtn = document.querySelector('.asset-tab-btn[data-type="images"]');
            if (imagesTabBtn) {
                document.querySelectorAll('.asset-tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.asset-gallery-grid').forEach(g => g.classList.add('hidden'));
                imagesTabBtn.classList.add('active');
                const imgGallery = document.getElementById('imageGallery');
                if (imgGallery) imgGallery.classList.remove('hidden');
            }

            if (currentExecutingId || message.prompt_id) {
                const itemIndex = globalGenerationQueue.findIndex(i =>
                    i.status !== 'completed' &&
                    (i.id === currentExecutingId || (message.prompt_id && i.prompt_id === message.prompt_id))
                );

                if (itemIndex !== -1) {
                    const item = globalGenerationQueue[itemIndex];
                    item.status = 'completed';
                    item.resultUrl = message.url;

                    // Handle FLUX images generated for WAN2.2
                    if (message.isForWan && message.wanId) {
                        appendConsoleLine(`🖼️ FLUX ${message.wanRole} image ready for WAN2.2: ${message.filename}`, 'system');
                        
                        // Find waiting WAN2.2 video items and update their image references
                        globalGenerationQueue.forEach(q => {
                            if (q.model === 'wan2.2' && q.status === 'waiting') {
                                if (message.wanRole === 'start' && q.startImageId === message.wanId) {
                                    q.startImageFilename = message.filename;
                                    appendConsoleLine(`✅ WAN2.2 start image assigned (step ${q.wanStepIndex}): ${message.filename}`, 'debug');
                                } else if (message.wanRole === 'end' && q.endImageId === message.wanId) {
                                    q.endImageFilename = message.filename;
                                    appendConsoleLine(`✅ WAN2.2 end image assigned (step ${q.wanStepIndex}): ${message.filename}`, 'debug');
                                }
                                
                                // CADENA CONTINUA: Si es un paso continuo (no el primero) y tiene prevEndImageId,
                                // usar la imagen end del paso anterior como start
                                if (q.isChainContinued && q.prevEndImageId && !q.startImageFilename) {
                                    // Buscar el filename de la imagen end del paso anterior
                                    const prevEndItem = globalGenerationQueue.find(prev => 
                                        prev.id === q.prevEndImageId && prev.status === 'completed'
                                    );
                                    if (prevEndItem && prevEndItem.resultUrl) {
                                        q.startImageFilename = prevEndItem.resultFilename || 
                                            prevEndItem.resultUrl.split('/').pop();
                                        appendConsoleLine(`🔗 CADENA: Usando fin del paso anterior como inicio: ${q.startImageFilename}`, 'system');
                                    }
                                }
                                
                                // If both images are ready, activate the WAN2.2 generation
                                if (q.startImageFilename && q.endImageFilename) {
                                    q.status = 'pending';
                                    appendConsoleLine(`🚀 WAN2.2 video generation activated (step ${q.wanStepIndex})`, 'system');
                                }
                            }
                        });
                        
                        // CADENA CONTINUA: Si es una imagen 'end', buscar el siguiente paso WAN2.2
                        // y asignarle esta imagen como su 'start'
                        if (message.wanRole === 'end') {
                            const currentStepIndex = message.wanStepIndex;
                            const nextWanStep = globalGenerationQueue.find(q => 
                                q.model === 'wan2.2' && 
                                q.wanStepIndex === currentStepIndex + 1 &&
                                q.isChainContinued &&
                                q.status === 'waiting'
                            );
                            if (nextWanStep && !nextWanStep.startImageFilename) {
                                nextWanStep.startImageFilename = message.filename;
                                nextWanStep.prevEndImageFilename = message.filename;
                                appendConsoleLine(`🔗 CADENA CONTINUA: Paso ${currentStepIndex + 1} usa fin del paso ${currentStepIndex} como inicio`, 'system');
                            }
                        }
                    }
                    // AUTO-VIDEO PIPELINE: If this storyboard item was flagged for auto-video
                    else if (item.autoVideo) {
                        // Use videoPrompt if specifically set for this I2V step, else fallback to storyboard prompt
                        const generationPrompt = item.videoPrompt || message.prompt || item.prompt;
                        appendConsoleLine(`🎬 Auto-transitioning to Video for: ${generationPrompt.substring(0, 30)}...`, 'system');
                        
                        // Find the waiting I2V item and activate it
                        const waitingI2V = globalGenerationQueue.find(q => 
                            q.status === 'waiting' && 
                            q.waitingForStoryboardId === item.id
                        );
                        
                        if (waitingI2V) {
                            waitingI2V.status = 'pending';
                            waitingI2V.imageFilename = message.filename;
                            appendConsoleLine(`✅ I2V item activated with generated image: ${message.filename}`, 'debug');
                        } else {
                            // Fallback: add directly if not pre-added
                            addToQueue(generationPrompt, message.filename, {
                                isAutoAssemble: item.isAutoAssemble,
                                isAutoRender: item.isAutoRender,
                                batchId: item.batchId || ('batch_v_' + Date.now()),
                                replaceClipId: item.replaceClipId
                            });
                        }
                    }


                    updateGlobalQueueUI();
                }
                isGeneratingGlobal = false;
                currentExecutingId = null;
                setTimeout(() => checkGlobalQueue(), 1000);
            }
        }
        if (message.type === 'comfy_status') {
            const statusDot = document.getElementById('comfyStatusDot');
            if (statusDot) {
                if (message.status === 'connected') {
                    statusDot.className = 'status-dot connected';
                    statusDot.title = 'ComfyUI Connected';
                } else {
                    statusDot.className = 'status-dot disconnected';
                    statusDot.title = 'ComfyUI Disconnected';
                }
            }
        }

        // QUEUE STATE SYNC (from server, after reconnection)
        if (message.type === 'queue_state') {
            console.log(`📡 Received queue state from server: ${message.activePrompts?.length || 0} active prompts, ComfyUI connected: ${message.comfyConnected}`);
            if (message.activePrompts && message.activePrompts.length > 0) {
                // Mark items in our queue that match active server prompts
                message.activePrompts.forEach(sp => {
                    const localItem = globalGenerationQueue.find(i => i.prompt_id === sp.prompt_id);
                    if (localItem) {
                        // Server still has this prompt active — it's really generating
                        if (localItem.status !== 'generating') {
                            localItem.status = 'generating';
                            localItem.generationStartTime = Date.now();
                        }
                    }
                });
                updateGlobalQueueUI();
            }
            // Sync ComfyUI status dot
            if (message.comfyConnected) {
                const statusDot = document.getElementById('comfyStatusDot');
                if (statusDot) {
                    statusDot.className = 'status-dot connected';
                    statusDot.title = 'ComfyUI Connected';
                }
            }
            return;
        }

        // PROMPT_QUEUED: el servidor nos informa el prompt_id real de ComfyUI
        if (message.type === 'prompt_queued') {
            if (message.queueItemId) {
                const item = globalGenerationQueue.find(qi => qi.id === message.queueItemId);
                if (item) {
                    item.prompt_id = message.prompt_id;
                    console.log(`🔗 Queue item ${message.queueItemId} -> ComfyUI prompt: ${message.prompt_id}`);
                }
            }
            return;
        }

        // GENERATION ERROR HANDLING
        if (message.type === 'generation_error') {
            const errorMsg = message.error || 'Unknown generation error';
            appendConsoleLine(`❌ ${errorMsg}`, 'error');
            showToast(errorMsg, 'error');

            // Mark the current item as failed
            if (currentExecutingId) {
                const itemIndex = globalGenerationQueue.findIndex(i => i.id === currentExecutingId);
                if (itemIndex !== -1) {
                    globalGenerationQueue[itemIndex].status = 'failed';
                    globalGenerationQueue[itemIndex].error = errorMsg;
                    appendConsoleLine(`⛔ Item #${itemIndex + 1} marked as failed: ${globalGenerationQueue[itemIndex].prompt.substring(0, 40)}`, 'error');
                }
            }

            isGeneratingGlobal = false;
            currentExecutingId = null;
            updateGlobalQueueUI();
            setTimeout(() => checkGlobalQueue(), 1500);
        }

        // TIMEOUT HANDLER FOR QUEUE ITEMS
        if (message.type === 'queue_timeout') {
            const errorMsg = message.error || 'Queue item timed out';
            appendConsoleLine(`⏰ ${errorMsg}`, 'error');
            showToast(errorMsg, 'warning');

            if (message.prompt_id) {
                const itemIndex = globalGenerationQueue.findIndex(i => i.prompt_id === message.prompt_id);
                if (itemIndex !== -1) {
                    globalGenerationQueue[itemIndex].status = 'failed';
                    globalGenerationQueue[itemIndex].error = errorMsg;
                }
            }

            isGeneratingGlobal = false;
            currentExecutingId = null;
            updateGlobalQueueUI();
            setTimeout(() => checkGlobalQueue(), 1500);
        }
    } catch (e) {
        console.error('Error procesando mensaje WebSocket:', e);
    }
}

// WebSocket reconnection handlers
function handleWsClose() {
    console.log(`WebSocket disconnected. Reconnecting in ${Math.min(1000 * Math.pow(2, wsReconnectAttempts), MAX_WS_RECONNECT_DELAY)}ms...`);
    appendConsoleLine('[SYSTEM] WebSocket disconnected. Reconnecting...', 'warning');
    
    // Save queue state so pending items aren't lost
    saveQueueState();
    
    // Reset generation state to avoid permanent lock
    if (isGeneratingGlobal) {
        isGeneratingGlobal = false;
        currentExecutingId = null;
        updateGlobalQueueUI();
    }
    
    // Schedule reconnection with exponential backoff
    const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts), MAX_WS_RECONNECT_DELAY);
    wsReconnectAttempts++;
    wsReconnectTimer = setTimeout(connectWebSocket, delay);
}

function handleWsError() {
    console.error('WebSocket error');
    // onclose will fire after onerror, so the reconnect is handled there
    if (ws) {
        ws.close();
    }
}

function connectWebSocket() {
    // Clean up any existing connection
    if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
    }
    if (ws) {
        try { ws.close(); } catch(e) {}
        ws = null;
    }
    
    ws = new WebSocket(`ws://${window.location.hostname}:${window.location.port}`);
    ws.onopen = handleWsOpen;
    ws.onmessage = handleWsMessage;
    ws.onclose = handleWsClose;
    ws.onerror = handleWsError;
}

// ============================================
// TOAST NOTIFICATION SYSTEM
// ============================================
function showToast(text, type = 'info', duration = 7000) {
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast-item toast-${type}`;

    const iconMap = {
        error: '❌',
        success: '✅',
        warning: '⚠️',
        info: 'ℹ️'
    };
    const titleMap = {
        error: 'Error',
        success: 'Success',
        warning: 'Warning',
        info: 'Info'
    };

    toast.innerHTML = `
        <div class="toast-icon">${iconMap[type] || 'ℹ️'}</div>
        <div class="toast-content">
            <div class="toast-title">${titleMap[type] || 'Info'}</div>
            <div class="toast-text">${text}</div>
        </div>
        <button class="toast-close" onclick="this.parentElement.remove()">×</button>
    `;

    container.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    // Auto-dismiss
    const timeoutId = setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 400);
    }, duration);

    // Click to dismiss immediately
    toast.addEventListener('click', (e) => {
        if (e.target.closest('.toast-close')) return;
        clearTimeout(timeoutId);
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 400);
    });
}

// ============================================
// GENERATION TIMEOUT CHECK — NO FALSE TIMEOUTS
// ============================================
const GENERATION_WARN_MINUTES = 10;  // Warn after 10 minutes
const GENERATION_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour — real timeout, not a false positive

function checkGenerationTimeouts() {
    const now = Date.now();
    let foundTimeout = false;
    globalGenerationQueue.forEach(item => {
        if (item.status === 'generating' && item.generationStartTime) {
            const elapsed = now - item.generationStartTime;
            const elapsedMin = Math.round(elapsed / 60000);

            // Show warning at 10 min but DON'T kill the generation
            if (!item._timeoutWarning && elapsed > GENERATION_WARN_MINUTES * 60 * 1000) {
                item._timeoutWarning = true;
                const msg = `⚠️ Generation taking long (${elapsedMin} min): ${item.prompt.substring(0, 40)}...`;
                appendConsoleLine(msg, 'warning');
                showToast(msg, 'warning', 10000);
                // Update progress text to show elapsed time
                if (progressText) {
                    progressText.textContent = `⏳ [${elapsedMin} min] Still generating: ${item.prompt.substring(0, 40)}...`;
                }
            }

            // Update elapsed time display every 5 minutes after warning
            if (item._timeoutWarning && item._lastWarnedMinute !== elapsedMin && elapsedMin % 5 === 0) {
                item._lastWarnedMinute = elapsedMin;
                appendConsoleLine(`⏳ Still processing (${elapsedMin} min): ${item.prompt.substring(0, 40)}...`, 'warning');
                // Keep progress bar showing something
                if (progressText) {
                    progressText.textContent = `⏳ [${elapsedMin} min] Still generating: ${item.prompt.substring(0, 40)}...`;
                }
            }

            // Only HARD FAIL if exceeding the very generous 1-hour timeout
            if (elapsed > GENERATION_TIMEOUT_MS) {
                item.status = 'failed';
                foundTimeout = true;
                item.error = `⏰ Hard timeout: generation exceeded 60 minutes`;
                appendConsoleLine(`⏰ Hard timeout: ${item.prompt.substring(0, 40)}... (${elapsedMin} min)`, 'error');
                showToast(`Generation hard timeout after ${elapsedMin} min`, 'error');
            }
        }
    });

    if (foundTimeout) {
        isGeneratingGlobal = false;
        currentExecutingId = null;
        updateGlobalQueueUI();
        saveQueueState();
        setTimeout(() => checkGlobalQueue(), 1500);
    } else if (!isGeneratingGlobal) {
        updateGlobalQueueUI();
        checkGlobalQueue();
    }
}

// Run timeout check every 30 seconds
setInterval(checkGenerationTimeouts, 30000);

// ============================================
// IMAGE UPLOAD HANDLING
// ============================================

const imageUploadArea = document.getElementById('imageUploadArea');
const imageUploadInput = document.getElementById('imageUploadInput');
const uploadStatus = document.getElementById('uploadStatus');
const modeIndicator = document.getElementById('modeIndicator');
const modeText = document.getElementById('modeText');
const dimensionControls = document.getElementById('dimensionControls');

if (imageUploadArea) {
    imageUploadArea.addEventListener('click', () => {
        if (!imageUploadArea.classList.contains('has-image')) imageUploadInput.click();
    });

    imageUploadArea.addEventListener('dragover', (e) => { e.preventDefault(); imageUploadArea.classList.add('dragover'); });
    imageUploadArea.addEventListener('dragleave', () => imageUploadArea.classList.remove('dragover'));
    imageUploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        imageUploadArea.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) handleImageFile(e.dataTransfer.files[0]);
    });
}

if (imageUploadInput) {
    imageUploadInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) handleImageFile(e.target.files[0]);
    });
}

async function handleImageFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => showImagePreview(e.target.result, file.name);
    reader.readAsDataURL(file);

    uploadStatus.classList.add('visible');
    uploadStatus.textContent = '⏳ Subiendo imagen...';

    try {
        const formData = new FormData();
        formData.append('image', file);
        const response = await fetch('/api/upload-image', { method: 'POST', body: formData });
        const result = await response.json();

        if (result.success) {
            uploadedImageFilename = result.filename;
            uploadStatus.textContent = '✅ Imagen lista';
            uploadStatus.style.color = '#34d399';
            updateMode();
        }
    } catch (error) {
        uploadStatus.textContent = '❌ Error';
        uploadStatus.style.color = '#ef4444';
    }
}

async function handleStepImageFile(file, div) {
    const uploadArea = div.querySelector('.step-image-upload-area');
    const filenameInput = div.querySelector('.step-uploaded-filename');
    
    const reader = new FileReader();
    reader.onload = (e) => showStepImagePreview(e.target.result, file.name, div);
    reader.readAsDataURL(file);

    try {
        const formData = new FormData();
        formData.append('image', file);
        const response = await fetch('/api/upload-image', { method: 'POST', body: formData });
        const result = await response.json();

        if (result.success) {
            filenameInput.value = result.filename;
            appendConsoleLine(`✅ Step image uploaded: ${result.filename}`, 'debug');
        }
    } catch (error) {
        appendConsoleLine(`❌ Step image upload error: ${error.message}`, 'error');
    }
}

function showStepImagePreview(dataUrl, filename, div) {
    const uploadArea = div.querySelector('.step-image-upload-area');
    uploadArea.classList.add('has-image');
    uploadArea.innerHTML = `
        <div class="step-image-preview-container">
            <img src="${dataUrl}" alt="Preview">
            <div class="step-image-preview-info" style="position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,0.6); padding: 5px; font-size: 0.6em; color: white;">
                ${filename}
            </div>
            <button class="step-remove-image-btn" title="Remove image">×</button>
        </div>
    `;
    
    uploadArea.querySelector('.step-remove-image-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        removeStepImage(div);
    });
}

function removeStepImage(div) {
    const uploadArea = div.querySelector('.step-image-upload-area');
    const filenameInput = div.querySelector('.step-uploaded-filename');
    filenameInput.value = '';
    uploadArea.classList.remove('has-image');
    uploadArea.innerHTML = `
        <div class="step-upload-placeholder">
            <svg xmlns="http://www.w3.org/2000/svg" style="width: 24px; height: 24px; color: #64748b; margin-bottom: 5px;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <p style="font-size: 0.7em; color: #94a3b8; margin: 0;">Click or drop image</p>
        </div>
    `;
}

function showImagePreview(dataUrl, filename) {
    imageUploadArea.classList.add('has-image');
    imageUploadArea.innerHTML = `
        <div class="image-preview-container">
            <img src="${dataUrl}" alt="Preview">
            <div class="image-preview-info">
                <div class="filename">${filename}</div>
                <span class="mode-badge i2v">🎬 I2V ACTIVE</span>
            </div>
            <button class="remove-image-btn" id="removeImageBtn">✕</button>
        </div>
    `;
    document.getElementById('removeImageBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        removeImage();
    });
}

function removeImage() {
    uploadedImageFilename = null;
    imageUploadArea.classList.remove('has-image');
    imageUploadArea.innerHTML = `<div class="upload-placeholder">...</div>`; // Use existing HTML structure
    updateMode();
}

function updateMode() {
    const isI2V = !!uploadedImageFilename;
    const modeInd = document.getElementById('modeIndicator');
    const modeTxt = document.getElementById('modeText');
    const dimControls = document.getElementById('dimensionControls');

    if (modeInd) modeInd.className = isI2V ? 'mode-indicator i2v' : 'mode-indicator t2v';
    if (modeTxt) modeTxt.textContent = isI2V ? 'I2V ACTIVE' : 'T2V ACTIVE';
    if (dimControls) {
        if (isI2V) {
            dimControls.classList.add('disabled-for-i2v');
            document.getElementById('refStrengthGroup')?.style.setProperty('display', 'block');
        } else {
            dimControls.classList.remove('disabled-for-i2v');
            document.getElementById('refStrengthGroup')?.style.setProperty('display', 'none');
        }
    }
}

// ============================================
// PROJECT & SESSION MANAGEMENT
// ============================================

let openProjects = []; // { id, name, data }
let activeProjectId = null;

const projectTabsList = document.getElementById('projectTabsList');
const projectGallery = document.getElementById('projectGallery');

function getProjectData() {
    // Capturar el estado completo del editor y prompting
    return {
        timeline: getTimelineData(),
        prompting: {
            globalImagePrompt: document.getElementById('globalImagePrompt')?.value || '',
            globalVideoPrompt: document.getElementById('globalVideoPrompt')?.value || '',
            sequence: Array.from(document.querySelectorAll('.prompt-item')).map(el => ({
                prompt: el.querySelector('.image-prompt')?.value || '',
                videoPrompt: el.querySelector('.video-prompt')?.value || '',
                mode: el.querySelector('.step-mode-select-compact')?.value || 't2i2v',
                imageFilename: el.querySelector('.step-uploaded-filename')?.value || ''
            })),
            autoAssemble: document.getElementById('autoAssembleCheck')?.checked || false,
            autoRender: document.getElementById('autoRenderCheck')?.checked || false
        },
        params: {
            width: document.getElementById('videoWidth')?.value,
            height: document.getElementById('videoHeight')?.value,
            length: document.getElementById('videoLength')?.value,
            steps: document.getElementById('samplerSteps')?.value,
            fluxSteps: document.getElementById('storyboardSteps')?.value,
            cfg: document.getElementById('cfgScale')?.value,
            refStrength: document.getElementById('refStrength')?.value,
            randomSeed: document.getElementById('randomSeed')?.checked,
            seed: document.getElementById('seed')?.value
        },
        storyboard: [...storyboardItems],
        uploadedImage: uploadedImageFilename,
        creationTime: Date.now()
    };
}

function applyProjectData(data) {
    if (!data) return;

    // 1. Limpiar Timeline
    const tracks = document.querySelectorAll('.timeline-track');
    tracks.forEach(t => t.innerHTML = '');
    
    // 2. Restaurar Clips
    if (data.timeline && Array.isArray(data.timeline)) {
        data.timeline.forEach(clipData => {
            const track = document.querySelector(`.timeline-track[data-track="${clipData.track}"]`);
            if (track) {
                // Re-crear el clip visualmente
                const left = clipData.startTime * 25; // 25px/s
                addClipToTimeline(`/${clipData.track.startsWith('A') ? 'audio' : 'videos'}/${clipData.filename}`, track, left + track.getBoundingClientRect().left, clipData.prompt || '', clipData.metadata || {});
            }
        });
    }

    // 3. Restaurar Prompting (unificado - siempre secuencia)
    if (data.prompting || data.sequencer) {
        const promptingData = data.prompting || data.sequencer; // backward compatibility
        if (document.getElementById('globalImagePrompt')) document.getElementById('globalImagePrompt').value = promptingData.globalImagePrompt || promptingData.globalPrompt || '';
        if (document.getElementById('globalVideoPrompt')) document.getElementById('globalVideoPrompt').value = promptingData.globalVideoPrompt || promptingData.globalPrompt || '';
        
        const seqContainer = document.getElementById('promptSequence');
        if (seqContainer) {
            seqContainer.innerHTML = '';
            if (promptingData.sequence && Array.isArray(promptingData.sequence)) {
                promptingData.sequence.forEach(step => {
                    if (typeof step === 'object' && step !== null) {
                        addPromptStep(step, step.mode || 't2i2v');
                    } else {
                        // backward compatibility: old format was just strings
                        addPromptStep(step || '', 't2i2v');
                    }
                });
            } else {
                addPromptStep();
            }
        }
        
        if (document.getElementById('autoAssembleCheck')) document.getElementById('autoAssembleCheck').checked = promptingData.autoAssemble;
        if (document.getElementById('autoRenderCheck')) document.getElementById('autoRenderCheck').checked = promptingData.autoRender;
    }

    // 4. Restaurar Parámetros
    if (data.params) {
        if (document.getElementById('videoWidth')) document.getElementById('videoWidth').value = data.params.width;
        if (document.getElementById('videoHeight')) document.getElementById('videoHeight').value = data.params.height;
        if (document.getElementById('videoLength')) document.getElementById('videoLength').value = data.params.length;
        if (document.getElementById('samplerSteps')) document.getElementById('samplerSteps').value = data.params.steps;
        if (document.getElementById('storyboardSteps')) document.getElementById('storyboardSteps').value = data.params.fluxSteps;
        if (document.getElementById('cfgScale')) document.getElementById('cfgScale').value = data.params.cfg;
        if (document.getElementById('refStrength')) document.getElementById('refStrength').value = data.params.refStrength;
        if (document.getElementById('randomSeed')) document.getElementById('randomSeed').checked = data.params.randomSeed;
        if (document.getElementById('seed')) document.getElementById('seed').value = data.params.seed;
        
        // Actualizar labels
        sliders.forEach(s => {
            const el = document.getElementById(s.id);
            const valEl = document.getElementById(s.valueId);
            if (el && valEl) valEl.textContent = el.value;
        });
    }

    // 5. Storyboard
    storyboardItems = data.storyboard ? [...data.storyboard] : [];
    updateStoryboardUI();

    // 6. Image Upload
    uploadedImageFilename = data.uploadedImage || null;
    if (uploadedImageFilename) {
        showImagePreview(`/uploads/${uploadedImageFilename}`, uploadedImageFilename);
    } else {
        removeImage();
    }
    
    updateMode();
    appendConsoleLine(`📂 Project applied.`, 'system');
}

function createNewProject(name, initialData = null) {
    const id = 'proj_' + Date.now();
    const project = {
        id,
        name: name || `Project ${openProjects.length + 1}`,
        data: initialData || getProjectData()
    };
    openProjects.push(project);
    switchProject(id);
    renderProjectTabs();
    return id;
}

function switchProject(id) {
    if (activeProjectId === id) return;

    // Guardar estado del proyecto actual antes de cambiar
    if (activeProjectId) {
        const current = openProjects.find(p => p.id === activeProjectId);
        if (current) {
            current.data = getProjectData();
            appendConsoleLine(`💾 Autosaved ${current.name}`, 'debug');
        }
    }

    stopTimelinePlayback(); // Pausar todo al cambiar

    activeProjectId = id;
    const project = openProjects.find(p => p.id === id);
    if (project) {
        applyProjectData(project.data);
    }

    renderProjectTabs();
}

function closeProject(id, e) {
    if (e) e.stopPropagation();
    
    const index = openProjects.findIndex(p => p.id === id);
    if (index === -1) return;

    const proj = openProjects[index];
    if (confirm(`Save changes to "${proj.name}" before closing?`)) {
        saveProjectToFile(proj.name, proj.data);
    }

    openProjects.splice(index, 1);
    
    if (activeProjectId === id) {
        if (openProjects.length > 0) {
            switchProject(openProjects[0].id);
        } else {
            activeProjectId = null;
            // Leave empty - don't create default project
            renderProjectTabs();
        }
    }
    
    renderProjectTabs();
}

function renderProjectTabs() {
    if (!projectTabsList) return;
    projectTabsList.innerHTML = '';
    
    openProjects.forEach(proj => {
        const tab = document.createElement('div');
        tab.className = `project-tab-item ${proj.id === activeProjectId ? 'active' : ''}`;
        tab.innerHTML = `
            <span class="tab-name tab-name-text">${proj.name}</span>
            <span class="close-tab-btn">×</span>
        `;
        
        const nameSpan = tab.querySelector('.tab-name');
        
        // Renombrado con doble click
        nameSpan.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            const input = document.createElement('input');
            input.type = 'text';
            input.value = proj.name;
            input.className = 'tab-name-input';
            
            nameSpan.replaceWith(input);
            input.focus();
            input.select();
            
            const saveRename = () => {
                const newName = input.value.trim();
                if (newName && newName !== proj.name) {
                    proj.name = newName;
                    renderProjectTabs();
                    updateGlobalQueueUI(); // Update batch indicators in queue and completed history
                    appendConsoleLine(`✏️ Project renamed to: ${newName}`, 'system');
                } else {
                    input.replaceWith(nameSpan);
                }
            };
            
            input.onblur = saveRename;
            input.onkeydown = (ev) => {
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    saveRename();
                }
                if (ev.key === 'Escape') {
                    ev.preventDefault();
                    input.replaceWith(nameSpan);
                }
            };
        });

        tab.onclick = () => switchProject(proj.id);
        tab.querySelector('.close-tab-btn').onclick = (e) => closeProject(proj.id, e);
        projectTabsList.appendChild(tab);
    });
}

async function saveProjectToFile(name, dataOverride = null, silent = false) {
    const data = dataOverride || getProjectData();
    try {
        const response = await fetch('/api/projects/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, data })
        });
        const result = await response.json();
        if (result.success) {
            if (!silent) {
                appendConsoleLine(`✅ Project "${name}" saved to storage.`, 'system');
            }
            loadProjectsList();
        }
    } catch (e) {
        console.error('Save project error:', e);
    }
}

async function loadProjectsList() {
    if (!projectGallery) return;
    try {
        const response = await fetch('/api/projects');
        const projects = await response.json();
        projectGallery.innerHTML = '';
        
        projects.forEach(p => {
            const card = document.createElement('div');
            card.className = 'project-item-card';
            card.draggable = true;
            
            const date = new Date(p.mtime).toLocaleDateString();
            
            card.innerHTML = `
                <div class="project-card-header">
                    <div class="project-icon-box">📂</div>
                    <div class="project-card-info">
                        <span class="project-card-name">${p.name}</span>
                        <span class="project-card-meta">Saved: ${date}</span>
                    </div>
                </div>
                <div class="project-card-actions">
                    <button class="project-action-btn btn-delete-project">Delete</button>
                    <button class="project-action-btn primary-btn-std btn-open-project">Open</button>
                </div>
            `;
            
            card.onclick = () => {
                // No abrir si se hace click en las acciones
            };

            card.querySelector('.btn-open-project').onclick = () => openStoredProject(p.name);
            card.querySelector('.btn-delete-project').onclick = (e) => {
                e.stopPropagation();
                if (confirm(`Delete project "${p.name}"?`)) deleteProject(p.name);
            };

            card.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('projectName', p.name);
                card.style.opacity = '0.5';
            });
            card.addEventListener('dragend', () => card.style.opacity = '1');
            
            projectGallery.appendChild(card);
        });
    } catch (e) { console.error(e); }
}

async function openStoredProject(name) {
    // Si ya está abierto, solo cambiar
    const existing = openProjects.find(p => p.name === name);
    if (existing) {
        switchProject(existing.id);
        document.getElementById('tabEditorBtn').click();
        return;
    }

    try {
        const response = await fetch(`/api/projects/${name}`);
        const data = await response.json();
        const id = createNewProject(name, data);
        document.getElementById('tabEditorBtn').click();
        appendConsoleLine(`📂 Project "${name}" loaded.`, 'system');
    } catch (e) {
        console.error('Load project error:', e);
    }
}

async function deleteProject(name) {
    try {
        const response = await fetch(`/api/projects/${name}`, { method: 'DELETE' });
        const result = await response.json();
        if (result.success) {
            appendConsoleLine(`🗑️ Project "${name}" deleted.`, 'system');
            loadProjectsList();
        }
    } catch (e) { console.error(e); }
}

document.getElementById('newProjectBtn')?.addEventListener('click', () => {
    const count = openProjects.length + 1;
    const fresh = getProjectData();
    fresh.timeline = [];
    fresh.storyboard = [];
    fresh.uploadedImage = null;
    createNewProject(`Project ${count}`, fresh);
});

document.getElementById('saveProjectBtn')?.addEventListener('click', () => {
    const current = openProjects.find(p => p.id === activeProjectId);
    if (current) {
        saveProjectToFile(current.name);
    } else {
        alert("No active project to save.");
    }
});

// Drag & Drop Project into Editor
const tabEditor = document.getElementById('tabEditor');
if (tabEditor) {
    tabEditor.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('projectName')) e.preventDefault();
    });
    tabEditor.addEventListener('drop', (e) => {
        const name = e.dataTransfer.getData('projectName');
        if (name) {
            e.preventDefault();
            openStoredProject(name);
        }
    });
}

// Initial Session - Start empty, projects created when batches are added
setTimeout(() => {
    // Don't create default project - let it be empty until user creates a batch
    if (openProjects.length === 0) {
        activeProjectId = null;
        renderProjectTabs();
    }
}, 500);

// ============================================
// CORE UI LOGIC (TABS & CONSOLE)
// ============================================

function appendConsoleLine(text, type = 'info') {
    const extendedLogs = document.getElementById('extendedLogs');
    if (!extendedLogs) return;
    const line = document.createElement('div');
    const timestamp = new Date().toLocaleTimeString();
    let color = '#34d399';
    if (type === 'debug') color = '#64748b';
    if (type === 'error') color = '#ef4444';
    if (type === 'system') color = '#818cf8';
    line.innerHTML = `<span style="color: #475569">[${timestamp}]</span> <span style="color: ${color}">${text}</span>`;
    extendedLogs.appendChild(line);
    extendedLogs.parentElement.scrollTop = extendedLogs.parentElement.scrollHeight;
}

const tabButtons = document.querySelectorAll('.tab-button');
const tabContents = document.querySelectorAll('.tab-content');

tabButtons.forEach(button => {
    button.addEventListener('click', () => {
        const targetId = button.dataset.target;
        tabButtons.forEach(btn => btn.classList.remove('active'));
        button.classList.add('active');
        tabContents.forEach(content => content.classList.remove('active'));

        const target = document.getElementById(targetId);
        if (target) target.classList.add('active');

        // Manejar visibilidad del Timeline y clases del body
        document.body.classList.remove('tab-editor-active');
        if (targetId === 'tabEditor') {
            document.body.classList.add('tab-editor-active');
        } else {
            stopTimelinePlayback();
        }
    });
});

// Listeners para actualización de valores de los sliders
const sliders = [
    { id: 'videoWidth', valueId: 'videoWidthValue' },
    { id: 'videoHeight', valueId: 'videoHeightValue' },
    { id: 'videoLength', valueId: 'videoLengthValue' },
    { id: 'samplerSteps', valueId: 'samplerStepsValue' },
    { id: 'storyboardSteps', valueId: 'storyboardStepsValue' },
    { id: 'cfgScale', valueId: 'cfgScaleValue' },
    { id: 'refStrength', valueId: 'refStrengthValue' },
    { id: 'autoOverlapSlider', valueId: 'autoOverlapValue' }
];

sliders.forEach(slider => {
    const el = document.getElementById(slider.id);
    const valEl = document.getElementById(slider.valueId);
    if (el && valEl) {
        el.addEventListener('input', () => {
            valEl.textContent = el.value + (slider.id.includes('Overlap') ? '%' : '');
        });
    }
});

// Botón Reset para parámetros
const resetParamsBtn = document.getElementById('resetParamsBtn');
if (resetParamsBtn) {
    resetParamsBtn.addEventListener('click', () => {
        document.getElementById('videoWidth').value = 1280;
        document.getElementById('videoHeight').value = 720;
        document.getElementById('videoLength').value = 121;
        document.getElementById('samplerSteps').value = 20;

        // Disparar evento input para actualizar los labels
        sliders.forEach(s => document.getElementById(s.id).dispatchEvent(new Event('input')));
    });
}

// ============================================
// GENERATION ENGINE & QUEUE
// ============================================

function updateGlobalQueueUI() {
    const queueContainer = document.getElementById('globalQueueContainer');
    const queueList = document.getElementById('queueList');
    const queueCount = document.getElementById('queueCount');
    if (!queueContainer || !queueList) return;

    // Sort items by batch and type: images first, then videos, grouped by batch
    let activeItems = globalGenerationQueue.filter(i => i.status !== 'completed');
    
    // Sort by: batchId (chronological), then type (storyboard first), then original order
    activeItems.sort((a, b) => {
        // If different batches, sort by batchId (earlier batches first)
        if (a.batchId !== b.batchId) {
            return (a.batchId || '').localeCompare(b.batchId || '');
        }
        // Same batch: storyboard (images) before videos
        if (a.type === 'storyboard' && b.type !== 'storyboard') return -1;
        if (a.type !== 'storyboard' && b.type === 'storyboard') return 1;
        // Same type: maintain original order (by id)
        return a.id - b.id;
    });
    const completedItems = globalGenerationQueue.filter(i => i.status === 'completed');
    
    if (activeItems.length > 0 || isGeneratingGlobal) {
        queueContainer.classList.remove('hidden');
    } else {
        queueContainer.classList.add('hidden');
        if (progressText) {
            progressText.textContent = '✨ Nothing to generate, all done';
            if (progressFill) progressFill.style.width = '100%';
            if (document.getElementById('progressPct')) document.getElementById('progressPct').textContent = '100%';
        }
    }
    
    // Update completed history
    updateCompletedHistory(completedItems);

    // Calculate counters for images, videos, and WAN2.2 (including waiting items)
    const imgItems = activeItems.filter(i => i.type === 'storyboard' || i.type === 'flux_for_wan');
    const wanItems = activeItems.filter(i => i.model === 'wan2.2');
    const videoItems = activeItems.filter(i => i.type !== 'storyboard' && i.type !== 'flux_for_wan' && i.model !== 'wan2.2');
    const imgCompleted = globalGenerationQueue.filter(i => (i.type === 'storyboard' || i.type === 'flux_for_wan') && i.status === 'completed').length;
    const wanCompleted = globalGenerationQueue.filter(i => i.model === 'wan2.2' && i.status === 'completed').length;
    const videoCompleted = globalGenerationQueue.filter(i => i.type !== 'storyboard' && i.type !== 'flux_for_wan' && i.model !== 'wan2.2' && i.status === 'completed').length;
    const totalImg = imgItems.length + imgCompleted;
    const totalWan = wanItems.length + wanCompleted;
    const totalVideo = videoItems.length + videoCompleted;

    if (queueCount) queueCount.textContent = activeItems.length;
    
    // Update or create counters
    let countersDiv = document.getElementById('queueCounters');
    if (!countersDiv) {
        countersDiv = document.createElement('div');
        countersDiv.id = 'queueCounters';
        countersDiv.style.cssText = `
            display: flex;
            gap: 20px;
            padding: 12px 15px;
            background: rgba(15, 23, 42, 0.5);
            border-radius: 8px;
            margin-bottom: 15px;
            font-size: 0.85em;
            font-weight: 700;
        `;
        queueList.parentElement.insertBefore(countersDiv, queueList);
    }
    
    if (totalImg > 0 || totalVideo > 0 || totalWan > 0) {
        countersDiv.style.display = 'flex';
        countersDiv.innerHTML = '';
        
        if (totalImg > 0) {
            const imgCounter = document.createElement('div');
            imgCounter.style.cssText = 'color: #818cf8;';
            imgCounter.innerHTML = `🖼️ IMG remaining: <span style="color: #f59e0b;">${imgItems.length}/${totalImg}</span>`;
            countersDiv.appendChild(imgCounter);
        }
        
        if (totalWan > 0) {
            const wanCounter = document.createElement('div');
            wanCounter.style.cssText = 'color: #a855f7;';
            wanCounter.innerHTML = `🎬 WAN2.2 remaining: <span style="color: #f59e0b;">${wanItems.length}/${totalWan}</span>`;
            countersDiv.appendChild(wanCounter);
        }
        
        if (totalVideo > 0) {
            const videoCounter = document.createElement('div');
            videoCounter.style.cssText = 'color: #34d399;';
            videoCounter.innerHTML = `🎬 Video remaining: <span style="color: #f59e0b;">${videoItems.length}/${totalVideo}</span>`;
            countersDiv.appendChild(videoCounter);
        }
    } else {
        countersDiv.style.display = 'none';
    }

    queueList.innerHTML = '';

    activeItems.forEach((item, idx) => {
        const div = document.createElement('div');
        div.style.cssText = `
            padding: 15px; 
            background: rgba(15, 23, 42, 0.7); 
            border-left: 4px solid ${item.status === 'generating' ? '#818cf8' : '#334155'}; 
            border-radius: 8px; 
            font-size: 0.85em; 
            color: #e2e8f0;
            display: flex;
            flex-direction: column;
            gap: 8px;
            transition: all 0.3s ease;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        `;

        let modeLabel = item.imageFilename ? 'I2V' : 'T2V';
        if (item.type === 'storyboard') modeLabel = 'T2I';
        if (item.type === 'export') modeLabel = 'EXPORT';
        if (item.model === 'wan2.2') {
            const chainInfo = item.isChainContinued ? '🔗' : '🔥';
            modeLabel = `WAN2.2 ${chainInfo}`;
        }
        if (item.type === 'flux_for_wan') modeLabel = `FLUX ${item.wanRole === 'start' ? '🔥' : '🔗'} (${item.wanRole})`;
        if (item.status === 'waiting' && item.type !== 'export') {
            if (item.model === 'wan2.2') {
                const hasStart = item.startImageFilename ? '✓' : (item.isChainContinued ? '🔗' : '○');
                const hasEnd = item.endImageFilename ? '✓' : '○';
                const chainStatus = item.isChainContinued ? '🔗' : '🔥';
                modeLabel = `WAN2.2 ${chainStatus} (start:${hasStart} end:${hasEnd})`;
            } else {
                modeLabel = 'I2V (waiting for image)';
            }
        }

        const progressIndicator = item.status === 'generating' ?
            '<span style="color: #f59e0b; animation: pulse 1s infinite;">⚡ PROCESSING</span>' :
            item.status === 'waiting' ?
            '<span style="color: #64748b;">⏸️ WAITING</span>' :
            item.status === 'failed' ?
            '<span style="color: #ef4444;">❌ FAILED</span>' :
            '<span style="color: #94a3b8;">⏳ QUEUED</span>';

        // Show error detail for failed items
        let errorHtml = '';
        if (item.status === 'failed' && item.error) {
            errorHtml = `<div class="error-detail">${item.error}</div>`;
        }

        // Apply error styling
        if (item.status === 'failed') {
            div.style.borderLeftColor = '#ef4444';
            div.style.background = 'rgba(127, 29, 29, 0.3)';
        }

        // Show batch info if available - get batch name from project
        let batchInfo = '';
        if (item.batchId) {
            const batchProject = openProjects.find(p => p.id === item.projectId);
            const batchName = batchProject ? batchProject.name : item.batchId.substring(0, 12) + '...';
            batchInfo = `<span style="margin: 0 5px; opacity: 0.3;">|</span> Batch: <span style="color: #10b981;" data-batch-id="${item.batchId}">${batchName}</span>`;
        }

        div.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: start;">
                <div style="font-weight: 700; color: #818cf8; font-size: 0.7em; text-transform: uppercase; letter-spacing: 1px;">
                    Item #${idx + 1} <span style="margin: 0 5px; opacity: 0.3;">|</span> ${modeLabel} ${batchInfo}
                </div>
                <div style="font-size: 0.7em; font-weight: 800;">${progressIndicator}</div>
            </div>
            <div style="font-size: 0.9em; line-height: 1.5; color: #f1f5f9; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">
                ${item.prompt}
            </div>
            ${errorHtml}
        `;
        queueList.appendChild(div);
    });
    
    // Persist queue state to localStorage after every UI update
    saveQueueState();
}

function checkGlobalQueue() {
    if (isGeneratingGlobal) return;

    // Get all pending items
    const pendingItems = globalGenerationQueue.filter(item => item.status === 'pending');
    if (pendingItems.length === 0) return;
    
    // Group by batch and find the earliest batch that still has work
    const batchGroups = {};
    pendingItems.forEach(item => {
        const batchKey = item.batchId || 'no_batch';
        if (!batchGroups[batchKey]) {
            batchGroups[batchKey] = { images: [], fluxForWan: [], videos: [], wan22Waiting: [], exports: [] };
        }
        if (item.type === 'storyboard') {
            batchGroups[batchKey].images.push(item);
        } else if (item.type === 'flux_for_wan') {
            batchGroups[batchKey].fluxForWan.push(item);
        } else if (item.type === 'export') {
            batchGroups[batchKey].exports.push(item);
        } else {
            batchGroups[batchKey].videos.push(item);
        }
    });
    
    // Find the first batch (chronologically) and process in order:
    // 1. FLUX images for WAN2.2, 2. Regular images, 3. Videos (incl. WAN2.2 when pending), 4. Exports
    const sortedBatchIds = Object.keys(batchGroups).sort();
    let nextItem = null;
    
    for (const batchId of sortedBatchIds) {
        const batch = batchGroups[batchId];
        // First, process FLUX images for WAN
        if (batch.fluxForWan.length > 0) {
            nextItem = batch.fluxForWan[0];
            break;
        }
        // Then, process regular images
        if (batch.images.length > 0) {
            nextItem = batch.images[0];
            break;
        }
        // Then, process videos
        if (batch.videos.length > 0) {
            nextItem = batch.videos[0];
            break;
        }
        // Finally, process exports
        if (batch.exports.length > 0) {
            nextItem = batch.exports[0];
            break;
        }
    }
    
    if (!nextItem) return;

    nextItem.status = 'generating';
    nextItem.generationStartTime = Date.now(); // Track start time for timeout detection
    currentExecutingId = nextItem.id;
    isGeneratingGlobal = true;
    updateGlobalQueueUI();

    // Get batch name from project
    const batchProject = openProjects.find(p => p.id === nextItem.projectId);
    const batchName = batchProject ? batchProject.name : null;
    
    // Handle export items differently
    if (nextItem.type === 'export') {
        appendConsoleLine(`🎬 Starting auto-render export for batch: ${batchName}`, 'system');
        // Trigger the export directly
        const project = openProjects.find(p => p.id === nextItem.projectId);
        if (project && project.data.timeline && project.data.timeline.length > 0) {
            // Pass the queueItem to startRealExport to handle async completion
            startRealExport(project.data.timeline, nextItem.isAutoRender, nextItem);
        } else {
            appendConsoleLine(`⚠️ Cannot export: timeline is empty`, 'system');
            nextItem.status = 'completed';
            isGeneratingGlobal = false;
            currentExecutingId = null;
            updateGlobalQueueUI();
            setTimeout(() => checkGlobalQueue(), 1000);
        }
    } else if (nextItem.type === 'flux_for_wan') {
        // Generate FLUX image for WAN2.2
        const message = {
            type: 'generarStoryboard',
            prompt: nextItem.prompt,
            params: nextItem.params,
            batchId: nextItem.batchId,
            batchName: batchName,
            isForWan: true,
            wanRole: nextItem.wanRole,
            wanId: nextItem.id,
            wanStepIndex: nextItem.wanStepIndex,
            queueItemId: nextItem.id
        };
        try { ws.send(JSON.stringify(message)); } catch (e) {
            console.error('WS send failed (flux_for_wan):', e);
            nextItem.status = 'pending';
            isGeneratingGlobal = false;
            currentExecutingId = null;
            updateGlobalQueueUI();
            setTimeout(() => checkGlobalQueue(), 2000);
            return;
        }
        appendConsoleLine(`>> Generating FLUX image for WAN2.2 (${nextItem.wanRole}): ${nextItem.prompt.substring(0, 30)}...`, 'system');
    } else if (nextItem.model === 'wan2.2') {
        // Generate WAN2.2 video
        const message = {
            type: 'generarWan22',
            prompt: nextItem.prompt,
            params: nextItem.params,
            startImageFilename: nextItem.startImageFilename,
            endImageFilename: nextItem.endImageFilename,
            batchId: nextItem.batchId,
            batchName: batchName,
            queueItemId: nextItem.id
        };
        try { ws.send(JSON.stringify(message)); } catch (e) {
            console.error('WS send failed (wan2.2):', e);
            nextItem.status = 'pending';
            isGeneratingGlobal = false;
            currentExecutingId = null;
            updateGlobalQueueUI();
            setTimeout(() => checkGlobalQueue(), 2000);
            return;
        }
        appendConsoleLine(`>> Launching WAN2.2 video: ${nextItem.prompt.substring(0, 30)}...`, 'system');
    } else {
        const message = {
            type: nextItem.type === 'storyboard' ? 'generarStoryboard' : 'generarImagen',
            prompt: nextItem.prompt,
            params: nextItem.params,
            imageFilename: nextItem.imageFilename,
            storyboardIndex: nextItem.storyboardIndex,
            batchId: nextItem.batchId,
            batchName: batchName,
            queueItemId: nextItem.id
        };
        try { ws.send(JSON.stringify(message)); } catch (e) {
            console.error('WS send failed (storyboard/video):', e);
            nextItem.status = 'pending';
            isGeneratingGlobal = false;
            currentExecutingId = null;
            updateGlobalQueueUI();
            setTimeout(() => checkGlobalQueue(), 2000);
            return;
        }
        appendConsoleLine(`>> Launching ${nextItem.type || 'generation'}: ${nextItem.prompt.substring(0, 30)}...`, 'system');
    }
}

// Botón de Lanzamiento (Stage) - REMOVED, now all generation is from Prompting tab
// const generateBtn = document.getElementById('generateButton');

const promptModeSelect = null; // Removed - now unified prompting interface
const simplePromptContainer = null; // Removed
const advancedMode = null; // Removed - always show sequence

const generateVideoFromSequencer = document.getElementById('generateFromPrompting');
if (generateVideoFromSequencer) {
    generateVideoFromSequencer.addEventListener('click', () => {
        handleSequencerGenerate();
    });
}

function handleSequencerGenerate() {
    console.log('Generating from unified prompting interface');

    // Get all prompt steps
    const promptItems = document.querySelectorAll('.prompt-item');
    let addedCount = 0;

    const isAutoAssemble = document.getElementById('autoAssembleCheck')?.checked;
    const isAutoRender = document.getElementById('autoRenderCheck')?.checked;
    // Interpret Slider 0-100% as Overlap Percentage (0% = sequential, 100% = stacked)
    const overlapValue = parseFloat(document.getElementById('autoOverlapSlider')?.value || 0);
    const autoOverlapRatio = overlapValue / 100;
    const batchId = 'batch_' + Date.now();
    const globalImagePrompt = document.getElementById('globalImagePrompt')?.value.trim() || '';
    const globalVideoPrompt = document.getElementById('globalVideoPrompt')?.value.trim() || '';
    
    // Variable para rastrear la cadena continua de imágenes WAN2.2
    // Cada paso WAN2.2 (excepto el primero) usa el final del anterior como su inicio
    let previousWanEndImageId = null;
    let previousWanEndImageFilename = null;

    promptItems.forEach((item, index) => {
        const tImg = item.querySelector('.image-prompt');
        const tVid = item.querySelector('.video-prompt');
        const modeSelect = item.querySelector('.step-mode-select-compact');
        const modelSelect = item.querySelector('.step-model-select');
        const outputSelect = item.querySelector('.step-output-select');
        const wanFluxCheck = item.querySelector('.wan-flux-images-check');
        
        const valImg = tImg?.value.trim();
        const valVid = tVid?.value.trim();
        const mode = modeSelect?.value || 't2i2v';
        const model = modelSelect?.value || 'ltx2';
        const outputType = outputSelect?.value || 'video';
        const useFluxForWanImages = wanFluxCheck?.checked ?? true;

        if (valImg || valVid) {
            // Global style prefix
            const finalImgPrompt = valImg ? (globalImagePrompt ? `${globalImagePrompt}, ${valImg}` : valImg) : '';
            const finalVidPrompt = valVid ? (globalVideoPrompt ? `${globalVideoPrompt}, ${valVid}` : valVid) : '';

            if (mode === 't2i' || model === 'flux' || outputType === 'image') {
                // Image generation with FLUX
                addToStoryboardQueue(finalImgPrompt || finalVidPrompt, { 
                    batchId, 
                    storyboardIndex: index, 
                    autoOverlap: autoOverlapRatio,
                    model: 'flux'
                });
            } else if (mode === 'wan2.2' || mode === 'chainvideo' || model === 'wan2.2') {
                // WAN2.2 I2V with FLUX-generated start/end images
                // CADENA CONTINUA: Cada video usa el final del anterior como su inicio
                const isFirstWanStep = index === 0 || !previousWanEndImageId;
                const startImageId = isFirstWanStep ? 'wan_start_' + Date.now() + '_' + index + Math.random() : null;
                const endImageId = 'wan_end_' + Date.now() + '_' + index + Math.random();
                
                if (isFirstWanStep) {
                    // Primer paso: generar ambas imágenes (inicio y fin)
                    globalGenerationQueue.push({
                        id: startImageId,
                        prompt: finalImgPrompt,
                        type: 'flux_for_wan',
                        params: {},
                        status: 'pending',
                        projectId: activeProjectId,
                        batchId,
                        isForWan: true,
                        wanRole: 'start',
                        wanStepIndex: index,
                        isChainStart: true
                    });
                }
                
                // Siempre generar imagen de fin (será el inicio del siguiente)
                globalGenerationQueue.push({
                    id: endImageId,
                    prompt: finalVidPrompt || finalImgPrompt,
                    type: 'flux_for_wan',
                    params: {},
                    status: 'pending',
                    projectId: activeProjectId,
                    batchId,
                    isForWan: true,
                    wanRole: 'end',
                    wanStepIndex: index,
                    isChainEnd: true,
                    prevStartImageId: startImageId // Referencia para el primer paso
                });
                
                // Add WAN2.2 video generation
                globalGenerationQueue.push({
                    id: Date.now() + Math.random() + 0.5,
                    prompt: finalVidPrompt || finalImgPrompt,
                    params: {
                        videoWidth: parseInt(document.getElementById('videoWidth').value),
                        videoHeight: parseInt(document.getElementById('videoHeight').value),
                        videoLength: parseInt(document.getElementById('videoLength').value),
                        samplerSteps: parseInt(document.getElementById('samplerSteps').value),
                        cfgScale: parseFloat(document.getElementById('cfgScale').value),
                        refStrength: parseFloat(document.getElementById('refStrength').value),
                        seed: document.getElementById('randomSeed').checked ? -1 : parseInt(document.getElementById('seed').value)
                    },
                    model: 'wan2.2',
                    useFluxImages: useFluxForWanImages,
                    startImageId: isFirstWanStep ? startImageId : null, // null = usar end del anterior
                    endImageId: endImageId,
                    prevEndImageId: previousWanEndImageId, // Referencia al final del paso anterior
                    wanStepIndex: index,
                    isChainContinued: !isFirstWanStep,
                    status: 'waiting',
                    projectId: activeProjectId,
                    isAutoAssemble,
                    isAutoRender,
                    batchId,
                    autoOverlap: autoOverlapRatio
                });
                
                // Guardar referencia para el siguiente paso
                previousWanEndImageId = endImageId;
            } else if (mode === 'i2v') {
                const stepImageFilename = item.querySelector('.step-uploaded-filename')?.value;
                addToQueue(finalVidPrompt || finalImgPrompt, stepImageFilename, { 
                    isAutoAssemble, 
                    isAutoRender, 
                    batchId, 
                    autoOverlap: autoOverlapRatio, 
                    model 
                });
            } else if (mode === 't2i2v') {
                const storyboardId = 'sb_' + Date.now() + '_' + index + Math.random();
                
                // Add T2I (storyboard) item
                addToStoryboardQueue(finalImgPrompt, {
                    batchId,
                    storyboardIndex: index,
                    autoVideo: true,
                    videoPrompt: finalVidPrompt,
                    isAutoAssemble,
                    isAutoRender,
                    autoOverlap: autoOverlapRatio,
                    id: storyboardId
                });
                
                // Immediately add I2V item with 'waiting' status
                globalGenerationQueue.push({
                    id: Date.now() + Math.random() + 0.5,
                    prompt: finalVidPrompt,
                    params: {
                        videoWidth: parseInt(document.getElementById('videoWidth').value),
                        videoHeight: parseInt(document.getElementById('videoHeight').value),
                        videoLength: parseInt(document.getElementById('videoLength').value),
                        samplerSteps: parseInt(document.getElementById('samplerSteps').value),
                        cfgScale: parseFloat(document.getElementById('cfgScale').value),
                        refStrength: parseFloat(document.getElementById('refStrength').value),
                        seed: document.getElementById('randomSeed').checked ? -1 : parseInt(document.getElementById('seed').value)
                    },
                    imageFilename: null, // Will be set when T2I completes
                    status: 'waiting',
                    waitingForStoryboardId: storyboardId,
                    projectId: activeProjectId,
                    isAutoAssemble,
                    isAutoRender,
                    batchId,
                    autoOverlap: autoOverlapRatio
                });
            } else {
                // Text to Video directly (t2v)
                addToQueue(finalVidPrompt || finalImgPrompt, null, { isAutoAssemble, isAutoRender, batchId, autoOverlap: autoOverlapRatio, model });
            }
            addedCount++;
        }
    });


    if (addedCount === 0) {
        alert("Please enter at least one prompt step");
        return;
    }

    appendConsoleLine(`🎬 Added ${addedCount} prompts to generation queue`, 'system');

    // Create a NEW PROJECT for this Batch (Clean of storyboard and timeline previos)
    // Use pending batch name from magic prompt if available, otherwise use timestamp
    const batchName = window.pendingBatchName || `Batch ${new Date().toLocaleTimeString()}`;
    window.pendingBatchName = null; // Clear after use
    const freshData = getProjectData();
    freshData.storyboard = [];
    freshData.timeline = [];
    const batchProjectId = createNewProject(batchName, freshData);
    
    // Re-asociar TODOS los items de ESTE batch al proyecto recién creado
    globalGenerationQueue.forEach(item => {
        if (item.batchId === batchId) {
            item.projectId = batchProjectId;
        }
    });

    // Si autoRender está activado, agregar el export final al queue PARA ESTE BATCH
    if (isAutoRender) {
        globalGenerationQueue.push({
            id: Date.now() + Math.random() + 0.9,
            prompt: `Final Export - ${batchName}`,
            type: 'export',
            status: 'pending',
            batchId: batchId,
            projectId: batchProjectId,
            isExport: true,
            isAutoRender: true
        });
        appendConsoleLine(`📦 Auto-render export added to queue for batch: ${batchName}`, 'system');
    }

    // Force queue refresh to correctly show the newest batch project association
    updateGlobalQueueUI();

    appendConsoleLine(`🚀 Batch "${batchName}" queued — ${addedCount} step(s). Starting generation engine...`, 'system');

    // Kick off the generation engine directly
    checkGlobalQueue();

    // Redirigir a Stage
    document.getElementById('tabOutputBtn').click();
}

document.getElementById('addPromptButton')?.addEventListener('click', () => {
    addPromptStep();
});

// Workflow definitions
const WORKFLOW_CONFIG = {
    t2i: { name: '🖼️ T2I', model: 'flux', output: 'image', desc: 'Text to Image with FLUX' },
    t2v: { name: '🎬 T2V', model: 'ltx2', output: 'video', desc: 'Text to Video direct with LTX-2' },
    t2i2v: { name: '🔄 T2I→I2V', model: 'ltx2', output: 'video', desc: 'Image then Video with LTX-2' },
    i2v: { name: '📸 I2V', model: 'ltx2', output: 'video', desc: 'Image to Video with manual image upload' },
    chainvideo: { name: '🔗 CHAINVIDEO', model: 'wan2.2', output: 'video', desc: 'Linked videos with Wan2.2 (start/end images)' }
};

// Update workflow info display
function updateWorkflowInfo() {
    const workflowSelect = document.getElementById('workflowSelect');
    const workflowInfo = document.getElementById('workflowInfo');
    if (workflowSelect && workflowInfo) {
        const workflow = workflowSelect.value;
        const config = WORKFLOW_CONFIG[workflow];
        workflowInfo.textContent = config?.desc || '';
    }
}

// Generation Line Add Step Button
document.getElementById('addGenerationLineBtn')?.addEventListener('click', () => {
    const workflowSelect = document.getElementById('workflowSelect');
    const selectedWorkflow = workflowSelect?.value || 't2v';
    
    addPromptStep('', selectedWorkflow);
    
    // Scroll to the new step
    const container = document.getElementById('promptSequence');
    if (container) {
        const newStep = container.lastElementChild;
        if (newStep) newStep.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
});

function addPromptStep(val = '', mode = 't2v') {
    const container = document.getElementById('promptSequence');
    if (!container) return;

    // Handle val as string or object
    let promptImg = '';
    let promptVid = '';
    
    let stepImage = '';
    if (typeof val === 'object' && val !== null) {
        promptImg = val['PROMPT IMAGE'] || val.promptImage || val.prompt || '';
        promptVid = val['VIDEO IMAGE'] || val.videoImage || val.video || '';
        stepImage = val.imageFilename || '';
    } else {
        promptImg = val;
        promptVid = val;
    }

    const count = container.querySelectorAll('.prompt-item').length + 1;
    const div = document.createElement('div');
    div.className = 'prompt-item';
    
    // Use WORKFLOW_CONFIG to determine model and output
    const workflow = WORKFLOW_CONFIG[mode] || WORKFLOW_CONFIG['t2v'];
    const initialModel = workflow.model;
    const initialOutput = workflow.output;
    const isChainVideo = mode === 'chainvideo';
    
    div.dataset.mode = mode;
    div.dataset.model = initialModel;
    
    div.innerHTML = `
        <div class="prompt-header">
            <div class="prompt-header-left">
                <div class="prompt-number">${count}</div>
                <span class="prompt-status-text">STEP</span>
                <span class="workflow-badge" style="font-size: 0.65em; margin-left: 8px; padding: 2px 6px; border-radius: 4px; background: ${isChainVideo ? 'rgba(168,85,247,0.2)' : 'rgba(99,102,241,0.1)'}; border: 1px solid ${isChainVideo ? '#a855f7' : 'rgba(99,102,241,0.3)'}; color: ${isChainVideo ? '#a855f7' : '#818cf8'};">${workflow.name}</span>
                <span class="wan-chain-indicator ${isChainVideo ? '' : 'hidden'}" style="font-size: 0.65em; color: #a855f7; margin-left: 8px; padding: 2px 6px; background: rgba(168,85,247,0.1); border-radius: 4px; border: 1px solid rgba(168,85,247,0.3);">${count === 1 && isChainVideo ? '🔥 START' : '🔗 CHAIN'}</span>
            </div>
            <div class="prompt-header-right" style="display: flex; gap: 8px; align-items: center;">
                <!-- Model Display (Locked per workflow) -->
                <span class="step-model-display" style="padding: 4px 8px; font-size: 0.75em; border-radius: 4px; border: 1px solid rgba(99,102,241,0.3); background: rgba(15,23,42,0.8); color: #e2e8f0; font-weight: 600;">
                    ${initialModel === 'flux' ? '🖼️ FLUX' : initialModel === 'wan2.2' ? '🎬 Wan 2.2' : '🎬 LTX-2'}
                </span>
                <!-- Hidden selects for compatibility -->
                <select class="step-model-select hidden" title="AI Model">
                    <option value="ltx2" ${initialModel === 'ltx2' ? 'selected' : ''}>LTX-2</option>
                    <option value="wan2.2" ${initialModel === 'wan2.2' ? 'selected' : ''}>Wan 2.2</option>
                    <option value="flux" ${initialModel === 'flux' ? 'selected' : ''}>FLUX</option>
                </select>
                <select class="step-output-select hidden" title="Output Type">
                    <option value="video" ${initialOutput === 'video' ? 'selected' : ''}>Video</option>
                    <option value="image" ${initialOutput === 'image' ? 'selected' : ''}>Image</option>
                </select>
                <select class="step-mode-select-compact hidden" title="Generation mode">
                    <option value="t2v" ${mode === 't2v' ? 'selected' : ''}>T2V</option>
                    <option value="t2i" ${mode === 't2i' ? 'selected' : ''}>T2I</option>
                    <option value="t2i2v" ${mode === 't2i2v' ? 'selected' : ''}>T2I→I2V</option>
                    <option value="i2v" ${mode === 'i2v' ? 'selected' : ''}>I2V</option>
                    <option value="chainvideo" ${mode === 'chainvideo' ? 'selected' : ''}>CHAINVIDEO</option>
                </select>
                <button class="step-magic-btn" title="Magic Prompt (Improve with AI)" style="background: rgba(168, 85, 247, 0.1); color: #a855f7; border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 6px; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; font-size: 0.9em; cursor: pointer; transition: all 0.2s;">🪄</button>
                <button class="remove-prompt-btn" title="Remove prompt">×</button>
            </div>
        </div>
        <div class="prompt-content collapsed">
            <div class="prompt-inputs-container">
                <!-- Workflow info panel -->
                <div class="workflow-info-panel" style="background: rgba(99,102,241,0.05); border: 1px solid rgba(99,102,241,0.1); border-radius: 6px; padding: 10px; margin-bottom: 12px;">
                    <div style="display: flex; gap: 15px; flex-wrap: wrap; align-items: center; justify-content: space-between;">
                        <div style="display: flex; gap: 10px; align-items: center;">
                            <span style="font-size: 0.75em; color: #818cf8; font-weight: 600;">⚡ Workflow:</span>
                            <span style="font-size: 0.7em; color: #e2e8f0;">${workflow.desc}</span>
                        </div>
                        <div class="wan22-settings ${isChainVideo ? '' : 'hidden'}" style="display: flex; gap: 10px; align-items: center;">
                            <label style="font-size: 0.7em; color: #a855f7; font-weight: 600;">
                                🔗 Cadena continua activada
                            </label>
                        </div>
                    </div>
                </div>
                
                <div class="step-image-upload-section hidden" style="margin-bottom: 15px;">
                    <label style="font-size: 0.75em; color: #818cf8; font-weight: 600; display: block; margin-bottom: 8px;">REFERENCE IMAGE (I2V)</label>
                    <div class="step-image-upload-area" style="border: 2px dashed rgba(99,102,241,0.3); border-radius: 8px; padding: 15px; text-align: center; cursor: pointer; background: rgba(15, 23, 42, 0.4); transition: all 0.2s;">
                        <div class="step-upload-placeholder">
                            <svg xmlns="http://www.w3.org/2000/svg" style="width: 24px; height: 24px; color: #64748b; margin-bottom: 5px;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                            </svg>
                            <p style="font-size: 0.7em; color: #94a3b8; margin: 0;">Click or drop image</p>
                        </div>
                    </div>
                    <input type="file" class="step-image-input hidden" accept="image/*">
                    <input type="hidden" class="step-uploaded-filename">
                </div>
                
                <div class="prompt-split-label image" id="labelImg_${count}">
                    <span>PROMPT IMAGE (DESCRIPTION)</span>
                </div>
                <textarea class="sequence-prompt-textarea image-prompt" placeholder="Visual description of the frame...">${promptImg}</textarea>
                
                <div class="prompt-split-label video" id="labelVid_${count}">
                    <span>VIDEO IMAGE (ANIMATION & PLOT)</span>
                </div>
                <textarea class="sequence-prompt-textarea video-prompt" placeholder="Animation details and plot...">${promptVid}</textarea>
            </div>
            <button class="expand-prompt-btn" title="Expand/collapse prompt">▼</button>
        </div>
    `;

    const header = div.querySelector('.prompt-header');
    const content = div.querySelector('.prompt-content');
    const expandBtn = div.querySelector('.expand-prompt-btn');
    const modeSelect = div.querySelector('.step-mode-select-compact');
    const modelSelect = div.querySelector('.step-model-select');
    const outputSelect = div.querySelector('.step-output-select');
    const wanSettings = div.querySelector('.wan22-settings');
    const chainIndicator = div.querySelector('.wan-chain-indicator');
    const tImg = div.querySelector('.image-prompt');
    const tVid = div.querySelector('.video-prompt');
    const lImg = div.querySelector('.prompt-split-label.image');
    const lVid = div.querySelector('.prompt-split-label.video');

    function updateVisibility() {
        const currentModel = modelSelect.value;
        const currentMode = modeSelect.value;
        const outputType = outputSelect.value;
        const isWan22 = currentModel === 'wan2.2' || currentMode === 'chainvideo';
        const isI2VManual = currentMode === 'i2v';
        
        // Show/hide I2V Manual Upload UI
        const stepImgUpload = div.querySelector('.step-image-upload-section');
        if (stepImgUpload) {
            stepImgUpload.classList.toggle('hidden', !isI2VManual);
        }

        // Show/hide WAN2.2 specific settings
        if (wanSettings) {
            wanSettings.classList.toggle('hidden', !isWan22);
        }
        
        // Show/hide chain indicator for WAN2.2 / CHAINVIDEO
        if (chainIndicator) {
            chainIndicator.classList.toggle('hidden', !isWan22);
            if (isWan22) {
                const stepNum = parseInt(div.querySelector('.prompt-number')?.textContent || '1');
                const isChainStart = stepNum === 1 || currentMode === 'chainvideo' && stepNum === 1;
                if (isChainStart) {
                    chainIndicator.textContent = '🔥 START';
                    chainIndicator.style.background = 'rgba(168,85,247,0.2)';
                } else {
                    chainIndicator.textContent = '🔗 CHAIN';
                    chainIndicator.style.background = 'rgba(168,85,247,0.1)';
                }
            }
        }
        
        // Update visibility based on output type
        if (outputType === 'image' || currentModel === 'flux') {
            lImg.style.display = 'flex';
            tImg.style.display = 'block';
            lVid.style.display = 'none';
            tVid.style.display = 'none';
            lImg.querySelector('span').textContent = 'PROMPT IMAGE';
        } else {
            // Video output
            lImg.style.display = isI2VManual ? 'none' : 'flex';
            tImg.style.display = isI2VManual ? 'none' : 'block';
            
            lVid.style.display = 'flex';
            tVid.style.display = 'block';
            lImg.querySelector('span').textContent = isWan22 ? 'START IMAGE PROMPT' : 'PROMPT IMAGE (STATIC)';
            lVid.querySelector('span').textContent = isWan22 ? 'END IMAGE PROMPT / VIDEO' : 'VIDEO IMAGE (ANIMATION & PLOT)';
        }
        
        // Sync mode select for backward compatibility
        if (currentModel === 'flux' || outputType === 'image') {
            modeSelect.value = 't2i';
        } else if (isWan22) {
            modeSelect.value = currentMode === 'chainvideo' ? 'chainvideo' : 'wan2.2';
        } else if (currentMode === 'i2v') {
            modeSelect.value = 'i2v';
        } else {
            modeSelect.value = outputType === 'video' ? 't2i2v' : 't2i';
        }
    }

    // Event listeners for model and output dropdowns
    modelSelect.addEventListener('change', () => {
        // Auto-update output type based on model
        if (modelSelect.value === 'flux') {
            outputSelect.value = 'image';
        }
        updateVisibility();
    });
    
    outputSelect.addEventListener('change', () => {
        // Auto-update model based on output type
        if (outputSelect.value === 'image' && modelSelect.value !== 'flux') {
            modelSelect.value = 'flux';
        } else if (outputSelect.value === 'video' && modelSelect.value === 'flux') {
            modelSelect.value = 'ltx2';
        }
        updateVisibility();
    });
    
    updateVisibility();

    // Auto-resize function
    function autoResize(el) {
        if (!el || el.style.display === 'none') return;
        el.style.height = 'auto';
        el.style.height = Math.max(80, Math.min(el.scrollHeight, 600)) + 'px';
    }

    [tImg, tVid].forEach(t => {
        t.addEventListener('input', () => autoResize(t));
    });

    // Also resize when expanding
    const observer = new MutationObserver(() => {
        if (!content.classList.contains('collapsed')) {
            setTimeout(() => { autoResize(tImg); autoResize(tVid); }, 50);
        }
    });
    observer.observe(content, { attributes: true, attributeFilter: ['class'] });

    if (promptImg || promptVid) setTimeout(() => { autoResize(tImg); autoResize(tVid); }, 0);

    header.addEventListener('click', (e) => {
        if (e.target.closest('.step-mode-select-compact') || 
            e.target.closest('.step-model-select') || 
            e.target.closest('.step-output-select') ||
            e.target.closest('.remove-prompt-btn')) return;
        content.classList.toggle('collapsed');
        expandBtn.textContent = content.classList.contains('collapsed') ? '▼' : '▲';
    });

    expandBtn.addEventListener('click', () => {
        content.classList.toggle('collapsed');
        expandBtn.textContent = content.classList.contains('collapsed') ? '▼' : '▲';
    });

    div.querySelector('.remove-prompt-btn').addEventListener('click', () => {
        div.remove();
        container.querySelectorAll('.prompt-item').forEach((item, idx) => {
            item.querySelector('.prompt-number').textContent = idx + 1;
        });
    });

    // Magic Prompt listener for step
    const stepMagicBtn = div.querySelector('.step-magic-btn');
    if (stepMagicBtn) {
        stepMagicBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const currentMode = modeSelect.value;
            const isI2VManual = currentMode === 'i2v';
            
            const pImg = tImg.value.trim();
            const pVid = tVid.value.trim();
            
            if (!pImg && !pVid) {
                appendConsoleLine('⚠️ Please enter some text to improve', 'warning');
                return;
            }
            
            stepMagicBtn.textContent = '⏳';
            stepMagicBtn.disabled = true;
            
            try {
                if (pImg && !isI2VManual) {
                    const res = await fetch('/api/improve-step-prompt', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text: pImg, type: 'image' })
                    });
                    const data = await res.json();
                    if (data.improvedText) {
                        tImg.value = data.improvedText;
                        autoResize(tImg);
                    }
                }
                
                if (pVid) {
                    const res = await fetch('/api/improve-step-prompt', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text: pVid, type: 'video' })
                    });
                    const data = await res.json();
                    if (data.improvedText) {
                        tVid.value = data.improvedText;
                        autoResize(tVid);
                    }
                }
                appendConsoleLine(`✨ Step ${count} prompts improved with AI`, 'system');
            } catch (err) {
                appendConsoleLine(`❌ Error improving step prompt: ${err.message}`, 'error');
            } finally {
                stepMagicBtn.textContent = '🪄';
                stepMagicBtn.disabled = false;
            }
        });
    }

    // Image upload listeners for step
    const stepUploadArea = div.querySelector('.step-image-upload-area');
    const stepImageInput = div.querySelector('.step-image-input');
    if (stepUploadArea && stepImageInput) {
        stepUploadArea.addEventListener('click', () => {
            if (!stepUploadArea.classList.contains('has-image')) stepImageInput.click();
        });
        stepImageInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) handleStepImageFile(e.target.files[0], div);
        });
        
        stepUploadArea.addEventListener('dragover', (e) => { e.preventDefault(); stepUploadArea.classList.add('dragover'); });
        stepUploadArea.addEventListener('dragleave', () => stepUploadArea.classList.remove('dragover'));
        stepUploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            stepUploadArea.classList.remove('dragover');
            if (e.dataTransfer.files.length > 0) handleStepImageFile(e.dataTransfer.files[0], div);
        });
    }

    if (stepImage) {
        const filenameInput = div.querySelector('.step-uploaded-filename');
        if (filenameInput) filenameInput.value = stepImage;
        showStepImagePreview(`/uploads/${stepImage}`, stepImage, div);
    }

    container.appendChild(div);
}


// Initial step
if (document.getElementById('promptSequence') && document.getElementById('promptSequence').children.length === 0) {
    addPromptStep();
}

// ============================================
// JSON ACTIONS (SEQUENCER)
// ============================================

const jsonExampleBtn = document.getElementById('jsonExampleBtn');
const importJsonBtn = document.getElementById('importJsonBtn');

if (jsonExampleBtn) {
    jsonExampleBtn.addEventListener('click', () => {
        // Get current prompts from the sequencer
        const promptItems = document.querySelectorAll('.prompt-item');
        const globalImagePrompt = document.getElementById('globalImagePrompt')?.value.trim() || '';
        const globalVideoPrompt = document.getElementById('globalVideoPrompt')?.value.trim() || '';
        
        const steps = [];
        promptItems.forEach(item => {
            const imgPrompt = item.querySelector('.image-prompt')?.value.trim() || '';
            const vidPrompt = item.querySelector('.video-prompt')?.value.trim() || '';
            const mode = item.querySelector('.step-mode-select-compact')?.value || 't2i2v';
            
            if (imgPrompt || vidPrompt) {
                const step = {};
                if (mode === 't2i2v') {
                    step["PROMPT IMAGE"] = imgPrompt;
                    step["VIDEO IMAGE"] = vidPrompt;
                } else if (mode === 't2i') {
                    step["PROMPT IMAGE"] = imgPrompt || vidPrompt;
                } else {
                    step["VIDEO IMAGE"] = vidPrompt || imgPrompt;
                }
                steps.push(step);
            }
        });
        
        const jsonData = {
            globalImage: globalImagePrompt,
            globalVideo: globalVideoPrompt,
            steps: steps.length > 0 ? steps : [
                {
                    "PROMPT IMAGE": "a futuristic city at night",
                    "VIDEO IMAGE": "the camera pans slowly over the skyscrapers with flying vehicles"
                }
            ]
        };
        
        const jsonStr = JSON.stringify(jsonData, null, 2);

        // Copiar al portapapeles
        navigator.clipboard.writeText(jsonStr).then(() => {
            appendConsoleLine(`📋 JSON copied to clipboard! (${steps.length} steps)`, 'system');
            // Notify visually change button color temporarily
            const originalText = jsonExampleBtn.textContent;
            jsonExampleBtn.textContent = '✅';
            jsonExampleBtn.style.color = '#10b981';
            setTimeout(() => {
                jsonExampleBtn.textContent = originalText;
                jsonExampleBtn.style.color = '#818cf8';
            }, 1500);
        }).catch(err => {
            console.error('Failed to copy JSON:', err);
            alert('JSON:\n\n' + jsonStr);
        });
    });
}

if (importJsonBtn) {
    importJsonBtn.addEventListener('click', () => {
        const area = document.getElementById('jsonImportArea');
        if (area) area.classList.remove('hidden');
    });
}

const confirmJsonImport = document.getElementById('confirmJsonImport');
const cancelJsonImport = document.getElementById('cancelJsonImport');

if (cancelJsonImport) {
    cancelJsonImport.addEventListener('click', () => {
        const area = document.getElementById('jsonImportArea');
        if (area) area.classList.add('hidden');
    });
}

if (confirmJsonImport) {
    confirmJsonImport.addEventListener('click', () => {
        const input = document.getElementById('jsonInputText').value.trim();
        if (!input) return;

        try {
            const data = JSON.parse(input);
            applyBatchData(data);
            
            // Cerrar el area
            document.getElementById('jsonImportArea').classList.add('hidden');
            document.getElementById('jsonInputText').value = '';
        } catch (e) {
            console.error('JSON Import Error:', e);
            alert("Error importing JSON: " + e.message);
        }
    });
}

function applyBatchData(data, batchNameHint = null) {
    if (!data.steps || !Array.isArray(data.steps)) {
        throw new Error("Invalid format: 'steps' array is missing.");
    }

    // Limpiar pasos actuales
    const container = document.getElementById('promptSequence');
    if (container) container.innerHTML = '';

    // Cargar Global Prompt
    const globalImagePromptEl = document.getElementById('globalImagePrompt');
    const globalVideoPromptEl = document.getElementById('globalVideoPrompt');
    if (globalImagePromptEl && (data.globalImage || data.global)) {
        globalImagePromptEl.value = data.globalImage || data.global;
    }
    if (globalVideoPromptEl && (data.globalVideo || data.global)) {
        globalVideoPromptEl.value = data.globalVideo || data.global;
    }

    // Get current workflow from selector
    const workflowSelect = document.getElementById('workflowSelect');
    const currentWorkflow = workflowSelect?.value || 't2v';

    // Cargar pasos con el workflow actual
    data.steps.forEach(step => {
        addPromptStep(step, currentWorkflow);
    });

    // Store batch name hint for later use
    if (batchNameHint) {
        window.pendingBatchName = batchNameHint;
    }

    appendConsoleLine(`✅ Applied Batch Data: ${data.steps.length} prompts added (${currentWorkflow} workflow).`, 'system');
}

const enhancePromptBtn = document.getElementById('enhancePromptBtn');
const magicPromptBtn = document.getElementById('magicPromptBtn');
const aiPromptArea = document.getElementById('aiPromptArea');
const ollamaModelSelect = document.getElementById('ollamaModelSelect');

if (magicPromptBtn && aiPromptArea) {
    magicPromptBtn.addEventListener('click', () => {
        aiPromptArea.classList.toggle('hidden');
        if (!aiPromptArea.classList.contains('hidden')) {
            loadOllamaModels();
        }
    });
}

async function loadOllamaModels() {
    if (!ollamaModelSelect) return;
    try {
        const response = await fetch('/api/list-ollama-models');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const models = data.models || [];
        ollamaModelSelect.innerHTML = '';
        // Add a placeholder option so user must explicitly choose a model
        const placeholderOpt = document.createElement('option');
        placeholderOpt.value = '';
        placeholderOpt.disabled = true;
        placeholderOpt.selected = true;
        placeholderOpt.textContent = '-- Select a model --';
        ollamaModelSelect.appendChild(placeholderOpt);
        if (models.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'No Ollama models found';
            ollamaModelSelect.appendChild(opt);
        } else {
            // Sort: push embedding models to the end, text-generation models first
            const sorted = [...models].sort((a, b) => {
                const aIsEmbed = a.name.toLowerCase().includes('embed') || a.name.toLowerCase().includes('nomic');
                const bIsEmbed = b.name.toLowerCase().includes('embed') || b.name.toLowerCase().includes('nomic');
                if (aIsEmbed && !bIsEmbed) return 1;
                if (!aIsEmbed && bIsEmbed) return -1;
                return a.name.localeCompare(b.name);
            });
            sorted.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.name;
                opt.textContent = m.name;
                ollamaModelSelect.appendChild(opt);
            });
        }
    } catch (e) {
        console.error('Error loading Ollama models:', e);
        if (ollamaModelSelect) {
            ollamaModelSelect.innerHTML = '<option value="">Ollama not available</option>';
        }
    }
}

if (enhancePromptBtn) {
    enhancePromptBtn.addEventListener('click', async () => {
        const text = document.getElementById('manualBatchPrompt').value.trim();
        const modelName = ollamaModelSelect ? ollamaModelSelect.value : 'llama3.2:latest';

        if (!modelName) {
            alert("Please select an Ollama model from the dropdown first.");
            return;
        }

        if (!text) {
            alert("Por favor escribe una idea primero.");
            return;
        }

        enhancePromptBtn.disabled = true;
        enhancePromptBtn.textContent = '🪄 GENERATING BATCH WITH AI...';
        appendConsoleLine(`🪄 Asking Ollama (${modelName}) for a cinematic batch...`, 'system');

        try {
            const response = await fetch('/api/enhance-prompt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, modelName })
            });

            const data = await response.json();
            if (data.error) throw new Error(data.error);

            // Extract a short name from the user's idea (first 3-5 words)
            const words = text.trim().split(/\s+/);
            const shortName = words.slice(0, Math.min(5, words.length)).join(' ');
            const batchName = shortName.length > 40 ? shortName.substring(0, 40) + '...' : shortName;

            applyBatchData(data, batchName);
            appendConsoleLine(`✨ Batch sequence generated successfully: "${batchName}".`, 'system');
        } catch (err) {
            console.error('Enhance error:', err);
            appendConsoleLine(`❌ AI Enhancement failed: ${err.message}`, 'error');
            alert("Error al mejorar el prompt: " + err.message);
        } finally {
            enhancePromptBtn.disabled = false;
            enhancePromptBtn.textContent = '✨ GENERATE CLIP FROM IDEA';
        }
    });
}

function addToQueue(prompt, forcedImage = null, options = {}) {
    const params = {
        videoWidth: parseInt(document.getElementById('videoWidth').value),
        videoHeight: parseInt(document.getElementById('videoHeight').value),
        videoLength: parseInt(document.getElementById('videoLength').value),
        samplerSteps: parseInt(document.getElementById('samplerSteps').value),
        cfgScale: parseFloat(document.getElementById('cfgScale').value),
        refStrength: parseFloat(document.getElementById('refStrength').value),
        seed: document.getElementById('randomSeed').checked ? -1 : parseInt(document.getElementById('seed').value),
        negativePrompt: options.negativePrompt || ''
    };

    globalGenerationQueue.push({
        id: Date.now() + Math.random(),
        prompt: prompt,
        params,
        imageFilename: forcedImage !== null ? forcedImage : uploadedImageFilename,
        status: 'pending',
        projectId: activeProjectId,
        autoOverlap: options.autoOverlap !== undefined ? options.autoOverlap : (parseFloat(document.getElementById('autoOverlapSlider')?.value || 0) / 100),
        ...options // replaceClipId, isAutoAssemble, batchId, etc.
    });

    updateGlobalQueueUI();
    checkGlobalQueue();
}

async function loadExistingVideos() {
    try {
        const response = await fetch('/api/videos?t=' + Date.now());
        const videos = await response.json();
        const gallery = document.getElementById('videoGallery');
        if (!gallery) return;
        gallery.innerHTML = '';

        videos.forEach((video, index) => {
            const galleryItem = document.createElement('div');
            galleryItem.className = 'gallery-item';
            if (video.filename.startsWith('export_') || (video.metadata && video.metadata.isExport)) {
                galleryItem.classList.add('export-item');
            }

            const isEx = galleryItem.classList.contains('export-item');
            const techInfo = video.metadata || { videoWidth: 1280, videoHeight: 720, samplerSteps: 20, videoLength: 121 };
            const promptStr = isEx ? (video.metadata.prompt || 'Final Output Render') : (video.prompt || '');
            const dateStr = new Date(video.timestamp).toLocaleString();
            
            // Preserve original prompts from metadata for regeneration
            const fullMetadata = {
                ...techInfo,
                imagePrompt: techInfo.imagePrompt || video.prompt || '',
                videoPrompt: techInfo.videoPrompt || video.prompt || '',
                imageFilename: techInfo.imageFilename || null
            };

            // Badge style and text
            const badgeLabel = isEx ? `🎬 FINAL EXPORT` : `${techInfo.videoWidth}x${techInfo.videoHeight} • ${techInfo.samplerSteps} steps`;
            const badgeStyle = isEx ? `background: linear-gradient(90deg, #10b981, #059669); color: white; border: 1px solid rgba(16, 185, 129, 0.5);` : `background: rgba(15, 23, 42, 0.85); color: #a5b4fc; border: 1px solid rgba(99, 102, 241, 0.3);`;

            galleryItem.innerHTML = `
                <div style="position: relative; width: 100%; height: 160px; overflow: hidden; border-radius: 8px; background: #000; box-shadow: 0 4px 10px rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center;">
                    <div class="video-placeholder-icon" style="position: absolute; font-size: 40px; opacity: 0.15; filter: grayscale(1); pointer-events: none; z-index: 1;">🎬</div>
                    <video src="${video.url}" style="width: 100%; height: 100%; object-fit: cover; position: relative; z-index: 2;" controls preload="none"></video>
                    <button class="previz-btn" title="View in Previz" style="position: absolute; top: 10px; right: 10px; background: ${isEx ? '#10b981' : '#6366f1'}; border-radius: 50%; width: 32px; height: 32px; min-width: 32px; display: flex; align-items: center; justify-content: center; border: none; cursor: pointer; color: white; padding: 0; flex-shrink: 0; z-index: 10;">👁️</button>
                    ${isEx ? `<div style="position: absolute; top: 10px; left: 10px; background: #10b981; color: white; font-size: 8px; padding: 2px 6px; border-radius: 4px; font-weight: 800; text-transform: uppercase; z-index: 10;">MASTER</div>` : ''}
                    <div style="position: absolute; top: ${isEx ? '30' : '8'}px; left: 8px; background: rgba(15, 23, 42, 0.7); padding: 2px 6px; border-radius: 4px; font-size: 8px; color: #94a3b8; pointer-events: none; z-index: 10;">${dateStr}</div>
                    <div style="position: absolute; bottom: 8px; left: 8px; padding: 3px 8px; border-radius: 6px; font-size: 10px; font-weight: 800; ${badgeStyle}; z-index: 10;">${badgeLabel}</div>
                </div>
                <div style="padding: 4px;">
                    <div style="font-size: 11px; color: ${isEx ? '#10b981' : '#6366f1'}; font-weight: 800; text-transform: uppercase; margin-bottom: 4px; letter-spacing: 0.5px;">${isEx ? 'Project Output' : 'Prompt'}</div>
                    <div style="font-size: 10px; color: #e2e8f0; line-height: 1.4; max-height: 4.2em; overflow-y: auto; background: rgba(15, 23, 42, 0.4); padding: 6px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.05);">
                        ${promptStr || '<span style="opacity: 0.5; font-style: italic;">No prompt recorded</span>'}
                    </div>
                </div>
            `;


            galleryItem.draggable = true;
            galleryItem.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('videoSrc', video.url);
                e.dataTransfer.setData('videoPrompt', promptStr);
                e.dataTransfer.setData('videoMetadata', JSON.stringify(fullMetadata));
                galleryItem.style.opacity = '0.5';
            });
            galleryItem.addEventListener('dragend', () => galleryItem.style.opacity = '1');

            // LOAD ON HOVER: Solo carga el video cuando el usuario pasa el mouse por encima
            galleryItem.addEventListener('mouseenter', () => {
                const v = galleryItem.querySelector('video');
                if (v && v.preload === 'none') {
                    v.preload = 'metadata';
                    v.load();
                }
            }, { once: true });

            galleryItem.querySelector('.previz-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                loadVideoToPreviz(video.url);
                // Cambiar a la pestaña Previz
                const tabPrevizBtn = document.getElementById('tabPrevizBtn');
                if (tabPrevizBtn) tabPrevizBtn.click();
            });

            gallery.appendChild(galleryItem);

        });
    } catch (e) { console.error(e); }
}

async function loadExistingImages() {
    try {
        const response = await fetch('/api/images?t=' + Date.now());
        const images = await response.json();
        const gallery = document.getElementById('imageGallery');
        if (!gallery) return;
        gallery.innerHTML = '';

        images.forEach((image) => {
            const galleryItem = document.createElement('div');
            galleryItem.className = 'gallery-item';

            galleryItem.innerHTML = `
                <div style="position: relative; width: 100%; height: 160px; overflow: hidden; border-radius: 8px; background: #000; box-shadow: 0 4px 10px rgba(0,0,0,0.3);">
                    <img src="${image.url}" style="width: 100%; height: 100%; object-fit: cover;">
                    <div style="position: absolute; top: 10px; right: 10px; display: flex; gap: 5px;">
                        <button class="view-img-btn" title="View in Previz" style="background: rgba(15, 23, 42, 0.8); border-radius: 50%; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border: none; cursor: pointer; color: white; border: 1px solid rgba(255,255,255,0.1); z-index: 5;">👁️</button>
                        <button class="previz-btn" title="Use as Reference" style="background: #a855f7; border-radius: 50%; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border: none; cursor: pointer; color: white; padding: 0; flex-shrink: 0; z-index: 5;">📤</button>
                    </div>
                    <div style="position: absolute; bottom: 8px; left: 8px; background: rgba(15, 23, 42, 0.75); padding: 3px 8px; border-radius: 4px; font-size: 9px; color: #cbd5e1; border: 1px solid rgba(255,255,255,0.1); pointer-events: none;">IMAGE ASSET</div>
                </div>
                <div style="padding: 8px 4px 4px 4px;">
                    <div style="font-size: 11px; color: #a855f7; font-weight: 800; text-transform: uppercase; margin-bottom: 2px; letter-spacing: 0.5px;">Filename</div>
                    <div style="font-size: 10px; color: #94a3b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${image.filename}</div>
                </div>
            `;

            galleryItem.querySelector('.view-img-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                loadImageToPreviz(image.url);
                const tabPrevizBtn = document.getElementById('tabPrevizBtn');
                if (tabPrevizBtn) tabPrevizBtn.click();
            });

            galleryItem.querySelector('.previz-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                showImagePreview(image.url, image.filename);
                uploadedImageFilename = image.filename;
                updateMode();
                appendConsoleLine(`🖼️ Loaded image as reference: ${image.filename}`, 'system');
            });

            // Drag & Drop support
            galleryItem.draggable = true;
            galleryItem.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('imageSrc', image.url);
                e.dataTransfer.setData('imageFilename', image.filename);
                galleryItem.style.opacity = '0.5';
            });
            galleryItem.addEventListener('dragend', () => {
                galleryItem.style.opacity = '1';
            });

            gallery.appendChild(galleryItem);
        });
    } catch (e) { console.error(e); }
}

async function loadExistingAudio() {
    try {
        const response = await fetch('/api/audio?t=' + Date.now());
        const audioFiles = await response.json();
        const gallery = document.getElementById('audioGallery');
        if (!gallery) return;
        gallery.innerHTML = '';

        audioFiles.forEach((audio) => {
            const galleryItem = document.createElement('div');
            galleryItem.className = 'gallery-item';

            galleryItem.innerHTML = `
                <div style="position: relative; width: 100%; height: 80px; overflow: hidden; border-radius: 8px; background: #1e3a8a; box-shadow: 0 4px 10px rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center;">
                    <div style="font-size: 30px; opacity: 0.5;">🎵</div>
                    <div style="position: absolute; bottom: 5px; right: 8px; font-size: 9px; color: #94a3b8;">AUDIO</div>
                </div>
                <div style="padding: 8px 4px 4px 4px;">
                    <div style="font-size: 11px; color: #3b82f6; font-weight: 800; text-transform: uppercase; margin-bottom: 2px; letter-spacing: 0.5px;">Filename</div>
                    <div style="font-size: 10px; color: #94a3b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${audio.filename}</div>
                </div>
            `;

            galleryItem.draggable = true;
            galleryItem.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('audioSrc', audio.url);
                e.dataTransfer.setData('audioFilename', audio.filename);
                galleryItem.style.opacity = '0.5';
            });
            galleryItem.addEventListener('dragend', () => galleryItem.style.opacity = '1');

            gallery.appendChild(galleryItem);
        });

        // Setup drop to upload in audio gallery
        if (!gallery.dataset.hasDropListener) {
            gallery.addEventListener('dragover', (e) => {
                e.preventDefault();
                gallery.style.background = 'rgba(59, 130, 246, 0.1)';
            });
            gallery.addEventListener('dragleave', () => {
                gallery.style.background = '';
            });
            gallery.addEventListener('drop', async (e) => {
                e.preventDefault();
                gallery.style.background = '';
                const files = e.dataTransfer.files;
                if (files.length > 0) {
                    for (const file of files) {
                        if (file.type.startsWith('audio/')) {
                            appendConsoleLine(`📤 Uploading audio: ${file.name}...`, 'system');
                            const formData = new FormData();
                            formData.append('audio', file);
                            const res = await fetch('/api/upload-audio', { method: 'POST', body: formData });
                            const result = await res.json();
                            if (result.success) {
                                appendConsoleLine(`✅ Audio uploaded: ${result.filename}`, 'system');
                            }
                        }
                    }
                    loadExistingAudio();
                }
            });
            gallery.dataset.hasDropListener = 'true';
        }
    } catch (e) { console.error(e); }
}

// Main Workspace Tab Switching
document.querySelectorAll('.tab-button-std').forEach(btn => {
    btn.addEventListener('click', () => {
        const target = btn.dataset.target;
        if (!target) return;

        document.querySelectorAll('.tab-button-std').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        const content = document.getElementById(target);
        if (content) content.classList.add('active');

        if (target === 'tabEditor') document.body.classList.add('tab-editor-active');
        else document.body.classList.remove('tab-editor-active');
    });
});

// Sub-Tab Switching (Previz)
document.querySelectorAll('.sub-tab-btn-std').forEach(btn => {
    btn.addEventListener('click', () => {
        const targetId = btn.dataset.sub;
        const parent = btn.parentElement.parentElement;
        parent.querySelectorAll('.sub-tab-btn-std').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        parent.querySelectorAll('.sub-tab-content').forEach(c => c.classList.remove('active'));
        const content = document.getElementById(targetId);
        if (content) content.classList.add('active');
    });
});

// Asset Tab Switching
document.querySelectorAll('.asset-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const type = btn.dataset.type;
        document.querySelectorAll('.asset-tab-btn').forEach(b => {
            b.classList.remove('active');
        });
        btn.classList.add('active');

        document.getElementById('videoGallery')?.classList.add('hidden');
        document.getElementById('imageGallery')?.classList.add('hidden');
        document.getElementById('audioGallery')?.classList.add('hidden');
        document.getElementById('projectGallery')?.classList.add('hidden');

        if (type === 'videos') {
            document.getElementById('videoGallery')?.classList.remove('hidden');
        } else if (type === 'images') {
            document.getElementById('imageGallery')?.classList.remove('hidden');
            loadExistingImages();
        } else if (type === 'audio') {
            document.getElementById('audioGallery')?.classList.remove('hidden');
            loadExistingAudio();
        } else if (type === 'projects') {
            document.getElementById('projectGallery')?.classList.remove('hidden');
            loadProjectsList();
        }
    });
});

// ============================================
// TIMELINE & EDITOR (OPTIMIZED)
// ============================================

let selectedClipElement = null; // Elemento seleccionado actualmente en el timeline
let currentTimelineMode = 'trim'; // 'trim' o 'stretch'
let currentlyRegeneratingClipId = null; // ID del clip que se está editando en el modal de regeneración

const timelineTracksContent = document.getElementById('editorTimeline');
const playhead = document.createElement('div');
playhead.id = 'timelinePlayhead';
playhead.style.cssText = 'position: absolute; top: 0; left: 0; width: 2px; height: 100%; background: #ff3e3e; z-index: 50; pointer-events: none;';
if (timelineTracksContent) {
    timelineTracksContent.appendChild(playhead);

    let isScrubbing = false;

    const handleScrub = (e) => {
        const rect = timelineTracksContent.getBoundingClientRect();
        const x = e.clientX - rect.left + timelineTracksContent.scrollLeft;
        currentTlPos = Math.max(0, x);
        playhead.style.left = `${currentTlPos}px`;
        syncPreviewToTime(currentTlPos, true); // true means force seek
    };

    timelineTracksContent.addEventListener('mousedown', (e) => {
        if (e.target.closest('.timeline-clip')) return; // Let clip dragging handle itself
        isScrubbing = true;
        handleScrub(e);
        document.addEventListener('mousemove', handleScrub);
        document.addEventListener('mouseup', () => {
            isScrubbing = false;
            document.removeEventListener('mousemove', handleScrub);
        }, { once: true });
    });

    timelineTracksContent.addEventListener('click', (e) => {
        if (e.target.closest('.timeline-clip')) return;
        handleScrub(e);
    });

    // RESTORED DRAG & DROP FOR TIMELINE
    timelineTracksContent.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });

    timelineTracksContent.addEventListener('drop', (e) => {
        e.preventDefault();
        const videoSrc = e.dataTransfer.getData('videoSrc');
        const audioSrc = e.dataTransfer.getData('audioSrc');
        const prompt = e.dataTransfer.getData('videoPrompt');
        const metadata = JSON.parse(e.dataTransfer.getData('videoMetadata') || '{}');
        
        const tracks = document.querySelectorAll('.timeline-track');
        let targetTrack = tracks[0];
        const rect = timelineTracksContent.getBoundingClientRect();

        tracks.forEach(track => {
            const r = track.getBoundingClientRect();
            if (e.clientY >= r.top && e.clientY <= r.bottom) targetTrack = track;
        });

        const videoTracks = Array.from(tracks).filter(t => t.dataset.track.startsWith('V'));
        const audioTracks = Array.from(tracks).filter(t => t.dataset.track.startsWith('A'));

        if (videoSrc) {
            const videoId = 'clip_' + Date.now() + '_V';
            const audioId = 'clip_' + Date.now() + '_A';
            
            // For videos, targetTrack MUST be a video track
            let finalVideoTrack = targetTrack.dataset.track.startsWith('V') ? targetTrack : (videoTracks[0] || targetTrack);
            
            // Add video to V track
            const vClip = addClipToTimeline(videoSrc, finalVideoTrack, e.clientX, prompt, { ...metadata, clipId: videoId });
            
            // Add audio to A1
            const audioTrack = document.querySelector('.timeline-track[data-track="A1"]');
            if (audioTrack) {
                const aClip = addClipToTimeline(videoSrc, audioTrack, e.clientX, prompt, { ...metadata, isAudioOnly: true, clipId: audioId });
                vClip.dataset.linkedTo = audioId;
                aClip.dataset.linkedTo = videoId;
                vClip.dataset.audioDetached = "false";
                appendConsoleLine(`🎞️ Linked video & audio tracks added.`, 'system');
            }
        } else if (audioSrc) {
            // For pure audio drops, only allow A tracks
            let finalAudioTrack = targetTrack.dataset.track.startsWith('A') ? targetTrack : (audioTracks[0] || targetTrack);
            addClipToTimeline(audioSrc, finalAudioTrack, e.clientX, '', { isAudioOnly: true });
            appendConsoleLine(`🎵 Added audio track to timeline: ${audioSrc.split('/').pop()}`, 'system');
        }
    });
}

// Auto-save debounce timer
let autoSaveTimer = null;

function triggerAutoSave() {
    if (!activeProjectId) return;
    
    // Debounce: wait 2 seconds after last change before saving
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
        const project = openProjects.find(p => p.id === activeProjectId);
        if (project) {
            project.data = getProjectData();
            saveProjectToFile(project.name, project.data);
        }
    }, 2000);
}

// Función para refrescar la cache de clips (se llama cuando cambian)
function refreshClipCache() {
    const clips = document.querySelectorAll('.timeline-clip');
    clipCache = Array.from(clips).map(clip => {
        const l = parseFloat(clip.style.left) || 0;
        const w = clip.offsetWidth;
        const track = clip.parentElement.dataset.track || 'V1';
        const video = clip.querySelector('video');
        const meta = JSON.parse(clip.dataset.metadata || '{}');
        return {
            element: clip,
            left: l,
            width: w,
            right: l + w,
            track: track,
            src: video ? video.src : null,
            videoElement: video,
            isAudioOnly: !!meta.isAudioOnly
        };
    }).sort((a, b) => b.track.localeCompare(a.track));
    
    // Trigger auto-save when clips change
    triggerAutoSave();
}

function addClipToTimeline(src, trackElement, xPos, prompt = '', metadata = {}) {
    const emptyMsg = document.querySelector('.timeline-empty-msg');
    if (emptyMsg) emptyMsg.remove();
    const clip = document.createElement('div');
    clip.className = 'timeline-clip';
    clip.dataset.clipId = metadata.clipId || ('clip_' + Date.now() + Math.random());
    clip.dataset.prompt = prompt;
    clip.dataset.metadata = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);

    const filename = src.split('/').pop().split('?')[0];
    const rect = trackElement.getBoundingClientRect();
    clip.style.left = `${Math.max(0, xPos - rect.left)}px`;
    
    // Set initial width based on metadata.videoLength as fallback
    // This will be updated once the video metadata loads
    const videoFrames = metadata.videoLength || 121;
    const FPS = 24;
    const videoDuration = videoFrames / FPS;
    const calculatedWidth = videoDuration * 25;
    clip.style.width = `${calculatedWidth}px`;

    const isAudio = metadata.isAudioOnly === true;
    if (isAudio) clip.classList.add('audio-clip');

    clip.innerHTML = `
        <div class="trim-handle trim-handle-left"></div>
        <video src="${src}" ${isAudio ? '' : 'muted'} preload="metadata" style="${isAudio ? 'display:none;' : 'width: 100%; height: 100%; object-fit: cover;'}"></video>
        ${isAudio ? '<div class="audio-waveform-icon">🎵</div>' : ''}
        <div class="clip-info" style="position: absolute; bottom: 2px; left: 4px; pointer-events: none; text-shadow: 0 0 4px #000;"><span>${filename}</span></div>
        <div class="trim-handle trim-handle-right"></div>
        <div class="clip-actions-overlay">
            ${(!isAudio) ? `
                <button class="detach-audio-btn" title="Unlink Audio">🔗</button>
                <button class="regen-clip-btn" title="Regenerate this clip">↻</button>
            ` : ''}
            <button class="remove-clip-btn" title="${isAudio ? 'Delete Audio' : 'Delete Clip'}">×</button>
        </div>
    `;

    // Get the video element and update width based on actual duration
    const videoElement = clip.querySelector('video');
    if (videoElement) {
        videoElement.addEventListener('loadedmetadata', () => {
            // Timeline scale: 25px = 1 second
            const actualDuration = videoElement.duration;
            const correctWidth = actualDuration * 25;
            clip.style.width = `${correctWidth}px`;
            
            // Update metadata with actual duration for future reference
            const meta = JSON.parse(clip.dataset.metadata || '{}');
            meta.actualDuration = actualDuration;
            clip.dataset.metadata = JSON.stringify(meta);
            
            // Refresh cache to update clip dimensions
            refreshClipCache();
        });
    }

    if (!isAudio) {
        clip.querySelector('.detach-audio-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const linkedId = clip.dataset.linkedTo;
            if (linkedId) {
                const linkedClip = document.querySelector(`[data-clip-id="${linkedId}"]`);
                if (linkedClip) {
                    delete clip.dataset.linkedTo;
                    delete linkedClip.dataset.linkedTo;
                    clip.dataset.audioDetached = "true";
                    clip.querySelector('.detach-audio-btn').style.display = 'none';
                    appendConsoleLine(`🔓 Audio unlinked and independent.`, 'system');
                    refreshClipCache();
                }
            }
        });

        clip.querySelector('.regen-clip-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            openRegenModal(clip);
        });
    }
    setupClipInteractions(clip);

    clip.querySelector('.remove-clip-btn').addEventListener('click', () => {
        const linkedId = clip.dataset.linkedTo;
        clip.remove();
        if (linkedId) {
            const linked = document.querySelector(`[data-clip-id="${linkedId}"]`);
            if (linked) linked.remove();
        }
        refreshClipCache();
        checkTimelineEmpty();
    });

    trackElement.appendChild(clip);
    calculateTimelineOverlaps();
    refreshClipCache();

    // Evento de selección
    clip.addEventListener('click', (e) => {
        e.stopPropagation();
        if (selectedClipElement) selectedClipElement.classList.remove('selected');
        selectedClipElement = clip;
        clip.classList.add('selected');
    });

    return clip;
}


function setupClipInteractions(clip) {
    let isDragging = false, isTrimmingLeft = false, isTrimmingRight = false;
    let startX, startLeft, startWidth;

    clip.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;

        // Selección automática al interactuar
        if (selectedClipElement) selectedClipElement.classList.remove('selected');
        selectedClipElement = clip;
        clip.classList.add('selected');

        startX = e.clientX;
        startLeft = parseFloat(clip.style.left) || 0;
        startWidth = clip.offsetWidth;
        
        // Find linked clip if any
        if (clip.dataset.linkedTo) {
            const linked = document.querySelector(`[data-clip-id="${clip.dataset.linkedTo}"]`);
            if (linked) {
                clip._linkedClip = linked;
                clip._linkedStartLeft = parseFloat(linked.style.left) || 0;
                clip._linkedStartWidth = linked.offsetWidth;
            }
        } else {
            clip._linkedClip = null;
        }

        if (e.target.classList.contains('trim-handle-left')) isTrimmingLeft = true;
        else if (e.target.classList.contains('trim-handle-right')) isTrimmingRight = true;
        else isDragging = true;
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        e.preventDefault();
    });

    function handleMouseMove(e) {
        const delta = e.clientX - startX;
        if (isDragging) {
            let nL = Math.max(0, startLeft + delta);
            clip.style.left = `${nL}px`;
            
            if (clip._linkedClip) {
                // El linkeado se mueve relativo al clip principal limitado a 0
                const linkedDelta = nL - startLeft;
                clip._linkedClip.style.left = `${Math.max(0, clip._linkedStartLeft + linkedDelta)}px`;
            }

            const isAudioOnly = clip.classList.contains('audio-clip');
            const tracks = document.querySelectorAll('.timeline-track');
            
            tracks.forEach(track => {
                const r = track.getBoundingClientRect();
                if (e.clientY >= r.top && e.clientY <= r.bottom) {
                    const isAudioTrack = track.dataset.track.startsWith('A');
                    // Solo permitir si el track y el clip coinciden en tipo
                    if (isAudioOnly === isAudioTrack) {
                        track.appendChild(clip);
                    }
                }
            });
        } else if (isTrimmingLeft) {
            let nL = startLeft + delta, nW = startWidth - delta;
            if (nW > 20 && nL >= 0) {
                clip.style.left = `${nL}px`; clip.style.width = `${nW}px`;
                if (clip._linkedClip) {
                    clip._linkedClip.style.left = `${clip._linkedStartLeft + delta}px`;
                    clip._linkedClip.style.width = `${clip._linkedStartWidth - delta}px`;
                }
            }
        } else if (isTrimmingRight) {
            let nW = startWidth + delta;
            if (nW > 20) {
                clip.style.width = `${nW}px`;
                if (clip._linkedClip) {
                    clip._linkedClip.style.width = `${clip._linkedStartWidth + delta}px`;
                }
            }
        }
        checkAutoBlending(clip);
        refreshClipCache(); // Update cache during drag for smooth preview
        syncPreviewToTime(currentTlPos || parseFloat(clip.style.left));
    }


    function handleMouseUp() {
        isDragging = isTrimmingLeft = isTrimmingRight = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);

        // Finalizar el movimiento, calcular transparencias
        calculateTimelineOverlaps();
        refreshClipCache();
    }
}

function calculateTimelineOverlaps() {
    const clips = Array.from(document.querySelectorAll('.timeline-clip'));
    clips.forEach(clip => {
        clip.style.opacity = '1';
        clip.dataset.overlapping = 'false';
    });

    for (let i = 0; i < clips.length; i++) {
        const c1 = clips[i];
        const r1 = c1.getBoundingClientRect();
        for (let j = i + 1; j < clips.length; j++) {
            const c2 = clips[j];
            const r2 = c2.getBoundingClientRect();

            // Si hay solapamiento horizontal (sin importar el track para la visualización del editor)
            const overlap = !(r1.right < r2.left || r1.left > r2.right);
            if (overlap) {
                c1.style.opacity = '0.6';
                c2.style.opacity = '0.6';
                c1.dataset.overlapping = 'true';
                c2.dataset.overlapping = 'true';
            }
        }
    }
}

// Atajo de Barra Espaciadora para Play/Pause y Delete para borrar clips
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.code === 'Space') {
        e.preventDefault();
        const playBtn = document.getElementById('tlPlayBtn');
        if (playBtn) playBtn.click();
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedClipElement) {
            appendConsoleLine(`🗑️ Clip deleted via shortcut`, 'system');
            selectedClipElement.remove();
            selectedClipElement = null;
            refreshClipCache();
            checkTimelineEmpty();
        }
    }

    // Atajos para modos
    if (e.key === 't' || e.key === 'T') document.getElementById('modeTrimBtn')?.click();
    if (e.key === 's' || e.key === 'S') document.getElementById('modeStretchBtn')?.click();
});


function checkAutoBlending(activeClip) {
    const allClips = document.querySelectorAll('.timeline-clip');
    const aL = parseFloat(activeClip.style.left), aR = aL + activeClip.offsetWidth;
    activeClip.style.background = '';
    allClips.forEach(other => {
        if (other === activeClip) return;
        const oL = parseFloat(other.style.left), oR = oL + other.offsetWidth;
        if (aL < oR && aR > oL) {
            activeClip.style.background = 'linear-gradient(90deg, #4f46e5, #ec4899)';
            other.style.border = '1px dashed #ec4899';
        } else other.style.border = '';
    });
}

function syncPreviewToTime(xPos, forceSeek = false) {
    const previewA = document.getElementById('timelinePreviewA');
    const previewB = document.getElementById('timelinePreviewB');
    const edPlaceholder = document.getElementById('editorPlaceholder');

    if (!clipCache.length) {
        if (edPlaceholder) edPlaceholder.style.display = 'block';
        if (previewA) previewA.style.display = 'none';
        if (previewB) previewB.style.display = 'none';
        return;
    }

    // Buscar clips que coincidan con la posición actual
    // Diferenciamos clips de VIDEO (V1, V2...) de clips de AUDIO (A1, A2...)
    const activeClips = clipCache.filter(c => xPos >= c.left && xPos <= c.right);
    const videoActiveClips = activeClips.filter(c => !c.isAudioOnly);
    const audioActiveClips = activeClips.filter(c => c.isAudioOnly);

    // --- MANEJO DE VIDEO (Monitor Dual) ---
    if (videoActiveClips.length === 0) {
        if (previewA) {
            previewA.pause();
            previewA.style.display = 'none';
        }
        if (previewB) {
            previewB.pause();
            previewB.style.display = 'none';
        }
        if (edPlaceholder) edPlaceholder.style.display = 'block';
    } else {
        if (edPlaceholder) edPlaceholder.style.display = 'none';
        if (previewA) previewA.style.display = 'block';

        if (videoActiveClips.length >= 2) {
            const v1 = videoActiveClips[0];
            const v2 = videoActiveClips[1];

            const overlapStart = Math.max(v1.left, v2.left);
            const overlapEnd = Math.min(v1.right, v2.right);
            const overlapDuration = overlapEnd - overlapStart;

            let t = 0;
            if (overlapDuration > 0) {
                t = (xPos - overlapStart) / overlapDuration;
            }

            updateVideoPreview(previewA, v1, xPos, 1 - t, forceSeek);
            if (previewB) {
                previewB.style.display = 'block';
                updateVideoPreview(previewB, v2, xPos, t, forceSeek);
            }
        } else {
            const v = videoActiveClips[0];
            updateVideoPreview(previewA, v, xPos, 1.0, forceSeek);
            if (previewB) {
                previewB.style.display = 'none';
                previewB.pause();
            }
        }
    }

    // --- MANEJO DE AUDIO (Directo desde el elemento del Timeline) ---
    // Sincronizar y reproducir tracks de audio independientes
    audioActiveClips.forEach(c => {
        if (!c.videoElement) return;

        let playbackRate = 1.0;
        const metadata = JSON.parse(c.element.dataset.metadata || '{}');
        const naturalFrames = metadata.videoLength || 121;
        const FPS = 24;
        const naturalDuration = naturalFrames / FPS;
        const naturalWidth = naturalDuration * 25;

        if (currentTimelineMode === 'stretch') {
            playbackRate = naturalWidth / c.width;
        }

        const targetTime = (xPos - c.left) / (25 * playbackRate);
        c.videoElement.playbackRate = playbackRate;

        const drift = Math.abs(c.videoElement.currentTime - targetTime);
        if (forceSeek || drift > 0.15) {
            c.videoElement.currentTime = targetTime;
        }

        if (isPlayingTl) {
            if (c.videoElement.paused) c.videoElement.play().catch(() => {});
        } else {
            if (!c.videoElement.paused) c.videoElement.pause();
        }
    });

    // Pausar clips de audio que ya no están bajo el cabezal
    clipCache.forEach(c => {
        if (c.isAudioOnly && (xPos < c.left || xPos > c.right)) {
            if (c.videoElement && !c.videoElement.paused) {
                c.videoElement.pause();
            }
        }
    });
}

function updateVideoPreview(video, clip, xPos, weight, forceSeek) {
    // Si estamos en stretch mode, la velocidad cambia para que el video dure exactamente lo que mide el clip
    // Asumimos que el video original dura 150px (6s) por defecto si no hay metadatos.
    // En un sistema real usaríamos video.duration, pero aquí el 'length' en frames escalado apx sirve.

    let playbackRate = 1.0;
    const metadata = JSON.parse(clip.element.dataset.metadata || '{}');
    const naturalFrames = metadata.videoLength || 121;
    const FPS = 24;
    const naturalDuration = naturalFrames / FPS;
    const naturalWidth = naturalDuration * 25;

    if (currentTimelineMode === 'stretch') {
        playbackRate = naturalWidth / clip.width;
    }

    const targetTime = (xPos - clip.left) / (25 * playbackRate);

    if (video.src !== clip.src) {
        video.src = clip.src;
        video.muted = false;
        video.currentTime = targetTime;
        video.playbackRate = playbackRate;
        if (isPlayingTl) video.play().catch(() => { });
    } else {
        video.playbackRate = playbackRate;
        // Si el video ya está cargado pero no está reproduciendo y debería estarlo
        if (isPlayingTl && video.paused) {
            video.muted = false;
            video.play().catch(() => { });
        }
    }

    // Aplicar interpolación visual y sonora
    video.style.opacity = weight;
    const isDetached = clip.element.dataset.audioDetached === "true";
    video.volume = isDetached ? 0 : weight; // Interpolación de audio o silencio si está extraído
    video.muted = isDetached;

    const drift = Math.abs(video.currentTime - targetTime);
    if (forceSeek || drift > 0.15) {
        video.currentTime = targetTime;
    }
}

function playbackLoop() {
    if (!isPlayingTl) return;

    const now = performance.now();
    const deltaTime = now - lastTickTime;
    lastTickTime = now;

    const pixelsToMove = (deltaTime / 1000) * 25;
    currentTlPos += pixelsToMove;

    if (playhead) playhead.style.left = `${currentTlPos}px`;
    syncPreviewToTime(currentTlPos, false);

    if (timelineTracksContent && currentTlPos > timelineTracksContent.clientWidth + timelineTracksContent.scrollLeft - 100) {
        timelineTracksContent.scrollLeft += pixelsToMove;
    }

    if (currentTlPos > 3000) stopTimelinePlayback();
    else tlAnimationFrame = requestAnimationFrame(playbackLoop);
}

function startTimelinePlayback() {
    isPlayingTl = true;
    const playBtn = document.getElementById('tlPlayBtn');
    const playIcon = document.getElementById('playIcon');
    const playText = document.getElementById('playText');

    if (playBtn) {
        playBtn.style.background = 'var(--warning)';
        if (playIcon) playIcon.textContent = '⏸';
        if (playText) playText.textContent = 'PAUSE';
    }

    // Play any active audio clips
    const activeAudioClips = clipCache.filter(c => currentTlPos >= c.left && currentTlPos <= c.right && c.isAudioOnly);
    activeAudioClips.forEach(c => {
        if (c.videoElement) {
            c.videoElement.play().catch(() => {});
        }
    });

    lastTickTime = performance.now();
    tlAnimationFrame = requestAnimationFrame(playbackLoop);
}

function stopTimelinePlayback() {
    isPlayingTl = false;
    if (tlAnimationFrame) {
        cancelAnimationFrame(tlAnimationFrame);
        tlAnimationFrame = null;
    }
    const playBtn = document.getElementById('tlPlayBtn');
    const playIcon = document.getElementById('playIcon');
    const playText = document.getElementById('playText');
    const previewVideo = document.getElementById('timelinePreview');

    if (playBtn) {
        playBtn.style.background = 'var(--accent)';
        if (playIcon) playIcon.textContent = '▶';
        if (playText) playText.textContent = 'PLAY';
    }

    // PAUSE ALL PREVIEW VIDEOS
    const pA = document.getElementById('timelinePreviewA');
    const pB = document.getElementById('timelinePreviewB');
    if (pA) pA.pause();
    if (pB) pB.pause();

    // Pause all audio track clips
    if (clipCache) {
        clipCache.forEach(c => {
            if (c.isAudioOnly && c.videoElement && !c.videoElement.paused) {
                c.videoElement.pause();
            }
        });
    }
}

const tlPlayBtn = document.getElementById('tlPlayBtn');
const tlResetBtn = document.getElementById('tlResetBtn');

if (tlPlayBtn) {
    tlPlayBtn.addEventListener('click', () => {
        if (isPlayingTl) {
            stopTimelinePlayback();
        } else {
            // Asegurar que los monitores tengan sonido al dar Play (interacción del usuario)
            const pA = document.getElementById('timelinePreviewA');
            const pB = document.getElementById('timelinePreviewB');
            if (pA) { pA.muted = false; pA.volume = 1.0; }
            if (pB) { pB.muted = false; pB.volume = 1.0; }
            startTimelinePlayback();
        }
    });
}

if (tlResetBtn) {
    tlResetBtn.addEventListener('click', () => {
        stopTimelinePlayback();
        currentTlPos = 0;
        if (playhead) playhead.style.left = '0px';
        syncPreviewToTime(0, true);
        if (timelineTracksContent) timelineTracksContent.scrollLeft = 0;
        
        // Pause and reset all local clip videos (audio)
        clipCache.forEach(c => {
            if (c.videoElement) {
                c.videoElement.pause();
                c.videoElement.currentTime = 0;
            }
        });
    });
}

// Logic for Timeline Mode Toolbar
const modeTrimBtn = document.getElementById('modeTrimBtn');
const modeStretchBtn = document.getElementById('modeStretchBtn');

if (modeTrimBtn && modeStretchBtn) {
    modeTrimBtn.addEventListener('click', () => {
        currentTimelineMode = 'trim';
        modeTrimBtn.classList.add('active');
        modeStretchBtn.classList.remove('active');
        appendConsoleLine('✂️ Timeline Mode: TRIM (Normal)', 'system');
    });

    modeStretchBtn.addEventListener('click', () => {
        currentTimelineMode = 'stretch';
        modeStretchBtn.classList.add('active');
        modeTrimBtn.classList.remove('active');
        appendConsoleLine('↔️ Timeline Mode: STRETCH (Rate)', 'system');
    });
}

// Deseleccionar al hacer click en el fondo del timeline
if (timelineTracksContent) {
    timelineTracksContent.addEventListener('click', (e) => {
        if (!e.target.closest('.timeline-clip')) {
            if (selectedClipElement) {
                selectedClipElement.classList.remove('selected');
                selectedClipElement = null;
            }
        }
    });
}


// ============================================
// PREVIZ TAB LOGIC
// ============================================

const previzTab = document.getElementById('tabPreviz');
if (previzTab) {
    const subTabBtns = previzTab.querySelectorAll('.sub-tab-btn');
    const subTabContents = previzTab.querySelectorAll('.sub-tab-content');

    subTabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.dataset.sub;
            subTabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            subTabContents.forEach(content => {
                content.classList.remove('active');
                if (content.id === targetId) {
                    content.classList.add('active');
                }
            });
        });
    });

    const monitor = document.getElementById('previz-monitor');
    if (monitor) {
        monitor.addEventListener('dragover', (e) => {
            e.preventDefault();
            monitor.style.borderColor = '#6366f1';
            monitor.style.background = 'rgba(99, 102, 241, 0.1)';
        });

        monitor.addEventListener('dragleave', () => {
            monitor.style.borderColor = '#475569';
            monitor.style.background = '#000';
        });

        monitor.addEventListener('drop', (e) => {
            e.preventDefault();
            monitor.style.borderColor = '#475569';
            monitor.style.background = '#000';
            const src = e.dataTransfer.getData('videoSrc');
            if (src) {
                loadVideoToPreviz(src);
            }
        });
    }
}

function loadVideoToPreviz(src) {
    const previzVideo = document.getElementById('previzVideo');
    const previzImage = document.getElementById('previzImage');
    const previzPlaceholder = document.getElementById('previzPlaceholder');
    if (!previzVideo) return;

    if (previzImage) previzImage.classList.add('hidden');
    previzVideo.src = src;
    previzVideo.classList.remove('hidden');
    if (previzPlaceholder) previzPlaceholder.classList.add('hidden');

    // Mostrar información de metadatos detallada
    const filename = src.split('/').pop().split('?')[0];
    const metaContainer = document.getElementById('previzMetadata');

    if (metaContainer) {
        metaContainer.innerHTML = '<p style="opacity:0.5; text-align:center;">Loading metadata...</p>';
        fetch('/api/videos?t=' + Date.now())
            .then(res => res.json())
            .then(videos => {
                const videoData = videos.find(v => v.filename === filename);
                if (videoData && videoData.prompt) {
                    const tech = videoData.metadata || {};
                    const creationDate = videoData.timestamp ? new Date(videoData.timestamp).toLocaleString() : 'N/A';
                    metaContainer.innerHTML = `
                        <div style="background: rgba(30, 41, 59, 0.5); padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #6366f1;">
                            <div style="font-size: 0.7em; color: #818cf8; text-transform: uppercase; margin-bottom: 5px;">Original Prompt</div>
                            <div style="font-size: 1.1em; color: white; font-weight: 500;">${videoData.prompt}</div>
                        </div>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                            <div class="meta-item">
                                <div style="font-size: 0.7em; color: #64748b; text-transform: uppercase;">Resolution</div>
                                <div style="font-size: 1em; color: #e2e8f0; font-weight: 600;">${tech.videoWidth || '?'} x ${tech.videoHeight || '?'}</div>
                            </div>
                            <div class="meta-item">
                                <div style="font-size: 0.7em; color: #64748b; text-transform: uppercase;">Steps</div>
                                <div style="font-size: 1em; color: #e2e8f0; font-weight: 600;">${tech.samplerSteps || '?'} steps</div>
                            </div>
                            <div class="meta-item">
                                <div style="font-size: 0.7em; color: #64748b; text-transform: uppercase;">Length</div>
                                <div style="font-size: 1em; color: #e2e8f0; font-weight: 600;">${tech.videoLength || '?'} frames</div>
                            </div>
                            <div class="meta-item">
                                <div style="font-size: 0.7em; color: #64748b; text-transform: uppercase;">Created</div>
                                <div style="font-size: 0.8em; color: #e2e8f0; font-weight: 600;">${creationDate}</div>
                            </div>
                            <div class="meta-item">
                                <div style="font-size: 0.7em; color: #64748b; text-transform: uppercase;">Method</div>
                                <div style="font-size: 1em; color: #e2e8f0; font-weight: 600;">${tech.imageFilename ? 'I2V (Image to Video)' : 'T2V (Text to Video)'}</div>
                            </div>
                        </div>
                        <div style="margin-top: 20px; padding-top: 15px; border-top: 1px solid #334155; font-size: 0.8em; color: #64748b;">
                            Filename: ${filename}
                        </div>
                    `;
                } else {
                    metaContainer.innerHTML = '<p style="opacity:0.5; text-align:center; margin-top:50px;">Metadata not found for this video.</p>';
                }
            })
            .catch(err => {
                metaContainer.innerHTML = '<p style="color:#ef4444; text-align:center;">Error loading metadata.</p>';
            });
    }

    previzVideo.play();
}

// RESTORED DRAG & DROP FOR PREVIZ
const previzMonitor = document.getElementById('previz-monitor');
if (previzMonitor) {
    previzMonitor.addEventListener('dragover', (e) => {
        e.preventDefault();
        previzMonitor.classList.add('drag-over');
    });
    previzMonitor.addEventListener('dragleave', () => {
        previzMonitor.classList.remove('drag-over');
    });
    previzMonitor.addEventListener('drop', (e) => {
        e.preventDefault();
        previzMonitor.classList.remove('drag-over');
        const videoSrc = e.dataTransfer.getData('videoSrc');
        const imageSrc = e.dataTransfer.getData('imageSrc');
        
        if (videoSrc) {
            loadVideoToPreviz(videoSrc);
            appendConsoleLine(`👁️ Video loaded into Previz via Drag&Drop`, 'system');
        } else if (imageSrc) {
            loadImageToPreviz(imageSrc);
            appendConsoleLine(`👁️ Image loaded into Previz via Drag&Drop`, 'system');
        }
    });
}

function loadImageToPreviz(src) {
    const previzVideo = document.getElementById('previzVideo');
    const previzImage = document.getElementById('previzImage');
    const previzPlaceholder = document.getElementById('previzPlaceholder');
    if (!previzImage) return;

    if (previzVideo) {
        previzVideo.pause();
        previzVideo.classList.add('hidden');
    }
    previzImage.src = src;
    previzImage.classList.remove('hidden');
    if (previzPlaceholder) previzPlaceholder.classList.add('hidden');

    // Mostrar información de metadatos detallada
    const filename = src.split('/').pop().split('?')[0];
    const metaContainer = document.getElementById('previzMetadata');

    if (metaContainer) {
        metaContainer.innerHTML = '<p style="opacity:0.5; text-align:center;">Loading metadata...</p>';
        fetch('/api/images?t=' + Date.now())
            .then(res => res.json())
            .then(images => {
                const imageData = images.find(img => img.filename === filename);
                if (imageData && imageData.prompt) {
                    const creationDate = imageData.timestamp ? new Date(imageData.timestamp).toLocaleString() : 'N/A';
                    metaContainer.innerHTML = `
                        <div style="background: rgba(30, 41, 59, 0.5); padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #a855f7;">
                            <div style="font-size: 0.7em; color: #a855f7; text-transform: uppercase; margin-bottom: 5px;">Generation Prompt</div>
                            <div style="font-size: 1.1em; color: white; font-weight: 500;">${imageData.prompt}</div>
                        </div>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                            <div class="meta-item">
                                <div style="font-size: 0.7em; color: #64748b; text-transform: uppercase;">Type</div>
                                <div style="font-size: 1em; color: #e2e8f0; font-weight: 600;">Flux Image</div>
                            </div>
                            <div class="meta-item">
                                <div style="font-size: 0.7em; color: #64748b; text-transform: uppercase;">Created</div>
                                <div style="font-size: 0.8em; color: #e2e8f0; font-weight: 600;">${creationDate}</div>
                            </div>
                            <div class="meta-item">
                                <div style="font-size: 0.7em; color: #64748b; text-transform: uppercase;">Steps</div>
                                <div style="font-size: 1em; color: #e2e8f0; font-weight: 600;">${imageData.metadata?.storyboardSteps || '20'} steps</div>
                            </div>
                        </div>
                        <div style="margin-top: 20px; padding-top: 15px; border-top: 1px solid #334155; font-size: 0.8em; color: #64748b;">
                            Filename: ${filename}
                        </div>
                    `;
                } else {
                    metaContainer.innerHTML = `
                        <p style="opacity:0.5; text-align:center; margin-top:50px;">Metadata not found for this image.</p>
                        <div style="opacity:0.3; font-size:0.7em; text-align:center;">${filename}</div>
                    `;
                }
            })
            .catch(err => {
                metaContainer.innerHTML = '<p style="color:#ef4444; text-align:center;">Error loading metadata.</p>';
            });
    }
}

if (syncWithEditorBtn) {
    syncWithEditorBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const editorVideo = document.getElementById('timelinePreviewA');
        if (editorVideo && editorVideo.src) {
            loadVideoToPreviz(editorVideo.src);
            previzVideo.currentTime = editorVideo.currentTime;
        } else {
            alert("No video currently in Editor timeline.");
        }
    });
}

// ============================================
// EXPORT PIPELINE (REAL)
// ============================================

let currentExportTaskId = null;
let isExporting = false;

function getTimelineData() {
    const clips = document.querySelectorAll('.timeline-clip');
    const data = [];
    clips.forEach(clip => {
        const video = clip.querySelector('video');
        if (!video) return;

        // El timeline funciona a 25px = 1s
        const startTime = parseFloat(clip.style.left) / 25;
        const duration = clip.offsetWidth / 25;
        const track = clip.parentElement.dataset.track || 'V1';

        // Extraer nombre de archivo de la URL
        const filename = video.src.split('/').pop().split('?')[0];

        // Determinar si debemos incluir el audio de este clip específico
        // Si es un track de video y tiene un audio linkeado (no desvinculado), entonces el track de video va muteado
        // Porque el audio ya está en el track A1
        const isAudioOnly = !!(JSON.parse(clip.dataset.metadata || '{}').isAudioOnly);
        const isDetached = clip.dataset.audioDetached === "true";
        const isMuted = !isAudioOnly && !isDetached && !!clip.dataset.linkedTo;

        data.push({
            filename,
            startTime,
            duration,
            track,
            muted: isMuted,
            metadata: JSON.parse(clip.dataset.metadata || '{}')
        });
    });
    // Ordenar por tiempo de inicio
    return data.sort((a, b) => a.startTime - b.startTime);
}

const exportBtn = document.getElementById('exportProjectBtn');
if (exportBtn) {
    exportBtn.addEventListener('click', () => {
        const timelineData = getTimelineData();
        if (timelineData.length === 0) return alert("Timeline is empty!");

        startRealExport(timelineData);
    });
}

async function startRealExport(timelineData, isAutoRender = false, queueItem = null) {
    const modal = document.getElementById('exportModal');
    const progressBar = document.getElementById('exportProgressBar');
    const progressPct = document.getElementById('exportProgressPct');
    const statusText = document.getElementById('exportProgressText');
    const exportConsole = document.getElementById('exportConsole');
    const viewBtn = document.getElementById('viewFinalVideo');
    const badge = document.getElementById('exportStatusBadge');

    // Solo mostrar modal si NO es auto-render
    if (!isAutoRender) {
        modal.style.display = 'flex';
    }
    viewBtn.style.display = 'none';
    progressBar.style.width = '0%';
    progressPct.textContent = '0%';
    statusText.textContent = 'Enviando petición...';
    badge.textContent = 'PROCESAMIENTO';
    badge.style.background = 'rgba(99, 102, 241, 0.2)';

    isExporting = true;

    try {
        appendExportLog('> Solicitando exportación de ' + timelineData.length + ' clips...');

        // Get batch info from queueItem or current project
        let batchId = null;
        let batchName = null;
        if (queueItem) {
            batchId = queueItem.batchId;
            const batchProject = openProjects.find(p => p.id === queueItem.projectId);
            batchName = batchProject ? batchProject.name : null;
        }

        const response = await fetch('/api/export-timeline', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                clips: timelineData,
                batchId: batchId,
                batchName: batchName
            })
        });

        const result = await response.json();

        if (result.success) {
            appendExportLog('> Renderizado completado con éxito.');
            progressBar.style.width = '100%';
            progressPct.textContent = '100%';
            statusText.textContent = 'Listo para descargar';
            badge.textContent = 'COMPLETED';
            badge.style.background = '#10b981';

            viewBtn.style.display = 'block';
            viewBtn.onclick = () => window.open(result.url, '_blank');
            
            if (queueItem) {
                queueItem.status = 'completed';
                queueItem.resultUrl = result.url;
            } else {
                // Add export to completed queue
                globalGenerationQueue.push({
                    id: Date.now() + Math.random(),
                    prompt: `Timeline Export (${timelineData.length} clips)`,
                    status: 'completed',
                    resultUrl: result.url,
                    isExport: true,
                    type: 'export',
                    projectId: activeProjectId
                });
            }
            updateGlobalQueueUI();
            
            // Refresh video gallery to show new export
            loadExistingVideos();
            appendConsoleLine('✅ Export completed and added to gallery', 'system');
            
            if (queueItem) {
                isGeneratingGlobal = false;
                currentExecutingId = null;
                setTimeout(() => checkGlobalQueue(), 1000);
            }
        } else {
            throw new Error(result.error || 'Error desconocido');
        }
    } catch (error) {
        console.error('Export error:', error);
        appendExportLog('❌ ERROR: ' + error.message);
        statusText.textContent = 'Fallo al exportar';
        badge.textContent = 'FAILED';
        badge.style.background = '#ef4444';
        
        if (queueItem) {
            queueItem.status = 'completed';
            isGeneratingGlobal = false;
            currentExecutingId = null;
            updateGlobalQueueUI();
            setTimeout(() => checkGlobalQueue(), 1000);
        }
    } finally {
        isExporting = false;
    }
}

function appendExportLog(text) {
    const consoleEl = document.getElementById('exportConsole');
    if (!consoleEl) return;
    const div = document.createElement('div');
    div.textContent = text;
    consoleEl.appendChild(div);
    consoleEl.scrollTop = consoleEl.scrollHeight;
}

// Botón de cerrar modal
const closeExportModal = document.getElementById('closeExportModal');
const closeExportBtnTop = document.getElementById('closeExportBtnTop');
const activeExportWidget = document.getElementById('activeExportWidget');

if (closeExportModal) {
    closeExportModal.onclick = () => {
        document.getElementById('exportModal').style.display = 'none';
        if (isExporting && activeExportWidget) activeExportWidget.style.display = 'block';
    };
}
if (closeExportBtnTop) {
    closeExportBtnTop.onclick = () => {
        document.getElementById('exportModal').style.display = 'none';
        if (isExporting && activeExportWidget) activeExportWidget.style.display = 'block';
    };
}
if (activeExportWidget) {
    activeExportWidget.onclick = () => {
        document.getElementById('exportModal').style.display = 'flex';
        activeExportWidget.style.display = 'none';
    };
}

function assembleBatchInTimeline(batchItems) {
    // Tomamos el projectId del primer item del batch
    const targetProjectId = batchItems[0]?.projectId;
    // autoOverlap is the RATIO of sharing (0.0 = sequential, 1.0 = stacked)
    const overlapRatio = batchItems[0]?.autoOverlap !== undefined ? batchItems[0].autoOverlap : 0.0;
    // offsetRatio is how much we move forward (1.0 = sequential, 0.0 = stacked)
    const offsetRatio = 1.0 - overlapRatio;

    if (!targetProjectId) return;

    // 1. Calcular los clips a añadir
    let currentX = 0;
    const newClipsRaw = [];
    batchItems.forEach((item) => {
        if (item.resultUrl) {
            const filename = item.resultUrl.split('/').pop().split('?')[0];
            const vFrames = item.params?.videoLength || 121;
            const FPS = 24;
            const vDuration = vFrames / FPS;
            const vWidth = vDuration * 25;
            
            newClipsRaw.push({
                filename,
                startTime: currentX / 25,
                duration: vDuration,
                track: 'V1',
                prompt: item.prompt,
                metadata: item.params
            });
            
            // Advance by the width MINUS the overlap
            currentX += (vWidth * offsetRatio);
        }
    });

    // 2. Actualizar el proyecto en MEMORIA
    const project = openProjects.find(p => p.id === targetProjectId);
    if (project) {
        if (!project.data.timeline) project.data.timeline = [];
        
        let startFrom = 0;
        if (project.data.timeline.length > 0) {
            const last = project.data.timeline.sort((a,b) => b.startTime - a.startTime)[0];
            const lastFrames = last.metadata?.videoLength || 121;
            const FPS = 24;
            const lastDuration = lastFrames / FPS;
            // The batch starts after the last existing clip, respecting the overlap
            startFrom = last.startTime + (lastDuration * offsetRatio);
        }

        newClipsRaw.forEach(c => {
            project.data.timeline.push({
                ...c,
                startTime: c.startTime + startFrom
            });
        });
    }

    // 3. Cambiar al proyecto del batch y abrir el Editor
    if (activeProjectId !== targetProjectId) {
        // Cambiar al proyecto del batch
        switchProject(targetProjectId);
    } else {
        // Si ya es el proyecto activo, solo refrescar
        applyProjectData(project.data);
    }
    
    // 4. Abrir automáticamente la pestaña del Editor
    const editorTabBtn = document.getElementById('tabEditorBtn');
    if (editorTabBtn) {
        editorTabBtn.click();
    }

    appendConsoleLine(`🎬 Auto-assembled ${batchItems.length} clips in project ${project?.name || targetProjectId}. Editor opened.`, 'system');
}

// Initial Load
loadExistingVideos();
calculateTimelineOverlaps();

// ============================================
// STORYBOARD LOGIC
// ============================================

// ============================================
// REGEN MODAL LOGIC
// ============================================

const regenSettingsModal = document.getElementById('regenSettingsModal');
const closeRegenModal = document.getElementById('closeRegenModal');
const confirmRegenBtn = document.getElementById('confirmRegenBtn');

function openRegenModal(clip) {
    currentlyRegeneratingClipId = clip.dataset.clipId;
    const prompt = clip.dataset.prompt || '';
    const meta = JSON.parse(clip.dataset.metadata || '{}');

    // Cargar prompts separados (imagen y video)
    const imagePrompt = meta.imagePrompt || prompt;
    const videoPrompt = meta.videoPrompt || prompt;
    
    document.getElementById('regenImagePrompt').value = imagePrompt;
    document.getElementById('regenVideoPrompt').value = videoPrompt;

    // Configurar checkboxes de regeneración
    const keepImageCheck = document.getElementById('regenKeepImage');
    const regenBothCheck = document.getElementById('regenBoth');

    if (keepImageCheck && regenBothCheck) {
        const hasImage = !!meta.imageFilename;
        
        // Si tiene imagen, por defecto mantenerla
        keepImageCheck.checked = hasImage;
        regenBothCheck.checked = false;
        
        // Deshabilitar opciones si no hay imagen
        keepImageCheck.disabled = !hasImage;
        regenBothCheck.disabled = !hasImage;

        // Listener para que sean mutuamente excluyentes
        if (!keepImageCheck.dataset.hasListener) {
            keepImageCheck.addEventListener('change', () => {
                if (keepImageCheck.checked) {
                    regenBothCheck.checked = false;
                }
            });
            keepImageCheck.dataset.hasListener = 'true';
        }
        
        if (!regenBothCheck.dataset.hasListener) {
            regenBothCheck.addEventListener('change', () => {
                if (regenBothCheck.checked) {
                    keepImageCheck.checked = false;
                }
            });
            regenBothCheck.dataset.hasListener = 'true';
        }
    }

    // Sliders
    const sliders = [
        { id: 'regenWidth', valId: 'regenWidthVal', key: 'videoWidth', def: 1280 },
        { id: 'regenHeight', valId: 'regenHeightVal', key: 'videoHeight', def: 720 },
        { id: 'regenSteps', valId: 'regenStepsVal', key: 'samplerSteps', def: 20 },
        { id: 'regenCfg', valId: 'regenCfgVal', key: 'cfgScale', def: 4.0 }
    ];

    sliders.forEach(s => {
        const el = document.getElementById(s.id);
        const valEl = document.getElementById(s.valId);
        const val = meta[s.key] || s.def;
        el.value = val;
        valEl.textContent = val;

        // Ensure inputs update labels
        if (!el.dataset.hasListener) {
            el.addEventListener('input', () => valEl.textContent = el.value);
            el.dataset.hasListener = 'true';
        }
    });

    regenSettingsModal.style.display = 'flex';
}

if (closeRegenModal) {
    closeRegenModal.onclick = () => {
        regenSettingsModal.style.display = 'none';
        currentlyRegeneratingClipId = null;
    };
}

if (confirmRegenBtn) {
    confirmRegenBtn.onclick = () => {
        if (!currentlyRegeneratingClipId) return;

        const clipQuery = `.timeline-clip[data-clip-id="${currentlyRegeneratingClipId}"]`;
        const clip = document.querySelector(clipQuery);
        if (!clip) return;

        const imagePrompt = document.getElementById('regenImagePrompt').value.trim();
        const videoPrompt = document.getElementById('regenVideoPrompt').value.trim();
        
        if (!videoPrompt) return alert('Video prompt cannot be empty');

        const metadata = JSON.parse(clip.dataset.metadata || '{}');
        const newParams = {
            ...metadata,
            videoWidth: parseInt(document.getElementById('regenWidth').value),
            videoHeight: parseInt(document.getElementById('regenHeight').value),
            samplerSteps: parseInt(document.getElementById('regenSteps').value),
            cfgScale: parseFloat(document.getElementById('regenCfg').value),
            videoLength: metadata.videoLength || 121,
            seed: -1,
            imagePrompt: imagePrompt,
            videoPrompt: videoPrompt
        };

        const keepImage = document.getElementById('regenKeepImage')?.checked;
        const regenBoth = document.getElementById('regenBoth')?.checked;
        const hasImage = !!metadata.imageFilename;

        appendConsoleLine(`♻️ Launching regeneration for clip ${currentlyRegeneratingClipId.substring(0, 8)}...`, 'system');

        // Cierra el modal
        regenSettingsModal.style.display = 'none';

        // Redirigir a STAGE para ver progreso
        const tabOutputBtn = document.getElementById('tabOutputBtn');
        if (tabOutputBtn) tabOutputBtn.click();

        if (hasImage && keepImage) {
            // Mantener imagen existente, regenerar solo video
            appendConsoleLine(`🖼️ Keeping existing image, regenerating video only`, 'system');
            addToQueue(videoPrompt, metadata.imageFilename, {
                status: 'pending',
                replaceClipId: currentlyRegeneratingClipId,
                params: newParams
            });
        } else if (hasImage && regenBoth) {
            // Regenerar ambos: imagen y video
            appendConsoleLine(`🔄 Regenerating both image and video`, 'system');
            if (!imagePrompt) return alert('Image prompt cannot be empty when regenerating both');
            addToStoryboardQueue(imagePrompt, {
                autoVideo: true,
                videoPrompt: videoPrompt,
                replaceClipId: currentlyRegeneratingClipId,
                params: { ...newParams, storyboardSteps: parseInt(document.getElementById('storyboardSteps').value) }
            });
        } else if (!hasImage) {
            // No tiene imagen, generar T2V directo
            appendConsoleLine(`🎬 Generating T2V (no reference image)`, 'system');
            addToQueue(videoPrompt, null, {
                status: 'pending',
                replaceClipId: currentlyRegeneratingClipId,
                params: newParams
            });
        } else {
            // Caso por defecto: mantener imagen si existe
            addToQueue(videoPrompt, metadata.imageFilename || null, {
                status: 'pending',
                replaceClipId: currentlyRegeneratingClipId,
                params: newParams
            });
        }

        updateGlobalQueueUI();
        checkGlobalQueue();

        currentlyRegeneratingClipId = null;
    };
}

function addToStoryboardQueue(prompt, options = {}) {

    // Get params: prefer passed options.params, fallback to sidebar sliders
    const customParams = options.params || {};
    const params = {
        videoWidth: customParams.videoWidth || parseInt(document.getElementById('videoWidth')?.value) || 1024,
        videoHeight: customParams.videoHeight || parseInt(document.getElementById('videoHeight')?.value) || 1024,
        storyboardSteps: customParams.storyboardSteps || parseInt(document.getElementById('storyboardSteps')?.value) || 25,
        ...(customParams.seed !== undefined ? { seed: customParams.seed } : {})
    };

    globalGenerationQueue.push({
        id: Date.now() + Math.random(),
        prompt: prompt,
        params,
        type: 'storyboard',
        status: 'pending',
        projectId: activeProjectId,
        ...options,
        params  // Ensure params comes from this function, not options spread
    });

    updateGlobalQueueUI();
    checkGlobalQueue();
}

function handleStoryboardGenerated(message) {
    // 1. Encontrar el proyecto de origen para esta generación
    const queueItem = globalGenerationQueue.find(qi => (qi.id === currentExecutingId) || (message.prompt_id && qi.prompt_id === message.prompt_id));
    const targetProjectId = queueItem ? queueItem.projectId : activeProjectId;
    const project = openProjects.find(p => p.id === targetProjectId);

    if (!project) {
        // No project? Still add to the fallback storyboardItems so the data isn't lost
        const existingIdx = storyboardItems.findIndex(item => 
            item.storyboardIndex === message.storyboardIndex && item.batchId === message.batchId
        );
        const newItem = {
            id: existingIdx >= 0 ? storyboardItems[existingIdx].id : ('sb_' + Date.now() + Math.random()),
            url: message.url,
            filename: message.filename,
            prompt: message.prompt,
            videoPrompt: queueItem ? (queueItem.videoPrompt || '') : '',
            storyboardIndex: message.storyboardIndex !== undefined ? message.storyboardIndex : storyboardItems.length,
            batchId: message.batchId || 'default',
            status: 'ready',
            params: message.params || {}
        };
        if (existingIdx >= 0) {
            storyboardItems[existingIdx] = { ...storyboardItems[existingIdx], ...newItem };
        } else {
            storyboardItems.push(newItem);
        }
        storyboardItems.sort((a, b) => a.storyboardIndex - b.storyboardIndex);
        updateStoryboardUI();
        return;
    }
    if (!project.data.storyboard) project.data.storyboard = [];
    
    const projStoryboard = project.data.storyboard;
    const existing = projStoryboard.find(item => item.storyboardIndex === message.storyboardIndex && item.batchId === message.batchId);

    const newItemData = {
        id: existing ? existing.id : ('sb_' + Date.now() + Math.random()),
        url: message.url,
        filename: message.filename,
        prompt: message.prompt,
        videoPrompt: queueItem ? (queueItem.videoPrompt || '') : (existing ? (existing.videoPrompt || '') : ''),
        storyboardIndex: message.storyboardIndex !== undefined ? message.storyboardIndex : projStoryboard.length,
        batchId: message.batchId || 'default',
        status: 'ready',
        params: message.params || {}
    };

    if (existing) {
        Object.assign(existing, newItemData);
    } else {
        projStoryboard.push(newItemData);
    }

    // 2. Si este es el proyecto activo, sincronizamos y refrescamos
    if (targetProjectId === activeProjectId) {
        storyboardItems = [...projStoryboard];
        storyboardItems.sort((a, b) => a.storyboardIndex - b.storyboardIndex);
        updateStoryboardUI();
    }
    
    appendConsoleLine(`💾 Storyboard item updated in project ${project.name}`, 'debug');
}

function updateStoryboardUI() {
    const grid = document.getElementById('storyboardGrid');
    const placeholder = document.getElementById('storyboardPlaceholder');
    if (!grid) return;

    if (storyboardItems.length > 0) {
        if (placeholder) placeholder.classList.add('hidden');
        grid.innerHTML = '';

        storyboardItems.forEach((item, index) => {
            const div = document.createElement('div');
            div.className = 'storyboard-card';

            div.innerHTML = `
                <div class="storyboard-media-box">
                    <img src="${item.url}?t=${Date.now()}" loading="lazy">
                    <div class="storyboard-index-badge">${index + 1}</div>
                </div>
                <div class="storyboard-info-box">
                    <div class="storyboard-prompt">${item.prompt}</div>
                    <div class="storyboard-meta-row">
                        <span class="sb-meta-tag">Flux</span>
                        <span class="sb-meta-tag">${item.params?.storyboardSteps || '20'} Steps</span>
                    </div>
                    <div class="storyboard-actions">
                        <button class="sb-action-btn sb-btn-view" title="View in Previz">👁️</button>
                        <button class="sb-action-btn sb-btn-regen" title="Regenerate Image">↻</button>
                        <button class="sb-action-btn sb-btn-video" title="Generate Video">🎬 VIDEO</button>
                        <button class="sb-action-btn sb-btn-remove" title="Remove">×</button>
                    </div>
                </div>
            `;

            div.querySelector('.sb-btn-view').onclick = (e) => {
                e.stopPropagation();
                loadImageToPreviz(item.url);
                document.getElementById('tabPrevizBtn').click();
            };

            div.querySelector('.sb-btn-regen').onclick = (e) => {
                e.stopPropagation();
                // Usamos la misma función de storyboard queue con los parámetros originales para que REEMPLACE al terminar
                appendConsoleLine(`♻️ Regenerating storyboard image #${index + 1}...`, 'system');
                addToStoryboardQueue(item.prompt, { 
                    storyboardIndex: item.storyboardIndex, 
                    batchId: item.batchId,
                    videoPrompt: item.videoPrompt 
                });
                document.getElementById('tabOutputBtn').click();
            };

            div.querySelector('.sb-btn-video').onclick = (e) => {
                e.stopPropagation();
                const isAutoAssemble = document.getElementById('autoAssembleCheck')?.checked;
                addToQueue(item.videoPrompt || item.prompt, item.filename, { isAutoAssemble });
                document.getElementById('tabOutputBtn').click();
                appendConsoleLine(`🚀 Storyboard image #${index + 1} sent to Video pipeline`, 'system');
            };

            div.querySelector('.sb-btn-remove').onclick = (e) => {
                e.stopPropagation();
                storyboardItems = storyboardItems.filter(i => i.id !== item.id);
                updateStoryboardUI();
            };

            grid.appendChild(div);
        });
    } else {
        if (placeholder) {
            grid.innerHTML = '';
            grid.appendChild(placeholder);
            placeholder.classList.remove('hidden');
        }
    }
}

// Event Listeners for Storyboard Buttons
document.getElementById('clearStoryboardBtn')?.addEventListener('click', () => {
    storyboardItems = [];
    updateStoryboardUI();
    appendConsoleLine('🗑️ Storyboard cleared.', 'system');
});

document.getElementById('generateVidsFromStoryboardBtn')?.addEventListener('click', () => {
    if (storyboardItems.length === 0) return alert('No storyboard images to generate from');

    if (confirm(`Generate ${storyboardItems.length} videos from these images?`)) {
        appendConsoleLine(`🚀 Transitioning storyboard to video pipeline (${storyboardItems.length} items)`, 'system');

        const isAutoAssemble = document.getElementById('autoAssembleCheck')?.checked;
        const batchId = 'batch_vid_' + Date.now();

        storyboardItems.forEach((item, index) => {
            // Usamos la imagen del storyboard como base para I2V, y el videoPrompt si existe
            addToQueue(item.videoPrompt || item.prompt, item.filename, { isAutoAssemble, batchId });
        });

        // Ir a Stage para ver progreso
        const tabOutputBtn = document.getElementById('tabOutputBtn');
        if (tabOutputBtn) tabOutputBtn.click();
    }
});

// STORYBOARD IMAGE UPLOAD
document.getElementById('uploadStoryboardImageBtn')?.addEventListener('click', () => {
    document.getElementById('storyboardImageInput')?.click();
});

document.getElementById('storyboardImageInput')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const prompt = window.prompt('Enter a video prompt for this image (optional):') || 'Camera movement';
    
    try {
        const formData = new FormData();
        formData.append('image', file);
        const response = await fetch('/api/upload-image', { method: 'POST', body: formData });
        const result = await response.json();
        
        if (result.success) {
            const newItem = {
                id: 'sb_upload_' + Date.now(),
                url: `/uploads/${result.filename}`,
                filename: result.filename,
                prompt: file.name,
                videoPrompt: prompt,
                storyboardIndex: storyboardItems.length,
                batchId: 'manual_upload',
                status: 'ready',
                params: {}
            };
            
            storyboardItems.push(newItem);
            updateStoryboardUI();
            appendConsoleLine(`📤 Image uploaded to storyboard: ${result.filename}`, 'system');
        }
    } catch (error) {
        appendConsoleLine(`❌ Error uploading image: ${error.message}`, 'error');
    }
    
    e.target.value = '';
});

// UPDATE COMPLETED HISTORY
function updateCompletedHistory(completedItems) {
    const completedList = document.getElementById('completedList');
    const completedCount = document.getElementById('completedCount');
    
    if (!completedList || !completedCount) return;
    
    completedCount.textContent = completedItems.length;
    completedList.innerHTML = '';
    
    if (completedItems.length === 0) {
        completedList.innerHTML = '<div style="padding: 20px; text-align: center; color: #64748b; font-size: 0.9em;">No completed generations yet</div>';
        return;
    }
    
    // Show most recent first
    const sortedItems = [...completedItems].reverse();
    
    sortedItems.forEach((item, idx) => {
        const div = document.createElement('div');
        div.style.cssText = `
            padding: 12px; 
            background: rgba(16, 185, 129, 0.1); 
            border-left: 4px solid #10b981; 
            border-radius: 8px; 
            font-size: 0.85em; 
            color: #e2e8f0;
            margin-bottom: 8px;
            transition: all 0.2s ease;
            display: flex;
            gap: 12px;
            align-items: center;
        `;
        
        let modeLabel = item.imageFilename ? 'I2V' : 'T2V';
        if (item.type === 'storyboard') modeLabel = 'T2I';
        if (item.isExport) modeLabel = 'EXPORT';
        
        // Show batch info if available - get batch name from project
        let batchInfo = '';
        if (item.batchId) {
            const batchProject = openProjects.find(p => p.id === item.projectId);
            const batchName = batchProject ? batchProject.name : item.batchId.substring(0, 12) + '...';
            batchInfo = `<span style="margin: 0 5px; opacity: 0.3;">|</span> Batch: <span style="color: #10b981;" data-batch-id="${item.batchId}">${batchName}</span>`;
        }
        const timestamp = new Date().toLocaleTimeString();
        
        div.innerHTML = `
            <div style="flex: 1;">
                <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 6px;">
                    <div style="font-weight: 700; color: #10b981; font-size: 0.7em; text-transform: uppercase; letter-spacing: 1px;">
                        ${modeLabel} ${batchInfo}
                    </div>
                    <div style="font-size: 0.65em; color: #64748b;">${timestamp}</div>
                </div>
                <div style="font-size: 0.85em; line-height: 1.4; color: #cbd5e1; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">
                    ${item.prompt || 'Final Export'}
                </div>
            </div>
            ${(item.resultUrl || item.type === 'storyboard') ? `<button class="view-completed-btn" title="View in Previz" style="background: rgba(129, 140, 248, 0.2); border: 1px solid #818cf8; color: #818cf8; padding: 4px 8px; border-radius: 6px; cursor: pointer; font-size: 0.9em; transition: all 0.2s;">👁️</button>` : ''}
        `;
        
        if (item.resultUrl || item.type === 'storyboard') {
            const viewBtn = div.querySelector('.view-completed-btn');
            viewBtn?.addEventListener('click', () => {
                if (item.type === 'storyboard') {
                    loadImageToPreviz(item.resultUrl);
                } else {
                    loadVideoToPreviz(item.resultUrl);
                }
                document.getElementById('tabPrevizBtn')?.click();
                appendConsoleLine(`👁️ Viewing completed ${modeLabel} in Previz`, 'system');
            });
        }
        
        completedList.appendChild(div);
    });
}

// CLEAR HISTORY BUTTON
document.getElementById('clearHistoryBtn')?.addEventListener('click', () => {
    if (confirm('Clear completed history?')) {
        globalGenerationQueue = globalGenerationQueue.filter(i => i.status !== 'completed');
        updateGlobalQueueUI();
        saveQueueState();
        appendConsoleLine('🗑️ Completed history cleared.', 'system');
    }
});

// STOP QUEUE BUTTON
document.getElementById('stopQueueBtn')?.addEventListener('click', () => {
    if (confirm('⚠️ Stop all pending generations? This will clear the queue.')) {
        // Clear all pending items
        globalGenerationQueue = globalGenerationQueue.filter(i => i.status === 'completed');
        isGeneratingGlobal = false;
        currentExecutingId = null;
        
        updateGlobalQueueUI();
        saveQueueState();
        appendConsoleLine('⏹ Queue stopped. All pending items cleared.', 'system');
        
        if (progressText) {
            progressText.textContent = '⏹ Queue stopped by user';
            if (progressFill) progressFill.style.width = '0%';
            if (document.getElementById('progressPct')) document.getElementById('progressPct').textContent = '0%';
        }
    }
});

// ============================================
// NEW WORKFLOW-BASED CREATE INTERFACE
// ============================================

// Track uploaded images per workflow
const wfUploadedImages = {};

// Bind workflow card clicks to switch panels
document.addEventListener('click', (e) => {
    const card = e.target.closest('.wf-card');
    if (!card) return;
    
    const workflow = card.dataset.workflow;
    if (!workflow) return;
    
    // Update cards
    document.querySelectorAll('.wf-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    
    // Update panels
    document.querySelectorAll('.wf-panel').forEach(p => p.classList.remove('active'));
    const panel = document.querySelector(`.wf-panel[data-panel="${workflow}"]`);
    if (panel) panel.classList.add('active');
    
    // Sync old workflow select for compatibility
    const oldSelect = document.getElementById('workflowSelect');
    if (oldSelect) {
        oldSelect.value = workflow;
        updateWorkflowInfo();
    }
});

// Bind slider values
document.addEventListener('input', (e) => {
    const slider = e.target.closest('.wf-param-slider');
    if (!slider) return;
    const valEl = slider.parentElement.querySelector('.wf-val');
    if (valEl) {
        const val = parseFloat(slider.value);
        valEl.textContent = slider.step && slider.step.includes('.') ? val.toFixed(1) : val;
    }
});

// ============================================
// FLUX IMAGE (T2I) HANDLERS
// ============================================
function setupT2IUpload() {
    const area = document.getElementById('t2iUploadArea');
    const input = document.getElementById('t2iImageInput');
    if (!area || !input) return;
    
    area.addEventListener('click', () => {
        if (!area.classList.contains('has-image')) input.click();
    });
    area.addEventListener('dragover', (e) => { e.preventDefault(); area.classList.add('dragover'); });
    area.addEventListener('dragleave', () => area.classList.remove('dragover'));
    area.addEventListener('drop', (e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length > 0) handleWfUpload(e.dataTransfer.files[0], 't2i', area);
    });
    input.addEventListener('change', (e) => {
        if (e.target.files.length > 0) handleWfUpload(e.target.files[0], 't2i', area);
    });
}

function handleWfUpload(file, wf, area) {
    const formData = new FormData();
    formData.append('image', file);
    
    fetch('/api/upload-image', { method: 'POST', body: formData })
        .then(r => r.json())
        .then(result => {
            if (result.success) {
                wfUploadedImages[wf] = result.filename;
                area.classList.add('has-image');
                const reader = new FileReader();
                reader.onload = (e) => {
                    area.innerHTML = `
                        <div style="position: relative; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;">
                            <img src="${e.target.result}" style="max-width: 100%; max-height: 100px; object-fit: contain; border-radius: 6px;">
                            <button class="wf-remove-img" style="position: absolute; top: 5px; right: 5px; background: rgba(239,68,68,0.8); color: white; border: none; border-radius: 50%; width: 24px; height: 24px; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center;">×</button>
                        </div>`;
                    area.querySelector('.wf-remove-img').addEventListener('click', (e) => {
                        e.stopPropagation();
                        removeWfImage(wf, area);
                    });
                };
                reader.readAsDataURL(file);
                appendConsoleLine(`✅ ${wf.toUpperCase()} image uploaded: ${result.filename}`, 'system');
            }
        })
        .catch(err => appendConsoleLine(`❌ Upload error: ${err.message}`, 'error'));
}

function removeWfImage(wf, area) {
    wfUploadedImages[wf] = null;
    area.classList.remove('has-image');
    area.innerHTML = `<div class="wf-upload-placeholder">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="width: 32px; height: 32px; opacity: 0.3;"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
        <p>Drop image (optional)</p>
    </div>`;
}

function setupI2VUpload() {
    const area = document.getElementById('i2vUploadArea');
    const input = document.getElementById('i2vImageInput');
    if (!area || !input) return;
    
    area.addEventListener('click', () => {
        if (!area.classList.contains('has-image')) input.click();
    });
    area.addEventListener('dragover', (e) => { e.preventDefault(); area.classList.add('dragover'); });
    area.addEventListener('dragleave', () => area.classList.remove('dragover'));
    area.addEventListener('drop', (e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length > 0) handleWfUpload(e.dataTransfer.files[0], 'i2v', area);
    });
    input.addEventListener('change', (e) => {
        if (e.target.files.length > 0) handleWfUpload(e.target.files[0], 'i2v', area);
    });
}

// ============================================
// GENERATE HANDLERS PER WORKFLOW
// ============================================
function getSeed(prefix) {
    const randomCheck = document.getElementById(`${prefix}RandomSeed`);
    const seedInput = document.getElementById(`${prefix}Seed`);
    if (randomCheck && randomCheck.checked) return -1;
    if (seedInput) return parseInt(seedInput.value) || -1;
    return -1;
}

function getSliderVal(bindId) {
    const slider = document.querySelector(`.wf-param-slider[data-bind="${bindId}"]`);
    if (!slider) return null;
    const val = parseFloat(slider.value);
    // Determine if it should be float
    if (slider.step && slider.step.includes('.')) return val;
    return val;
}

// Generate T2I (FLUX IMAGE)
function generateT2I() {
    const prompt = document.getElementById('t2iPrompt')?.value.trim();
    if (!prompt) { appendConsoleLine('⚠️ Please enter an image prompt', 'warning'); return; }
    
    // Use addToStoryboardQueue
    addToStoryboardQueue(prompt, {
        model: 'flux',
        params: {
            videoWidth: getSliderVal('t2iWidth') || 1024,
            videoHeight: getSliderVal('t2iHeight') || 1024,
            storyboardSteps: getSliderVal('t2iSteps') || 25,
            seed: getSeed('t2i')
        }
    });
    
    appendConsoleLine(`🖼️ T2I queued: ${prompt.substring(0, 50)}...`, 'system');
    document.getElementById('tabOutputBtn')?.click();
}

// Generate T2V (DIRECT VIDEO)
function generateT2V() {
    const prompt = document.getElementById('t2vPrompt')?.value.trim();
    if (!prompt) { appendConsoleLine('⚠️ Please enter a video prompt', 'warning'); return; }
    
    addToQueue(prompt, null, {
        model: 'ltx2',
        params: {
            videoWidth: getSliderVal('t2vWidth') || 1280,
            videoHeight: getSliderVal('t2vHeight') || 720,
            videoLength: getSliderVal('t2vFrames') || 121,
            samplerSteps: getSliderVal('t2vSteps') || 20,
            cfgScale: getSliderVal('t2vCFG') || 4.0,
            seed: getSeed('t2v')
        }
    });
    
    appendConsoleLine(`🎬 T2V queued: ${prompt.substring(0, 50)}...`, 'system');
    document.getElementById('tabOutputBtn')?.click();
}

// Generate T2I→I2V
function generateT2I2V() {
    const imgPrompt = document.getElementById('t2i2vImagePrompt')?.value.trim();
    const vidPrompt = document.getElementById('t2i2vVideoPrompt')?.value.trim();
    
    if (!imgPrompt && !vidPrompt) { appendConsoleLine('⚠️ Please enter at least one prompt', 'warning'); return; }
    
    const isAutoAssemble = document.getElementById('t2i2vAutoAssemble')?.checked || false;
    const isAutoRender = document.getElementById('t2i2vAutoRender')?.checked || false;
    const batchId = 'batch_' + Date.now();
    const storyboardId = 'sb_' + Date.now();
    
    // Add T2I (storyboard) item
    globalGenerationQueue.push({
        id: storyboardId,
        prompt: imgPrompt || vidPrompt,
        type: 'storyboard',
        params: {
            videoWidth: getSliderVal('t2i2vWidth') || 1280,
            videoHeight: getSliderVal('t2i2vHeight') || 720,
            storyboardSteps: getSliderVal('t2i2vFluxSteps') || 25,
            seed: getSeed('t2i2v')
        },
        status: 'pending',
        projectId: activeProjectId,
        batchId,
        autoVideo: true,
        videoPrompt: vidPrompt || imgPrompt,
        isAutoAssemble,
        isAutoRender
    });
    
    // Add I2V item waiting for image
    globalGenerationQueue.push({
        id: Date.now() + Math.random(),
        prompt: vidPrompt || imgPrompt,
        params: {
            videoWidth: getSliderVal('t2i2vWidth') || 1280,
            videoHeight: getSliderVal('t2i2vHeight') || 720,
            videoLength: getSliderVal('t2i2vFrames') || 121,
            samplerSteps: getSliderVal('t2i2vSteps') || 20,
            cfgScale: getSliderVal('t2i2vCFG') || 4.0,
            refStrength: getSliderVal('t2i2vRef') || 1.0,
            seed: getSeed('t2i2v')
        },
        imageFilename: null,
        status: 'waiting',
        waitingForStoryboardId: storyboardId,
        projectId: activeProjectId,
        isAutoAssemble,
        isAutoRender,
        batchId
    });
    
    appendConsoleLine(`🔄 T2I→I2V queued: ${(imgPrompt || vidPrompt).substring(0, 40)}...`, 'system');
    updateGlobalQueueUI();
    checkGlobalQueue();
    document.getElementById('tabOutputBtn')?.click();
}

// Generate I2V (Manual Image)
function generateI2V() {
    const prompt = document.getElementById('i2vPrompt')?.value.trim();
    const image = wfUploadedImages['i2v'];
    
    if (!image) { appendConsoleLine('⚠️ Please upload a reference image first', 'warning'); return; }
    if (!prompt) { appendConsoleLine('⚠️ Please enter a video prompt', 'warning'); return; }
    
    addToQueue(prompt, image, {
        params: {
            videoWidth: getSliderVal('i2vWidth') || 1280,
            videoHeight: getSliderVal('i2vHeight') || 720,
            videoLength: getSliderVal('i2vFrames') || 121,
            samplerSteps: getSliderVal('i2vSteps') || 20,
            cfgScale: getSliderVal('i2vCFG') || 4.0,
            refStrength: getSliderVal('i2vRef') || 1.0,
            seed: getSeed('i2v')
        },
        model: 'ltx2'
    });
    
    appendConsoleLine(`📸 I2V queued with image: ${prompt.substring(0, 50)}...`, 'system');
    document.getElementById('tabOutputBtn')?.click();
}

// ============================================
// CHAIN VIDEO STEPS
// ============================================
function addChainStep(startPrompt = '', endPrompt = '') {
    const container = document.getElementById('chainSequence');
    if (!container) return;
    
    const count = container.querySelectorAll('.chain-step-item').length + 1;
    const div = document.createElement('div');
    div.className = 'chain-step-item';
    div.innerHTML = `
        <div class="chain-step-header">
            <div style="display: flex; align-items: center; gap: 8px;">
                <div class="chain-step-number">${count}</div>
                <span style="font-size: 0.7em; color: #a855f7; font-weight: 700;">WAN2.2 CHAIN</span>
            </div>
            <button class="chain-remove-step" style="background: rgba(239,68,68,0.1); color: #ef4444; border: none; border-radius: 6px; width: 24px; height: 24px; cursor: pointer;">×</button>
        </div>
        <div class="chain-step-content">
            <div class="chain-prompt-row">
                <div style="flex: 1;">
                    <label style="font-size: 0.6em; color: #818cf8; font-weight: 700; text-transform: uppercase; display: block; margin-bottom: 4px;">🟢 START IMAGE PROMPT</label>
                    <textarea class="chain-start-prompt" placeholder="Describe the starting frame...">${startPrompt}</textarea>
                </div>
                <div style="flex: 1;">
                    <label style="font-size: 0.6em; color: #a855f7; font-weight: 700; text-transform: uppercase; display: block; margin-bottom: 4px;">🔴 END IMAGE PROMPT</label>
                    <textarea class="chain-end-prompt" placeholder="Describe the ending frame...">${endPrompt}</textarea>
                </div>
            </div>
        </div>
    `;
    
    div.querySelector('.chain-remove-step').addEventListener('click', () => {
        div.remove();
        container.querySelectorAll('.chain-step-item').forEach((item, idx) => {
            item.querySelector('.chain-step-number').textContent = idx + 1;
        });
    });
    
    container.appendChild(div);
}

function generateChainVideo() {
    const steps = document.querySelectorAll('.chain-step-item');
    if (steps.length === 0) { appendConsoleLine('⚠️ Please add at least one chain step', 'warning'); return; }
    
    const batchId = 'chain_' + Date.now();
    let previousWanEndImageId = null;
    let addedCount = 0;
    
    steps.forEach((item, index) => {
        const startPrompt = item.querySelector('.chain-start-prompt')?.value.trim();
        const endPrompt = item.querySelector('.chain-end-prompt')?.value.trim();
        
        if (!startPrompt && !endPrompt) return;
        
        const isFirstStep = index === 0 || !previousWanEndImageId;
        const endImageId = 'wan_end_' + Date.now() + '_' + index;
        const startImageId = isFirstStep ? 'wan_start_' + Date.now() + '_' + index : null;
        
        // Generate start image if first step
        if (isFirstStep) {
            globalGenerationQueue.push({
                id: startImageId,
                prompt: startPrompt,
                type: 'flux_for_wan',
                params: {},
                status: 'pending',
                projectId: activeProjectId,
                batchId,
                isForWan: true,
                wanRole: 'start',
                wanStepIndex: index,
                isChainStart: true
            });
        }
        
        // Always generate end image
        globalGenerationQueue.push({
            id: endImageId,
            prompt: endPrompt || startPrompt,
            type: 'flux_for_wan',
            params: {},
            status: 'pending',
            projectId: activeProjectId,
            batchId,
            isForWan: true,
            wanRole: 'end',
            wanStepIndex: index,
            isChainEnd: true
        });
        
        // Add WAN2.2 video generation
        globalGenerationQueue.push({
            id: Date.now() + Math.random() + index,
            prompt: endPrompt || startPrompt,
            params: {
                videoWidth: getSliderVal('chainWidth') || 1280,
                videoHeight: getSliderVal('chainHeight') || 720,
                videoLength: getSliderVal('chainFrames') || 121,
                samplerSteps: getSliderVal('chainSteps') || 20,
                cfgScale: getSliderVal('chainCFG') || 4.0,
                seed: getSeed('chain')
            },
            model: 'wan2.2',
            useFluxImages: true,
            startImageId: isFirstStep ? startImageId : null,
            endImageId: endImageId,
            prevEndImageId: previousWanEndImageId,
            wanStepIndex: index,
            isChainContinued: !isFirstStep,
            status: 'waiting',
            projectId: activeProjectId,
            isAutoAssemble: false,
            isAutoRender: false,
            batchId
        });
        
        previousWanEndImageId = endImageId;
        addedCount++;
    });
    
    if (addedCount === 0) { appendConsoleLine('⚠️ No valid prompts in chain steps', 'warning'); return; }
    
    appendConsoleLine(`🔗 CHAINVIDEO queued: ${addedCount} steps`, 'system');
    updateGlobalQueueUI();
    checkGlobalQueue();
    document.getElementById('tabOutputBtn')?.click();
}

// Chain magic prompt (uses Ollama)
function setupChainMagic() {
    const magicBtn = document.getElementById('chainMagicBtn');
    const promptArea = document.getElementById('chainPromptArea');
    const enhancerBtn = document.getElementById('chainEnhanceBtn');
    const modelSelect = document.getElementById('chainOllamaModel');
    const batchPrompt = document.getElementById('chainBatchPrompt');
    
    if (magicBtn && promptArea) {
        magicBtn.addEventListener('click', () => {
            promptArea.classList.toggle('hidden');
            if (!promptArea.classList.contains('hidden')) loadChainModels();
        });
    }
    
    if (enhancerBtn && modelSelect && batchPrompt) {
        enhancerBtn.addEventListener('click', async () => {
            const text = batchPrompt.value.trim();
            const modelName = modelSelect.value;
            
            if (!modelName) { appendConsoleLine('⚠️ Please select an Ollama model', 'warning'); return; }
            if (!text) { appendConsoleLine('⚠️ Please describe your video sequence idea', 'warning'); return; }
            
            enhancerBtn.disabled = true;
            enhancerBtn.textContent = '⏳ Generating...';
            
            try {
                const response = await fetch('/api/enhance-prompt', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text, modelName })
                });
                const data = await response.json();
                if (data.error) throw new Error(data.error);
                
                if (data.steps && Array.isArray(data.steps)) {
                    // Clear existing chain steps
                    const container = document.getElementById('chainSequence');
                    if (container) container.innerHTML = '';
                    
                    data.steps.forEach(step => {
                        const imgP = step['PROMPT IMAGE'] || step.promptImage || step.prompt || '';
                        const vidP = step['VIDEO IMAGE'] || step.videoImage || step.video || '';
                        addChainStep(imgP, vidP);
                    });
                    appendConsoleLine(`✨ Generated ${data.steps.length} chain steps from idea`, 'system');
                }
            } catch (err) {
                appendConsoleLine(`❌ Magic prompt error: ${err.message}`, 'error');
            } finally {
                enhancerBtn.disabled = false;
                enhancerBtn.textContent = '✨ GENERATE CHAIN FROM IDEA';
            }
        });
    }
}

async function loadChainModels() {
    const select = document.getElementById('chainOllamaModel');
    if (!select) return;
    try {
        const response = await fetch('/api/list-ollama-models');
        const data = await response.json();
        const models = data.models || [];
        select.innerHTML = '<option value="" disabled selected>-- Select a model --</option>';
        if (models.length === 0) {
            select.innerHTML = '<option value="">No models found</option>';
        } else {
            models.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.name;
                opt.textContent = m.name;
                select.appendChild(opt);
            });
        }
    } catch (e) {
        select.innerHTML = '<option value="">Ollama not available</option>';
    }
}

// Chain JSON import
function setupChainJsonImport() {
    const importBtn = document.getElementById('chainImportJsonBtn');
    const jsonArea = document.getElementById('chainJsonImport');
    const confirmBtn = document.getElementById('chainConfirmJson');
    const cancelBtn = document.getElementById('chainCancelJson');
    const jsonInput = document.getElementById('chainJsonInput');
    
    if (importBtn && jsonArea) {
        importBtn.addEventListener('click', () => jsonArea.classList.remove('hidden'));
    }
    if (cancelBtn && jsonArea) {
        cancelBtn.addEventListener('click', () => {
            jsonArea.classList.add('hidden');
            if (jsonInput) jsonInput.value = '';
        });
    }
    if (confirmBtn && jsonInput) {
        confirmBtn.addEventListener('click', () => {
            try {
                const data = JSON.parse(jsonInput.value);
                if (!data.steps || !Array.isArray(data.steps)) throw new Error("Invalid format");
                
                const container = document.getElementById('chainSequence');
                if (container) container.innerHTML = '';
                
                data.steps.forEach(step => {
                    const imgP = step['PROMPT IMAGE'] || step.promptImage || step.prompt || '';
                    const vidP = step['VIDEO IMAGE'] || step.videoImage || step.video || '';
                    addChainStep(imgP, vidP);
                });
                appendConsoleLine(`✅ Imported ${data.steps.length} chain steps from JSON`, 'system');
                jsonArea.classList.add('hidden');
                jsonInput.value = '';
            } catch (e) {
                appendConsoleLine(`❌ JSON import error: ${e.message}`, 'error');
            }
        });
    }
}

// ============================================
// WORKFLOW PRESETS (Save/Load per-workflow)
// ============================================

// Define what params to capture for each workflow
const WORKFLOW_PRESET_CONFIG = {
    t2i: {
        fields: {
            prompt: { selector: '#t2iPrompt', type: 'textarea' },
            width: { bind: 't2iWidth', type: 'slider' },
            height: { bind: 't2iHeight', type: 'slider' },
            steps: { bind: 't2iSteps', type: 'slider' },
            seed: { prefix: 't2i', type: 'seed' }
        }
    },
    t2v: {
        fields: {
            prompt: { selector: '#t2vPrompt', type: 'textarea' },
            width: { bind: 't2vWidth', type: 'slider' },
            height: { bind: 't2vHeight', type: 'slider' },
            frames: { bind: 't2vFrames', type: 'slider' },
            steps: { bind: 't2vSteps', type: 'slider' },
            cfg: { bind: 't2vCFG', type: 'slider' },
            seed: { prefix: 't2v', type: 'seed' }
        }
    },
    t2i2v: {
        fields: {
            imagePrompt: { selector: '#t2i2vImagePrompt', type: 'textarea' },
            videoPrompt: { selector: '#t2i2vVideoPrompt', type: 'textarea' },
            width: { bind: 't2i2vWidth', type: 'slider' },
            height: { bind: 't2i2vHeight', type: 'slider' },
            frames: { bind: 't2i2vFrames', type: 'slider' },
            fluxSteps: { bind: 't2i2vFluxSteps', type: 'slider' },
            steps: { bind: 't2i2vSteps', type: 'slider' },
            cfg: { bind: 't2i2vCFG', type: 'slider' },
            ref: { bind: 't2i2vRef', type: 'slider' },
            seed: { prefix: 't2i2v', type: 'seed' },
            autoAssemble: { selector: '#t2i2vAutoAssemble', type: 'checkbox' },
            autoRender: { selector: '#t2i2vAutoRender', type: 'checkbox' }
        }
    },
    i2v: {
        fields: {
            prompt: { selector: '#i2vPrompt', type: 'textarea' },
            width: { bind: 'i2vWidth', type: 'slider' },
            height: { bind: 'i2vHeight', type: 'slider' },
            frames: { bind: 'i2vFrames', type: 'slider' },
            steps: { bind: 'i2vSteps', type: 'slider' },
            cfg: { bind: 'i2vCFG', type: 'slider' },
            ref: { bind: 'i2vRef', type: 'slider' },
            seed: { prefix: 'i2v', type: 'seed' }
        }
    },
    chainvideo: {
        fields: {
            width: { bind: 'chainWidth', type: 'slider' },
            height: { bind: 'chainHeight', type: 'slider' },
            frames: { bind: 'chainFrames', type: 'slider' },
            steps: { bind: 'chainSteps', type: 'slider' },
            cfg: { bind: 'chainCFG', type: 'slider' },
            seed: { prefix: 'chain', type: 'seed' }
        }
    }
};

// Collect current values from a workflow's UI into a preset data object
function collectWorkflowPresetData(workflow) {
    const config = WORKFLOW_PRESET_CONFIG[workflow];
    if (!config) return {};

    const data = {};
    for (const [key, field] of Object.entries(config.fields)) {
        switch (field.type) {
            case 'textarea': {
                const el = document.querySelector(field.selector);
                if (el) data[key] = el.value;
                break;
            }
            case 'slider': {
                const val = getSliderVal(field.bind);
                data[key] = val !== null ? val : '';
                break;
            }
            case 'checkbox': {
                const el = document.querySelector(field.selector);
                if (el) data[key] = el.checked;
                break;
            }
            case 'seed': {
                const randomCheck = document.getElementById(`${field.prefix}RandomSeed`);
                const seedInput = document.getElementById(`${field.prefix}Seed`);
                data.seedRandom = randomCheck ? randomCheck.checked : true;
                data.seedValue = seedInput ? parseInt(seedInput.value) || 0 : 0;
                break;
            }
        }
    }

    // For chainvideo, also capture chain steps
    if (workflow === 'chainvideo') {
        const steps = [];
        document.querySelectorAll('.chain-step-item').forEach(item => {
            const start = item.querySelector('.chain-start-prompt')?.value || '';
            const end = item.querySelector('.chain-end-prompt')?.value || '';
            steps.push({ startPrompt: start, endPrompt: end });
        });
        data.chainSteps = steps;
    }

    return data;
}

// Apply preset data to a workflow's UI
function applyWorkflowPresetData(workflow, data) {
    const config = WORKFLOW_PRESET_CONFIG[workflow];
    if (!config || !data) return;

    for (const [key, field] of Object.entries(config.fields)) {
        if (data[key] === undefined && key !== 'seedValue' && key !== 'seedRandom') continue;
        switch (field.type) {
            case 'textarea': {
                const el = document.querySelector(field.selector);
                if (el && data[key] !== undefined) el.value = data[key];
                break;
            }
            case 'slider': {
                const slider = document.querySelector(`.wf-param-slider[data-bind="${field.bind}"]`);
                if (slider && data[key] !== undefined) {
                    slider.value = data[key];
                    // Update the display label
                    const valEl = slider.parentElement.querySelector('.wf-val');
                    if (valEl) {
                        const val = parseFloat(slider.value);
                        valEl.textContent = slider.step && slider.step.includes('.') ? val.toFixed(1) : val;
                    }
                    // Dispatch input event for any listeners
                    slider.dispatchEvent(new Event('input', { bubbles: true }));
                }
                break;
            }
            case 'checkbox': {
                const el = document.querySelector(field.selector);
                if (el && data[key] !== undefined) el.checked = data[key];
                break;
            }
            case 'seed': {
                if (data.seedRandom !== undefined) {
                    const randomCheck = document.getElementById(`${field.prefix}RandomSeed`);
                    if (randomCheck) randomCheck.checked = data.seedRandom;
                }
                if (data.seedValue !== undefined) {
                    const seedInput = document.getElementById(`${field.prefix}Seed`);
                    if (seedInput) seedInput.value = data.seedValue;
                }
                break;
            }
        }
    }

    // For chainvideo, restore chain steps
    if (workflow === 'chainvideo' && data.chainSteps && Array.isArray(data.chainSteps)) {
        // Clear existing steps
        const container = document.getElementById('chainSequence');
        if (container) {
            container.innerHTML = '';
            // Re-add steps from preset
            data.chainSteps.forEach(step => {
                addChainStep(step.startPrompt || '', step.endPrompt || '');
            });
        }
    }
}

// Prompt user for a preset name
function promptPresetName() {
    return new Promise((resolve) => {
        const name = prompt('Enter a name for this preset:', '');
        resolve(name ? name.trim() : null);
    });
}

// Save a preset for a workflow
async function saveWorkflowPreset(workflow) {
    const name = await promptPresetName();
    if (!name) return;

    const data = collectWorkflowPresetData(workflow);
    if (Object.keys(data).length === 0) {
        appendConsoleLine(`⚠️ No data to save for workflow: ${workflow}`, 'warning');
        return;
    }

    try {
        const res = await fetch(`/api/presets/${workflow}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, label: name, data })
        });
        const result = await res.json();
        if (result.success) {
            appendConsoleLine(`💾 Preset saved: ${workflow}/${name}`, 'system');
            loadPresetsIntoDropdown(workflow);
        } else {
            appendConsoleLine(`❌ Failed to save preset: ${result.error}`, 'error');
        }
    } catch (err) {
        appendConsoleLine(`❌ Error saving preset: ${err.message}`, 'error');
    }
}

// Delete a preset
async function deleteWorkflowPreset(workflow, name) {
    if (!name) return;
    if (!confirm(`Delete preset "${name}"?`)) return;

    try {
        const res = await fetch(`/api/presets/${workflow}/${encodeURIComponent(name)}`, { method: 'DELETE' });
        const result = await res.json();
        if (result.success) {
            appendConsoleLine(`🗑️ Preset deleted: ${workflow}/${name}`, 'system');
            loadPresetsIntoDropdown(workflow);
        } else {
            appendConsoleLine(`❌ Failed to delete preset: ${result.error}`, 'error');
        }
    } catch (err) {
        appendConsoleLine(`❌ Error deleting preset: ${err.message}`, 'error');
    }
}

// Load presets from server and populate dropdown
async function loadPresetsIntoDropdown(workflow) {
    const bar = document.querySelector(`.wf-preset-bar[data-workflow="${workflow}"]`);
    if (!bar) return;
    const select = bar.querySelector('.wf-preset-select');
    if (!select) return;

    try {
        const res = await fetch(`/api/presets/${workflow}`);
        const presets = await res.json();

        // Remember current selection
        const currentVal = select.value;

        // Rebuild options
        select.innerHTML = '<option value="">-- Presets --</option>';
        presets.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = p.label || p.name;
            select.appendChild(opt);
        });

        // Restore selection
        if (currentVal && presets.some(p => p.name === currentVal)) {
            select.value = currentVal;
        }

        // Show/hide delete button
        const deleteBtn = bar.querySelector('.wf-preset-delete-btn');
        if (deleteBtn) {
            deleteBtn.style.display = presets.length > 0 ? '' : 'none';
        }
    } catch (err) {
        console.warn(`Failed to load presets for ${workflow}:`, err);
    }
}

// Load a preset and apply it to the workflow UI
async function loadWorkflowPreset(workflow, presetName) {
    if (!presetName) return;

    try {
        const res = await fetch(`/api/presets/${workflow}`);
        const presets = await res.json();
        const preset = presets.find(p => p.name === presetName);
        if (!preset || !preset.data) {
            appendConsoleLine(`⚠️ Preset not found: ${presetName}`, 'warning');
            return;
        }

        applyWorkflowPresetData(workflow, preset.data);
        appendConsoleLine(`📂 Preset loaded: ${workflow}/${presetName}`, 'system');
    } catch (err) {
        appendConsoleLine(`❌ Error loading preset: ${err.message}`, 'error');
    }
}

// Setup preset event handlers for all workflow bars
function setupPresetHandlers() {
    document.querySelectorAll('.wf-preset-bar').forEach(bar => {
        const workflow = bar.dataset.workflow;
        if (!workflow) return;

        const select = bar.querySelector('.wf-preset-select');
        const saveBtn = bar.querySelector('.wf-preset-save-btn');
        const deleteBtn = bar.querySelector('.wf-preset-delete-btn');

        if (select) {
            select.addEventListener('change', () => {
                loadWorkflowPreset(workflow, select.value);
            });
        }

        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                saveWorkflowPreset(workflow);
            });
        }

        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => {
                deleteWorkflowPreset(workflow, select ? select.value : '');
            });
        }

        // Initial load
        loadPresetsIntoDropdown(workflow);
    });
}

// ============================================
// MODIFIED INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 Studio initialized. Loading assets...');
    
    // Initialize workflow selector (NEW card-based)
    const firstCard = document.querySelector('.wf-card.active');
    if (firstCard) {
        const firstPanel = document.querySelector(`.wf-panel[data-panel="${firstCard.dataset.workflow}"]`);
        if (firstPanel) firstPanel.classList.add('active');
    }
    
    // Setup per-workflow handlers
    setupT2IUpload();
    setupI2VUpload();
    setupChainMagic();
    setupChainJsonImport();
    
    // Setup preset save/load handlers
    setupPresetHandlers();
    
    // Generate button handlers
    document.querySelectorAll('.wf-gen-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const wf = btn.dataset.workflow;
            switch(wf) {
                case 't2i': generateT2I(); break;
                case 't2v': generateT2V(); break;
                case 't2i2v': generateT2I2V(); break;
                case 'i2v': generateI2V(); break;
                case 'chainvideo': generateChainVideo(); break;
            }
        });
    });
    
    // Chain add step button
    document.getElementById('chainAddStepBtn')?.addEventListener('click', () => addChainStep());
    
    // Restore generation queue from localStorage
    const hasRestoredQueue = loadQueueState();
    if (hasRestoredQueue) {
        updateGlobalQueueUI();
        const pendingCount = globalGenerationQueue.filter(i => i.status === 'pending').length;
        if (pendingCount > 0) {
            appendConsoleLine(`🚀 Restarting generation engine with ${pendingCount} pending items...`, 'system');
            setTimeout(() => checkGlobalQueue(), 2000);
        }
        const waitingCount = globalGenerationQueue.filter(i => i.status === 'waiting').length;
        if (waitingCount > 0) {
            appendConsoleLine(`⏸️ ${waitingCount} items waiting for images`, 'system');
        }
    }
    
    loadExistingVideos();
    loadExistingImages();
    loadExistingAudio();
    loadProjectsList();
    
    // Start WebSocket connection
    connectWebSocket();
});
