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
require('dotenv').config();

// Telegram Bot (auto-sends generated media)
const telegramBot = require('./telegram-bot.js');

// Default Telegram settings
const TELEGRAM_ENABLED = !!process.env.TELEGRAM_BOT_TOKEN;
if (TELEGRAM_ENABLED) {
    console.log('🤖 Telegram Bot enabled');
} else {
    console.log('🤖 Telegram Bot disabled — set TELEGRAM_BOT_TOKEN in .env');
}

const ipglobal = process.env.COMFYUI_ADDRESS || "127.0.0.1"; // Default to localhost
const serverAddress = ipglobal.includes(':') ? ipglobal : `${ipglobal}:8188`;
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

            if (message.type === 'execution_error') {
                console.error('❌ ComfyUI execution error:', JSON.stringify(message.data).substring(0, 500));
                const promptId = message.data?.prompt_id;
                const errorDetail = message.data?.exception_message || message.data?.exception?.message || JSON.stringify(message.data).substring(0, 300);
                const nodeId = message.data?.node_id || 'unknown';
                
                // Broadcast error to all clients
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'generation_error',
                            error: `❌ ComfyUI execution error (node ${nodeId}): ${errorDetail}`,
                            prompt_id: promptId,
                            node: nodeId
                        }));
                    }
                });
                
                // Clean up prompt details for this prompt_id
                if (promptId && promptDetails[promptId]) {
                    delete promptDetails[promptId];
                }
            }

            if (message.type === 'executed') {
                const promptId = message.data.prompt_id;
                const details = promptDetails[promptId];
                console.log(`🎬 Ejecución completada para el nodo: ${message.data.node} (Prompt ID: ${promptId})`);

                // Buscar video o imagen en las distintas posibles salidas de ComfyUI
                let assetFound = null;
                let assetType = 'video';
                const output = message.data.output || {};

                if (output.video) assetFound = output.video;
                else if (output.gifs) assetFound = output.gifs;
                else if (output.images) {
                    const imgs = Array.isArray(output.images) ? output.images : [output.images];
                    if (imgs.length === 0) {
                        console.log(`   ⚠️ output.images is empty array for node ${message.data.node}`);
                    }
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

                if (!assetFound && message.data.node) {
                    console.log(`   ℹ️ No downloadable asset for node ${message.data.node}${output.images ? ` (images=${Array.isArray(output.images) ? output.images.length : typeof output.images})` : ''}${output.video ? ' (has video)' : ''}${output.gifs ? ' (has gifs)' : ''}`);
                }

                if (assetFound) {
                    console.log(`   ✅ Asset found for node ${message.data.node}: ${assetType} count=${Array.isArray(assetFound) ? assetFound.length : 1}`);
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
                                    prompt_id: promptId,
                                    batchId: metaToSave.batchId,
                                    batchName: metaToSave.batchName,
                                    type: metaToSave.type || 'video'
                                });
                            } else {
                                saveImageMetadata(filenameOnly, {
                                    prompt: metaToSave.prompt,
                                    params: metaToSave.params,
                                    storyboardIndex: metaToSave.storyboardIndex,
                                    batchId: metaToSave.batchId,
                                    batchName: metaToSave.batchName,
                                    prompt_id: promptId,
                                    isForWan: metaToSave.isForWan,
                                    wanRole: metaToSave.wanRole,
                                    wanId: metaToSave.wanId
                                });
                            }

                            // Notificar al frontend
                            wss.clients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    const msg = {
                                        type: assetType === 'video' ? 'video_generated' : 'storyboard_generated',
                                        url: `/${targetSubdir}/${filenameOnly}`,
                                        filename: filenameOnly,
                                        prompt: metaToSave.prompt,
                                        storyboardIndex: metaToSave.storyboardIndex,
                                        batchId: metaToSave.batchId,
                                        prompt_id: promptId
                                    };
                                    // Include WAN2.2 specific info if applicable
                                    if (metaToSave.isForWan) {
                                        msg.isForWan = true;
                                        msg.wanRole = metaToSave.wanRole;
                                        msg.wanId = metaToSave.wanId;
                                        msg.wanStepIndex = metaToSave.wanStepIndex;
                                    }
                                    client.send(JSON.stringify(msg));
                                }
                            });

                            // Enviar a Telegram automáticamente si está configurado
                            if (TELEGRAM_ENABLED && telegramBot.getDefaultChatId()) {
                                const telegramCaption = `🎬 <b>${assetType === 'video' ? 'Video' : 'Image'} Generated</b>\n\n📝 <code>${(metaToSave.prompt || '').substring(0, 200)}</code>`;
                                const telegramPromise = assetType === 'video'
                                    ? telegramBot.sendVideoToTelegram(null, targetPath, telegramCaption)
                                    : telegramBot.sendPhotoToTelegram(null, targetPath, telegramCaption);
                                telegramPromise
                                    .then(() => console.log(`🤖 Sent ${assetType} to Telegram: ${filenameOnly}`))
                                    .catch(err => console.warn(`🤖 Failed to send ${assetType} to Telegram: ${err.message}`));
                            }
                        } catch (error) {
                            console.error(`❌ Error al descargar ${assetType}:`, error);
                            // Notify frontend about the failure so it can recover the queue
                            const errorMsg = `❌ Failed to download ${assetType} from ComfyUI: ${error.message || error}`;
                            wss.clients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: 'generation_error',
                                        error: errorMsg,
                                        prompt_id: promptId
                                    }));
                                }
                            });
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
// GENERATION TIMEOUT CHECKER
// ============================================
const GENERATION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes max

setInterval(() => {
    const now = Date.now();
    Object.keys(promptDetails).forEach(promptId => {
        const details = promptDetails[promptId];
        if (details && details.generationStartTime) {
            const elapsed = now - details.generationStartTime;
            if (elapsed > GENERATION_TIMEOUT_MS) {
                console.error(`⏰ Hard timeout for prompt ${promptId}: ${Math.round(elapsed / 60000)} min`);
                
                // Notify frontend
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'queue_timeout',
                            error: `⏰ Hard timeout: generation exceeded 30 minutes`,
                            prompt_id: promptId
                        }));
                    }
                });
                
                // Clean up
                delete promptDetails[promptId];
            }
        }
    });
}, 60000); // Check every 60 seconds

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


app.post('/api/generate-avatar', upload.fields([
    { name: 'audio', maxCount: 1 },
    { name: 'image', maxCount: 1 }
]), async (req, res) => {
    try {
        if (!req.files || !req.files['audio']) {
            return res.status(400).json({ error: 'Se requiere un archivo de audio' });
        }
        
        const prompt = req.body.prompt || '';
        const resolution = req.body.resolution || '480p';
        
        // Procesar audio
        const audioFile = req.files['audio'][0];
        const audioExt = path.extname(audioFile.originalname) || '.mp3';
        const audioFilename = `longcat_audio_${Date.now()}${audioExt}`;
        const audioPath = path.join(__dirname, 'public', 'uploads', audioFilename);
        fs.renameSync(audioFile.path, audioPath);
        
        // Procesar imagen (opcional)
        let imageFilename = null;
        if (req.files['image']) {
            const imgFile = req.files['image'][0];
            const imgExt = path.extname(imgFile.originalname) || '.png';
            imageFilename = `longcat_img_${Date.now()}${imgExt}`;
            const imgPath = path.join(__dirname, 'public', 'uploads', imageFilename);
            fs.renameSync(imgFile.path, imgPath);
        }
        
        // Generar avatar via WebSocket (para que el frontend reciba updates)
        const outputFilename = `longcat_${Date.now()}.mp4`;
        const outputPath = path.join(__dirname, 'public', 'videos', outputFilename);
        const scriptPath = path.join(__dirname, 'longcat_avatar.py');
        
        if (!fs.existsSync(scriptPath)) {
            return res.status(500).json({ error: 'Script LongCat no encontrado. Ejecutá setup primero.' });
        }
        
        const mode = imageFilename ? 'ai2v' : 'at2v';
        let cmd = `"${process.execPath}" "${scriptPath}" --no_setup --mode ${mode} --audio "${audioPath}" --prompt "${prompt.replace(/"/g, '\\"')}" --output "${outputPath}" --resolution ${resolution} --use_int8`;
        if (imageFilename) {
            const imgPath = path.join(__dirname, 'public', 'uploads', imageFilename);
            cmd += ` --image "${imgPath}"`;
        }
        
        console.log(`🐱 [REST] LongCat generando: ${outputFilename}`);
        
        // Responder inmediatamente con el filename
        // La generación corre en background
        exec(cmd, { timeout: 1800000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                console.error(`❌ [REST] LongCat error: ${error.message}`);
                return;
            }
            console.log(`✅ [REST] LongCat completado: ${outputFilename}`);
            
            // Guardar metadata
            saveVideoMetadata(outputFilename, {
                prompt: prompt,
                params: { resolution, mode },
                type: 'longcat-avatar'
            });
            
            // Notificar frontend
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'video_generated',
                        url: `/videos/${outputFilename}`,
                        filename: outputFilename,
                        prompt: prompt,
                        prompt_id: 'longcat-' + Date.now()
                    }));
                }
            });
        });
        
        res.json({
            success: true,
            message: 'Generación de avatar iniciada',
            outputFilename: outputFilename,
            estimatedTime: '5-10 minutos'
        });
    } catch (error) {
        console.error('Error generating avatar:', error);
        res.status(500).json({ error: error.message });
    }
});


app.post('/api/setup-longcat', async (req, res) => {
    try {
        const scriptPath = path.join(__dirname, 'longcat_avatar.py');
        if (!fs.existsSync(scriptPath)) {
            return res.status(500).json({ error: 'longcat_avatar.py no encontrado' });
        }
        
        res.json({ 
            success: true, 
            message: 'Setup iniciado. Corré: python longcat_avatar.py --help',
            instructions: [
                '1. Asegurate de tener Python 3.10+ y CUDA 12.4',
                '2. El script descargará automáticamente el modelo (~75GB)',
                '3. Corré: python longcat_avatar.py --mode at2v --audio test.mp3 --prompt "test" --output test.mp4',
                '4. Requiere ~24GB VRAM con --use_int8',
                '5. Opcional: git clone https://github.com/meituan-longcat/LongCat-Video.git'
            ]
        });
    } catch (error) {
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
        const { clips, batchId, batchName } = req.body;
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

            // --- AUDIO (En cualquier clip que lo tenga y NO este muteado) ---
            const hasAudio = await checkAudio(clipPath);
            if (hasAudio && !c.muted) {
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

        // Recopilar todos los prompts de los clips para metadata completo
        const clipPrompts = clips.map(c => c.prompt || 'Unknown').filter(p => p && p !== 'Unknown');
        const combinedPrompt = clipPrompts.length > 0 ? clipPrompts.join(' | ') : 'Final Project Export';

        saveVideoMetadata(outputFilename, {
            prompt: combinedPrompt,
            isExport: true,
            clipCount: clips.length,
            duration: totalDuration,
            batchId: batchId || null,
            batchName: batchName || null,
            clips: clips.map(c => ({
                filename: c.filename,
                prompt: c.prompt,
                startTime: c.startTime,
                duration: c.duration
            })),
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

// ============================================
// OLLAMA PROMPT ENHANCER
// ============================================

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

app.get('/api/list-ollama-models', async (req, res) => {
    try {
        const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
        if (!response.ok) throw new Error(`Ollama responded with ${response.status}`);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        const isConnRefused = error?.cause?.code === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED';
        if (!isConnRefused) console.error('Error listing Ollama models:', error);
        res.json({ models: [] });
    }
});

app.post('/api/enhance-prompt', async (req, res) => {
    try {
        const { text, modelName } = req.body;
        if (!text) return res.status(400).json({ error: 'No prompt text provided' });

        const ollamaModel = modelName || 'llama3.2:latest';

        const skillPath = path.join(__dirname, '.agents', 'skills', 'prompt_master', 'SKILL.md');
        let skillGuide = "";
        try {
            skillGuide = fs.readFileSync(skillPath, 'utf8');
        } catch (e) {
            console.warn("⚠️ No se pudo leer SKILL.md");
        }

        const promptText = `
        Sos un asistente experto en ingeniería de prompts para modelos de IA como Flux y LTX-2. 
        Tu tarea es tomar la siguiente "Idea del Usuario" y generar un JSON de batch siguiendo ESTRICTAMENTE las reglas de esta guía de estilo:

        --- GUIA DE ESTILO (SKILL.MD) ---
        ${skillGuide}
        --- FIN GUIA ---

        IDEA DEL USUARIO: "${text}"

        REGLAS DE SALIDA:
        - Debes devolver ÚNICAMENTE el JSON válido.
        - El JSON debe tener llaves "globalImage", "globalVideo" y un array "steps".
        - "globalImage" debe definir el estilo visual de alta calidad basado en la guía.
        - "globalVideo" debe definir el tono de voz y estilo de cámara global basado en la guía.
        - Crea al menos de 3 a 5 "steps" que cuenten una pequeña historia basada en la idea.
        - Cada step debe tener "PROMPT IMAGE" (detalles visuales de Flux) y "VIDEO IMAGE" (acción, cámara y diálogos entre comillas para LTX-2).
        - Asegura la consistencia de los sujetos en todos los pasos.
        - NO incluyas explicaciones fuera del bloque JSON.
        `;

        const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: ollamaModel,
                prompt: promptText,
                stream: false
            })
        });
        if (!ollamaRes.ok) throw new Error(`Ollama responded with ${ollamaRes.status}`);
        const ollamaData = await ollamaRes.json();
        const generatedText = ollamaData.response || "";

        const jsonMatch = generatedText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const cleanJson = JSON.parse(jsonMatch[0]);
            res.json(cleanJson);
        } else {
            throw new Error("No se pudo extraer un JSON válido de la respuesta de Ollama.");
        }

    } catch (error) {
        console.error('Error enhancing prompt:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/improve-step-prompt', async (req, res) => {
    try {
        const { text, type, modelName } = req.body;
        if (!text) return res.status(400).json({ error: 'No prompt text provided' });

        const ollamaModel = modelName || 'llama3.2:latest';
        const skillPath = path.join(__dirname, '.agents', 'skills', 'prompt_master', 'SKILL.md');
        let skillGuide = "";
        try { skillGuide = fs.readFileSync(skillPath, 'utf8'); } catch (e) {}

        const promptText = `
        Sos un asistente experto en ingeniería de prompts. 
        Tu tarea es mejorar el siguiente prompt de usuario para que sea de alta calidad.
        
        --- GUIA DE ESTILO ---
        ${skillGuide}
        --- FIN GUIA ---

        TIPO DE PROMPT: ${type === 'video' ? 'VIDEO / ANIMACIÓN (LTX-2)' : 'IMAGEN ESTÁTICA (FLUX)'}
        PROMPT ORIGINAL: "${text}"

        REGLAS DE SALIDA:
        - Devuelve ÚNICAMENTE el texto del prompt mejorado.
        - NO incluyas introducciones, explicaciones ni comillas externas.
        - Asegúrate de seguir las reglas de estilo de la guía (detalles técnicos, iluminación, cámara, etc).
        `;

        const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: ollamaModel,
                prompt: promptText,
                stream: false
            })
        });
        
        if (!ollamaRes.ok) throw new Error(`Ollama responded with ${ollamaRes.status}`);
        const ollamaData = await ollamaRes.json();
        res.json({ improvedText: ollamaData.response.trim() });

    } catch (error) {
        console.error('Error improving step prompt:', error);
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
// TELEGRAM BOT API ENDPOINT
// ============================================

app.post('/api/send-to-telegram', async (req, res) => {
    try {
        const { filename, type, chatId, caption } = req.body;

        if (!filename) {
            return res.status(400).json({ error: 'filename is required' });
        }

        // Determine the file path based on type
        let filePath;
        if (type === 'video') {
            filePath = path.join(__dirname, 'public', 'videos', filename);
        } else {
            // Default to uploads for images
            filePath = path.join(__dirname, 'public', 'uploads', filename);
        }

        // If the file doesn't exist in the default location, try the other
        if (!fs.existsSync(filePath)) {
            const altPath = type === 'video'
                ? path.join(__dirname, 'public', 'uploads', filename)
                : path.join(__dirname, 'public', 'videos', filename);
            if (fs.existsSync(altPath)) {
                filePath = altPath;
            } else {
                return res.status(404).json({ error: `File not found: ${filename}` });
            }
        }

        if (!TELEGRAM_ENABLED) {
            return res.status(400).json({ error: 'Telegram Bot not configured (TELEGRAM_BOT_TOKEN missing)' });
        }

        const targetChatId = chatId || telegramBot.getDefaultChatId();
        if (!targetChatId) {
            return res.status(400).json({ error: 'No chat ID provided and TELEGRAM_CHAT_ID not configured' });
        }

        const fileType = type || 'image';
        let result;

        if (fileType === 'video') {
            result = await telegramBot.sendVideoToTelegram(targetChatId, filePath, caption || '');
            console.log(`🤖 Sent video ${filename} to Telegram chat ${targetChatId}`);
        } else {
            result = await telegramBot.sendPhotoToTelegram(targetChatId, filePath, caption || '');
            console.log(`🤖 Sent image ${filename} to Telegram chat ${targetChatId}`);
        }

        res.json({
            success: true,
            message_id: result.result?.message_id,
            chat: result.result?.chat
        });
    } catch (error) {
        console.error('❌ Error sending to Telegram:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// SERVIDOR Y WEBSOCKETS CLIENTES
// ============================================

const port = 5634;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.error(`❌ Error: El puerto ${port} ya está en uso.`);
        console.error(`💡 Probablemente el servidor ya esté corriendo en otra ventana. Ciérrala e intenta de nuevo.`);
        process.exit(1);
    }
});

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
            if (message.type === 'request_queue_state') {
                // Send back the current prompt_ids that are being tracked by the server
                const activePromptIds = Object.keys(promptDetails).map(pid => ({
                    prompt_id: pid,
                    details: promptDetails[pid]
                }));
                ws.send(JSON.stringify({
                    type: 'queue_state',
                    activePrompts: activePromptIds,
                    comfyConnected: wsComfy && wsComfy.readyState === 1 ? true : false
                }));
                console.log(`📡 Sent queue state to reconnecting client: ${activePromptIds.length} active prompts`);
                return;
            }
            if (message.type === 'generarImagen') {
                const mode = message.imageFilename ? 'I2V' : 'T2V';
                console.log(`\n🎬 [${mode}] Nueva generación recibida`);
                console.log(`   Batch   : ${message.batchName || message.batchId || 'sin batch'}`);
                console.log(`   Prompt  : ${message.prompt}`);
                console.log(`   Imagen  : ${message.imageFilename || 'ninguna'}`);
                console.log(`   Params  : steps=${message.params?.samplerSteps} cfg=${message.params?.cfgScale} size=${message.params?.videoWidth}x${message.params?.videoHeight}`);
                try {
                    const promptId = await generarVideo(message.prompt, message.params, message.imageFilename);
                    console.log(`   ✅ Enviado a ComfyUI — prompt_id: ${promptId}`);
                    const details = { 
                        prompt: message.prompt,
                        params: message.params,
                        imageFilename: message.imageFilename,
                        type: 'video',
                        batchId: message.batchId,
                        batchName: message.batchName,
                        generationStartTime: Date.now()
                    };
                    promptDetails[promptId] = details;
                    lastPromptDetails = details;
                    
                    // NOTIFICAR AL FRONTEND: enviar el prompt_id real de ComfyUI
                    ws.send(JSON.stringify({
                        type: 'prompt_queued',
                        prompt_id: promptId,
                        queueItemId: message.queueItemId || null
                    }));
                } catch (e) {
                    console.error(`❌ Error generando video: ${e.message}`);
                    ws.send(JSON.stringify({ type: 'generation_error', error: `❌ Error generando video: ${e.message}` }));
                }
            } else if (message.type === 'generarStoryboard') {
                const wanTag = message.isForWan ? ` [WAN2.2 ${message.wanRole} step=${message.wanStepIndex}]` : '';
                console.log(`\n🖼️ [FLUX${wanTag}] Nueva generación recibida`);
                console.log(`   Batch   : ${message.batchName || message.batchId || 'sin batch'}`);
                console.log(`   Prompt  : ${message.prompt}`);
                console.log(`   Params  : steps=${message.params?.storyboardSteps || 'default'}`);
                try {
                    const promptId = await generarStoryboard(message.prompt, message.params, message.storyboardIndex, message.batchId);
                    console.log(`   ✅ Enviado a ComfyUI — prompt_id: ${promptId}`);
                    const details = { 
                        prompt: message.prompt,
                        params: message.params,
                        type: 'storyboard',
                        storyboardIndex: message.storyboardIndex,
                        batchId: message.batchId,
                        batchName: message.batchName,
                        isForWan: message.isForWan || false,
                        wanRole: message.wanRole || null,
                        wanId: message.wanId || null,
                        wanStepIndex: message.wanStepIndex !== undefined ? message.wanStepIndex : null,
                        generationStartTime: Date.now()
                    };
                    promptDetails[promptId] = details;
                    lastPromptDetails = details;
                    
                    // NOTIFICAR AL FRONTEND: enviar el prompt_id real de ComfyUI
                    ws.send(JSON.stringify({
                        type: 'prompt_queued',
                        prompt_id: promptId,
                        queueItemId: message.queueItemId || null
                    }));
                } catch (e) {
                    console.error(`❌ Error generando storyboard: ${e.message}`);
                    ws.send(JSON.stringify({ type: 'generation_error', error: `❌ Error generando storyboard: ${e.message}` }));
                }
            } else if (message.type === 'generarWan22') {
                console.log(`\n🔥 [WAN2.2] Nueva generación recibida`);
                console.log(`   Batch   : ${message.batchName || message.batchId || 'sin batch'}`);
                console.log(`   Prompt  : ${message.prompt}`);
                console.log(`   Start   : ${message.startImageFilename || 'ninguna'}`);
                console.log(`   End     : ${message.endImageFilename || 'ninguna'}`);
                console.log(`   Params  : steps=${message.params?.samplerSteps} cfg=${message.params?.cfgScale} size=${message.params?.videoWidth}x${message.params?.videoHeight} length=${message.params?.videoLength}`);
                try {
                    const promptId = await generarWan22Video(message.prompt, message.params, message.startImageFilename, message.endImageFilename);
                    console.log(`   ✅ Enviado a ComfyUI — prompt_id: ${promptId}`);
                    const details = { 
                        prompt: message.prompt,
                        params: message.params,
                        type: 'wan22',
                        startImageFilename: message.startImageFilename,
                        endImageFilename: message.endImageFilename,
                        batchId: message.batchId,
                        batchName: message.batchName
                    };
                    promptDetails[promptId] = details;
                    lastPromptDetails = details;
                    
                    // NOTIFICAR AL FRONTEND: enviar el prompt_id real de ComfyUI
                    ws.send(JSON.stringify({
                        type: 'prompt_queued',
                        prompt_id: promptId,
                        queueItemId: message.queueItemId || null
                    }));
                } catch (e) {
                    console.error(`❌ Error generando WAN2.2 video: ${e.message}`);
                    ws.send(JSON.stringify({ type: 'generation_error', error: `❌ Error generando WAN2.2 video: ${e.message}` }));
                }
            } else if (message.type === 'generarLongCat') {
                const mode = message.imageFilename ? 'AI2V' : 'AT2V';
                console.log(`\n🐱 [LONGCAT ${mode}] Nueva generación de avatar recibida`);
                console.log(`   Prompt  : ${message.prompt}`);
                console.log(`   Audio   : ${message.audioFilename || 'ninguno'}`);
                console.log(`   Imagen  : ${message.imageFilename || 'ninguna'}`);
                console.log(`   Res     : ${message.params?.resolution || '480p'}`);
                try {
                    const result = await generarLongCat(message);
                    console.log(`   ✅ Video de avatar generado: ${result.filename}`);
                    const details = {
                        prompt: message.prompt,
                        params: message.params,
                        type: 'longcat',
                        audioFilename: message.audioFilename,
                        imageFilename: message.imageFilename,
                        batchId: message.batchId,
                        batchName: message.batchName
                    };
                    // Notificar al frontend
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'video_generated',
                                url: `/videos/${result.filename}`,
                                filename: result.filename,
                                prompt: message.prompt,
                                prompt_id: 'longcat-' + Date.now()
                            }));
                        }
                    });
                } catch (e) {
                    console.error(`❌ Error generando LongCat avatar: ${e.message}`);
                    ws.send(JSON.stringify({ type: 'generation_error', error: `❌ Error generando LongCat avatar: ${e.message}` }));
                }
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
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) {
                        const errorDetail = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error);
                        const nodeErrors = parsed.node_errors ? '\nNode errors: ' + JSON.stringify(parsed.node_errors) : '';
                        reject(new Error(`ComfyUI rejected the prompt: ${errorDetail}${nodeErrors}`));
                    } else if (!parsed.prompt_id) {
                        reject(new Error(`ComfyUI returned no prompt_id. Response: ${data.substring(0, 300)}`));
                    } else {
                        resolve(parsed.prompt_id);
                    }
                } catch (e) {
                    reject(new Error(`Failed to parse ComfyUI response: ${e.message}. Raw: ${data.substring(0, 300)}`));
                }
            });
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

    // Normalize sg_XX_ prefixed node IDs (I2V workflow from ComfyUI exports with sg_92_ prefix)
    const keys = Object.keys(promptWorkflow);
    for (const key of keys) {
        const match = key.match(/^sg_\d+_(.+)$/);
        if (match) {
            promptWorkflow[match[1]] = promptWorkflow[key];
            delete promptWorkflow[key];
        }
    }
    
    // Also normalize internal node references (e.g. ["sg_92_107", 0] -> ["107", 0])
    // ComfyUI connection arrays reference other nodes by their key, so sg_ prefixes must be stripped
    for (const [nodeKey, node] of Object.entries(promptWorkflow)) {
        if (!node || !node.inputs) continue;
        for (const [inputKey, inputVal] of Object.entries(node.inputs)) {
            if (Array.isArray(inputVal) && typeof inputVal[0] === 'string' && inputVal[0].match(/^sg_\d+_\d+$/)) {
                const m = inputVal[0].match(/^sg_\d+_(\d+)$/);
                if (m) {
                    node.inputs[inputKey][0] = m[1];
                }
            }
        }
    }

    // Configurar workflow
    if (isI2V) {
        // Validate required nodes exist
        ['3','4','11','67','98','47','107','108','62','9'].forEach(n => {
            if (!promptWorkflow[n]) {
                console.error(`[I2V] NODE ${n} MISSING after normalization!`);
                console.error(`[I2V] Available keys (${Object.keys(promptWorkflow).length}):`, Object.keys(promptWorkflow).sort((a,b)=>Number(a)-Number(b)).join(', '));
                throw new Error(`Node "${n}" not found in I2V workflow after sg_ prefix normalization`);
            }
        });
        promptWorkflow["3"]["inputs"]["text"] = promptText;
        if (params.negativePrompt) promptWorkflow["4"]["inputs"]["text"] = params.negativePrompt;
        
        const seedValue = (params.seed !== undefined && params.seed !== -1) ? params.seed : Math.floor(Math.random() * 1000000000);
        promptWorkflow["11"]["inputs"]["noise_seed"] = seedValue;
        promptWorkflow["67"]["inputs"]["noise_seed"] = seedValue;
        
        // Note: node 98 is LoadImage in the I2V workflow (was node 200 in old workflow)
        promptWorkflow["98"]["inputs"]["image"] = imageFilename;
        
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
        if (promptWorkflow["67"]) promptWorkflow["67"]["inputs"]["noise_seed"] = seedValue;

        if (params.videoWidth) promptWorkflow["89"]["inputs"]["width"] = params.videoWidth;
        if (params.videoHeight) promptWorkflow["89"]["inputs"]["height"] = params.videoHeight;
        if (params.cfgScale) promptWorkflow["47"]["inputs"]["cfg"] = params.cfgScale;

        // SAFETY: Always fix EmptyImage batch_size=1 (workflow JSON may be corrupt)
        if (promptWorkflow["89"] && promptWorkflow["89"].inputs) {
            promptWorkflow["89"]["inputs"]["batch_size"] = 1;
            promptWorkflow["89"]["inputs"]["color"] = 0;
        }

        // SAFETY: Clamp videoLength — 169 frames max (~7s at 24fps) to prevent OOM on 24GB VRAM
        if (params.videoLength) {
            promptWorkflow["62"]["inputs"]["value"] = Math.min(params.videoLength, 169);
        } else {
            promptWorkflow["62"]["inputs"]["value"] = 97; // default safe value
        }
    }

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

async function generarWan22Video(promptText, params = {}, startImageFilename = null, endImageFilename = null) {
    const workflowFile = 'video_wan2_2_14B_flf2v_api.json';
    const data = await fs.promises.readFile(path.join(__dirname, workflowFile), 'utf8');
    const promptWorkflow = JSON.parse(data);

    // Configurar el workflow WAN2.2
    // Texto del prompt
    promptWorkflow["90"]["inputs"]["text"] = promptText;
    
    // Configurar imágenes de inicio y fin si están disponibles
    if (startImageFilename) {
        promptWorkflow["80"]["inputs"]["image"] = startImageFilename;
    }
    if (endImageFilename) {
        promptWorkflow["89"]["inputs"]["image"] = endImageFilename;
    }
    
    // Configurar dimensiones y parámetros
    if (params.videoWidth) {
        promptWorkflow["81"]["inputs"]["width"] = params.videoWidth;
    }
    if (params.videoHeight) {
        promptWorkflow["81"]["inputs"]["height"] = params.videoHeight;
    }
    if (params.videoLength) {
        promptWorkflow["81"]["inputs"]["length"] = params.videoLength;
    }
    if (params.samplerSteps) {
        promptWorkflow["84"]["inputs"]["steps"] = params.samplerSteps;
    }
    if (params.cfgScale) {
        promptWorkflow["84"]["inputs"]["cfg"] = params.cfgScale;
    }
    
    // Seed
    const seedValue = (params.seed !== undefined && params.seed !== -1) ? params.seed : Math.floor(Math.random() * 1000000000000000);
    promptWorkflow["84"]["inputs"]["noise_seed"] = seedValue;

    const promptId = await queuePrompt(promptWorkflow);
    console.log(`🚀 WAN2.2 prompt enviado a ComfyUI. ID: ${promptId}`);
    return promptId;
}

// ============================================
// LONGCAT: Audio-Driven Avatar Generation
// ============================================

async function generarLongCat(message) {
    const { execSync } = require('child_process');
    const prompt = message.prompt || '';
    const audioFilename = message.audioFilename || '';
    const imageFilename = message.imageFilename || null;
    const resolution = message.params?.resolution || '480p';
    const useInt8 = message.params?.useInt8 !== false; // default true
    
    // Validar que tenemos audio
    if (!audioFilename) {
        throw new Error('Se requiere un archivo de audio para LongCat');
    }
    
    // Construir paths
    const audioPath = path.join(__dirname, 'public', 'uploads', audioFilename);
    let imagePath = null;
    if (imageFilename) {
        imagePath = path.join(__dirname, 'public', 'uploads', imageFilename);
    }
    
    // Verificar que existe el audio
    if (!fs.existsSync(audioPath)) {
        throw new Error(`Archivo de audio no encontrado: ${audioPath}`);
    }
    
    const outputFilename = `longcat_${Date.now()}.mp4`;
    const outputPath = path.join(__dirname, 'public', 'videos', outputFilename);
    const scriptPath = path.join(__dirname, 'longcat_avatar.py');
    
    // Si no existe el script, crearlo (ya debería estar)
    if (!fs.existsSync(scriptPath)) {
        throw new Error(`Script LongCat no encontrado: ${scriptPath}`);
    }
    
    // Construir comando
    const mode = imageFilename ? 'ai2v' : 'at2v';
    let cmd = `"${process.execPath}" "${scriptPath}" --mode ${mode} --audio "${audioPath}" --prompt "${prompt.replace(/"/g, '\\"')}" --output "${outputPath}" --resolution ${resolution}`;
    
    if (useInt8) cmd += ' --use_int8';
    if (imagePath) cmd += ` --image "${imagePath}"`;
    
    console.log(`🐱 Ejecutando LongCat: ${cmd.substring(0, 200)}...`);
    
    // Informar inicio
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ 
                type: 'executing', 
                node: 'LongCat-Avatar',
                message: 'Generando avatar con audio... (puede tomar 5-10 minutos)'
            }));
        }
    });
    
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        
        exec(cmd, { timeout: 1800000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            
            if (error) {
                console.error(`❌ LongCat error (${elapsed}s): ${error.message}`);
                console.error(`   stderr: ${(stderr || '').substring(0, 500)}`);
                reject(new Error(`LongCat falló: ${error.message}. stderr: ${(stderr || '').substring(0, 200)}`));
                return;
            }
            
            // Intentar parsear la salida JSON
            let resultData = null;
            for (const line of stdout.split('\n')) {
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.success !== undefined) {
                        resultData = parsed;
                        break;
                    }
                } catch (e) { /* ignorar líneas que no son JSON */ }
            }
            
            console.log(`✅ LongCat completado (${elapsed}s)`);
            
            if (resultData && resultData.success) {
                // Guardar metadata
                saveVideoMetadata(outputFilename, {
                    prompt: prompt,
                    params: { resolution, mode, useInt8 },
                    type: 'longcat-avatar',
                    elapsed_seconds: elapsed
                });
                
                resolve({ filename: outputFilename });
            } else if (fs.existsSync(outputPath)) {
                // Fallback: si existe el archivo, asumimos éxito
                saveVideoMetadata(outputFilename, {
                    prompt: prompt,
                    params: { resolution, mode, useInt8 },
                    type: 'longcat-avatar',
                    elapsed_seconds: elapsed
                });
                resolve({ filename: outputFilename });
            } else {
                const errorMsg = resultData?.error || 'No se generó video';
                console.error(`❌ LongCat: ${errorMsg}`);
                reject(new Error(errorMsg));
            }
        });
    });
}

// ============================================
// PRESETS API (Save/Load per-workflow presets)
// ============================================
const PRESETS_DIR = path.join(__dirname, 'public', 'presets');
if (!fs.existsSync(PRESETS_DIR)) fs.mkdirSync(PRESETS_DIR, { recursive: true });

// GET /api/presets/:workflow — list all presets for a workflow
app.get('/api/presets/:workflow', (req, res) => {
    const { workflow } = req.params;
    const wfDir = path.join(PRESETS_DIR, workflow);
    if (!fs.existsSync(wfDir)) return res.json([]);
    try {
        const files = fs.readdirSync(wfDir)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                const name = f.replace(/\.json$/, '');
                const fullPath = path.join(wfDir, f);
                const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
                return { name, ...data, _path: fullPath };
            })
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        res.json(files);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/presets/:workflow — save a new preset
app.post('/api/presets/:workflow', (req, res) => {
    try {
        const { workflow } = req.params;
        const { name, label, data } = req.body;
        if (!name || !data) return res.status(400).json({ error: 'name and data required' });
        
        const wfDir = path.join(PRESETS_DIR, workflow);
        if (!fs.existsSync(wfDir)) fs.mkdirSync(wfDir, { recursive: true });
        
        const safeName = name.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
        if (!safeName) return res.status(400).json({ error: 'Invalid preset name' });
        
        const presetPath = path.join(wfDir, `${safeName}.json`);
        const preset = {
            label: label || safeName,
            data,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        fs.writeFileSync(presetPath, JSON.stringify(preset, null, 2));
        
        console.log(`💾 Preset saved: ${workflow}/${safeName}`);
        res.json({ success: true, name: safeName });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/presets/:workflow/:name — delete a preset
app.delete('/api/presets/:workflow/:name', (req, res) => {
    try {
        const { workflow, name } = req.params;
        const safeName = name.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
        const presetPath = path.join(PRESETS_DIR, workflow, `${safeName}.json`);
        if (fs.existsSync(presetPath)) {
            fs.unlinkSync(presetPath);
            console.log(`🗑️ Preset deleted: ${workflow}/${safeName}`);
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Preset not found' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Iniciar conexión con ComfyUI una vez que el servidor está listo
connectToComfy();

