require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const ftp = require('basic-ftp');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Sube public/ del proyecto a la carpeta de la app en el FTP de Ferozo.
//   local:  ./public/**  ->  remoto: $FTP_REMOTE_BASE/**
// NO toca .htaccess.
//
// CLAVE: no alcanza con comparar tamanios. Un cambio que pesa lo mismo
// (por ejemplo bumpear ?v=1 -> ?v=2 en el index.html) NUNCA se subia y el
// navegador seguia sirviendo el JS viejo cacheado. Ahora se compara el sha1
// de cada archivo contra un manifiesto local (.deploy-manifest.json) y
// tambien el tamanio remoto, por si otra copia piso el archivo.
//
//   node deploy_scripts/upload_ftp.js             (solo lo que cambio)
//   node deploy_scripts/upload_ftp.js --forzar    (sube TODO el front)
const FORZAR = process.argv.includes('--forzar');
const EXCLUDED = ['node_modules', '.git', '.env', '.env.example', 'agent', 'deploy_scripts', '.vscode', 'README.md', 'package.json', 'package-lock.json',
    // Media: NO se sube a la web. Se sirve desde la PC que la generó (a través
    // del hub). Subir 1.7 GB de videos al FTP fue un legado de la versión vieja.
    'uploads', 'videos', 'audio', 'presets', 'projects', 'backup', 'temp'];
const RUTA_MANIFIESTO = path.join(__dirname, '.deploy-manifest.json');

function sha1(archivo) {
    return crypto.createHash('sha1').update(fs.readFileSync(archivo)).digest('hex');
}

function leerManifiesto() {
    try { return JSON.parse(fs.readFileSync(RUTA_MANIFIESTO, 'utf8')); } catch (e) { return {}; }
}

async function syncLocalToRemote(client, localFolder, remoteFolder, ctx) {
    await client.ensureDir(remoteFolder);

    const remoteList = await client.list();
    const remoteMap = new Map();
    for (const item of remoteList) remoteMap.set(item.name, item);

    for (const item of fs.readdirSync(localFolder)) {
        if (EXCLUDED.includes(item)) continue;
        if (item.startsWith('.ht')) continue; // nunca se sube/edita .htaccess

        const localPath = path.join(localFolder, item);
        const stat = fs.statSync(localPath);

        if (stat.isDirectory()) {
            await syncLocalToRemote(client, localPath, remoteFolder + '/' + item, ctx);
            await client.cd(remoteFolder);
        } else {
            const remoto = remoteFolder + '/' + item;
            const remoteItem = remoteMap.get(item);
            const hash = sha1(localPath);
            const cambio = FORZAR
                || ctx.manifiesto[remoto] !== hash
                || !remoteItem
                || remoteItem.size !== stat.size;

            if (cambio) {
                await client.uploadFrom(localPath, item);
                ctx.manifiesto[remoto] = hash;
                ctx.subidos++;
                if (ctx.detalle) console.log('[SUBIENDO] ' + remoto);
            } else {
                ctx.salteados++;
            }
        }
    }
}

async function uploadToFtp() {
    const client = new ftp.Client();
    client.ftp.verbose = false;

    const ftpHost = process.env.FTP_HOST;
    const ftpUser = process.env.FTP_USER;
    const ftpPassword = process.env.FTP_PASS;
    const remoteBase = process.env.FTP_REMOTE_BASE || '/comfylatam';

    if (!ftpHost || !ftpUser || !ftpPassword) {
        console.error('[FTP] Faltan FTP_HOST / FTP_USER / FTP_PASS en el .env');
        process.exitCode = 1;
        return;
    }

    const ctx = { manifiesto: leerManifiesto(), subidos: 0, salteados: 0, detalle: true };

    try {
        console.log('--- FTP COMFYLATAM: front -> ' + remoteBase + (FORZAR ? ' (FORZADO)' : '') + ' ---');
        await client.access({
            host: ftpHost,
            user: ftpUser,
            password: ftpPassword,
            secure: true,
            secureOptions: { rejectUnauthorized: false }
        });

        const localRootFolder = path.join(__dirname, '..', 'public');
        await syncLocalToRemote(client, localRootFolder, remoteBase, ctx);

        fs.writeFileSync(RUTA_MANIFIESTO, JSON.stringify(ctx.manifiesto, null, 2));
        console.log('==========================================');
        console.log('FTP: ' + ctx.subidos + ' subidos, ' + ctx.salteados + ' sin cambios.');
        console.log('==========================================');
    } catch (err) {
        console.error('Error en la subida FTP:', err.message);
        process.exitCode = 1;
    } finally {
        client.close();
    }
}

uploadToFtp();
