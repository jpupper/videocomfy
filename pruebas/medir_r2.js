// Mide una subida REAL a R2 desde esta PC (mismo código que usa la app).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const r2 = require('../hub/lib/r2');

(async () => {
    console.log('R2 configurado:', r2.r2Configurado(), '| bucket:', r2.bucket ? r2.bucket() : '?');
    const tam = Number(process.argv[2] || 2) * 1024 * 1024;
    const f = path.join(os.tmpdir(), 'prueba-subida-' + Date.now() + '.png');
    fs.writeFileSync(f, Buffer.alloc(tam, 7));
    console.log('archivo de prueba:', (tam / 1048576).toFixed(1), 'MB');
    const t0 = Date.now();
    const r = await r2.subirArchivo(f, { tipo: 'comfylatam', sub: 'pruebas', filename: path.basename(f), mime: 'image/png', size: tam });
    const seg = ((Date.now() - t0) / 1000).toFixed(2);
    console.log('resultado:', r ? 'OK ' + r.url : 'NULL (falló)');
    console.log('tiempo:', seg, 's ·', (tam / 1048576 / (Number(seg) || 1) * 8).toFixed(2), 'Mbps efectivos');
    try { fs.unlinkSync(f); } catch (e) { }
    process.exit(0);
})();
