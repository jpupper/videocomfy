# ComfyTD - Image Generation Bridge

## Overview
ComfyTD is a bridge application that connects ComfyUI (a powerful stable diffusion interface) with TouchDesigner. It allows for local image generation and seamless transmission between these two platforms, providing a minimal yet functional demonstration of this integration.

## Features
- Local image generation using ComfyUI
- Real-time image transmission to TouchDesigner
- Team-based image organization
- WebSocket communication for real-time updates
- Simple web interface for interaction

## Requirements
- Node.js (v14 or higher)
- ComfyUI running locally
- TouchDesigner
- Web browser

## Installation

1. Clone this repository:
   ```bash
   git clone [repository-url]
   cd comfytd
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure the application:
   - Open `server.js` and update the `ipglobal` variable with your ComfyUI server IP address

## Usage

1. Start the server:
   ```bash
   npm start
   # or
   node server.js
   # or use the provided batch file
   run.bat
   ```

2. The server will start on port 5634. Open your browser and navigate to:
   ```
   http://localhost:5634
   ```

3. Connect TouchDesigner to the application:
   - Open the provided TouchDesigner file (`comfytdtolch1.4.toe` or `iaartlabf.toe`)
   - Configure the WebSocket connection in TouchDesigner to point to your server

4. Generate images by sending prompts through the web interface or directly via WebSocket connections

## Technical Details

### Architecture
- **Express.js server**: Handles HTTP requests and serves static files
- **WebSocket server**: Manages real-time communication between clients
- **ComfyUI integration**: Sends generation requests and receives generated images
- **File system management**: Organizes generated images by team

### API Endpoints
- WebSocket connection for image generation: `ws://localhost:5634`
- Socket.IO connection for UI controls: `http://localhost:5634`

### Message Format
To generate an image, send a WebSocket message with the following format:
```json
{
  "type": "generarImagen",
  "prompt": "your image description here",
  "equipo": "team_number"
}
```

## Troubleshooting
- Ensure ComfyUI is running and accessible at the configured IP address
- Check network connectivity between all components
- Verify that the workflow_api.json file is properly configured

## License
This project is provided as-is for demonstration purposes.

---

## ¿De dónde levanta? (ComfyUI propio vs. la web de jpiassets)

Esta app es el **editor + motor local**: habla directo con un **ComfyUI** que corre en la misma
máquina. La dirección sale de `COMFYUI_ADDRESS` (por defecto **`127.0.0.1`**, puerto 8188):

| Escenario | Contra qué Comfy genera |
|---|---|
| Clonás el repo y lo corrés en tu compu | **Tu ComfyUI** (`COMFYUI_ADDRESS`, por defecto tu `127.0.0.1:8188`) |
| Julián lo corre en su PC | El ComfyUI de la PC de Julián |
| Usás la **web** (`fullscreencode.com/jpiassets`) | El ComfyUI de la PC de Julián — la web **relayea** por el VPS: navegador → jpiassets (VPS) → agente local → videocomfy (:5634) → ComfyUI (:8188) |

O sea: **corriendo local = tu Comfy**. Nada del repo apunta a la PC de otra persona: las direcciones
están en `.env` (que no se versiona) y el valor por defecto es `localhost`.

### Uso local (lo normal si clonás el repo)

```bat
copy .env.example .env        :: revisá COMFYUI_ADDRESS y PORT
:: levantá ComfyUI (el tuyo) y después:
node server.js                :: editor en http://127.0.0.1:5634
```

Requisitos: Node 18+, un ComfyUI corriendo en `127.0.0.1:8188` y los modelos que use el workflow que
elijas. Si ComfyUI no está prendido, el editor abre igual pero no genera.

### La web (jpiassets)

La versión web **pide login de fullscreencode** (fscauth) y usa la PC de Julián a través del agente.
Para eso hace falta el agente (`../jpiassets/agent`) con `AGENT_URL`/`AGENT_TOKEN`, que los administra
quien corre el VPS. Sin agente, la web no genera.


## Red COMFYLATAM (usar el Comfy de la red / compartir el tuyo)

La app es un **nodo** de la red: si corrés el agente (`conectar-comfylatam.bat`
del repo `jpiassets`), tu app se publica con su nombre y modelos, y podés:

- **Compartir tu Comfy**: pestaña **🌎 RED** → switch "Compartir mi Comfy en la red".
  Apagado por defecto: nadie usa tu máquina hasta que lo prendas.
- **Usar el Comfy de otros**: en la misma pestaña elegís el nodo, escribís el
  prompt y le das *GENERAR EN LA RED*. El trabajo se hace en la PC de esa persona
  y el resultado vuelve por el hub.

### Config
En `.env`:
```
AGENT_TOKEN=<el mismo token del hub (agent/.env del repo jpiassets)>
RED_HUB=https://vps-4455523-x.dattaweb.com
RED_BASE=/comfylatam
```
Sin `AGENT_TOKEN` la app anda igual (local, contra tu Comfy) pero no puede
publicarse en la red. La identidad del nodo (peerId, nombre, compartir) se guarda
en `config-local.json` (no se versiona).

### Endpoints que expone la app local
| Ruta | Para qué |
|---|---|
| `GET /api/red/estado` | identidad del nodo, si comparte, modelos y nodos vistos |
| `POST /api/red/compartir` | `{compartir, nombre}` prende/apaga y avisa al hub |
| `POST /api/red/job` | encola un trabajo que llegó de la red (lo llama el agente) |
| `POST /api/red/generar` | `{peerId, prompt, modelo, params}`: acá o en otro nodo |
| `POST /api/red/nodos` / `/api/red/evento` | el agente empuja la red a la app |

`PORT` y `RED_PEER_ID` / `RED_NODO_NOMBRE` / `RED_COMPARTIR` / `RED_CONFIG` por
entorno permiten correr varios nodos en la misma máquina (pruebas).

## Red COMFYLATAM (nodo embebido)

La app **se conecta sola al hub** al arrancar: no hay que correr ningun `.bat`
aparte. `nodo.js` viaja dentro de la app y hace de puente (socket.io) entre tu
ComfyUI local y la red en el VPS.

- `npm start` -> la app se publica en la red automaticamente.
- El switch **Transmitir mi Comfy** (pestana RED) decide si *otros* pueden generar
  en tu PC. Apagado, igual apareces en la lista (marcado sin transmitir).
- En **SETTINGS** cambias la direccion de ComfyUI (local o RunPod) y en la pestana
  **PERFIL** inicias sesion con fullscreencode (opcional en local) para publicar
  tu nombre y avatar en la red.

## Cómo aparece mi PC en la red (si cloné el repo)

**No hay que configurar nada.** El nodo va dentro de la app: al correrla se
conecta sola al hub público con el *token público de nodo* que ya viene en el
código (`comfylatam-nodo-2026`).

Pasos:

1. Tener **Node 18 o superior** (`node -v`). Con Node viejo la app avisa y no conecta.
2. `npm install` (una vez).
3. `npm start` — o el `.bat` que uses para levantarla.
4. Abrir `http://127.0.0.1:5634` — en el panel dice *publicado en la red*.
5. En la pestaña **🌎 RED**, prender **Transmitir mi Comfy** si querés que otros
   puedan generar en tu máquina (es opt-in: apagado, igual aparecés, pero marcada
   como *transmisión apagada*).

Si no aparece, el panel RED (modo local) lo dice:

| Síntoma | Causa |
|---|---|
| `⚠️ no pude conectar al VPS: token de agente invalido` | tu `.env` tiene un `AGENT_TOKEN` que no es el público — borralo o poné `comfylatam-nodo-2026` |
| `ENOTFOUND` / `ETIMEDOUT` | no hay internet o un firewall bloquea `wss:` (la app sale a buscar el hub: no hay que abrir puertos) |
| dice *publicado* pero la web no la ve | recargá la web con Ctrl+Shift+R; el hub muestra la lista cada pocos segundos |

> El **dueño del hub** (el VPS) sí usa el `AGENT_TOKEN` privado en su `.env`: así su
> máquina entra con el token privado y las instalaciones nuevas con el público.
