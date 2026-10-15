// Cliente WS de prueba: manda una generación chica y cuenta lo que pasa.
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:5634');

const t0 = Date.now();
const seg = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
let listo = false;

ws.on('open', () => {
    console.log(seg(), 'conectado al ws de la app');
    ws.send(JSON.stringify({
        type: 'generarImagen',
        prompt: 'a red ball on white background, product shot',
        params: { modelo: 'zimage', samplerSteps: 4, videoWidth: 512, videoHeight: 512, cfgScale: 1 },
        batchId: 'ck-cola-' + Date.now(),
        batchName: 'prueba de cola'
    }));
    console.log(seg(), 'trabajo enviado (zimage 512x512, 4 steps)');
});

ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    const utiles = ['executing', 'progress', 'comfy_cola', 'storyboard_generated', 'video_generated', 'generation_error', 'comfy_status'];
    if (!utiles.includes(m.type)) return;
    if (m.type === 'progress') {
        if (m.value === m.max) console.log(seg(), `progress ${m.value}/${m.max}`);
        return;
    }
    if (m.type === 'comfy_cola') {
        console.log(seg(), `cola de ComfyUI -> ejecutando ${m.ejecutando} | esperando ${m.pendientes}`);
        return;
    }
    if (m.type === 'storyboard_generated' || m.type === 'video_generated') {
        console.log(seg(), `✅ ${m.type}: ${m.filename || m.url}`);
        listo = true;
        setTimeout(async () => {
            const r = await fetch('http://127.0.0.1:5634/api/comfy/cola').then(x => x.json()).catch(() => ({}));
            const q = await fetch('http://127.0.0.1:8188/queue').then(x => x.json()).catch(() => ({}));
            console.log(seg(), 'cola app ->', JSON.stringify(r));
            console.log(seg(), 'comfyui directo -> ejecutando', (q.queue_running || []).length, '| pendientes', (q.queue_pending || []).length);
            ws.close(); process.exit(0);
        }, 4000);
        return;
    }
    if (m.type === 'generation_error') { console.log(seg(), '❌', m.error); ws.close(); process.exit(1); return; }
    console.log(seg(), m.type, m.node !== undefined ? 'nodo ' + m.node : '');
});

ws.on('error', (e) => { console.log(seg(), 'ERROR', e.message); process.exit(1); });
setTimeout(() => { console.log(seg(), listo ? 'fin' : '⏱ TIMEOUT (no llegó el resultado)'); process.exit(listo ? 0 : 2); }, 150000);
