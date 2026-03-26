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
let isAdvancedMode = false;


// Variables para modo de blending
let isBlendMode = false;
let selectedVideos = [];
let videoElements = new Map(); // Mapa de filename -> elemento de galería

// Variables para image upload
let uploadedImageFilename = null; // Nombre del archivo en ComfyUI

// ============================================
// IMAGE UPLOAD HANDLING
// ============================================

const imageUploadArea = document.getElementById('imageUploadArea');
const imageUploadInput = document.getElementById('imageUploadInput');
const uploadPlaceholder = document.getElementById('uploadPlaceholder');
const uploadStatus = document.getElementById('uploadStatus');
const modeIndicator = document.getElementById('modeIndicator');
const modeText = document.getElementById('modeText');
const dimensionControls = document.getElementById('dimensionControls');

// Click to upload
imageUploadArea.addEventListener('click', () => {
    if (!imageUploadArea.classList.contains('has-image')) {
        imageUploadInput.click();
    }
});

// Drag & Drop
imageUploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    imageUploadArea.classList.add('dragover');
});

imageUploadArea.addEventListener('dragleave', (e) => {
    e.preventDefault();
    imageUploadArea.classList.remove('dragover');
});

imageUploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    imageUploadArea.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0 && files[0].type.startsWith('image/')) {
        handleImageFile(files[0]);
    }
});

// File input change
imageUploadInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        handleImageFile(e.target.files[0]);
    }
});

async function handleImageFile(file) {
    // Show preview immediately
    const reader = new FileReader();
    reader.onload = (e) => {
        showImagePreview(e.target.result, file.name);
    };
    reader.readAsDataURL(file);

    // Upload to server -> ComfyUI
    uploadStatus.classList.add('visible');
    uploadStatus.textContent = '⏳ Subiendo imagen a ComfyUI...';

    try {
        const formData = new FormData();
        formData.append('image', file);

        const response = await fetch('/api/upload-image', {
            method: 'POST',
            body: formData
        });

        const result = await response.json();

        if (result.success) {
            uploadedImageFilename = result.filename;
            uploadStatus.textContent = '✅ Imagen lista para I2V';
            uploadStatus.style.color = '#34d399';
            setTimeout(() => {
                uploadStatus.classList.remove('visible');
                uploadStatus.style.color = '';
            }, 2000);
            updateMode();
        } else {
            throw new Error(result.error || 'Error desconocido');
        }
    } catch (error) {
        console.error('Error uploading image:', error);
        uploadStatus.textContent = '❌ Error al subir imagen: ' + error.message;
        uploadStatus.style.color = '#ef4444';
        // Still keep the preview but clear the filename
        uploadedImageFilename = null;
        updateMode();
    }
}

function showImagePreview(dataUrl, filename) {
    imageUploadArea.classList.add('has-image');
    imageUploadArea.innerHTML = `
        <div class="image-preview-container">
            <img src="${dataUrl}" alt="Preview">
            <div class="image-preview-info">
                <div class="filename">${filename}</div>
                <span class="mode-badge i2v">🎬 Image-to-Video</span>
            </div>
            <button class="remove-image-btn" id="removeImageBtn" title="Quitar imagen">✕</button>
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
    imageUploadArea.innerHTML = `
        <div class="upload-placeholder" id="uploadPlaceholder">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <p>Arrastra una imagen o haz clic</p>
            <p class="upload-hint">PNG, JPG, WEBP • Si subes imagen → modo I2V</p>
        </div>
    `;
    imageUploadInput.value = '';
    updateMode();
}

function updateMode() {
    const isI2V = !!uploadedImageFilename;

    if (isI2V) {
        modeIndicator.className = 'mode-indicator i2v';
        modeText.textContent = 'Modo Image-to-Video (I2V)';
        modeIndicator.querySelector('.mode-icon').textContent = '🖼️';
        dimensionControls.classList.add('disabled-for-i2v');
    } else {
        modeIndicator.className = 'mode-indicator t2v';
        modeText.textContent = 'Modo Text-to-Video (T2V)';
        modeIndicator.querySelector('.mode-icon').textContent = '🎬';
        dimensionControls.classList.remove('disabled-for-i2v');
    }
}

// ============================================
// WEBSOCKET HANDLING
// ============================================

ws.onopen = () => {
    console.log('WebSocket connection established');
};

ws.onmessage = (event) => {
    try {
        const message = JSON.parse(event.data);
        console.log('Mensaje del servidor:', message.type, message);

        // Manejar actualizaciones de progreso
        if (message.type === 'progress') {
            const percentage = Math.round((message.value / message.max) * 100);
            const progressFill = document.getElementById('progressFill');
            const progressText = document.getElementById('progressText');
            const progressContainer = document.getElementById('progressContainer');

            if (progressFill) {
                progressFill.style.width = percentage + '%';
                progressFill.textContent = percentage + '%';
            }

            if (currentExecutingId) {
                const item = globalGenerationQueue.find(i => i.id === currentExecutingId);
                if (item) {
                    const modeLabel = item.imageFilename ? 'I2V' : 'T2V';
                    if (progressText) {
                        progressText.textContent = `⏳ [${modeLabel}] Generando... ${message.value}/${message.max} pasos (${percentage}%)`;
                    }
                }
            } else if (progressText) {
                progressText.textContent = `⏳ Generando... ${message.value}/${message.max} pasos (${percentage}%)`;
            }

            if (progressContainer && progressContainer.style.display === 'none') {
                progressContainer.style.display = 'block';
            }
        }

        // Manejar estado de descarga de video
        if (message.type === 'video_downloading') {
            const progressFill = document.getElementById('progressFill');
            const progressText = document.getElementById('progressText');
            const progressContainer = document.getElementById('progressContainer');

            progressFill.style.width = '100%';
            progressFill.textContent = '100%';
            progressText.textContent = message.message;
            progressContainer.style.display = 'block';
            appendConsoleLine(`> ${message.message}`, 'system');
        }

        // Manejar mensajes de ejecución de nodos (Mini-Consola)
        if (message.type === 'executing') {
            const statusConsole = document.getElementById('statusConsole');
            const consoleBody = document.getElementById('consoleBody');

            if (statusConsole.style.display === 'none' || !statusConsole.style.display) {
                statusConsole.style.display = 'block';
            }

            let msg = '';
            if (message.node === null) {
                msg = '> Step finished.';
            } else {
                msg = `> Executing node ID: ${message.node}`;
            }

            appendConsoleLine(msg, 'executing');
        }

        // Manejar video generado
        if (message.type === 'video_generated') {
            const timestamp = Date.now();
            const videoUrlWithCacheBuster = `${message.url}?t=${timestamp}`;
            console.log('Video generado con éxito:', videoUrlWithCacheBuster);

            // Ocultar placeholder
            if (placeholder) placeholder.style.display = 'none';

            // Forzar actualización inmediata de la galería
            loadExistingVideos();

            // Pequeño retardo adicional para asegurar que el SO haya liberado el archivo
            setTimeout(() => {
                loadExistingVideos();
            }, 1000);

            // Si estamos en modo Queue Global
            if (currentExecutingId) {
                const itemIndex = globalGenerationQueue.findIndex(i => i.id === currentExecutingId);
                if (itemIndex !== -1) {
                    // Actualizar UI
                    globalGenerationQueue[itemIndex].status = 'completed';
                    updateGlobalQueueUI();

                    // Eliminar de la cola tras unos segundos para no llenar la vista
                    const doneId = currentExecutingId;
                    setTimeout(() => {
                        const idx = globalGenerationQueue.findIndex(i => i.id === doneId);
                        if (idx !== -1) {
                            globalGenerationQueue.splice(idx, 1);
                            updateGlobalQueueUI();
                        }
                    }, 6000);
                }

                isGeneratingGlobal = false;
                currentExecutingId = null;

                // Iniciar el próximo si hay
                setTimeout(() => {
                    checkGlobalQueue();
                }, 2000);
            }

            // Mantener barra visible con estado
            const progressContainer = document.getElementById('progressContainer');
            const progressFill = document.getElementById('progressFill');
            const progressText = document.getElementById('progressText');

            if (progressContainer) progressContainer.style.display = 'block';
            if (progressFill) {
                progressFill.style.width = '100%';
                progressFill.textContent = '✓ Listo';
            }
            if (progressText) progressText.textContent = '✅ Video generado exitosamente';
        }
    } catch (e) {
        console.error('Error procesando mensaje WebSocket:', e, event.data);
    }
};

// Actualizar valores de los sliders en tiempo real
const sliders = [
    { id: 'videoWidth', valueId: 'videoWidthValue' },
    { id: 'videoHeight', valueId: 'videoHeightValue' },
    { id: 'videoLength', valueId: 'videoLengthValue' },
    { id: 'samplerSteps', valueId: 'samplerStepsValue' }
];

sliders.forEach(slider => {
    const element = document.getElementById(slider.id);
    const valueElement = document.getElementById(slider.valueId);

    element.addEventListener('input', (e) => {
        valueElement.textContent = e.target.value;
    });
});

// Select modo de ejecución
const promptModeSelect = document.getElementById('promptModeSelect');
const simplePrompt = document.getElementById('simplePromptContainer');

if (promptModeSelect) {
    promptModeSelect.addEventListener('change', (e) => {
        isAdvancedMode = e.target.value === 'sequence';
        
        if (isAdvancedMode) {
            simplePrompt.style.display = 'none';
            // Mover automáticamente a la pestaña de Secuenciador
            const tabBtn = document.getElementById('tabPromptsBtn');
            if (tabBtn) tabBtn.click();
            
            // Agregar primer prompt si está vacío
            if (document.getElementById('promptSequence').children.length === 0) {
                addPromptToSequence();
            }
        } else {
            simplePrompt.style.display = 'block';
            // Volver a la pestaña de salida
            const tabBtn = document.getElementById('tabOutputBtn');
            if (tabBtn) tabBtn.click();
        }
    });
}

// Lógica de Tabs Mejorada
const tabButtons = document.querySelectorAll('.tab-button');
const tabContents = document.querySelectorAll('.tab-content');

tabButtons.forEach(button => {
    button.addEventListener('click', () => {
        const targetId = button.dataset.target;
        
        // Manejar clases del body para layout dinámico
        document.body.classList.remove('tab-stage-active', 'tab-sequencer-active', 'tab-editor-active');
        if (targetId === 'tabOutput') document.body.classList.add('tab-stage-active');
        if (targetId === 'tabPrompts') document.body.classList.add('tab-sequencer-active');
        if (targetId === 'tabEditor') document.body.classList.add('tab-editor-active');

        // Switches de botones
        tabButtons.forEach(btn => btn.classList.remove('active'));
        button.classList.add('active');

        // Switches de contenido
        tabContents.forEach(content => content.classList.remove('active'));
        if (targetId) {
            const target = document.getElementById(targetId);
            if (target) target.classList.add('active');
        }
        
        // Pausar reproducción del timeline si salimos del editor
        if (targetId === 'tabOutput' || targetId === 'tabPrompts') { // Solo pausar si salimos del editor
            stopTimelinePlayback();
        }
    });
});

// Accordion Toggle Config
const slidersToggle = document.getElementById('slidersToggle');
const slidersContent = document.getElementById('slidersContent');
if (slidersToggle && slidersContent) {
    slidersToggle.addEventListener('click', () => {
        slidersToggle.classList.toggle('active');
        slidersContent.classList.toggle('show');
    });
}

// Agregar prompt a la secuencia
let promptCounter = 0;
function addPromptToSequence() {
    promptCounter++;
    const container = document.getElementById('promptSequence');
    const promptDiv = document.createElement('div');
    promptDiv.className = 'prompt-item';
    promptDiv.dataset.promptId = promptCounter;
    
    // Contamos cuántos hay en el DOM para el número
    const currentCount = container.children.length + 1;
    
    promptDiv.innerHTML = `
        <div class="prompt-header">
            <div class="prompt-header-left">
                <div class="prompt-number">${currentCount}</div>
                <span class="prompt-status-text">⏳ En espera</span>
            </div>
            <button class="remove-prompt-btn">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                Quitar
            </button>
        </div>
        <textarea class="sequence-prompt-textarea sequence-prompt" placeholder="Describe aquí la acción o detalle para esta escena...">A cinematic video of </textarea>
    `;

    // Botón para eliminar
    promptDiv.querySelector('.remove-prompt-btn').addEventListener('click', () => {
        promptDiv.remove();
        updatePromptNumbers();
    });

    container.appendChild(promptDiv);

    // Scroll automático al nuevo prompt
    container.scrollTop = container.scrollHeight;
}

function updatePromptNumbers() {
    const container = document.getElementById('promptSequence');
    const items = container.querySelectorAll('.prompt-item');
    items.forEach((item, index) => {
        item.querySelector('.prompt-number').textContent = index + 1;
    });
}

// Actualizar estado visual de los prompts
function updatePromptStatus(index, status) {
    const promptItems = document.querySelectorAll('.prompt-item');
    promptItems.forEach((item, i) => {
        const statusSpan = item.querySelector('.prompt-status-text');
        
        // Reset properties
        item.style.background = 'rgba(30, 41, 59, 0.6)';
        item.style.boxShadow = 'none';

        if (i < index) {
            // Completado
            item.style.borderColor = 'rgba(16, 185, 129, 0.5)';
            statusSpan.innerHTML = `✅ Completado`;
            statusSpan.style.color = '#10b981';
        } else if (i === index) {
            // Generando
            item.style.borderColor = '#6366f1';
            item.style.boxShadow = '0 0 15px rgba(99, 102, 241, 0.3)';
            statusSpan.innerHTML = `⚡ ${status}`;
            statusSpan.style.color = '#818cf8';
        } else {
            // Pendiente
            item.style.borderColor = 'rgba(99, 102, 241, 0.2)';
            statusSpan.innerHTML = `⏳ En espera`;
            statusSpan.style.color = '#94a3b8';
        }
    });
}

document.getElementById('addPromptButton').addEventListener('click', addPromptToSequence);

// Funciones de consola
function appendConsoleLine(text, type = '') {
    const consoleBody = document.getElementById('consoleBody');
    const line = document.createElement('div');
    line.className = `console-line ${type}`;
    line.textContent = text;
    consoleBody.appendChild(line);

    // Auto-scroll al final
    consoleBody.scrollTop = consoleBody.scrollHeight;

    // Limitar número de líneas para no saturar el DOM
    if (consoleBody.children.length > 50) {
        consoleBody.removeChild(consoleBody.firstChild);
    }
}

// ============================================
// SISTEMA DE COLA GLOBAL (QUEUE)
// ============================================

function updateGlobalQueueUI() {
    const queueContainer = document.getElementById('globalQueueContainer');
    const queueList = document.getElementById('queueList');
    const queueCount = document.getElementById('queueCount');
    
    // Actualizar botones de Generar / Stop
    const generateBtn = document.getElementById('generateButton');
    const stopBtn = document.getElementById('stopButton');
    const activeItems = globalGenerationQueue.filter(i => i.status !== 'completed');
    
    if (activeItems.length > 0 || isGeneratingGlobal) {
        if (generateBtn) generateBtn.style.display = 'none';
        if (stopBtn) stopBtn.style.display = 'block';
    } else {
        if (generateBtn) generateBtn.style.display = 'block';
        if (stopBtn) stopBtn.style.display = 'none';
    }

    if (!queueContainer || !queueList || !queueCount) return;

    if (globalGenerationQueue.length === 0) {
        queueContainer.style.display = 'none';
        return;
    }

    queueContainer.style.display = 'block';

    // Contar pendientes y generando
    queueCount.textContent = activeItems.length;

    queueList.innerHTML = '';
    globalGenerationQueue.forEach((item) => {
        const div = document.createElement('div');
        div.style.padding = '10px';
        div.style.borderRadius = '8px';
        div.style.marginBottom = '5px';
        div.style.fontSize = '0.9em';

        let borderColor, bg, icon, statusText, color;
        if (item.status === 'generating') {
            borderColor = '#10b981'; bg = 'rgba(16, 185, 129, 0.15)'; color = '#34d399'; icon = '⏳'; statusText = 'Generando ahora...';
        } else if (item.status === 'completed') {
            borderColor = '#6366f1'; bg = 'rgba(15, 23, 42, 0.6)'; color = '#a5b4fc'; icon = '✅'; statusText = 'Completado';
        } else {
            borderColor = '#f59e0b'; bg = 'rgba(15, 23, 42, 0.6)'; color = '#e2e8f0'; icon = '⏸'; statusText = 'En cola...';
        }

        div.style.borderLeft = `4px solid ${borderColor}`;
        div.style.background = bg;

        div.innerHTML = `
            <div style="font-weight: 600; margin-bottom: 4px; color: ${color}">
                ${icon} ${statusText}
            </div>
            <div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #cbd5e1; font-size: 0.85em;" title="${item.prompt}">
                ${item.imageFilename ? '🖼️ ' : '🎬 '} ${item.prompt}
            </div>
        `;
        queueList.appendChild(div);
    });
}

function checkGlobalQueue() {
    if (isGeneratingGlobal) return;

    const nextItemIndex = globalGenerationQueue.findIndex(item => item.status === 'pending');
    if (nextItemIndex === -1) {
        // Si estamos en modo avanzado, marcar todo como completado
        if (isAdvancedMode) {
            updatePromptStatus(999, '');
        }
        return;
    }

    const nextItem = globalGenerationQueue[nextItemIndex];
    nextItem.status = 'generating';
    currentExecutingId = nextItem.id;
    isGeneratingGlobal = true;

    updateGlobalQueueUI();

    // Si tiene un uiIndex (viene de modo avanzado), actualizar su estado visual
    if (nextItem.uiIndex !== undefined && nextItem.uiIndex !== null) {
        updatePromptStatus(nextItem.uiIndex, 'Generando...');
    }

    generateVideoQueueItem(nextItem);

}

function generateVideoQueueItem(item) {
    // Asegurar que la consola sea visible
    const statusConsole = document.getElementById('statusConsole');
    const consoleBody = document.getElementById('consoleBody');

    if (statusConsole) {
        statusConsole.style.display = 'block';
        statusConsole.style.opacity = '1';
        statusConsole.style.visibility = 'visible';
    }

    if (consoleBody) {
        consoleBody.innerHTML = '<div class="console-line system">> Initializing generative pipeline for queued item...</div>';
    }

    if (progressContainer) {
        progressContainer.style.display = 'block';
        progressContainer.style.visibility = 'visible';
        progressContainer.style.opacity = '1';
    }
    if (progressFill) {
        progressFill.style.width = '0%';
        progressFill.textContent = '0%';
    }

    const modeLabel = item.imageFilename ? 'I2V 🖼️' : 'T2V 🎬';
    const shortPrompt = item.prompt.length > 50 ? item.prompt.substring(0, 50) + '...' : item.prompt;
    progressText.textContent = `🛠 [${modeLabel}] Iniciando: "${shortPrompt}"`;

    // Ocultar placeholders y videos previos
    videoContainer.style.display = 'none';
    imageContainer.style.display = 'none';
    if (placeholder) placeholder.style.display = 'none';

    // Enviar requerimiento websocket
    const message = {
        type: 'generarImagen',
        prompt: item.prompt,
        params: item.params,
        imageFilename: item.imageFilename
    };

    console.log('Sending queued generation request:', message);
    ws.send(JSON.stringify(message));
}

// Función para generar video (para uso directo, no cola)
function generateVideo(prompt) {
    // Asegurar que la consola sea visible
    const statusConsole = document.getElementById('statusConsole');
    const consoleBody = document.getElementById('consoleBody');

    if (statusConsole) {
        statusConsole.style.display = 'block';
        statusConsole.style.opacity = '1';
        statusConsole.style.visibility = 'visible';
    }

    if (consoleBody) {
        consoleBody.innerHTML = '<div class="console-line system">> Initializing new generation pipeline...</div>';
    }

    const params = {
        videoWidth: parseInt(document.getElementById('videoWidth').value),
        videoHeight: parseInt(document.getElementById('videoHeight').value),
        videoLength: parseInt(document.getElementById('videoLength').value),
        samplerSteps: parseInt(document.getElementById('samplerSteps').value)
    };

    // Mostrar barra de progreso al iniciar - asegurar que sea visible
    if (progressContainer) {
        progressContainer.style.display = 'block';
        progressContainer.style.visibility = 'visible';
        progressContainer.style.opacity = '1';
    }
    if (progressFill) {
        progressFill.style.width = '0%';
        progressFill.textContent = '0%';
    }

    const modeLabel = uploadedImageFilename ? 'I2V 🖼️' : 'T2V 🎬';
    progressText.textContent = `🛠 [${modeLabel}] Iniciando generación de video...`;

    // Ocultar contenedores de medios anteriores
    videoContainer.style.display = 'none';
    imageContainer.style.display = 'none';
    if (placeholder) placeholder.style.display = 'none';

    // Enviar con o sin imagen
    const message = {
        type: 'generarImagen',
        prompt,
        params,
        imageFilename: uploadedImageFilename || null
    };

    console.log('Sending generation request:', message);
    ws.send(JSON.stringify(message));
}

// Agregar video a la galería
function addToGallery(videoElement, prompt, index) {
    let gallery = document.getElementById('videoGallery');
    if (!gallery) {
        // Crear galería si no existe
        gallery = document.createElement('div');
        gallery.id = 'videoGallery';
        document.querySelector('.output-panel').appendChild(gallery);
    }

    const galleryItem = document.createElement('div');
    galleryItem.className = 'gallery-item';

    const miniVideo = videoElement.cloneNode(true);
    miniVideo.controls = true;
    miniVideo.setAttribute('allowfullscreen', '');
    miniVideo.setAttribute('webkitallowfullscreen', '');
    miniVideo.setAttribute('mozallowfullscreen', '');

    const label = document.createElement('div');
    label.className = 'gallery-item-label';
    label.textContent = `Video #${index}`;
    label.title = prompt;

    galleryItem.appendChild(miniVideo);
    galleryItem.appendChild(label);

    // Habilitar Drag and Drop para el Editor
    galleryItem.draggable = true;
    galleryItem.addEventListener('dragstart', (e) => {
        const videoSrc = miniVideo.querySelector('source') ? miniVideo.querySelector('source').src : miniVideo.src;
        e.dataTransfer.setData('videoSrc', videoSrc);
        e.dataTransfer.setData('prompt', prompt);
        galleryItem.style.opacity = '0.5';
    });
    galleryItem.addEventListener('dragend', () => {
        galleryItem.style.opacity = '1';
    });

    // Click para reproducir el video en su lugar
    miniVideo.addEventListener('click', () => {
        if (miniVideo.paused) {
            miniVideo.play();
        } else {
            miniVideo.pause();
        }
    });

    gallery.appendChild(galleryItem);
}

document.getElementById('generateButton').addEventListener('click', () => {
    const params = {
        videoWidth: parseInt(document.getElementById('videoWidth').value),
        videoHeight: parseInt(document.getElementById('videoHeight').value),
        videoLength: parseInt(document.getElementById('videoLength').value),
        samplerSteps: parseInt(document.getElementById('samplerSteps').value)
    };

    // Captura si hay modo avanzado o simple
    let promptsToQueueItems = [];
    const imageFilename = uploadedImageFilename || null;

    if (isAdvancedMode) {
        const promptGeneral = document.getElementById('promptGeneral').value.trim();
        const promptElements = document.querySelectorAll('.sequence-prompt');

        promptElements.forEach((el, index) => {
            const val = el.value.trim();
            if (val) {
                // Combinar con prompt general si existe (estilo al final para mejor resultado)
                const finalPrompt = promptGeneral ? `${val}, ${promptGeneral}` : val;
                promptsToQueueItems.push({
                    prompt: finalPrompt,
                    uiIndex: index
                });
            }
        });

        if (promptsToQueueItems.length === 0) {
            alert('Por favor, agregue al menos un prompt a la secuencia.');
            return;
        }
    } else {
        const promptItem = document.getElementById('prompt').value.trim();
        if (!promptItem) {
            alert('Por favor, ingrese un prompt.');
            return;
        }
        promptsToQueueItems.push({
            prompt: promptItem,
            uiIndex: null
        });
    }

    // Meter todo a la cola masiva
    promptsToQueueItems.forEach(item => {
        globalGenerationQueue.push({
            id: Date.now() + Math.random().toString(36).substring(2, 9),
            prompt: item.prompt,
            uiIndex: item.uiIndex,
            params,
            imageFilename,
            status: 'pending'
        });
    });

    // Actualizar UI y arrancar
    updateGlobalQueueUI();
    checkGlobalQueue();

    // Redirigir automáticamente a la pestaña de progreso
    const tabBtn = document.getElementById('tabOutputBtn');
    if (tabBtn) tabBtn.click();
});

document.getElementById('stopButton').addEventListener('click', () => {
    isGeneratingGlobal = false;
    // Eliminamos todo menos el item actual que ya está corriendo en el servidor.
    // O podríamos enviar también una señal WS para cancelar al worker.
    globalGenerationQueue = globalGenerationQueue.filter(i => i.status === 'completed' || i.status === 'generating');
    
    // Set pending tasks effectively removed
    updateGlobalQueueUI();
    const progressText = document.getElementById('progressText');
    if (progressText) {
        progressText.textContent = '🛑 Generación en base a secuencia detenida exitosamente.';
    }
    
    setTimeout(() => {
        updateGlobalQueueUI(); // refresh view
    }, 100);
});

// Cargar videos existentes al iniciar la página
async function loadExistingVideos() {
    try {
        console.log('Refrescando galería de videos...');
        const response = await fetch('/api/videos?t=' + Date.now());
        const videos = await response.json();

        if (videos.length > 0) {
            console.log(`Cargando ${videos.length} videos existentes...`);

            // Ocultar placeholder
            if (placeholder) placeholder.style.display = 'none';

            // Crear galería si no existe
            let gallery = document.getElementById('videoGallery');
            if (!gallery) {
                gallery = document.createElement('div');
                gallery.id = 'videoGallery';

                // Agregar título a la galería
                const galleryTitle = document.createElement('h3');
                galleryTitle.className = 'gallery-title';
                galleryTitle.textContent = 'Videos Generados';
                gallery.appendChild(galleryTitle);

                document.querySelector('.output-panel').appendChild(gallery);
            }

            // Limpiar galería existente (excepto el título)
            const existingItems = gallery.querySelectorAll('div:not(h3)');
            existingItems.forEach(item => item.remove());

            // Agregar cada video a la galería
            videos.forEach((video, index) => {
                const galleryItem = document.createElement('div');
                galleryItem.className = 'gallery-item';

                const videoElement = document.createElement('video');
                // Cache buster agresivo para evitar ERR_CACHE_OPERATION_NOT_SUPPORTED
                videoElement.src = `${video.url}?t=${Date.now()}_${index}`;
                videoElement.controls = true;
                videoElement.preload = 'metadata';
                videoElement.setAttribute('allowfullscreen', '');
                videoElement.setAttribute('webkitallowfullscreen', '');
                videoElement.setAttribute('mozallowfullscreen', '');

                const label = document.createElement('div');
                label.className = 'gallery-item-label';
                label.textContent = video.filename;

                galleryItem.appendChild(videoElement);
                galleryItem.appendChild(label);

                // Habilitar Drag and Drop para el Editor (Videos Existentes)
                galleryItem.draggable = true;
                galleryItem.addEventListener('dragstart', (e) => {
                    const videoSrc = videoElement.src;
                    e.dataTransfer.setData('videoSrc', videoSrc);
                    e.dataTransfer.setData('prompt', video.filename);
                    galleryItem.style.opacity = '0.5';
                });
                galleryItem.addEventListener('dragend', () => {
                    galleryItem.style.opacity = '1';
                });

                // Guardar referencia en el mapa
                videoElements.set(video.filename, galleryItem);

                // Click en el item de galería para selección en modo blending
                galleryItem.addEventListener('click', (e) => {
                    // Si está en modo blending, manejar selección
                    if (isBlendMode) {
                        e.preventDefault();
                        e.stopPropagation();
                        handleVideoSelection(video.filename, galleryItem);
                    }
                });

                // Click en el video para reproducir (solo si no está en modo blending)
                videoElement.addEventListener('click', (e) => {
                    if (!isBlendMode) {
                        if (videoElement.paused) {
                            videoElement.play();
                        } else {
                            videoElement.pause();
                        }
                    } else {
                        // En modo blending, prevenir reproducción
                        e.preventDefault();
                        e.stopPropagation();
                    }
                });

                // Si ya está en modo blending, hacer seleccionable
                if (isBlendMode) {
                    galleryItem.classList.add('selectable');
                }

                gallery.appendChild(galleryItem);
            });

            // NO mostrar video en contenedor principal - mantenerlo oculto
            videoContainer.style.display = 'none';
            imageContainer.style.display = 'none';

            // Solo actualizar texto si no estamos generando
            if (!isGeneratingGlobal && progressText && !progressText.textContent.includes('Generando')) {
                progressText.textContent = `📹 ${videos.length} video${videos.length > 1 ? 's' : ''} cargado${videos.length > 1 ? 's' : ''}`;
            }
        } else {
            if (!isGeneratingGlobal && progressText) {
                progressText.textContent = '⏸ Esperando para generar...';
            }
        }
    } catch (error) {
        console.error('Error al cargar videos existentes:', error);
        progressText.textContent = '⏸ Esperando para generar...';
    }
}

// Estado inicial
progressContainer.style.display = 'block';
progressFill.style.width = '0%';
progressFill.textContent = '⏸';
progressText.textContent = '⏸ Cargando videos...';

// Cargar videos al iniciar
loadExistingVideos();

// ============================================
// FUNCIONALIDAD DE BLENDING DE VIDEOS
// ============================================

// Actualizar valor del slider de duración de blend
const blendDurationSlider = document.getElementById('blendDuration');
const blendDurationValue = document.getElementById('blendDurationValue');
if (blendDurationSlider && blendDurationValue) {
    blendDurationSlider.addEventListener('input', (e) => {
        blendDurationValue.textContent = e.target.value;
    });
}

// Activar/Desactivar modo de blending
const blendModeButton = document.getElementById('blendModeButton');
const blendControls = document.getElementById('blendControls');
const blendInfo = document.getElementById('blendInfo');
const executeBlendButton = document.getElementById('executeBlendButton');
const cancelBlendButton = document.getElementById('cancelBlendButton');

blendModeButton.addEventListener('click', () => {
    isBlendMode = !isBlendMode;

    if (isBlendMode) {
        // Activar modo blending
        blendControls.classList.add('active');
        blendModeButton.style.background = 'rgba(239, 68, 68, 0.2)';
        blendModeButton.style.color = '#ef4444';
        blendModeButton.style.borderColor = 'rgba(239, 68, 68, 0.3)';
        blendModeButton.textContent = '❌ Salir de Modo Blending';

        // Hacer todos los videos seleccionables
        document.querySelectorAll('.gallery-item').forEach(item => {
            item.classList.add('selectable');
        });

        updateBlendInfo();
    } else {
        // Desactivar modo blending
        exitBlendMode();
    }
});

// Cancelar selección
cancelBlendButton.addEventListener('click', () => {
    exitBlendMode();
});

function exitBlendMode() {
    isBlendMode = false;
    selectedVideos = [];

    blendControls.classList.remove('active');
    blendModeButton.style.background = 'rgba(16, 185, 129, 0.2)';
    blendModeButton.style.color = '#10b981';
    blendModeButton.style.borderColor = 'rgba(16, 185, 129, 0.3)';
    blendModeButton.textContent = '🎞️ Modo Blending de Videos';

    // Remover clase selectable y selected de todos los videos
    document.querySelectorAll('.gallery-item').forEach(item => {
        item.classList.remove('selectable', 'selected');
        // Remover indicador de orden si existe
        const orderIndicator = item.querySelector('.selection-order');
        if (orderIndicator) {
            orderIndicator.remove();
        }
    });

    updateBlendInfo();
}

function updateBlendInfo() {
    if (!isBlendMode) return;
    const count = selectedVideos.length;
    if (count === 0) {
        blendInfo.textContent = 'Selecciona 2 o más videos para hacer blending';
        executeBlendButton.disabled = true;
    } else if (count === 1) {
        blendInfo.textContent = `1 video seleccionado - Selecciona al menos 1 más`;
        executeBlendButton.disabled = true;
    } else {
        blendInfo.textContent = `${count} videos seleccionados - Orden: ${selectedVideos.map((v, i) => i + 1).join(' → ')}`;
        executeBlendButton.disabled = false;
    }
}

// Estado inicial
progressContainer.style.display = 'block';
progressFill.style.width = '0%';
progressFill.textContent = '⏸';
progressText.textContent = '⏸ Cargando videos...';

// Cargar videos al iniciar
loadExistingVideos();

// El bloque de funcionalidad de blending ya está definido arriba de la línea 1022.
// Solo mantenemos lo que sigue después del bloque duplicado.

// ============================================
// LÓGICA DEL EDITOR MAESTRO (TIMELINE)
// ============================================

let isPlayingTl = false;
let tlPlaybackInterval = null;
let currentTlPos = 0;

function addClipToTimeline(src, trackElement, xPos) {
    const emptyMsg = document.querySelector('.timeline-empty-msg');
    if (emptyMsg) emptyMsg.remove();

    const clip = document.createElement('div');
    clip.className = 'timeline-clip';
    const filename = src.split('/').pop();
    
    const rect = trackElement.getBoundingClientRect();
    const relativeX = xPos - rect.left;
    clip.style.left = `${relativeX}px`;
    clip.style.width = '150px';

    clip.innerHTML = `
        <div class="trim-handle trim-handle-left"></div>
        <video src="${src}" muted preload="metadata"></video>
        <div class="clip-info">
            <span>${filename}</span>
        </div>
        <div class="trim-handle trim-handle-right"></div>
        <button class="remove-clip-btn">×</button>
    `;

    // Eventos de Mover y Recortar
    setupClipInteractions(clip);

    clip.querySelector('.remove-clip-btn').addEventListener('click', (e) => {
        e.stopPropagation(); clip.remove(); checkTimelineEmpty();
    });

    trackElement.appendChild(clip);
}

function checkTimelineEmpty() {
    const anyClip = document.querySelector('.timeline-clip');
    const container = document.getElementById('editorTimeline');
    if (!anyClip && container) {
        if (!container.querySelector('.timeline-empty-msg')) {
             container.insertAdjacentHTML('beforeend', '<div class="timeline-empty-msg" style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #334155; pointer-events: none; font-size: 0.8em; text-transform: uppercase; letter-spacing: 2px;">Drag Assets Here</div>');
        }
    }
}

document.querySelectorAll('.timeline-track').forEach(track => {
    track.addEventListener('dragover', e => { e.preventDefault(); track.style.background = 'rgba(99,102,241,0.1)'; });
    track.addEventListener('dragleave', () => { track.style.background = ''; });
    track.addEventListener('drop', e => {
        e.preventDefault();
        track.style.background = '';
        const videoSrc = e.dataTransfer.getData('videoSrc');
        if (videoSrc) addClipToTimeline(videoSrc, track, e.clientX);
    });
});

const timelineTracksContent = document.getElementById('editorTimeline');
const playhead = document.createElement('div');
playhead.id = 'timelinePlayhead';
playhead.style.cssText = 'position: absolute; top: 0; left: 0; width: 2px; height: 100%; background: #ff3e3e; z-index: 50; pointer-events: none;';
if (timelineTracksContent) timelineTracksContent.appendChild(playhead);

if (timelineTracksContent) {
    timelineTracksContent.addEventListener('click', (e) => {
        const rect = timelineTracksContent.getBoundingClientRect();
        const x = e.clientX - rect.left + timelineTracksContent.scrollLeft;
        currentTlPos = x;
        playhead.style.left = `${x}px`;
        syncPreviewToTime(x);
    });
}

function setupClipInteractions(clip) {
    let isDragging = false;
    let isTrimmingLeft = false;
    let isTrimmingRight = false;
    let startX, startLeft, startWidth;

    clip.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('remove-clip-btn')) return;
        
        // Seleccionar clip
        document.querySelectorAll('.timeline-clip').forEach(c => c.classList.remove('selected'));
        clip.classList.add('selected');

        startX = e.clientX;
        startLeft = parseFloat(clip.style.left) || 0;
        startWidth = clip.offsetWidth;

        if (e.target.classList.contains('trim-handle-left')) {
            isTrimmingLeft = true;
        } else if (e.target.classList.contains('trim-handle-right')) {
            isTrimmingRight = true;
        } else {
            isDragging = true;
        }

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        e.preventDefault();
    });

    function handleMouseMove(e) {
        const deltaX = e.clientX - startX;

        if (isDragging) {
            let newLeft = startLeft + deltaX;
            if (newLeft < 0) newLeft = 0;
            clip.style.left = `${newLeft}px`;

            // Detectar cambio de pista
            const tracks = document.querySelectorAll('.timeline-track');
            tracks.forEach(track => {
                const rect = track.getBoundingClientRect();
                if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
                    if (clip.parentElement !== track) {
                        track.appendChild(clip);
                    }
                }
            });
        } else if (isTrimmingLeft) {
            let newLeft = startLeft + deltaX;
            let newWidth = startWidth - deltaX;
            if (newWidth > 20 && newLeft >= 0) {
                clip.style.left = `${newLeft}px`;
                clip.style.width = `${newWidth}px`;
            }
        } else if (isTrimmingRight) {
            let newWidth = startWidth + deltaX;
            if (newWidth > 20) {
                clip.style.width = `${newWidth}px`;
            }
        }
        
        // Sincronizar previsualización mientras mueves
        syncPreviewToTime(parseFloat(clip.style.left));
    }

    function handleMouseUp() {
        isDragging = false;
        isTrimmingLeft = false;
        isTrimmingRight = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
    }
}
function syncPreviewToTime(xPos) {
    const clips = document.querySelectorAll('.timeline-clip');
    const previewVideo = document.getElementById('timelinePreview');
    const edPlaceholder = document.getElementById('editorPlaceholder');

    if (!clips.length) return;

    let foundClip = null;
    // Prioridad por track (V3 > V2 > V1)
    const sortedClips = Array.from(clips).sort((a, b) => {
        const tA = a.parentElement.dataset.track || '';
        const tB = b.parentElement.dataset.track || '';
        return tB.localeCompare(tA);
    });

    for (const clip of sortedClips) {
        const left = parseFloat(clip.style.left);
        const width = clip.offsetWidth;
        if (xPos >= left && xPos <= left + width) {
            foundClip = clip;
            break;
        }
    }

    if (foundClip) {
        if (edPlaceholder) edPlaceholder.style.display = 'none';
        if (previewVideo) {
            previewVideo.style.display = 'block';
            const srcVideo = foundClip.querySelector('video');
            if (previewVideo.src !== srcVideo.src) {
                previewVideo.src = srcVideo.src;
            }
            const internalOffset = xPos - parseFloat(foundClip.style.left);
            previewVideo.currentTime = internalOffset / 25; 
        }
    } else {
        if (previewVideo) previewVideo.pause();
    }
}

// Controles de Playback del Timeline
const tlPlayBtn = document.getElementById('tlPlayBtn');
const tlStopBtn = document.getElementById('tlStopBtn');

if (tlPlayBtn) {
    tlPlayBtn.addEventListener('click', () => {
        if (isPlayingTl) {
            stopTimelinePlayback();
        } else {
            startTimelinePlayback();
        }
    });
}

if (tlStopBtn) {
    tlStopBtn.addEventListener('click', () => {
        stopTimelinePlayback();
        currentTlPos = 0;
        playhead.style.left = '0px';
    });
}

function startTimelinePlayback() {
    isPlayingTl = true;
    tlPlayBtn.textContent = 'PAUSE';
    tlPlayBtn.style.background = '#f59e0b';
    
    tlPlaybackInterval = setInterval(() => {
        currentTlPos += 2; // Velocidad de reproducción
        playhead.style.left = `${currentTlPos}px`;
        syncPreviewToTime(currentTlPos);
        
        // Auto-scroll si se sale de vista
        if (currentTlPos > timelineTracksContent.clientWidth + timelineTracksContent.scrollLeft - 100) {
            timelineTracksContent.scrollLeft += 2;
        }
        
        // Límite del timeline (ej: 5000px)
        if (currentTlPos > 5000) stopTimelinePlayback();
    }, 40);
}

function stopTimelinePlayback() {
    isPlayingTl = false;
    clearInterval(tlPlaybackInterval);
    if (tlPlayBtn) {
        tlPlayBtn.textContent = 'PLAY';
        tlPlayBtn.style.background = '#10b981';
    }
}

// Exportar (Placeholder funcional)
const exportBtn = document.getElementById('exportProjectBtn');
if (exportBtn) {
    exportBtn.addEventListener('click', () => {
        const clips = document.querySelectorAll('.timeline-clip');
        if (clips.length < 1) {
            alert('Agrega clips al timeline para exportar.');
            return;
        }
        appendConsoleLine('>> Iniciando compilación de proyecto...', 'system');
        setTimeout(() => {
            alert('¡Exportación simulada con éxito! Enviando data al servidor...');
            appendConsoleLine('>> Proyecto exportado: /exports/final_video.mp4', 'success');
        }, 2000);
    });
}
