// Crea un pedido LOCAL como lo hace el navegador (mismo mensaje por WS),
// para verificar que el registro GLOBAL del VPS lo recibe.
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:5634');
const t0 = Date.now();
const seg = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

ws.on('open', () => {
    console.log(seg(), 'conectado; mando generarImagen (origen local)');
    ws.send(JSON.stringify({
        type: 'generarImagen',
        origen: 'local',
        pedidoPor: { usuario: 'jpupper', displayName: 'JPupper', tipo: 'local' },
        prompt: 'prueba registro global local ' + Date.now(),
        params: { ancho: 512, alto: 512, steps: 4 },
        modelo: 'qwen21',
        queueItemId: 'prueba-global-' + Date.now()
    }));
});

let listo = false;
ws.on('message', (raw) => {
    let m = null; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || !m.type) return;
    if (['comfy_status', 'queue_state', 'comfy_cola', 'red_estado', 'progress', 'progress_state', 'pedidos'].indexOf(m.type) >= 0) return;
    console.log(seg(), m.type, m.filename || '');
    if ((m.type === 'storyboard_generated' || m.type === 'media_en_nube') && !listo) {
        listo = true;
        setTimeout(() => { console.log('fin (dejo correr la anotación global)'); process.exit(0); }, 6000);
    }
});
setTimeout(() => { console.log(seg(), 'corte'); process.exit(0); }, 120000);
