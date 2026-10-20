// Prueba de la cadena completa: pide el trabajo como lo hace la web, escucha
// el stream que recibe el navegador y verifica que llega el aviso de la nube.
const WebSocket = require('ws');
const HUB = 'https://vps-4455523-x.dattaweb.com/comfylatam';
const TOKEN = process.env.TOKEN || 'comfylatam-nodo-2026';
const PEER = 'nodo-81c5eec9';
const PROMPT = process.env.PROMPT || 'A cinematic portrait of a gaucho under a giant Argentine Sun of May, golden hour, solarpunk Buenos Aires, film grain';

const t0 = Date.now();
const seg = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
const vistos = [];

const ws = new WebSocket('ws://127.0.0.1:5634');
ws.on('open', async () => {
    console.log(seg(), 'conectado al stream de la app (lo mismo que ve el navegador)');
    const r = await fetch(HUB + '/api/red/generar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-token': TOKEN },
        body: JSON.stringify({ peerId: PEER, prompt: PROMPT, modelo: 'qwen21', tipo: 'imagen', params: { ancho: 1024, alto: 1024, steps: 20 } })
    });
    const d = await r.json().catch(() => ({}));
    console.log(seg(), 'pedido enviado:', r.status, d.jobId || d.message || '');
});
ws.on('message', (raw) => {
    let m = null; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || !m.type) return;
    if (['comfy_status', 'queue_state', 'comfy_cola', 'red_estado'].includes(m.type)) return;
    if (m.type === 'progress' || m.type === 'progress_state') {
        const v = (m.data && m.data.value) || 0, mx = (m.data && m.data.max) || 0;
        if (v === 1 || v === mx) console.log(seg(), 'generando', v + '/' + mx);
        return;
    }
    if (m.type === 'executed' || m.type === 'execution_success' || m.type === 'executing') {
        console.log(seg(), m.type, m.data && m.data.node ? 'nodo ' + m.data.node : '');
        return;
    }
    if (m.type === 'storyboard_generated' || m.type === 'video_generated' || m.type === 'media_en_nube') {
        console.log(seg(), '★', m.type, '| archivo:', m.filename || '-', '| urlNube:', (m.urlNube || '').slice(0, 64) || '(vacía)');
        vistos.push(m.type);
        if (m.type === 'media_en_nube') {
            console.log(seg(), '✅ CADENA COMPLETA: el navegador recibe la URL de Cloudflare');
            ws.close();
            process.exit(0);
        }
        return;
    }
    console.log(seg(), m.type);
});
ws.on('error', (e) => console.log('WS error', e.message));
setTimeout(() => { console.log(seg(), '⏱️  corte', 'eventos:', vistos.join(',')); process.exit(1); }, 240000);
