// Registro de nodos en el SERVIDOR, a prueba de fallos.
// Vive en un archivo (datos/nodos.log) para que quede constancia aunque Mongo
// esté caído o la app que se conecta no tenga IACOMFY: cada conexión, cada
// presentación y cada desconexión, con fecha ISO.
const fs = require('fs');
const path = require('path');

const ARCHIVO = path.join(__dirname, '..', 'datos', 'nodos.log');

function anotar(evento, datos = {}) {
    const fila = Object.assign({ t: new Date().toISOString(), evento }, datos);
    const linea = JSON.stringify(fila);
    try {
        fs.mkdirSync(path.dirname(ARCHIVO), { recursive: true });
        fs.appendFileSync(ARCHIVO, linea + '\n');
    } catch (e) {
        console.log('⚠️  no pude escribir nodos.log:', e.message);
    }
    const quien = datos.nombre || datos.peerId || '';
    console.log(`📇 ${evento}${quien ? ': ' + quien : ''} · ${fila.t}`);
    return fila;
}

function ultimos(n) {
    try {
        const txt = fs.readFileSync(ARCHIVO, 'utf8').trim();
        if (!txt) return [];
        return txt.split('\n').slice(-(n || 200)).map((l) => {
            try { return JSON.parse(l); } catch (e) { return { crudo: l }; }
        });
    } catch (e) { return []; }
}

// Cuántas veces y cuándo se conectó cada peer (para "¿esta PC ya estuvo acá?")
function resumen() {
    const out = {};
    ultimos(100000).forEach((f) => {
        const id = f.peerId || '?';
        const r = out[id] = out[id] || { peerId: id, nombre: f.nombre || '', veces: 0, primera: null, ultima: null };
        if (f.evento === 'conectado') {
            r.veces++;
            if (!r.primera || f.t < r.primera) r.primera = f.t;
            if (!r.ultima || f.t > r.ultima) r.ultima = f.t;
            if (f.nombre) r.nombre = f.nombre;
        }
    });
    return Object.values(out).sort((a, b) => String(b.ultima).localeCompare(String(a.ultima)));
}

module.exports = { anotar, ultimos, resumen, ARCHIVO };
