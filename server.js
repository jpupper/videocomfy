const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const bodyParser = require('body-parser');
const socketIO = require('socket.io');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const multer = require('multer');

const ipglobal = "192.168.0.13"; // IP de ComfyUI
const serverAddress = ipglobal + ":8188";
const clientId = uuidv4();

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());

// Configurar multer para upload de imágenes
const uploadDir = path.join(__dirname, 'public', 'uploads');
const projectsDir = path.join(__dirname, 'public', 'projects');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
if (!fs.existsSync(projectsDir)) {
    fs.mkdirSync(projectsDir, { recursive: true });
}
const upload = multer({ dest: uploadDir });

const promptDetails = {};  // Almacena detalles del prompt
let lastPromptDetails = null; // Fallback por si acaso el ID falla

// ============================================
// COMFYUI WEBSOCKET CON RECONEXIÓN
// ============================================

let wsComfy;
function connectToComfy() {
    console.log(`Conectando a ComfyUI en ws://${serverAddress}/ws?clientId=${clientId}...`);
    wsComfy = new WebSocket(`ws://${serverAddress}/ws?clientId=${clientId}`);

    wsComfy.on('open', () => {
        console.log('✅ Conexión establecida con ComfyUI');
        broadcastComfyStatus('connected');
    });

    wsComfy.on('message', async (data) => {
        try {
            // Manejar posibles datos binarios (imágenes de preview)
            if (data instanceof Buffer === false && typeof data !== 'string') {
                return;
            }

            const messageString = data.toString();
            // Log solo si no es binario y no es demasiado ruidoso
            if (messageString.length < 1000) {
                console.log('📩 Mensaje de ComfyUI:', messageString);
            }

            const message = JSON.parse(messageString);

            // Enviar progreso al cliente
            if (message.type === 'progress') {
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'progress',
                            value: message.data.value,
                            max: message.data.max
                        }));
                    }
                });
            }

            // Enviar mensajes de ejecución de nodos (Mini-Consola)
            if (message.type === 'executing') {
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'executing',
                            node: message.data.node,
                            prompt_id: message.data.prompt_id
                        }));
                    }
                });
            }

            if (message.type === 'executed') {
                const promptId = message.data.prompt_id;
                const details = promptDetails[promptId];
                console.log(`🎬 Ejecución completada para el nodo: ${message.data.node} (Prompt ID: ${promptId})`);

                // Buscar video o imagen en las distintas posibles salidas de ComfyUI
                let assetFound = null;
                let assetType = 'video';
                const output = message.data.output;

                if (output.video) assetFound = output.video;
                else if (output.gifs) assetFound = output.gifs;
                else if (output.images) {
                    const imgs = Array.isArray(output.images) ? output.images : [output.images];
                    // Primero buscar videos camuflados como imágenes
                    const possibleVideo = imgs.find(img => img.filename.endsWith('.webm') || img.filename.endsWith('.mp4'));
                    if (possibleVideo) {
                        assetFound = possibleVideo;
                    } else if (details && (details.type === 'storyboard' || details.isImage)) {
                        // Si es explícitamente un storyboard o imagen
                        assetFound = imgs;
                        assetType = 'image';
                    } else if (imgs.length > 0) {
                        // Por defecto, si hay imágenes y no se encontró video
                        assetFound = imgs;
                        assetType = 'image';
                    }
                }

                if (assetFound) {
                    const assetItems = Array.isArray(assetFound) ? assetFound : [assetFound];

                    for (const asset of assetItems) {
                        console.log(`📦 Procesando ${assetType} encontrado:`, asset.filename);

                        const subfolder = asset.subfolder || '';
                        const assetUrl = `http://${serverAddress}/view?filename=${encodeURIComponent(asset.filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(asset.type || 'output')}`;

                        const filenameOnly = path.basename(asset.filename);
                        const targetSubdir = assetType === 'video' ? 'videos' : 'uploads'; // Guardamos storyboard en uploads para I2V
                        const targetDir = path.join(__dirname, 'public', targetSubdir);
                        const targetPath = path.join(targetDir, filenameOnly);

                        if (!fs.existsSync(targetDir)) {
                            fs.mkdirSync(targetDir, { recursive: true });
                        }

                        try {
                            if (fs.existsSync(targetPath)) {
                                fs.unlinkSync(targetPath);
                            }
                        } catch (e) {
                            console.warn(`No se pudo borrar el archivo previo ${filenameOnly}, puede estar bloqueado.`);
                        }

                        try {
                            // Informar inicio de descarga
                            wss.clients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({ type: `${assetType}_downloading`, message: `Descargando ${assetType}...` }));
                                }
                            });

                            await downloadImage(assetUrl, targetPath);
                            console.log(`✅ ${assetType} descargado: ${filenameOnly}`);

                            // RE-UPLOAD TO COMFYUI: Si es una imagen (Storyboard), debemos subirla a ComfyUI/input 
                            // para que el proceso de I2V pueda encontrarla, ya que por defecto Comfy solo la guardó en output.
                            if (assetType === 'image') {
                                try {
                                    console.log(`📤 Re-subiendo storyboard a ComfyUI/input: ${filenameOnly}...`);
                                    await uploadImageToComfy(targetPath, filenameOnly);
                                    console.log(`✅ ${assetType} listo en ComfyUI.`);
                                } catch (errUpload) {
                                    console.error(`❌ Fallo al re-subir imagen a ComfyUI:`, errUpload);
                                }
                            }

                            // Guardar metadatos asociados al archivo
                            const metaToSave = details || lastPromptDetails || { prompt: 'Unknown Prompt', params: {} };
                            
                            if (assetType === 'video') {
                                saveVideoMetadata(filenameOnly, {
                                    prompt: metaToSave.prompt,
                                    params: metaToSave.params,
                                    imageFilename: metaToSave.imageFilename,
                                    prompt_id: promptId
                                });
                            } else {
                                saveImageMetadata(filenameOnly, {
                                    prompt: metaToSave.prompt,
                                    params: metaToSave.params,
                                    storyboardIndex: metaToSave.storyboardIndex,
                                    batchId: metaToSave.batchId,
                                    prompt_id: promptId
                                });
                            }

                            // Notificar al frontend
                            wss.clients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: assetType === 'video' ? 'video_generated' : 'storyboard_generated',
                                        url: `/${targetSubdir}/${filenameOnly}`,
                                        filename: filenameOnly,
                                        prompt: metaToSave.prompt,
                                        storyboardIndex: metaToSave.storyboardIndex,
                                        batchId: metaToSave.batchId,
                                        prompt_id: promptId
                                    }));
                                }
                            });
                        } catch (error) {
                            console.error(`❌ Error al descargar ${assetType}:`, error);
                        }
                    }
                }
            }
        } catch (err) {
            // Ignorar errores de parseo de mensajes binarios
            if (!(err instanceof SyntaxError)) {
                console.error('Error procesando mensaje de ComfyUI:', err);
            }
        }
    });

    wsComfy.on('close', () => {
        console.log('❌ Conexión con ComfyUI cerrada. Reconectando en 5s...');
        broadcastComfyStatus('disconnected');
        setTimeout(connectToComfy, 5000);
    });

    wsComfy.on('error', (err) => {
        console.error('❌ Error en WebSocket de ComfyUI:', err.message);
        broadcastComfyStatus('disconnected');
    });
}

// Se llamará al final del archivo para asegurar que wss esté definido
// connectToComfy();

// ============================================
// ENDPOINTS API
// ============================================

app.post('/api/upload-image', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No image received' });

        const ext = path.extname(req.file.originalname) || '.png';
        const newFilename = `input_image_${Date.now()}${ext}`;
        const newPath = path.join(uploadDir, newFilename);
        fs.renameSync(req.file.path, newPath);

        const comfyResult = await uploadImageToComfy(newPath, newFilename);
        console.log('Imagen subida a ComfyUI:', comfyResult);

        res.json({
            success: true,
            filename: comfyResult.name || newFilename,
            localPath: `/uploads/${newFilename}`
        });
    } catch (error) {
        console.error('Error uploading image:', error);
        res.status(500).json({ error: error.message });
    }
});

const VIDEO_META_PATH = path.join(__dirname, 'public', 'videos', 'metadata.json');
const IMAGE_META_PATH = path.join(__dirname, 'public', 'uploads', 'metadata.json');

function saveVideoMetadata(filename, metadata) {
    saveMetadata(VIDEO_META_PATH, filename, metadata);
}

function saveImageMetadata(filename, metadata) {
    saveMetadata(IMAGE_META_PATH, filename, metadata);
}

function saveMetadata(metaPath, filename, metadata) {
    let allMetadata = {};
    try {
        if (fs.existsSync(metaPath)) {
            allMetadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        }
    } catch (e) { 
        console.error(`[METADATA] Error reading file ${metaPath}:`, e); 
    }

    allMetadata[filename] = {
        ...metadata,
        timestamp: Date.now()
    };

    try {
        fs.writeFileSync(metaPath, JSON.stringify(allMetadata, null, 2));
        console.log(`[METADATA] ✅ Guardado exitoso para: ${filename} en ${path.basename(metaPath)}`);
    } catch (e) { 
        console.error(`[METADATA] Error writing file ${metaPath}:`, e); 
    }
}

function getVideoMetadata(filename) {
    return getMetadata(VIDEO_META_PATH, filename);
}

function getImageMetadata(filename) {
    return getMetadata(IMAGE_META_PATH, filename);
}

function getMetadata(metaPath, filename) {
    try {
        if (fs.existsSync(metaPath)) {
            const allMetadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            return allMetadata[filename] || null;
        }
    } catch (e) { }
    return null;
}

app.get('/api/images', (req, res) => {
    const uploadsDir = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(uploadsDir)) return res.json([]);
    
    let allMetadata = {};
    try {
        if (fs.existsSync(IMAGE_META_PATH)) {
            allMetadata = JSON.parse(fs.readFileSync(IMAGE_META_PATH, 'utf8'));
        }
    } catch (e) {}

    fs.readdir(uploadsDir, (err, files) => {
        if (err) return res.json([]);
        const images = files
            .filter(file => /\.(png|jpg|jpeg|webp)$/i.test(file))
            .map(file => {
                const stats = fs.statSync(path.join(uploadsDir, file));
                const meta = allMetadata[file] || {};
                return { 
                    filename: file, 
                    url: `/uploads/${file}`, 
                    mtime: stats.mtime.getTime(),
                    timestamp: meta.timestamp || stats.mtime.getTime(),
                    prompt: meta.prompt || '',
                    metadata: meta.params || {}
                };
            })
            .sort((a, b) => b.timestamp - a.timestamp);
        res.json(images);
    });
});

app.get('/api/audio', (req, res) => {
    const audioDir = path.join(__dirname, 'public', 'audio');
    if (!fs.existsSync(audioDir)) return res.json([]);
    
    fs.readdir(audioDir, (err, files) => {
        if (err) return res.json([]);
        const audioFiles = files
            .filter(file => /\.(mp3|wav|ogg|m4a)$/i.test(file))
            .map(file => {
                const stats = fs.statSync(path.join(audioDir, file));
                return { 
                    filename: file, 
                    url: `/audio/${file}`, 
                    mtime: stats.mtime.getTime()
                };
            })
            .sort((a, b) => b.mtime - a.mtime);
        res.json(audioFiles);
    });
});

app.post('/api/upload-audio', upload.single('audio'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No audio received' });

        const ext = path.extname(req.file.originalname) || '.mp3';
        const newFilename = `audio_${Date.now()}${ext}`;
        const audioDir = path.join(__dirname, 'public', 'audio');
        if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
        
        const newPath = path.join(audioDir, newFilename);
        fs.renameSync(req.file.path, newPath);

        res.json({
            success: true,
            filename: newFilename,
            url: `/audio/${newFilename}`
        });
    } catch (error) {
        console.error('Error uploading audio:', error);
        res.status(500).json({ error: error.message });
    }
});


async function checkAudio(filePath) {
    try {
        const { stdout } = await execPromise(`ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "${filePath}"`);
        return stdout.trim().length > 0;
    } catch (e) {
        console.warn(`[FFPROBE] Error checking audio for ${filePath}:`, e.message);
        return false;
    }
}

app.get('/api/videos', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const videosDir = path.join(__dirname, 'public', 'videos');
    if (!fs.existsSync(videosDir)) return res.json([]);

    fs.readdir(videosDir, (err, files) => {
        if (err) return res.json([]);
        
        let allMetadata = {};
        try {
            if (fs.existsSync(VIDEO_META_PATH)) {
                allMetadata = JSON.parse(fs.readFileSync(VIDEO_META_PATH, 'utf8'));
            }
        } catch (e) {}

        const videoFiles = files
            .filter(file => /\.(webm|mp4|gif)$/i.test(file))
            .map(file => {
                const stats = fs.statSync(path.join(videosDir, file));
                const meta = allMetadata[file] || {};
                return { 
                    filename: file, 
                    url: `/videos/${file}`, 
                    mtime: stats.mtime.getTime(),
                    timestamp: meta.timestamp || stats.mtime.getTime(),
                    prompt: meta.prompt || '',
                    metadata: meta.params || {}
                };
            })
            .sort((a, b) => b.timestamp - a.timestamp);
        res.json(videoFiles);
    });
});

app.post('/api/export-timeline', async (req, res) => {
    try {
        const { clips } = req.body;
        if (!clips || clips.length === 0) return res.status(400).json({ error: 'No clips provided' });

        console.log(`🎬 Iniciando exportación de timeline: ${clips.length} clips`);

        const videosDir = path.join(__dirname, 'public', 'videos');
        const audioDir = path.join(__dirname, 'public', 'audio');
        const outputFilename = `export_${Date.now()}.mp4`;
        const outputPath = path.join(videosDir, outputFilename);

        // 1. Determinar duración total
        let targetWidth = 1280;
        let targetHeight = 720;
        let totalDuration = 0;

        clips.forEach(c => {
            const end = c.startTime + c.duration;
            if (end > totalDuration) totalDuration = end;
        });

        // 2. Construir inputs de ffmpeg y mapear rutas
        const inputPaths = clips.map(c => {
            let fullPath = path.join(videosDir, c.filename);
            if (!fs.existsSync(fullPath)) {
                fullPath = path.join(audioDir, c.filename);
            }
            return fullPath;
        });

        const inputs = inputPaths.map(p => `-i "${p}"`).join(' ');

        // 3. Construir Filter Complex
        let filterComplex = '';
        // Crear fondo negro base
        filterComplex += `color=s=${targetWidth}x${targetHeight}:d=${totalDuration}:c=black[bg];`;

        let currentLayer = '[bg]';
        let audioLabels = [];
        let videoInputsCount = 0;

        for (let i = 0; i < clips.length; i++) {
            const c = clips[i];
            const isAudioTrack = c.track && c.track.startsWith('A');
            const offsetMs = Math.round(c.startTime * 1000);
            const offsetSec = offsetMs / 1000;
            const clipPath = inputPaths[i];

            // --- VIDEO (Solo si no es track de audio) ---
            if (!isAudioTrack) {
                filterComplex += `[${i}:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS-STARTPTS+(${offsetSec}/TB)[v${i}];`;
                
                const nextLayer = `[layer${i}]`;
                filterComplex += `${currentLayer}[v${i}]overlay=enable='between(t,${c.startTime},${c.startTime + c.duration})'${nextLayer};`;
                currentLayer = nextLayer;
                videoInputsCount++;
            }

            // --- AUDIO (En cualquier clip que lo tenga) ---
            const hasAudio = await checkAudio(clipPath);
            if (hasAudio) {
                filterComplex += `[${i}:a]atrim=0:${c.duration},asetpts=PTS-STARTPTS,adelay=${offsetMs}:all=1[a${i}];`;
                audioLabels.push(`[a${i}]`);
            }
        }

        // Renombrar la última capa de video
        if (videoInputsCount > 0) {
            filterComplex = filterComplex.replace(new RegExp(`\\[layer${clips.length - 1}\\]$`), '[outv]');
            // Si por alguna razón no se reemplazó (ej: el último clip era audio), aseguramos la salida
            if (!filterComplex.includes('[outv]')) {
                 filterComplex += `${currentLayer}copy[outv];`;
            }
        } else {
             filterComplex += `${currentLayer}copy[outv];`;
        }

        // 4. Mixing de Audio si existe
        let mapVideo = '-map "[outv]"';
        let mapAudio = '';
        if (audioLabels.length > 0) {
            filterComplex += `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest[outa]`;
            mapAudio = '-map "[outa]" -c:a aac -b:a 192k';
        }

        const command = `ffmpeg ${inputs} -filter_complex "${filterComplex}" ${mapVideo} ${mapAudio} -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -y "${outputPath}"`;
        
        console.log('Ejecutando FFmpeg:', command);
        await execPromise(command);

        saveVideoMetadata(outputFilename, {
            prompt: "Final Project Export",
            isExport: true,
            clipCount: clips.length,
            duration: totalDuration,
            params: { videoWidth: targetWidth, videoHeight: targetHeight }
        });

        res.json({ success: true, filename: outputFilename, url: `/videos/${outputFilename}` });

    } catch (error) {
        console.error('Error exporting timeline:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// PROJECTS API
// ============================================

app.get('/api/projects', (req, res) => {
    if (!fs.existsSync(projectsDir)) return res.json([]);
    
    fs.readdir(projectsDir, (err, files) => {
        if (err) return res.json([]);
        const projects = files
            .filter(file => file.endsWith('.json'))
            .map(file => {
                const stats = fs.statSync(path.join(projectsDir, file));
                return { 
                    name: file.replace('.json', ''),
                    filename: file,
                    mtime: stats.mtime.getTime()
                };
            })
            .sort((a, b) => b.mtime - a.mtime);
        res.json(projects);
    });
});

app.post('/api/projects/save', (req, res) => {
    try {
        const { name, data } = req.body;
        if (!name) return res.status(400).json({ error: 'Project name required' });
        
        const filename = `${name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.json`;
        const filePath = path.join(projectsDir, filename);
        
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        console.log(`[PROJECT] ✅ Guardado: ${name} -> ${filename}`);
        res.json({ success: true, filename });
    } catch (error) {
        console.error('Error saving project:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/projects/:name', (req, res) => {
    try {
        const name = req.params.name;
        const filePath = path.join(projectsDir, `${name}.json`);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Project not found' });
        
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/projects/:name', (req, res) => {
    try {
        const name = req.params.name;
        const filePath = path.join(projectsDir, `${name}.json`);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Project not found' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// SERVIDOR Y WEBSOCKETS CLIENTES
// ============================================

const port = 5634;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

server.listen(port, () => {
    console.log(`🚀 Servidor listo en http://localhost:${port}`);
});

wss.on('connection', (ws) => {
    console.log('🔌 Cliente conectado');
    
    // Informar estado actual de ComfyUI al nuevo cliente
    const currentStatus = (wsComfy && wsComfy.readyState === 1) ? 'connected' : 'disconnected';
    console.log(`🔌 Estado entregado a nuevo cliente: ${currentStatus}`);
    ws.send(JSON.stringify({ type: 'comfy_status', status: currentStatus }));

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            if (message.type === 'generarImagen') {
                console.log(`🎬 Petición generación: ${message.prompt} (${message.imageFilename ? 'I2V' : 'T2V'})`);
                const promptId = await generarVideo(message.prompt, message.params, message.imageFilename);
                const details = { 
                    prompt: message.prompt,
                    params: message.params,
                    imageFilename: message.imageFilename,
                    type: 'video'
                };
                promptDetails[promptId] = details;
                lastPromptDetails = details;
            } else if (message.type === 'generarStoryboard') {
                console.log(`🎬 Petición Storyboard: ${message.prompt}`);
                const promptId = await generarStoryboard(message.prompt, message.params, message.storyboardIndex, message.batchId);
                const details = { 
                    prompt: message.prompt,
                    params: message.params,
                    type: 'storyboard',
                    storyboardIndex: message.storyboardIndex,
                    batchId: message.batchId
                };
                promptDetails[promptId] = details;
                lastPromptDetails = details;
            }
        } catch (e) {
            console.error('Error en mensaje de cliente:', e);
        }
    });
});

// ============================================
// FUNCIONES AUXILIARES COMFYUI
// ============================================

async function uploadImageToComfy(filePath, filename) {
    const formData = new FormData();
    formData.append('image', fs.createReadStream(filePath), { filename });
    const options = {
        hostname: ipglobal, port: 8188, path: '/upload/image', method: 'POST',
        headers: formData.getHeaders()
    };
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(JSON.parse(data)));
        });
        req.on('error', reject);
        formData.pipe(req);
    });
}

async function queuePrompt(promptWorkflow) {
    const postData = JSON.stringify({ prompt: promptWorkflow, client_id: clientId });
    const options = {
        hostname: ipglobal, port: 8188, path: '/prompt', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    };
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(JSON.parse(data).prompt_id));
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

async function downloadImage(url, targetPath) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            if (res.statusCode !== 200) return reject(new Error(`Status: ${res.statusCode}`));
            const file = fs.createWriteStream(targetPath);
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
        }).on('error', reject);
    });
}

async function generarVideo(promptText, params = {}, imageFilename = null) {
    const isI2V = !!imageFilename;
    const workflowFile = isI2V ? 'video_ltx2_i2v_api.json' : 'video_ltx2_t2v_api.json';
    const data = await fs.promises.readFile(path.join(__dirname, workflowFile), 'utf8');
    const promptWorkflow = JSON.parse(data);

    // Configurar workflow
    if (isI2V) {
        promptWorkflow["3"]["inputs"]["text"] = promptText;
        if (params.negativePrompt) promptWorkflow["4"]["inputs"]["text"] = params.negativePrompt;
        
        const seedValue = (params.seed !== undefined && params.seed !== -1) ? params.seed : Math.floor(Math.random() * 1000000000);
        promptWorkflow["11"]["inputs"]["noise_seed"] = seedValue;
        promptWorkflow["67"]["inputs"]["noise_seed"] = seedValue;
        
        promptWorkflow["200"]["inputs"]["image"] = imageFilename;
        
        if (params.cfgScale) promptWorkflow["47"]["inputs"]["cfg"] = params.cfgScale;
        if (params.refStrength) {
            promptWorkflow["107"]["inputs"]["strength"] = params.refStrength;
            promptWorkflow["108"]["inputs"]["strength"] = params.refStrength;
        }
    } else {
        promptWorkflow["3"]["inputs"]["text"] = promptText;
        if (params.negativePrompt) promptWorkflow["4"]["inputs"]["text"] = params.negativePrompt;

        const seedValue = (params.seed !== undefined && params.seed !== -1) ? params.seed : Math.floor(Math.random() * 1000000000);
        promptWorkflow["11"]["inputs"]["noise_seed"] = seedValue;
        promptWorkflow["67"]["inputs"]["noise_seed"] = seedValue;

        if (params.videoWidth) promptWorkflow["89"]["inputs"]["width"] = params.videoWidth;
        if (params.videoHeight) promptWorkflow["89"]["inputs"]["height"] = params.videoHeight;
        if (params.cfgScale) promptWorkflow["47"]["inputs"]["cfg"] = params.cfgScale;
    }

    if (params.videoLength) promptWorkflow["62"]["inputs"]["value"] = params.videoLength;
    if (params.samplerSteps) promptWorkflow["9"]["inputs"]["steps"] = params.samplerSteps;

    const promptId = await queuePrompt(promptWorkflow);
    console.log(`🚀 Prompt enviado a ComfyUI. ID: ${promptId}`);
    return promptId;
}

async function generarStoryboard(promptText, params = {}, storyboardIndex = 0, batchId = null) {
    const workflowFile = 'flux_dev_full_text_to_image_api.json';
    const data = await fs.promises.readFile(path.join(__dirname, workflowFile), 'utf8');
    const promptWorkflow = JSON.parse(data);

    // Configurar workflow de Flux
    promptWorkflow["41"]["inputs"]["clip_l"] = promptText;
    promptWorkflow["41"]["inputs"]["t5xxl"] = promptText;
    promptWorkflow["31"]["inputs"]["seed"] = Math.floor(Math.random() * 1000000000000000);
    
    // Dimensiones (opcional, Flux suele ir bien en 1024)
    if (params.videoWidth) promptWorkflow["27"]["inputs"]["width"] = params.videoWidth;
    if (params.videoHeight) promptWorkflow["27"]["inputs"]["height"] = params.videoHeight;
    if (params.storyboardSteps) promptWorkflow["31"]["inputs"]["steps"] = params.storyboardSteps;
    
    const promptId = await queuePrompt(promptWorkflow);
    console.log(`🚀 Storyboard enviado a ComfyUI. ID: ${promptId}`);
    return promptId;
}

function broadcastComfyStatus(status) {
    if (!wss) {
        console.warn('⚠️ No se pudo difundir el estado: wss no está inicializado');
        return;
    }
    console.log(`📡 Difundiendo estado de ComfyUI a los clientes: ${status}`);
    wss.clients.forEach(client => {
        if (client.readyState === 1) { // 1 = OPEN
            client.send(JSON.stringify({ type: 'comfy_status', status }));
        }
    });
}

// Iniciar conexión con ComfyUI una vez que el servidor está listo
connectToComfy();

