// ============================================================
// comfylatam - PM2 (VPS). Las credenciales viven en el .env del VPS.
// ============================================================
module.exports = {
    apps: [{
        name: 'comfylatam',
        script: 'server.js',
        cwd: '/root/comfylatam',
        instances: 1,
        exec_mode: 'fork',
        autorestart: true,
        max_memory_restart: '600M',
        env: {
            NODE_ENV: 'production'
        }
    }]
};
