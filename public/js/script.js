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
            if (currentExecutingId || message.prompt_id) {
                const itemIndex = globalGenerationQueue.findIndex(i =>
                    i.status !== 'completed' &&
                    (i.id === currentExecutingId || (message.prompt_id && i.prompt_id === message.prompt_id))
                );

                if (itemIndex !== -1) {
                    const item = globalGenerationQueue[itemIndex];
                    item.status = 'completed';
                    item.resultUrl = message.url;

                    // AUTO-VIDEO PIPELINE: If this storyboard item was flagged for auto-video
                    if (item.autoVideo) {
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
                mode: el.querySelector('.step-mode-select-compact')?.value || 't2i2v'
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

async function saveProjectToFile(name, dataOverride = null) {
    const data = dataOverride || getProjectData();
    try {
        const response = await fetch('/api/projects/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, data })
        });
        const result = await response.json();
        if (result.success) {
            appendConsoleLine(`✅ Project "${name}" saved to storage.`, 'system');
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

    // Calculate counters for images and videos (including waiting items)
    const imgItems = activeItems.filter(i => i.type === 'storyboard');
    const videoItems = activeItems.filter(i => i.type !== 'storyboard');
    const imgCompleted = globalGenerationQueue.filter(i => i.type === 'storyboard' && i.status === 'completed').length;
    const videoCompleted = globalGenerationQueue.filter(i => i.type !== 'storyboard' && i.status === 'completed').length;
    const totalImg = imgItems.length + imgCompleted;
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
    
    if (totalImg > 0 || totalVideo > 0) {
        countersDiv.style.display = 'flex';
        countersDiv.innerHTML = '';
        
        if (totalImg > 0) {
            const imgCounter = document.createElement('div');
            imgCounter.style.cssText = 'color: #818cf8;';
            imgCounter.innerHTML = `🖼️ IMG remaining: <span style="color: #f59e0b;">${imgItems.length}/${totalImg}</span>`;
            countersDiv.appendChild(imgCounter);
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
        if (item.status === 'waiting' && item.type !== 'export') modeLabel = 'I2V (waiting for image)';

        const progressIndicator = item.status === 'generating' ?
            '<span style="color: #f59e0b; animation: pulse 1s infinite;">⚡ PROCESSING</span>' :
            item.status === 'waiting' ?
            '<span style="color: #64748b;">⏸️ WAITING</span>' :
            '<span style="color: #94a3b8;">⏳ QUEUED</span>';

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
        `;
        queueList.appendChild(div);
    });
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
            batchGroups[batchKey] = { images: [], videos: [], exports: [] };
        }
        if (item.type === 'storyboard') {
            batchGroups[batchKey].images.push(item);
        } else if (item.type === 'export') {
            batchGroups[batchKey].exports.push(item);
        } else {
            batchGroups[batchKey].videos.push(item);
        }
    });
    
    // Find the first batch (chronologically) and process images first, then videos, then exports
    const sortedBatchIds = Object.keys(batchGroups).sort();
    let nextItem = null;
    
    for (const batchId of sortedBatchIds) {
        const batch = batchGroups[batchId];
        // First, process all images in this batch
        if (batch.images.length > 0) {
            nextItem = batch.images[0];
            break;
        }
        // Then, process all videos in this batch
        if (batch.videos.length > 0) {
            nextItem = batch.videos[0];
            break;
        }
        // Finally, process exports for this batch
        if (batch.exports.length > 0) {
            nextItem = batch.exports[0];
            break;
        }
    }
    
    if (!nextItem) return;

    nextItem.status = 'generating';
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
    } else {
        const message = {
            type: nextItem.type === 'storyboard' ? 'generarStoryboard' : 'generarImagen',
            prompt: nextItem.prompt,
            params: nextItem.params,
            imageFilename: nextItem.imageFilename,
            storyboardIndex: nextItem.storyboardIndex,
            batchId: nextItem.batchId,
            batchName: batchName
        };
        ws.send(JSON.stringify(message));
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
    const autoOverlap = parseFloat(document.getElementById('autoOverlapSlider')?.value || 15) / 100;
    const batchId = 'batch_' + Date.now();
    const globalImagePrompt = document.getElementById('globalImagePrompt')?.value.trim() || '';
    const globalVideoPrompt = document.getElementById('globalVideoPrompt')?.value.trim() || '';

    promptItems.forEach((item, index) => {
        const tImg = item.querySelector('.image-prompt');
        const tVid = item.querySelector('.video-prompt');
        const modeSelect = item.querySelector('.step-mode-select-compact');
        
        const valImg = tImg?.value.trim();
        const valVid = tVid?.value.trim();
        const mode = modeSelect?.value || 't2i2v';

        if (valImg || valVid) {
            // Global style prefix
            const finalImgPrompt = valImg ? (globalImagePrompt ? `${globalImagePrompt}, ${valImg}` : valImg) : '';
            const finalVidPrompt = valVid ? (globalVideoPrompt ? `${globalVideoPrompt}, ${valVid}` : valVid) : '';

            if (mode === 't2i') {
                addToStoryboardQueue(finalImgPrompt || finalVidPrompt, { batchId, storyboardIndex: index, autoOverlap });
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
                    autoOverlap,
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
                    autoOverlap
                });
            } else {
                // Text to Video directly (t2v)
                addToQueue(finalVidPrompt || finalImgPrompt, null, { isAutoAssemble, isAutoRender, batchId, autoOverlap });
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
    const batchName = `Batch ${new Date().toLocaleTimeString()}`;
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

    // Force queue refesh to correctly show the newest batch project association
    updateGlobalQueueUI();

    // Redirigir a Stage
    document.getElementById('tabOutputBtn').click();
}

document.getElementById('addPromptButton')?.addEventListener('click', () => {
    addPromptStep();
});

function addPromptStep(val = '', mode = 't2i2v') {
    const container = document.getElementById('promptSequence');
    if (!container) return;

    // Handle val as string or object
    let promptImg = '';
    let promptVid = '';
    
    if (typeof val === 'object' && val !== null) {
        promptImg = val['PROMPT IMAGE'] || val.promptImage || val.prompt || '';
        promptVid = val['VIDEO IMAGE'] || val.videoImage || val.video || '';
    } else {
        promptImg = val;
        promptVid = val;
    }

    const count = container.querySelectorAll('.prompt-item').length + 1;
    const div = document.createElement('div');
    div.className = 'prompt-item';
    div.dataset.mode = mode;
    div.innerHTML = `
        <div class="prompt-header">
            <div class="prompt-header-left">
                <div class="prompt-number">${count}</div>
                <span class="prompt-status-text">STEP</span>
            </div>
            <div class="prompt-header-right">
                <select class="step-mode-select-compact" title="Generation mode">
                    <option value="t2v" ${mode === 't2v' ? 'selected' : ''}>🎬 T2V</option>
                    <option value="t2i" ${mode === 't2i' ? 'selected' : ''}>🖼️ T2I</option>
                    <option value="t2i2v" ${mode === 't2i2v' ? 'selected' : ''}>🔄 T2I→I2V</option>
                </select>
                <button class="remove-prompt-btn" title="Remove prompt">×</button>
            </div>
        </div>
        <div class="prompt-content collapsed">
            <div class="prompt-inputs-container">
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
    const tImg = div.querySelector('.image-prompt');
    const tVid = div.querySelector('.video-prompt');
    const lImg = div.querySelector('.prompt-split-label.image');
    const lVid = div.querySelector('.prompt-split-label.video');

    function updateVisibility() {
        const currentMode = modeSelect.value;
        if (currentMode === 't2i2v') {
            lImg.style.display = 'flex';
            tImg.style.display = 'block';
            lVid.style.display = 'flex';
            tVid.style.display = 'block';
            lImg.querySelector('span').textContent = 'PROMPT IMAGE (STATIC)';
        } else if (currentMode === 't2i') {
            lImg.style.display = 'flex';
            tImg.style.display = 'block';
            lVid.style.display = 'none';
            tVid.style.display = 'none';
            lImg.querySelector('span').textContent = 'PROMPT IMAGE';
        } else {
            // T2V
            lImg.style.display = 'none';
            tImg.style.display = 'none';
            lVid.style.display = 'flex';
            lVid.querySelector('span').textContent = 'PROMPT VIDEO';
            tVid.style.display = 'block';
        }
    }

    modeSelect.addEventListener('change', updateVisibility);
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
        if (e.target.closest('.step-mode-select-compact') || e.target.closest('.remove-prompt-btn')) return;
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

function applyBatchData(data) {
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

    // Get default mode from global selector
    const defaultMode = document.getElementById('defaultPromptMode')?.value || 't2i2v';

    // Cargar pasos
    data.steps.forEach(step => {
        addPromptStep(step, defaultMode);
    });

    appendConsoleLine(`✅ Applied Batch Data: ${data.steps.length} prompts added (${defaultMode} mode).`, 'system');
}

const enhancePromptBtn = document.getElementById('enhancePromptBtn');
const magicPromptBtn = document.getElementById('magicPromptBtn');
const aiPromptArea = document.getElementById('aiPromptArea');
const geminiModelSelect = document.getElementById('geminiModelSelect');

if (magicPromptBtn && aiPromptArea) {
    magicPromptBtn.addEventListener('click', () => {
        aiPromptArea.classList.toggle('hidden');
        if (!aiPromptArea.classList.contains('hidden')) {
            loadGeminiModels();
        }
    });
}

async function loadGeminiModels() {
    if (!geminiModelSelect) return;
    try {
        const response = await fetch('/api/list-models');
        const data = await response.json();
        if (data.models) {
            const currentVal = geminiModelSelect.value;
            geminiModelSelect.innerHTML = '';
            
            // Filtrar solo modelos que soporten generateContent
            const activeModels = data.models.filter(m => m.supportedGenerationMethods.includes('generateContent'));
            
            activeModels.forEach(m => {
                const nameShort = m.name.replace('models/', '');
                const opt = document.createElement('option');
                opt.value = nameShort;
                opt.textContent = m.displayName || nameShort;
                if (nameShort === 'gemini-flash-latest') opt.selected = true;
                geminiModelSelect.appendChild(opt);
            });
            
            if (currentVal && Array.from(geminiModelSelect.options).some(o => o.value === currentVal)) {
                geminiModelSelect.value = currentVal;
            }
        }
    } catch (e) {
        console.error('Error loading Gemini models:', e);
    }
}

if (enhancePromptBtn) {
    enhancePromptBtn.addEventListener('click', async () => {
        const text = document.getElementById('manualBatchPrompt').value.trim();
        const modelName = geminiModelSelect ? geminiModelSelect.value : 'gemini-2.5-flash';

        if (!text) {
            alert("Por favor escribe una idea primero.");
            return;
        }

        enhancePromptBtn.disabled = true;
        enhancePromptBtn.textContent = '🪄 GENERATING BATCH WITH AI...';
        appendConsoleLine(`🪄 Asking Gemini (${modelName}) for a cinematic batch...`, 'system');

        try {
            const response = await fetch('/api/enhance-prompt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, modelName })
            });

            const data = await response.json();
            if (data.error) throw new Error(data.error);

            applyBatchData(data);
            appendConsoleLine(`✨ Batch sequence generated successfully.`, 'system');
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
                e.dataTransfer.setData('videoMetadata', JSON.stringify(techInfo));
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

let isPlayingTl = false;
let tlAnimationFrame = null; // Cambio de Interval a AnimationFrame para fluidez
let currentTlPos = 0;
let clipCache = []; // Cache para evitar leer el DOM cada frame
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
    
    // Calculate width based on metadata.videoLength (defaulting to 121 frames = 150px = 6s)
    const videoFrames = metadata.videoLength || 121;
    const calculatedWidth = (videoFrames / 121) * 150;
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
        const naturalWidth = (naturalFrames / 121) * 150;

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
    const naturalWidth = (naturalFrames / 121) * 150; // Aproximación de ancho base

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
    const overlap = batchItems[0]?.autoOverlap !== undefined ? batchItems[0].autoOverlap : 0.15;
    if (!targetProjectId) return;

    // 1. Calcular los clips a añadir
    let currentX = 0;
    const newClipsRaw = [];
    batchItems.forEach((item) => {
        if (item.resultUrl) {
            const filename = item.resultUrl.split('/').pop().split('?')[0];
            const vFrames = item.params?.videoLength || 121;
            const vDuration = (vFrames / 121) * 6;
            const vWidth = (vFrames / 121) * 150;
            
            newClipsRaw.push({
                filename,
                startTime: currentX / 25,
                duration: vDuration,
                track: 'V1',
                prompt: item.prompt,
                metadata: item.params
            });
            currentX += (vWidth * overlap);
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
            const lastDuration = (lastFrames / 121) * 6;
            startFrom = last.startTime + (lastDuration * overlap);
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
        projectId: activeProjectId,
        ...options
    });

    updateGlobalQueueUI();
    checkGlobalQueue();
}

function handleStoryboardGenerated(message) {
    // 1. Encontrar el proyecto de origen para esta generación
    const queueItem = globalGenerationQueue.find(qi => (qi.id === currentExecutingId) || (message.prompt_id && qi.prompt_id === message.prompt_id));
    const targetProjectId = queueItem ? queueItem.projectId : activeProjectId;
    const project = openProjects.find(p => p.id === targetProjectId);

    if (!project) return console.warn('[STORYBOARD] No target project found for generated item');
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
        appendConsoleLine('⏹ Queue stopped. All pending items cleared.', 'system');
        
        if (progressText) {
            progressText.textContent = '⏹ Queue stopped by user';
            if (progressFill) progressFill.style.width = '0%';
            if (document.getElementById('progressPct')) document.getElementById('progressPct').textContent = '0%';
        }
    }
});

// INITIALIZATION: Load assets on startup
document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 Studio initialized. Loading assets...');
    loadExistingVideos();
    loadExistingImages();
    loadExistingAudio();
    loadProjectsList();
});
