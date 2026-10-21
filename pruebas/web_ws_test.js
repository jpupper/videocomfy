// Prueba del camino REAL de la web: un frame por /ws como el que manda el navegador.
const WebSocket = require('ws');
const PR = 'PRUEBA WS WEB ' + Date.now();
const url = 'wss://vps-4455523-x.dattaweb.com/comfylatam/ws';
const ws = new WebSocket(url, { rejectUnauthorized: false, origin: 'https://fullscreencode.com' });
let abierto = false;
ws.on('open', () => {
    abierto = true;
    console.log('WS abierto');
    ws.send(JSON.stringify({
        type: 'generarImagen', origen: 'web', prompt: PR,
        pedidoPor: { usuario: 'jpupper', displayName: 'JPupper', avatar: '', tipo: 'web' },
        params: { modelo: 'qwen21', ancho: 512, alto: 512, steps: 4 }
    }));
    console.log('frame enviado:', PR);
});
ws.on('unexpected-response', (req, res) => console.log('HTTP', res.statusCode, res.statusMessage));
ws.on('error', (e) => { console.log('error:', e.message); });
setTimeout(async () => {
    try {
        const r = await fetch('https://vps-4455523-x.dattaweb.com/comfylatam/api/red/pedidos-global?limite=3', { headers: { 'x-agent-token': 'comfylatam-nodo-2026' } });
        const d = await r.json();
        const hit = (d.pedidos || []).find((p) => p.prompt === PR);
        console.log('REGISTRO GLOBAL:', hit ? ('SI · ' + hit.estado + ' · ' + hit.peerNombre) : 'NO');
        const r2 = await fetch('http://127.0.0.1:5634/api/pedidos').then((x) => x.json()).catch(() => ({}));
        const loc = (r2.pedidos || []).find((p) => p.prompt === PR);
        console.log('LLEGO AL LOCAL:', loc ? ('SI · ' + loc.estado) : 'NO', '| ws abierto:', abierto);
    } catch (e) { console.log('err consulta:', e.message); }
    process.exit(0);
}, 6000);
