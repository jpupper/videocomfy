// Deja un redirect en la ruta vieja del FTP (/jpiassets/) para que los
// enlaces guardados sigan funcionando y caigan en /comfylatam/.
// Uso:  node deploy_scripts/ck_redirect_viejo.js
require('dotenv').config();
const path = require('path');
const { Client } = require('basic-ftp');

const HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>COMFYLATAM</title>
<meta http-equiv="refresh" content="0; url=/comfylatam/">
<link rel="canonical" href="/comfylatam/">
<style>body{background:#07060c;color:#e2e8f0;font-family:Inter,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
a{color:#00ffd5}</style>
</head>
<body>
<p>La app ahora se llama <b>COMFYLATAM</b>. <a href="/comfylatam/">Ir a /comfylatam/</a></p>
<script>location.replace('/comfylatam/' + location.search);</script>
</body>
</html>`;

// Las dos rutas viejas que hay que dejar redirigiendo
const VIEJAS = ['/megacomfyjp/index.html', '/jpiassets/index.html'];

(async () => {
    const c = new Client();
    c.ftp.verbose = false;
    try {
        await c.access({
            host: process.env.FTP_HOST,
            user: process.env.FTP_USER,
            password: process.env.FTP_PASS,
            secure: true
        });
        const { Readable } = require('stream');
        for (const ruta of VIEJAS) {
            await c.uploadFrom(Readable.from([HTML]), ruta);
            console.log('✓ redirect ->', ruta);
        }
    } catch (e) {
        console.error('✗ error:', e.message);
        process.exitCode = 1;
    } finally {
        c.close();
    }
})();
