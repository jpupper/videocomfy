// Prueba: ¿qué frames llegan a un CLIENTE WEB (el navegador de fullscreencode.com)
// mientras un trabajo corre en un nodo?
//   node pruebas/ws-web-frames.js <token> [peerId] [prompt]
// Abre el WS del hub como lo hace config-jpi.js (wss://<hub>/comfylatam/ws?token=…),
// pide un trabajo por /api/red/generar y lista los tipos que llegan con su hora.
// Sirve para decidir si la barra de progreso de la web se puede alimentar del WS
// o si tiene que reconciliar contra /api/pedidos.
const WebSocket = require('ws');

const HUB = process.env.HUB || 'https://vps-4455523-x.dattaweb.com/comfylatam';
const TOKEN = process.argv[2] || process.env.TOKEN || '';
const PEER = process.argv[3] || '';
const PROMPT = process.argv[4] || ('prueba frames web ' + Date.now());
const ESPERA_MS = Number(process.env.ESPERA_MS || 100000);

if (!TOKEN) { console.error('falta el token'); process.exit(2); }

const WS_URL = HUB.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(TOKEN);
const t0 = Date.now();
const vistos = [];
const ts = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

const ws = new WebSocket(WS_URL);
ws.on('unexpected-response', (_req, res) => {
    console.log(`❌ WS rechazado: HTTP ${res.statusCode} (sin sesión válida)`);
    process.exit(1);
});
ws.on('open', async () => {
    console.log(`✅ WS abierto a ${HUB} (${ts()})`);
    try {
        const r = await fetch(HUB + '/api/red/generar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
            body: JSON.stringify({ peerId: PEER, prompt: PROMPT, tipo: 'imagen', modelo: 'zimage', params: {} })
        });
        const j = await r.json().catch(() => ({}));
        console.log(`📤 generar -> ${r.status} ${JSON.stringify(j).slice(0, 220)} (${ts()})`);
    } catch (e) { console.log('📤 generar ERROR ' + e.message); }
});
ws.on('message', (raw) => {
    let m = {};
    try { m = JSON.parse(raw.toString()); } catch (e) { m = { type: '??' }; }
    const t = m.type || '??';
    vistos.push(t);
    // los pesados se resumen
    const extra = m.type === 'progress' ? ` ${m.value}/${m.max}` :
        (m.type === 'executing' ? ` node=${m.node || 'null'}` :
            (m.filename ? ' ' + m.filename : '') + (m.urlNube ? ' urlNube=SI' : ''));
    console.log(`  [${ts()}] ${t}${extra}`);
});
ws.on('error', (e) => console.log('❌ WS error: ' + e.message));
setTimeout(() => {
    const cuenta = {};
    vistos.forEach((t) => { cuenta[t] = (cuenta[t] || 0) + 1; });
    console.log('\n=== resumen de frames por tipo ===');
    console.log(JSON.stringify(cuenta, null, 2));
    try { ws.close(); } catch (e) { }
    process.exit(0);
}, ESPERA_MS);
