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
