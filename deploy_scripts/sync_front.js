#!/usr/bin/env node
// ============================================================
// sync_front.js — mantiene IGUALES los dos fronts del editor
// ------------------------------------------------------------
// El editor vive en dos lugares:
//   - LOCAL:  D:\Programacion\comfylatam\public        (lo sirve la app :5634)
//   - WEB:    <repo>\public                            (se sube al FTP)
// Cuando se toca la UI hay que actualizar los dos o se desincronizan
// (eso ya nos pasó: la web tenía los arreglos y el local seguía viejo).
//
// Copia la CAPA DE UI de acá (jpiassets/public, que es la fuente) hacia
// videocomfy/public. NO toca uploads/, videos/, audio/, presets/, projects/:
// ahí vive el media de Julián.
//
// Uso:  node deploy_scripts/sync_front.js            (copia)
//       node deploy_scripts/sync_front.js --check    (solo compara, no escribe)
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ORIGEN = path.join(__dirname, '..', 'public');
const VIDEOCOMFY = process.env.VIDEOCOMFY_PUBLIC || 'D:\\Programacion\\comfylatam\\public';
// Sentido de la copia: por defecto la web (repo) es la fuente; con
// --desde-videocomfy se copia al reves (cuando el cambio se hizo en la app
// local, que es lo natural al probar). En los dos casos el destino se respalda.
const REVERSO = process.argv.includes('--desde-videocomfy');
const DESTINO = REVERSO ? ORIGEN : VIDEOCOMFY;
const FUENTE = REVERSO ? VIDEOCOMFY : ORIGEN;
const SOLO_CHECK = process.argv.includes('--check');

// Capa de UI: todo lo que hace al editor (no el media)
const DIRS = ['css', 'js'];
const SUELTOS = ['index.html', 'config-jpi.js'];

function md5(p) {
    return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
}

function recolectar() {
    const lista = SUELTOS.slice();
    for (const d of DIRS) {
        const dir = path.join(FUENTE, d);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
            if (fs.statSync(path.join(dir, f)).isFile()) lista.push(d + '/' + f);
        }
    }
    return lista;
}

function main() {
    if (!fs.existsSync(DESTINO)) {
        console.error('✗ No existe el destino:', DESTINO);
        process.exit(1);
    }

    const archivos = recolectar();
    const copiados = [];
    const distintos = [];

    for (const rel of archivos) {
        const origen = path.join(FUENTE, rel);
        const destino = path.join(DESTINO, rel);
        if (!fs.existsSync(origen)) continue;

        if (fs.existsSync(destino) && md5(origen) === md5(destino)) continue;

        if (SOLO_CHECK) { distintos.push(rel); continue; }

        fs.mkdirSync(path.dirname(destino), { recursive: true });
        fs.copyFileSync(origen, destino);
        copiados.push(rel);
    }

    if (SOLO_CHECK) {
        if (distintos.length === 0) {
            console.log('✓ Los dos fronts están iguales (' + archivos.length + ' archivos de UI).');
            return;
        }
        console.log('✗ Desincronizados (' + distintos.length + '):');
        distintos.forEach(f => console.log('   -', f));
        console.log('\nCorré:  node deploy_scripts/sync_front.js');
        process.exitCode = 2;
        return;
    }

    if (copiados.length === 0) {
        console.log('✓ Nada que hacer: ' + DESTINO + ' ya está igual a ' + FUENTE + '.');
    } else {
        console.log('✓ Sincronizados ' + copiados.length + ' archivo(s) a ' + DESTINO + ':');
        copiados.forEach(f => console.log('   -', f));
    }
    console.log('   (no se tocó media: uploads/ videos/ audio/ presets/ projects/)');
}

main();
