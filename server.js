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
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
const upload = multer({ dest: uploadDir });

const promptDetails = {};  // Almacena detalles del prompt

// ============================================
// COMFYUI WEBSOCKET CON RECONEXIÓN
// ============================================

let wsComfy;
function connectToComfy() {
    console.log(`Conectando a ComfyUI en ws://${serverAddress}/ws?clientId=${clientId}...`);
    wsComfy = new WebSocket(`ws://${serverAddress}/ws?clientId=${clientId}`);

    wsComfy.on('open', () => {
        console.log('✅ Conexión establecida con ComfyUI');
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

                // Buscar video en las distintas posibles salidas de ComfyUI
                let videoFound = null;
                const output = message.data.output;

                if (output.video) videoFound = output.video;
                else if (output.gifs) videoFound = output.gifs;
                else if (output.images) {
                    // Verificar si alguno de los "images" es en realidad un video
                    const imgs = Array.isArray(output.images) ? output.images : [output.images];
                    const possibleVideo = imgs.find(img => img.filename.endsWith('.webm') || img.filename.endsWith('.mp4'));
                    if (possibleVideo) videoFound = possibleVideo;
                }

                if (videoFound) {
                    const videoItems = Array.isArray(videoFound) ? videoFound : [videoFound];

                    for (const video of videoItems) {
                        console.log('📦 Procesando video encontrado:', video.filename);

                        const subfolder = video.subfolder || '';
                        const videoUrl = `http://${serverAddress}/view?filename=${encodeURIComponent(video.filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(video.type || 'output')}`;

                        const filenameOnly = path.basename(video.filename);
                        const targetDir = path.join(__dirname, 'public', 'videos');
                        const targetPath = path.join(targetDir, filenameOnly);

                        if (!fs.existsSync(targetDir)) {
                            fs.mkdirSync(targetDir, { recursive: true });
                        }

                        // Intentar borrar si ya existe para evitar bloqueos
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
                                    client.send(JSON.stringify({ type: 'video_downloading', message: 'Descargando video...' }));
                                }
                            });

                            await downloadImage(videoUrl, targetPath);
                            console.log(`✅ Video descargado: ${filenameOnly}`);

                            // Notificar al frontend
                            wss.clients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: 'video_generated',
                                        url: `/videos/${filenameOnly}`,
                                        prompt: details ? details.prompt : ''
                                    }));
                                }
                            });
                        } catch (error) {
                            console.error('❌ Error al descargar video:', error);
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
        setTimeout(connectToComfy, 5000);
    });

    wsComfy.on('error', (err) => {
        console.error('❌ Error en WebSocket de ComfyUI:', err.message);
    });
}

connectToComfy();

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

app.get('/api/videos', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const videosDir = path.join(__dirname, 'public', 'videos');
    if (!fs.existsSync(videosDir)) return res.json([]);

    fs.readdir(videosDir, (err, files) => {
        if (err) return res.json([]);
        const videoFiles = files
            .filter(file => /\.(webm|mp4|gif)$/i.test(file))
            .map(file => {
                const stats = fs.statSync(path.join(videosDir, file));
                return { filename: file, url: `/videos/${file}`, mtime: stats.mtime.getTime() };
            })
            .sort((a, b) => b.mtime - a.mtime);
        res.json(videoFiles);
    });
});

app.post('/api/blend-videos', async (req, res) => {
    try {
        const { videos, blendDuration = 1.0 } = req.body;
        if (!videos || videos.length < 2) return res.status(400).json({ error: 'Min 2 videos' });

        const videosDir = path.join(__dirname, 'public', 'videos');
        const outputFilename = `blended_${Date.now()}.webm`;
        const outputPath = path.join(videosDir, outputFilename);
        const videoInputs = videos.map(v => path.join(videosDir, v));

        // Obtener dimensiones del primer video
        const { stdout: info } = await execPromise(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${videoInputs[0]}"`);
        const [targetWidth, targetHeight] = info.trim().split('x').map(Number);

        let filterComplex = '';
        for (let i = 0; i < videos.length; i++) {
            filterComplex += `[${i}:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v${i}s];`;
        }

        let currentVideo = '[v0s]';
        let totalTime = 0;
        for (let i = 1; i < videos.length; i++) {
            const { stdout: dur } = await execPromise(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoInputs[i - 1]}"`);
            totalTime += parseFloat(dur.trim());
            const offset = Math.max(0, totalTime - blendDuration);
            const outputLabel = i === videos.length - 1 ? '[outv]' : `[vx${i}]`;
            filterComplex += `${currentVideo}[v${i}s]xfade=transition=fade:duration=${blendDuration}:offset=${offset}${outputLabel};`;
            currentVideo = `[vx${i}]`;
        }

        const inputs = videoInputs.map(v => `-i "${v}"`).join(' ');
        await execPromise(`ffmpeg ${inputs} -filter_complex "${filterComplex}" -map "[outv]" -c:v libvpx-vp9 -b:v 2M -y "${outputPath}"`);

        res.json({ success: true, filename: outputFilename, url: `/videos/${outputFilename}` });
    } catch (error) {
        console.error('Error blending:', error);
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
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            if (message.type === 'generarImagen') {
                console.log(`🎬 Petición generación: ${message.prompt} (${message.imageFilename ? 'I2V' : 'T2V'})`);
                const promptId = await generarVideo(message.prompt, message.params, message.imageFilename);
                promptDetails[promptId] = { prompt: message.prompt };
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
    promptWorkflow["3"]["inputs"]["text"] = promptText;
    promptWorkflow["11"]["inputs"]["noise_seed"] = Math.floor(Math.random() * 1000000000);
    promptWorkflow["67"]["inputs"]["noise_seed"] = Math.floor(Math.random() * 1000000000);

    if (isI2V) {
        promptWorkflow["200"]["inputs"]["image"] = imageFilename;
    } else {
        if (params.videoWidth) promptWorkflow["89"]["inputs"]["width"] = params.videoWidth;
        if (params.videoHeight) promptWorkflow["89"]["inputs"]["height"] = params.videoHeight;
    }

    if (params.videoLength) promptWorkflow["62"]["inputs"]["value"] = params.videoLength;
    if (params.samplerSteps) promptWorkflow["9"]["inputs"]["steps"] = params.samplerSteps;

    const promptId = await queuePrompt(promptWorkflow);
    console.log(`🚀 Prompt enviado a ComfyUI. ID: ${promptId}`);
    return promptId;
}
