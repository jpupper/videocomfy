# COMFYLATAM

Una sola aplicación: un editor de imágenes y video sobre ComfyUI que corre en **tu** PC
y que, además, forma una **red** con todas las demás PCs conectadas.

- **Local** (`http://127.0.0.1:5634`): levantás la app en tu máquina y usás tu ComfyUI.
- **Web** (`https://fullscreencode.com/comfylatam/`): desde el navegador, con tu cuenta de
  fullscreencode, usás el ComfyUI de **cualquiera** de las PCs conectadas.
- **Red**: cada PC que corre la app aporta su ComfyUI. Cualquier usuario logueado puede
  elegir en qué PC generar. El que aporta decide si comparte o no.

No hay servidores de generación: el VPS sólo coordina (quién está conectado, quién comparte,
y pasa el trabajo). **Nada se genera en el servidor y nadie abre puertos**: tu PC sale a
buscar el trabajo, genera en su GPU y devuelve el resultado.

---

## Conectarse a la red (3 pasos)

1. **Clonar el repositorio y entrar a la carpeta**

   ```bash
   git clone https://github.com/jpupper/videocomfy.git
   cd videocomfy
   ```

2. **Instalar (una sola vez)** — necesitás **Node 18 o superior** (`node -v`) y tener ComfyUI
   andando en tu PC (`http://127.0.0.1:8188`).

   ```bash
   npm install
   ```

3. **Levantar la app y activar el botón**

   ```bash
   npm start            # o run.bat en Windows
   ```

   Se abre `http://127.0.0.1:5634`. Andá a la pestaña **🌎 RED** y prendé
   **“Transmitir mi Comfy”**. Listo: ya aparecés en la red de
   `https://fullscreencode.com/comfylatam/` y otros pueden generar en tu máquina.

**No hay que configurar nada más.** El nodo va dentro de la app y se conecta solo con el
token público de nodo. Sólo necesitás **internet** (la PC sale hacia afuera por `wss`, no hay
que tocar el router ni el firewall).

> Debajo del switch la app te dice si la web **ya te registró** ("✅ La web te tiene registrado
> como …"). Si queda en ámbar te dice qué falta, no te deja adivinando.

> Si apareces en la lista pero con el switch apagado, igual te ven: dice *transmisión apagada*
> y nadie puede generar en tu PC hasta que lo prendas. El botón es tu permiso.

### Si no aparecés en la red

| Qué ves en la consola de la app | Qué pasa |
|---|---|
| `no pude conectar al VPS: token de agente invalido` | Te quedó un `.env` de otra instalación. **Borralo**: un clon no necesita ningún `.env` |
| `ENOTFOUND` / `ETIMEDOUT` | No hay internet o un firewall bloquea `wss:` |
| `tenés Node X y se necesita 18 o superior` | Actualizá Node (nodejs.org, LTS) |
| Dice *publicado* pero la web no la muestra | Recargá la web con Ctrl+Shift+R |

---

## Cómo se usa

### En local (tu PC, tu ComfyUI)

1. `npm start` → `http://127.0.0.1:5634`
2. **CREATE** → escribí el prompt, elegí modelo (Z-Image Turbo, Qwen-Image 2.1, LTX-2) y generá.
3. Todo se genera en tu ComfyUI y queda en `public/uploads/` y `public/videos/`.

En local **no hace falta loguearse**. Si te logueás en la pestaña **👤 Perfil**, tu nombre y
avatar se publican en la red y los demás ven de quién es la PC.

### En la web (el ComfyUI de otra PC)

1. `https://fullscreencode.com/comfylatam/` → te pide login (fscauth, el login del ecosistema).
2. Pestaña **🌎 RED**: ves las PCs conectadas, cuáles están **🟢 libres** y cuáles **🟡 ocupadas**,
   con cuántos trabajos en cola, quién es el dueño y quién más está conectado.
3. Elegí la PC, escribí el prompt y **GENERAR EN LA RED**. El trabajo viaja por socket al nodo
   elegido, se genera en su GPU y el resultado vuelve a tu navegador.

En el **STAGE** ves de cada generación: qué usuario la pidió, con qué prompt, en qué PC se hizo
y a quién está registrada esa PC (📋 REGISTRO).

---

## Qué necesitás

- **Node 18+** (probado en Node 22/26)
- **ComfyUI** en `127.0.0.1:8188` (para generar; sin él la app arranca igual y tu PC no aparece
  como *libre* hasta que responda)
- Modelos en ComfyUI: Z-Image Turbo, Qwen-Image 2.1, LTX-2 (video) — los workflows están en `workflows/`
- Internet (para entrar a la red)

---

## Estructura

```
server.js  nodo.js  run.bat  package.json     # la app (raíz: sólo lo esencial)
public/            # front (html/css/js) + uploads, videos, audio, presets, projects
hub/               # el hub de la red (corre en el VPS: coordina nodos y sirve este public/)
hub/lib/relay.js   #   registro de nodos, clientes y relay de trabajos
workflows/         # los workflows de ComfyUI (la app los indexa de acá)
workflows/viejos/  # variantes y pruebas viejas (no las usa la app)
tools/             # telegram (desactivado), longcat
herramientas/      # mantenimiento (normalizar-metadata)
pruebas/           # scripts de prueba y logs
docs/              # notas
deploy_scripts/    # deploy del hub al VPS + subida del front al FTP
```

**Agregar un workflow**: dejá el `.json` en `workflows/` y listo. `GET /api/workflows`
lista todo lo que hay ahí (nodos, KB, y si la app lo usa).

---

## Puertos

| Dónde | Qué | Puerto |
|---|---|---|
| Tu PC | App COMFYLATAM (editor + nodo) | `5634` |
| Tu PC | ComfyUI | `8188` |
| VPS | Hub de la red (`hub/server.js`) | `8086` |
| VPS | fscauth (login) | `3027` |

---

## Mantenimiento del servidor

El hub vive en este mismo repo (`hub/`) y sirve el `public/` de la app: hay una sola copia del
front. Quien administra el VPS tiene los pasos en **`deploy_scripts/DEPLOY.md`**.

Para usar la red no hace falta nada de eso: cualquier PC entra con el token público, sin
configurar servidores. **Ninguna PC es "la principal"**: la red funciona con todas las que estén
conectadas y compartiendo.

---

## Notas

- **Telegram está desactivado**: no se carga el módulo ni se envía nada. Para prenderlo algún
  día: `TELEGRAM_HABILITADO=true` + `TELEGRAM_BOT_TOKEN=...` en el `.env`.
- Lo que generás **en tu PC** queda en tu disco. Lo que se pide desde la **web o la red** se guarda en
  Cloudflare R2 y se sirve desde ahí (nunca desde el VPS).
- Los `.env` no van al repo. Si clonás, no necesitás ninguno.
