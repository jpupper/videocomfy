// Prueba de ACCESO POR EQUIPO: entra como OTRO usuario (carloskernel) y mira
// si la PC restringida a jpupper desaparece de la comunidad.
// La clave se lee del .env y nunca se imprime.
require('dotenv').config({ path: '.carloskernel.env' });
const fs = require('fs');
const HUB = 'https://vps-4455523-x.dattaweb.com';

function leerEnv() {
    const f = ['.carloskernel.env',
        '../../sistemasfullscreen/skillmaestrofsc/.carloskernel.env',
        'D:/Programacion/sistemasfullscreen/skillmaestrofsc/.carloskernel.env']
        .map((p) => require('path').resolve(__dirname, p)).find((p) => fs.existsSync(p));
    if (!f) return {};
    const o = {};
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((l) => {
        const m = l.match(/^([A-Z_]+)=(.*)$/);
        if (m) o[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    });
    return o;
}

(async () => {
    const env = leerEnv();
    const email = env.CK_EMAIL || env.CARLOSKERNEL_EMAIL || 'carloskernel@fullscreencode.com';
    const pass = env.CK_PASS || env.CARLOSKERNEL_PASS || env.CK_PASSWORD || '';
    if (!pass) { console.log('sin credenciales de prueba en el archivo'); process.exit(1); }

    const rl = await fetch(HUB + '/jpconnect/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: pass })
    });
    const dl = await rl.json().catch(() => ({}));
    const token = dl.token || (dl.data && dl.data.token);
    if (!token) { console.log('login:', rl.status, 'sin token'); process.exit(1); }
    console.log('login OK como', (dl.user && dl.user.username) || email);

    for (const [quien, jwt] of [['carloskernel', token], ['sin sesión (token de nodo)', null]]) {
        const h = { 'x-agent-token': 'comfylatam-nodo-2026' };
        if (jwt) { delete h['x-agent-token']; h['Authorization'] = 'Bearer ' + jwt; }
        const r = await fetch(HUB + '/comfylatam/api/red/peers', { headers: h });
        const d = await r.json().catch(() => ({}));
        const pcs = (d.peers || []).map((p) => p.nombre + (p.accesoNodo && p.accesoNodo.modo === 'lista' ? ' [🔒 ' + (p.accesoNodo.usuarios || []).join(',') + ']' : ''));
        console.log(quien.padEnd(26), 'HTTP', r.status, '→', pcs.length ? pcs.join(' · ') : '(ninguna)');
    }
})();
