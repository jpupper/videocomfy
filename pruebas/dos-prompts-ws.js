// Prueba: DOS pedidos seguidos por el WS del hub con prompts DISTINTOS.
// Reproduce lo que hace la web al apretar GENERATE IMAGE dos veces cambiando el prompt.
//   node pruebas/dos-prompts-ws.js <token> <peerId>
// Mira: (a) que el hub despache cada frame con SU prompt, (b) qué archivo y qué
// prompt quedan en /api/pedidos, (c) si el evento de vuelta trae queueItemId.
const WebSocket = require('ws');

const HUB = process.env.HUB || 'https://vps-4455523-x.dattaweb.com/comfylatam';
const TOKEN = process.argv[2] || process.env.TOKEN || '';
const PEER = process.argv[3] || '';
const SEPARACION_MS = Number(process.env.SEPARACION_MS || 45000);
const ESPERA_MS = Number(process.env.ESPERA_MS || 150000);

if (!TOKEN) { console.error('falta el token'); process.exit(2); }
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
const marca = Date.now();
const A = 'PRUEBA PROMPT A ' + marca;
const B = 'PRUEBA PROMPT B ' + marca;

const ws = new WebSocket(HUB.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(TOKEN));
const eventos = [];

ws.on('unexpected-response', (_q, res) => { console.log('WS rechazado ' + res.statusCode); process.exit(1); });
ws.on('open', () => {
    console.log(`✅ WS abierto (${ts()})`);
    mandar(A, 'qa-1');
    setTimeout(() => mandar(B, 'qa-2'), SEPARACION_MS);
});
function mandar(prompt, id) {
    const frame = {
        type: 'generarImagen',
        prompt: prompt,
        params: { modelo: 'zimage', samplerSteps: 10, videoWidth: 1024, videoHeight: 1024 },
        batchId: 'batch_' + marca,
        queueItemId: id,
        peerId: PEER,
        pedidoPor: { usuario: 'carloskernel', displayName: 'CarlosKernel', tipo: 'web' },
        origen: 'web'
    };
    console.log(`📤 frame ${id} prompt="${prompt}" (${ts()})`);
    ws.send(JSON.stringify(frame));
}
ws.on('message', (raw) => {
    let m = {}; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (m.type === 'progress') return;
    if (m.type === 'storyboard_generated' || m.type === 'video_generated' || m.type === 'media_en_nube') {
        console.log(`  🔔 [${ts()}] ${m.type} filename=${m.filename} prompt="${String(m.prompt || '').slice(0, 40)}" queueItemId=${m.queueItemId} prompt_id=${m.prompt_id || ''}`);
        eventos.push(m);
    }
});
setTimeout(async () => {
    try {
        const r = await fetch(HUB + '/api/red/pedidos', { headers: { Authorization: 'Bearer ' + TOKEN } });
        const d = await r.json();
        console.log('\n=== pedidos (los de esta prueba) ===');
        (d.pedidos || []).filter((p) => String(p.prompt || '').indexOf(String(marca)) >= 0).forEach((p) => {
            console.log(`  ${p.estado} | ${p.archivo || '-'} | "${String(p.prompt).slice(0, 44)}" | id=${p.id}`);
        });
    } catch (e) { console.log('no pude leer pedidos: ' + e.message); }
    console.log('\nA =', A, '\nB =', B);
    try { ws.close(); } catch (e) { }
    process.exit(0);
}, ESPERA_MS);
