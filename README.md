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