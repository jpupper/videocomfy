// Prueba de "clientes conectados" desde el lado del navegador web.
// Se conecta al hub como lo hace el front, se identifica y deja la sesión unos
// segundos para ver que el hub lo cuente como cliente WEB.
const { io } = require('socket.io-client');
const fs = require('fs');
const path = require('path');

const HUB = 'https://vps-4455523-x.dattaweb.com';
const BASE = '/comfylatam';
const TOKEN = fs.readFileSync(path.join(process.env.LOCALAPPDATA, 'hermes', 'cache', 'scratch', 'ck_token.txt'), 'utf8').trim();

const sock = io(HUB, { path: BASE + '/socket.io', transports: ['websocket'] });

sock.on('connect', () => {
    console.log('✅ conectado al hub como cliente web (id', sock.id + ')');
    sock.emit('cliente:yo', { token: TOKEN, origen: 'web' });
});

sock.on('red:clientes', (d) => {
    console.log('👥 red:clientes ->', 'total', d.total, '| web', d.web, '| local', d.local,
        '| usuarios', d.usuariosTotal, JSON.stringify((d.usuarios || []).map(u => u.usuario)));
});

sock.on('red:peers', (d) => {
    const p = (d && d.peers) || [];
    console.log('🖥️  red:peers ->', p.length, 'nodo(s):', p.map(x => `${x.nombre}${x.ocupado ? ' (ocupado)' : ' (libre)'}@${x.usuario || '-'}`).join(', '));
});

sock.on('connect_error', (e) => console.log('⚠️ error:', e.message));

setTimeout(async () => {
    const r = await fetch(HUB + BASE + '/api/red/clientes', { headers: { Authorization: 'Bearer ' + TOKEN } });
    const d = await r.json();
    console.log('\n=== /api/red/clientes (lo que ve la pestaña RED) ===');
    console.log('  status', r.status, '| total', d.total, '| web', d.web, '| local', d.local,
        '| usuarios', d.usuariosTotal, '| apps locales', d.appsLocales);
    console.log('  usuarios:', JSON.stringify((d.usuarios || []).map(u => `${u.usuario} (web:${u.web} local:${u.local})`)));
    console.log('  nodos:', JSON.stringify((d.nodos || []).map(n => `${n.nombre} ${n.ocupado ? 'ocupado' : 'libre'} ${n.encolados}q`)));
    process.exit(0);
}, 9000);
