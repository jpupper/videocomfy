// Borra un archivo (o carpeta) del FTP de producción.
// Uso:  node deploy_scripts/ck_borrar_ftp.js /comfylatam/arquitectura.html
//       node deploy_scripts/ck_borrar_ftp.js /comfylatam/arquitectura.html --dry
// Las credenciales salen del .env del proyecto (FTP_*), nunca se imprimen.
'use strict';

const path = require('path');
const fs = require('fs');
const ftp = require('basic-ftp');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const remoto = process.argv[2];
const dry = process.argv.includes('--dry');

if (!remoto) {
    console.error('Falta la ruta remota. Ej: node deploy_scripts/ck_borrar_ftp.js /comfylatam/arquitectura.html');
    process.exit(1);
}

(async () => {
    const cliente = new ftp.Client(20000);
    cliente.ftp.verbose = false;
    try {
        await cliente.access({
            host: process.env.FTP_HOST,
            user: process.env.FTP_USER,
            password: process.env.FTP_PASS,
            secure: String(process.env.FTP_SECURE || 'true') !== 'false',
            secureOptions: { rejectUnauthorized: false }
        });
        const lista = await cliente.list(path.posix.dirname(remoto)).catch(() => []);
        const objetivo = path.posix.basename(remoto);
        const existe = lista.some((f) => f.name === objetivo);
        console.log(`${existe ? '✓ existe' : '⚠️ no está'} en el FTP: ${remoto}`);
        if (!existe) { cliente.close(); process.exit(0); }
        if (dry) { console.log('(--dry: no borro nada)'); cliente.close(); process.exit(0); }
        await cliente.remove(remoto);
        const despues = await cliente.list(path.posix.dirname(remoto)).catch(() => []);
        const sigue = despues.some((f) => f.name === objetivo);
        console.log(sigue ? '❌ no se pudo borrar' : '🗑️ borrado: ' + remoto);
        cliente.close();
        process.exit(sigue ? 1 : 0);
    } catch (e) {
        console.error('❌', e.message);
        cliente.close();
        process.exit(1);
    }
})();
