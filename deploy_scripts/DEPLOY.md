# DEPLOY · cómo se actualiza COMFYLATAM

Esto es **sólo para quien administra el servidor**. Para conectarse a la red no hace falta nada
de este archivo: se clona el repo, se prende el botón y listo (ver el README).

## Qué hay dónde

| dónde | qué |
|---|---|
| VPS `149.50.139.152:5752` | `hub/` (coordina la red) + `public/` (el mismo front de la app) |
| PM2 | proceso `comfylatam`, puerto `8086`, `BASE_PATH=/comfylatam` |
| FTP `fullscreencode.com` | `public/` → `/comfylatam/` (el dominio lo sirve Apache) |

El hub sirve **el mismo `public/`** del repo: hay una sola copia del front, no se duplica.

## Deploy normal (Windows)

```bat
deploy_scripts\run_deploy.bat
```

Hace tres cosas: `git pull` en el VPS, `pm2 restart comfylatam` y sube `public/` al FTP.
Si tocaste sólo el hub, alcanza con esto; si tocaste el front, además sube los archivos nuevos.

## Deploy por SSH (sin `run_deploy.bat`)

```bash
cd /root/comfylatam && git fetch origin main && git reset --hard origin/main
pm2 restart comfylatam
```

Y el front, desde el VPS (las credenciales FTP locales suelen dar 530):

```bash
node /tmp/subir-archivos.js <carpeta-local> <ruta-remota>
```

## Tokens (esto es lo que estaba mal explicado)

La red **no depende de ningún token privado**. Cualquier instalación nueva entra con el token
**público de nodo**, que está en `nodo.js` (`TOKEN_PUBLICO`) y se puede cambiar en el `.env` del
VPS con `RED_NODO_TOKEN`.

- `RED_NODO_TOKEN` (VPS, opcional): si se define, el hub exige ese valor en lugar del público.
  Si se cambia, **todos los nodos** necesitan el mismo valor en su `.env` — por eso conviene
  dejarlo sin definir.
- `AGENT_TOKEN` (privado): es sólo para tareas internas del servidor. **No hace falta para que
  una PC se conecte** y no se le pide a nadie. Si un README o un mensaje dice "poné el token
  privado", está mal.

## Verificar que aterrizó

```bash
curl -o /dev/null -w "%{http_code}\n" https://vps-4455523-x.dattaweb.com/comfylatam/api/version
curl -o /dev/null -w "%{http_code}\n" https://fullscreencode.com/comfylatam/
git log --oneline -1        # en /root/comfylatam
```

## Variables del `.env` del VPS (referencia)

`BASE_PATH=/comfylatam`, `RED_HUB`, `RED_BASE`, `AGENT_PATH`, `GITHUB_REPO`, `COOKIE_SESION`,
`FSC_AUTH_URL`, `ORIGENES_CORS`, `R2_*` (media), `SUBIR_A_R2=true`, `RED_NODO_TOKEN` (opcional),
`AGENT_TOKEN` (interno). Los `.env` no van al repo.
