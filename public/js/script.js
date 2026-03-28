const imageContainer = document.getElementById('imageContainer');
const videoContainer = document.getElementById('videoContainer');
const progressContainer = document.getElementById('progressContainer');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const placeholder = document.getElementById('placeholder');

const ws = new WebSocket(`ws://${window.location.hostname}:${window.location.port}`);

// Variables de cola de generación global
let globalGenerationQueue = [];
let isGeneratingGlobal = false;
let currentExecutingId = null;

// Variables para modo de blending
let isBlendMode = false;
let selectedVideos = [];
let videoElements = new Map();

// Variables para image upload
let uploadedImageFilename = null;

// Variables para Storyboard
let storyboardItems = [];

// ============================================
// WEBSOCKET HANDLING
// ============================================

ws.onopen = () => {
    console.log('WebSocket connection established');
    appendConsoleLine('[SYSTEM] WebSocket connected. Engine ready.', 'system');
};

ws.onmessage = (event) => {
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
                    const modeLabel = item.imageFilename ? 'I2V' : (item.type === 'storyboard' ? 'FLUX' : 'T2V');
                    const stepInfo = message.value && message.max ? ` • Step ${message.value}/${message.max}` : '';
                    progressText.textContent = `⚡ [${modeLabel}] ${item.type === 'storyboard' ? 'Drawing' : 'Animating'}: ${item.prompt.substring(0, 40)}...${stepInfo}`;
                }
            }
        }

        if (message.type === 'executing' && message.node) {
             if (currentExecutingId && progressText) {
                const item = globalGenerationQueue.find(i => i.id === currentExecutingId);
                if (item) {
                    item.prompt_id = message.prompt_id; // Link client ID with ComfyUI prompt_id
                    const modeLabel = item.imageFilename ? 'I2V' : (item.type === 'storyboard' ? 'FLUX' : 'T2V');
                    progressText.textContent = `⚡ [${modeLabel}] Executing node ${message.node}: ${item.prompt.substring(0, 40)}...`;
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
                    
                    if (autoBatch.length > 0 && batchItems.every(i => i.status === 'completed')) {
                        // All items in the batch are finished! Assemble them.
                        assembleBatchInTimeline(autoBatch);
                        
                        // AUTO-RENDER LOGIC
                        const isAutoRender = batchItems.some(i => i.isAutoRender);
                        if (isAutoRender) {
                            appendConsoleLine(`🎬 Auto-render triggered for batch: ${item.batchId}`, 'system');
                            setTimeout(() => {
                                const timelineData = getTimelineData();
                                if (timelineData.length > 0) startRealExport(timelineData);
                            }, 1000);
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
            if (currentExecutingId || message.prompt_id) {
                const itemIndex = globalGenerationQueue.findIndex(i => 
                    i.status !== 'completed' && 
                    (i.id === currentExecutingId || (message.prompt_id && i.prompt_id === message.prompt_id))
                );

                if (itemIndex !== -1) {
                    const item = globalGenerationQueue[itemIndex];
                    item.status = 'completed';
                    
                    // AUTO-VIDEO PIPELINE: If this storyboard item was flagged for auto-video
                    if (item.autoVideo) {
                        // Use message.prompt to be absolutely sure we use the correct prompt returned by the server
                        const generationPrompt = message.prompt || item.prompt;
                        appendConsoleLine(`🎬 Auto-transitioning to Video for: ${generationPrompt.substring(0, 30)}...`, 'system');
                        addToQueue(generationPrompt, message.filename, { 
                            isAutoAssemble: item.isAutoAssemble, 
                            isAutoRender: item.isAutoRender,
                            batchId: item.batchId || ('batch_v_' + Date.now())
                        });
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
    } catch (e) {
        console.error('Error procesando mensaje WebSocket:', e);
    }
};

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
    { id: 'refStrength', valueId: 'refStrengthValue' }
];

sliders.forEach(slider => {
    const el = document.getElementById(slider.id);
    const valEl = document.getElementById(slider.valueId);
    if (el && valEl) {
        el.addEventListener('input', () => {
            valEl.textContent = el.value;
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

    const activeItems = globalGenerationQueue.filter(i => i.status !== 'completed');
    if (activeItems.length > 0 || isGeneratingGlobal) {
        queueContainer.style.display = 'block';
    } else {
        queueContainer.style.display = 'none';
        if (progressText) {
            progressText.textContent = '✨ Nothing to generate, all done';
            if (progressFill) progressFill.style.width = '100%';
            if (document.getElementById('progressPct')) document.getElementById('progressPct').textContent = '100%';
        }
    }

    if (queueCount) queueCount.textContent = activeItems.length;
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
        if (item.type === 'storyboard') modeLabel = 'STORYBOARD (T2I)';

        const progressIndicator = item.status === 'generating' ? 
            '<span style="color: #f59e0b; animation: pulse 1s infinite;">⚡ PROCESSING</span>' : 
            '<span style="color: #94a3b8;">⏳ QUEUED</span>';

        div.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: start;">
                <div style="font-weight: 700; color: #818cf8; font-size: 0.7em; text-transform: uppercase; letter-spacing: 1px;">
                    Item #${idx + 1} <span style="margin: 0 5px; opacity: 0.3;">|</span> ${modeLabel}
                </div>
                <div style="font-size: 0.7em; font-weight: 800;">${progressIndicator}</div>
            </div>
            <div style="font-size: 0.9em; line-height: 1.5; color: #f1f5f9; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">
                ${item.prompt}
            </div>
        `;
        queueList.appendChild(div);
    });
}

function checkGlobalQueue() {
    if (isGeneratingGlobal) return;
    const nextItem = globalGenerationQueue.find(item => item.status === 'pending');
    if (!nextItem) return;

    nextItem.status = 'generating';
    currentExecutingId = nextItem.id;
    isGeneratingGlobal = true;
    updateGlobalQueueUI();

    const message = {
        type: nextItem.type === 'storyboard' ? 'generarStoryboard' : 'generarImagen',
        prompt: nextItem.prompt,
        params: nextItem.params,
        imageFilename: nextItem.imageFilename,
        storyboardIndex: nextItem.storyboardIndex,
        batchId: nextItem.batchId
    };
    ws.send(JSON.stringify(message));
    appendConsoleLine(`>> Launching ${nextItem.type || 'generation'}: ${nextItem.prompt.substring(0, 30)}...`, 'system');
}

// Botón de Lanzamiento (Stage)
const generateBtn = document.getElementById('generateButton');
if (generateBtn) {
    generateBtn.addEventListener('click', () => {
        const promptText = document.getElementById('promptStage').value.trim();
        if (!promptText) return alert('Please enter a prompt');

        const negPrompt = document.getElementById('negativePromptStage').value.trim();
        addToQueue(promptText, null, { negativePrompt: negPrompt });
        document.getElementById('promptStage').value = ''; 
        document.getElementById('negativePromptStage').value = '';
    });
}

const generateSequencerBtn = document.querySelector('.generate-from-prompts');
const promptModeSelect = document.getElementById('promptModeSelect');
const simplePromptContainer = document.getElementById('simplePromptContainer');
const advancedMode = document.getElementById('advancedMode');

if (promptModeSelect) {
    promptModeSelect.addEventListener('change', () => {
        if (promptModeSelect.value === 'single') {
            simplePromptContainer.style.display = 'block';
            advancedMode.style.display = 'none';
        } else {
            simplePromptContainer.style.display = 'none';
            advancedMode.style.display = 'block';
        }
    });
}

if (generateSequencerBtn) {
    generateSequencerBtn.addEventListener('click', () => {
        handleSequencerGenerate('video');
    });
}

const generateStoryboardBtn = document.getElementById('generateStoryboardFromSequencer');
if (generateStoryboardBtn) {
    generateStoryboardBtn.addEventListener('click', () => {
        handleSequencerGenerate('storyboard');
    });
}

const generateFullAutoBtn = document.getElementById('generateFullAutoBtn');
if (generateFullAutoBtn) {
    generateFullAutoBtn.addEventListener('click', () => {
        handleSequencerGenerate('full-auto');
    });
}

function handleSequencerGenerate(type) {
    const mode = promptModeSelect ? promptModeSelect.value : 'single';
    console.log(`Generating ${type} in mode:`, mode);
    
    if (mode === 'single') {
        const promptVal = document.getElementById('prompt').value.trim();
        if (promptVal) {
            if (type === 'storyboard') addToStoryboardQueue(promptVal);
            else if (type === 'full-auto') addToStoryboardQueue(promptVal, { autoVideo: true });
            else addToQueue(promptVal);
        }
        else alert("Please enter a prompt");
    } else {
        const promptGeneral = document.getElementById('promptGeneral').value.trim();
        const negativePromptGeneral = document.getElementById('negativePromptGeneral').value.trim();
        const sequencePrompts = document.querySelectorAll('.sequence-prompt-textarea');
        let addedCount = 0;

        const isAutoAssemble = document.getElementById('autoAssembleCheck')?.checked;
        const isAutoRender = document.getElementById('autoRenderCheck')?.checked;
        const batchId = 'batch_' + Date.now();

        sequencePrompts.forEach((el, index) => {
            const val = el.value.trim();
            if (val) {
                const finalPrompt = promptGeneral ? `${val}, ${promptGeneral}` : val;
                const finalNegative = negativePromptGeneral; 
                
                if (type === 'storyboard') {
                    addToStoryboardQueue(finalPrompt, { batchId, storyboardIndex: index, negativePrompt: finalNegative });
                } else if (type === 'full-auto') {
                    // Full Auto: Image then Video
                    addToStoryboardQueue(finalPrompt, { 
                        batchId, 
                        storyboardIndex: index, 
                        autoVideo: true, 
                        isAutoAssemble,
                        isAutoRender,
                        negativePrompt: finalNegative
                    });
                } else {
                    addToQueue(finalPrompt, null, { isAutoAssemble, isAutoRender, batchId, negativePrompt: finalNegative });
                }
                addedCount++;
            }
        });
        if (addedCount === 0) alert("Please enter at least one sequence step");
        else {
            if (type === 'storyboard') appendConsoleLine(`🎨 Added ${addedCount} prompts to Storyboard queue`, 'system');
            else if (type === 'full-auto') appendConsoleLine(`⚡ FULL AUTO: Added ${addedCount} prompts for T2I + I2V pipeline${isAutoRender ? ' (with Auto-render)' : ''}`, 'system');
            else if (isAutoAssemble) appendConsoleLine(`📦 Added batch for auto-assembly (${addedCount} clips)${isAutoRender ? ' (with Auto-render)' : ''}`, 'system');
        }
    }
    
    // Redirigir a la pestaña correspondiente
    if (type === 'storyboard') document.getElementById('tabStoryboardBtn').click();
    else document.getElementById('tabOutputBtn').click();
}

document.getElementById('addPromptButton')?.addEventListener('click', () => {
    addPromptStep();
});

function addPromptStep(val = '') {
    const container = document.getElementById('promptSequence');
    if (!container) return;
    
    const count = container.querySelectorAll('.prompt-item').length + 1;
    const div = document.createElement('div');
    div.className = 'prompt-item';
    div.innerHTML = `
        <div class="prompt-header">
            <div class="prompt-header-left">
                <div class="prompt-number">${count}</div>
                <span class="prompt-status-text">PROMPT ${count}</span>
            </div>
            <button class="remove-prompt-btn">×</button>
        </div>
        <textarea class="sequence-prompt-textarea" placeholder="Step description...">${val}</textarea>
    `;
    
    div.querySelector('.remove-prompt-btn').addEventListener('click', () => {
        div.remove();
        // Update numbers
        container.querySelectorAll('.prompt-item').forEach((item, idx) => {
            item.querySelector('.prompt-number').textContent = idx + 1;
            item.querySelector('.prompt-status-text').textContent = `PROMPT ${idx + 1}`;
        });
    });
    
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
        const example = {
            global: "cinematic style, 4k, highly detailed, masterwork",
            steps: [
                "a futuristic city at night",
                "a forest with glowing plants",
                "a space station orbiting a blue planet"
            ]
        };
        const jsonStr = JSON.stringify(example, null, 2);
        
        // Copiar al portapapeles
        navigator.clipboard.writeText(jsonStr).then(() => {
            appendConsoleLine('📋 JSON Example copied to clipboard!', 'system');
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
            alert('Example JSON:\n\n' + jsonStr);
        });
    });
}

if (importJsonBtn) {
    importJsonBtn.addEventListener('click', () => {
        const area = document.getElementById('jsonImportArea');
        if (area) area.style.display = 'block';
    });
}

const confirmJsonImport = document.getElementById('confirmJsonImport');
const cancelJsonImport = document.getElementById('cancelJsonImport');

if (cancelJsonImport) {
    cancelJsonImport.addEventListener('click', () => {
        const area = document.getElementById('jsonImportArea');
        if (area) area.style.display = 'none';
    });
}

if (confirmJsonImport) {
    confirmJsonImport.addEventListener('click', () => {
        const input = document.getElementById('jsonInputText').value.trim();
        if (!input) return;

        try {
            const data = JSON.parse(input);
            if (!data.steps || !Array.isArray(data.steps)) {
                throw new Error("Invalid format: 'steps' array is missing.");
            }

            // Limpiar pasos actuales
            const container = document.getElementById('promptSequence');
            if (container) container.innerHTML = '';

            // Cargar Global Prompt
            const promptGeneral = document.getElementById('promptGeneral');
            if (promptGeneral && data.global) {
                promptGeneral.value = data.global;
            }

            // Cargar pasos
            data.steps.forEach(stepText => {
                addPromptStep(stepText);
            });

            appendConsoleLine(`✅ Imported JSON: ${data.steps.length} prompts added.`, 'system');
            
            // Cerrar el area
            document.getElementById('jsonImportArea').style.display = 'none';
            document.getElementById('jsonInputText').value = '';
        } catch (e) {
            console.error('JSON Import Error:', e);
            alert("Error importing JSON: " + e.message);
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
        negativePrompt: document.getElementById('tabOutput').classList.contains('active') ? 
            document.getElementById('negativePromptStage').value.trim() : 
            (options.negativePrompt || '')
    };

    globalGenerationQueue.push({
        id: Date.now() + Math.random(),
        prompt: prompt,
        params,
        imageFilename: forcedImage !== null ? forcedImage : uploadedImageFilename,
        status: 'pending',
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

            
            const techInfo = video.metadata || { videoWidth: 1280, videoHeight: 720, samplerSteps: 20, videoLength: 121 };
            const promptStr = video.prompt || '';
            const dateStr = new Date(video.timestamp).toLocaleString();

            galleryItem.innerHTML = `
                <div style="position: relative; width: 100%; height: 160px; overflow: hidden; border-radius: 8px; background: #000; box-shadow: 0 4px 10px rgba(0,0,0,0.3);">
                    <video src="${video.url}?t=${Date.now()}" style="width: 100%; height: 100%; object-fit: cover;" controls preload="metadata"></video>
                    <button class="previz-btn" title="View in Previz" style="position: absolute; top: 10px; right: 10px; background: #6366f1; border-radius: 50%; width: 32px; height: 32px; min-width: 32px; display: flex; align-items: center; justify-content: center; border: none; cursor: pointer; color: white; padding: 0; flex-shrink: 0;">👁️</button>
                    <div style="position: absolute; top: 8px; left: 8px; background: rgba(15, 23, 42, 0.7); padding: 2px 6px; border-radius: 4px; font-size: 8px; color: #94a3b8; pointer-events: none;">${dateStr}</div>
                    <div style="position: absolute; bottom: 8px; left: 8px; background: rgba(15, 23, 42, 0.85); padding: 3px 8px; border-radius: 6px; font-size: 10px; color: #a5b4fc; font-weight: 600; border: 1px solid rgba(99, 102, 241, 0.3);">${techInfo.videoWidth}x${techInfo.videoHeight} • ${techInfo.samplerSteps} steps</div>
                </div>
                <div style="padding: 4px;">
                    <div style="font-size: 11px; color: #6366f1; font-weight: 800; text-transform: uppercase; margin-bottom: 4px; letter-spacing: 0.5px;">Prompt</div>
                    <div style="font-size: 10px; color: #e2e8f0; line-height: 1.4; max-height: 4.2em; overflow-y: auto; background: rgba(15, 23, 42, 0.4); padding: 6px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.05);">
                        ${promptStr || '<span style="opacity: 0.5; font-style: italic;">No prompt recorded</span>'}
                    </div>
                </div>
            `;

            galleryItem.draggable = true;
            galleryItem.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('videoSrc', video.url);
                e.dataTransfer.setData('videoPrompt', promptStr);
                e.dataTransfer.setData('videoMetadata', JSON.stringify(techInfo));
                galleryItem.style.opacity = '0.5';
            });
            galleryItem.addEventListener('dragend', () => galleryItem.style.opacity = '1');

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

            gallery.appendChild(galleryItem);
        });
    } catch (e) { console.error(e); }
}

// Asset Tab Switching
document.querySelectorAll('.asset-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const type = btn.dataset.type;
        document.querySelectorAll('.asset-tab-btn').forEach(b => {
            b.classList.remove('active');
            b.style.background = 'transparent';
            b.style.color = '#94a3b8';
        });
        btn.classList.add('active');
        btn.style.background = '#6366f1';
        btn.style.color = 'white';

        if (type === 'videos') {
            document.getElementById('videoGallery').style.display = 'grid';
            document.getElementById('imageGallery').style.display = 'none';
        } else {
            document.getElementById('videoGallery').style.display = 'none';
            document.getElementById('imageGallery').style.display = 'grid';
            loadExistingImages();
        }
    });
});

// ============================================
// TIMELINE & EDITOR (OPTIMIZED)
// ============================================

let isPlayingTl = false;
let tlAnimationFrame = null; // Cambio de Interval a AnimationFrame para fluidez
let currentTlPos = 0;
let clipCache = []; // Cache para evitar leer el DOM cada frame

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
}

// Función para refrescar la cache de clips (se llama cuando cambian)
function refreshClipCache() {
    const clips = document.querySelectorAll('.timeline-clip');
    clipCache = Array.from(clips).map(clip => {
        const l = parseFloat(clip.style.left) || 0;
        const w = clip.offsetWidth;
        const track = clip.parentElement.dataset.track || 'V1';
        const video = clip.querySelector('video');
        return {
            element: clip,
            left: l,
            width: w,
            right: l + w,
            track: track,
            src: video ? video.src : null,
            videoElement: video
        };
    }).sort((a, b) => b.track.localeCompare(a.track)); // Ordenar por track descending (V3 encima de V1)
}

function addClipToTimeline(src, trackElement, xPos, prompt = '', metadata = {}) {
    const emptyMsg = document.querySelector('.timeline-empty-msg');
    if (emptyMsg) emptyMsg.remove();
    const clip = document.createElement('div');
    clip.className = 'timeline-clip';
    clip.dataset.clipId = 'clip_' + Date.now() + Math.random();
    clip.dataset.prompt = prompt;
    clip.dataset.metadata = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);

    const filename = src.split('/').pop().split('?')[0];
    const rect = trackElement.getBoundingClientRect();
    clip.style.left = `${xPos - rect.left}px`;
    clip.style.width = '150px';
    clip.innerHTML = `
        <div class="trim-handle trim-handle-left"></div>
        <video src="${src}" muted preload="metadata" style="width: 100%; height: 100%; object-fit: cover;"></video>
        <div class="clip-info" style="position: absolute; bottom: 2px; left: 4px; pointer-events: none; text-shadow: 0 0 4px #000;"><span>${filename}</span></div>
        <div class="trim-handle trim-handle-right"></div>
        <button class="regen-clip-btn" title="Regenerate this clip">↻</button>
        <button class="remove-clip-btn" style="width: 20px; height: 20px; padding: 0;">×</button>
    `;
    setupClipInteractions(clip);
    
    clip.querySelector('.remove-clip-btn').addEventListener('click', () => { 
        clip.remove(); 
        refreshClipCache(); 
        checkTimelineEmpty(); 
    });

    clip.querySelector('.regen-clip-btn').addEventListener('click', () => {
        const p = clip.dataset.prompt;
        const m = JSON.parse(clip.dataset.metadata || '{}');
        if (!p) return appendConsoleLine('❌ No prompt available for regeneration', 'error');
        
        appendConsoleLine(`♻️ Regenerating clip: ${p.substring(0, 30)}...`, 'system');
        addToQueue(p, m.imageFilename || null, { replaceClipId: clip.dataset.clipId });
    });

    trackElement.appendChild(clip);
    calculateTimelineOverlaps();
    refreshClipCache();
}

function setupClipInteractions(clip) {
    let isDragging = false, isTrimmingLeft = false, isTrimmingRight = false;
    let startX, startLeft, startWidth;

    clip.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('remove-clip-btn')) return;
        startX = e.clientX;
        startLeft = parseFloat(clip.style.left) || 0;
        startWidth = clip.offsetWidth;
        if (e.target.classList.contains('trim-handle-left')) isTrimmingLeft = true;
        else if (e.target.classList.contains('trim-handle-right')) isTrimmingRight = true;
        else isDragging = true;
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        e.preventDefault();
    });

    function handleMouseMove(e) {
        const deltaX = e.clientX - startX;
        if (isDragging) {
            let nL = startLeft + deltaX;
            clip.style.left = `${nL < 0 ? 0 : nL}px`;
            const tracks = document.querySelectorAll('.timeline-track');
            tracks.forEach(track => {
                const r = track.getBoundingClientRect();
                if (e.clientY >= r.top && e.clientY <= r.bottom) track.appendChild(clip);
            });
        } else if (isTrimmingLeft) {
            let nL = startLeft + deltaX, nW = startWidth - deltaX;
            if (nW > 20 && nL >= 0) { clip.style.left = `${nL}px`; clip.style.width = `${nW}px`; }
        } else if (isTrimmingRight) {
            let nW = startWidth + deltaX;
            if (nW > 20) clip.style.width = `${nW}px`;
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

// Atajo de Barra Espaciadora para Play/Pause
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space') {
        e.preventDefault(); 
        const playBtn = document.getElementById('tlPlayBtn');
        if (playBtn) playBtn.click();
    }
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
    const activeClips = clipCache.filter(c => xPos >= c.left && xPos <= c.right);

    if (activeClips.length === 0) {
        if (previewA) previewA.pause();
        if (previewB) previewB.pause();
        if (edPlaceholder) edPlaceholder.style.display = 'block';
        return;
    }

    if (edPlaceholder) edPlaceholder.style.display = 'none';
    if (previewA) previewA.style.display = 'block';

    // Lógica de Interpolación (Crossfade)
    if (activeClips.length >= 2) {
        // Tenemos al menos 2 videos solapados
        const v1 = activeClips[0];
        const v2 = activeClips[1];

        // Determinar rango de solapamiento
        const overlapStart = Math.max(v1.left, v2.left);
        const overlapEnd = Math.min(v1.right, v2.right);
        const overlapDuration = overlapEnd - overlapStart;

        // Calcular factor de mezcla (0 a 1)
        let t = 0;
        if (overlapDuration > 0) {
            t = (xPos - overlapStart) / overlapDuration;
        }

        // Configurar Video A (Base / Saliente)
        updateVideoPreview(previewA, v1, xPos, 1 - t, forceSeek);
        
        // Configurar Video B (Entrante)
        if (previewB) {
            previewB.style.display = 'block';
            updateVideoPreview(previewB, v2, xPos, t, forceSeek);
        }
    } else {
        // Solo un video
        const v = activeClips[0];
        updateVideoPreview(previewA, v, xPos, 1.0, forceSeek);
        if (previewB) {
            previewB.style.display = 'none';
            previewB.pause();
        }
    }
}

function updateVideoPreview(video, clip, xPos, weight, forceSeek) {
    const targetTime = (xPos - clip.left) / 25;
    
    if (video.src !== clip.src) {
        video.src = clip.src;
        video.muted = false;
        video.currentTime = targetTime;
        if (isPlayingTl) video.play().catch(() => {});
    } else {
        // Si el video ya está cargado pero no está reproduciendo y debería estarlo
        if (isPlayingTl && video.paused) {
            video.muted = false;
            video.play().catch(() => {});
        }
    }

    // Aplicar interpolación visual y sonora
    video.style.opacity = weight;
    video.volume = weight; // Interpolación de audio conforme al crossfade

    const drift = Math.abs(video.currentTime - targetTime);
    if (forceSeek || drift > 0.15) {
        video.currentTime = targetTime;
    }
}

let lastTickTime = 0;

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
        playBtn.style.background = '#f59e0b';
        if (playIcon) playIcon.textContent = '⏸';
        if (playText) playText.textContent = 'PAUSE';
    }

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
        playBtn.style.background = '#10b981';
        if (playIcon) playIcon.textContent = '▶';
        if (playText) playText.textContent = 'PLAY';
    }
    
    // PAUSE ALL PREVIEW VIDEOS
    const pA = document.getElementById('timelinePreviewA');
    const pB = document.getElementById('timelinePreviewB');
    if (pA) pA.pause();
    if (pB) pB.pause();
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
            subTabBtns.forEach(b => {
                b.classList.remove('active');
                b.style.background = 'transparent';
                b.style.color = '#94a3b8';
            });
            btn.classList.add('active');
            btn.style.background = '#6366f1';
            btn.style.color = 'white';

            subTabContents.forEach(content => {
                content.style.display = 'none';
                if (content.id === targetId) {
                    content.style.display = (targetId === 'previz-monitor') ? 'flex' : 'block';
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
    
    if (previzImage) previzImage.style.display = 'none';
    previzVideo.src = src;
    previzVideo.style.display = 'block';
    if (previzPlaceholder) previzPlaceholder.style.display = 'none';
    
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

function loadImageToPreviz(src) {
    const previzVideo = document.getElementById('previzVideo');
    const previzImage = document.getElementById('previzImage');
    const previzPlaceholder = document.getElementById('previzPlaceholder');
    if (!previzImage) return;

    if (previzVideo) {
        previzVideo.pause();
        previzVideo.style.display = 'none';
    }
    previzImage.src = src;
    previzImage.style.display = 'block';
    if (previzPlaceholder) previzPlaceholder.style.display = 'none';

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
        
        data.push({
            filename,
            startTime,
            duration,
            track
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

async function startRealExport(timelineData) {
    const modal = document.getElementById('exportModal');
    const progressBar = document.getElementById('exportProgressBar');
    const progressPct = document.getElementById('exportProgressPct');
    const statusText = document.getElementById('exportProgressText');
    const exportConsole = document.getElementById('exportConsole');
    const viewBtn = document.getElementById('viewFinalVideo');
    const badge = document.getElementById('exportStatusBadge');
    
    modal.style.display = 'flex';
    viewBtn.style.display = 'none';
    progressBar.style.width = '0%';
    progressPct.textContent = '0%';
    statusText.textContent = 'Enviando petición...';
    badge.textContent = 'PROCESAMIENTO';
    badge.style.background = 'rgba(99, 102, 241, 0.2)';
    
    isExporting = true;
    
    try {
        appendExportLog('> Solicitando exportación de ' + timelineData.length + ' clips...');
        
        const response = await fetch('/api/export-timeline', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clips: timelineData })
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
        } else {
            throw new Error(result.error || 'Error desconocido');
        }
    } catch (error) {
        console.error('Export error:', error);
        appendExportLog('❌ ERROR: ' + error.message);
        statusText.textContent = 'Fallo al exportar';
        badge.textContent = 'FAILED';
        badge.style.background = '#ef4444';
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
    const track = document.querySelector('.timeline-track[data-track="V1"]');
    if (!track) return;

    let currentX = 0;
    const clipWidth = 150; // Default width in pixels
    const overlap = 0.15; // 15% overlap
    const step = clipWidth * (1 - overlap); // Distance between starts

    batchItems.forEach((item, idx) => {
        if (item.resultUrl) {
            addClipToTimeline(item.resultUrl, track, currentX + track.getBoundingClientRect().left, item.prompt, item.params);
            currentX += step;
        }
    });

    appendConsoleLine(`🎬 Auto-assembled ${batchItems.length} clips in timeline.`, 'system');
    document.getElementById('tabEditorBtn').click(); // Ir al editor para ver el resultado
}

// Initial Load
document.querySelectorAll('.timeline-track').forEach(track => {
    track.addEventListener('dragover', e => e.preventDefault());
    track.addEventListener('drop', e => {
        e.preventDefault();
        const src = e.dataTransfer.getData('videoSrc');
        const prompt = e.dataTransfer.getData('videoPrompt');
        const meta = e.dataTransfer.getData('videoMetadata');
        if (src) addClipToTimeline(src, track, e.clientX, prompt, meta);
    });
});

loadExistingVideos();
calculateTimelineOverlaps();

// ============================================
// STORYBOARD LOGIC
// ============================================

function addToStoryboardQueue(prompt, options = {}) {
    const params = {
        videoWidth: parseInt(document.getElementById('videoWidth').value),
        videoHeight: parseInt(document.getElementById('videoHeight').value),
        storyboardSteps: parseInt(document.getElementById('storyboardSteps').value)
    };

    globalGenerationQueue.push({
        id: Date.now() + Math.random(),
        prompt: prompt,
        params,
        type: 'storyboard',
        status: 'pending',
        ...options
    });

    updateGlobalQueueUI();
    checkGlobalQueue();
}

function handleStoryboardGenerated(message) {
    const existing = storyboardItems.find(item => item.storyboardIndex === message.storyboardIndex && item.batchId === message.batchId);
    
    if (existing) {
        existing.url = message.url;
        existing.filename = message.filename;
        existing.status = 'ready';
        existing.params = message.params || {};
    } else {
        storyboardItems.push({
            id: 'sb_' + Date.now() + Math.random(),
            url: message.url,
            filename: message.filename,
            prompt: message.prompt,
            storyboardIndex: message.storyboardIndex || storyboardItems.length,
            batchId: message.batchId || 'default',
            status: 'ready',
            params: message.params || {}
        });
    }
    
    // Ordenar por storyboardIndex si existen
    storyboardItems.sort((a, b) => a.storyboardIndex - b.storyboardIndex);
    updateStoryboardUI();
}

function updateStoryboardUI() {
    const grid = document.getElementById('storyboardGrid');
    const placeholder = document.getElementById('storyboardPlaceholder');
    if (!grid) return;

    if (storyboardItems.length > 0) {
        if (placeholder) placeholder.style.display = 'none';
        grid.innerHTML = '';
        
        storyboardItems.forEach((item, index) => {
            const div = document.createElement('div');
            div.className = 'storyboard-item';
            div.style.cssText = 'background: #1e293b; border: 1px solid #334155; border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; transition: all 0.3s ease;';
            
            div.innerHTML = `
                <div style="position: relative; width: 100%; height: 200px; background: #000;">
                    <img src="${item.url}?t=${Date.now()}" style="width: 100%; height: 100%; object-fit: cover;">
                    <div style="position: absolute; top: 10px; left: 10px; background: rgba(15, 23, 42, 0.8); padding: 4px 10px; border-radius: 4px; font-size: 0.7em; font-weight: bold; color: #818cf8;">Step ${index + 1}</div>
                    
                    <div style="position: absolute; top: 10px; right: 10px; display: flex; gap: 5px;">
                        <button class="view-sb-btn" title="View in Previz" style="background: rgba(15, 23, 42, 0.8); border: 1px solid rgba(255,255,255,0.1); border-radius: 50%; width: 32px; height: 32px; cursor: pointer; color: white; display: flex; align-items: center; justify-content: center; padding: 0;">👁️</button>
                        <button class="regen-story-btn" title="Regenerate Image" style="background: #a855f7; border: none; border-radius: 50%; width: 32px; height: 32px; min-width: 32px; cursor: pointer; color: white; display: flex; align-items: center; justify-content: center; padding: 0; flex-shrink: 0; box-sizing: border-box;">↻</button>
                    </div>
                    
                    <button class="remove-story-btn" title="Remove" style="position: absolute; bottom: 10px; right: 10px; background: #ef4444; border: none; border-radius: 50%; width: 24px; height: 24px; min-width: 24px; cursor: pointer; color: white; display: flex; align-items: center; justify-content: center; font-size: 0.8em; padding: 0; flex-shrink: 0; box-sizing: border-box;">×</button>
                </div>
                <div style="padding: 15px; flex: 1; display: flex; flex-direction: column; gap: 10px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-size: 0.7em; color: #64748b; font-weight: bold; text-transform: uppercase;">Prompt</span>
                        <span style="font-size: 0.6em; background: rgba(168, 85, 247, 0.2); color: #a855f7; padding: 2px 6px; border-radius: 4px;">Flux: ${item.params?.storyboardSteps || '??'} steps</span>
                    </div>
                    <div style="font-size: 0.85em; color: #e2e8f0; line-height: 1.4; max-height: 4.5em; overflow-y: auto; background: rgba(15, 23, 42, 0.4); padding: 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.05);">
                        ${item.prompt}
                    </div>
                </div>
            `;

            div.querySelector('.view-sb-btn').onclick = (e) => {
                e.stopPropagation();
                loadImageToPreviz(item.url);
                const tabPrevizBtn = document.getElementById('tabPrevizBtn');
                if (tabPrevizBtn) tabPrevizBtn.click();
            };
            
            div.querySelector('.regen-story-btn').onclick = (e) => {
                e.stopPropagation();
                // Actualizar estado antes de relanzar
                item.status = 'regenerating';
                addToStoryboardQueue(item.prompt, { storyboardIndex: item.storyboardIndex, batchId: item.batchId });
                appendConsoleLine(`♻️ Regenerating storyboard image ${index + 1}...`, 'system');
            };

            div.querySelector('.remove-story-btn').onclick = (e) => {
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
            placeholder.style.display = 'flex';
        }
    }
}

// Event Listeners for Storyboard Buttons
document.getElementById('clearStoryboardBtn')?.addEventListener('click', () => {
    if (confirm('Clear all storyboard images?')) {
        storyboardItems = [];
        updateStoryboardUI();
        appendConsoleLine('🗑️ Storyboard cleared.', 'system');
    }
});

document.getElementById('generateVidsFromStoryboardBtn')?.addEventListener('click', () => {
    if (storyboardItems.length === 0) return alert('No storyboard images to generate from');
    
    if (confirm(`Generate ${storyboardItems.length} videos from these images?`)) {
        appendConsoleLine(`🚀 Transitioning storyboard to video pipeline (${storyboardItems.length} items)`, 'system');
        
        const isAutoAssemble = document.getElementById('autoAssembleCheck')?.checked;
        const batchId = 'batch_vid_' + Date.now();

        storyboardItems.forEach((item, index) => {
            // Usamos la imagen del storyboard como base para I2V
            addToQueue(item.prompt, item.filename, { isAutoAssemble, batchId });
        });
        
        // Ir a Stage para ver progreso
        const tabOutputBtn = document.getElementById('tabOutputBtn');
        if (tabOutputBtn) tabOutputBtn.click();
    }
});

// INITIALIZATION: Load assets on startup
document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 Studio initialized. Loading assets...');
    loadExistingVideos();
    loadExistingImages();
});
