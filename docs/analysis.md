ANALISIS DE CAUSA RAIZ

Problema: "A veces pasa que el FLUX genera la imagen pero nunca aparece en la interfaz"

Basado en el analisis del codigo:
- server.js (lines 63-298): WebSocket handler para ComfyUI
- server.js (lines 128-279): Handler de mensaje 'executed'
- public/js/script.js (lines 116-485): Frontend WebSocket handler
- public/js/script.js (lines 1412-1537): checkGlobalQueue()
- public/js/script.js (lines 4055-4079): addToStoryboardQueue()
- public/js/script.js (lines 4081-4143): handleStoryboardGenerated()
- flux_dev_full_text_to_image_api.json: Workflow FLUX

CADENA DE EVENTOS PARA UNA GENERACION FLUX:

1. Frontend: addToStoryboardQueue() -> globalGenerationQueue push -> checkGlobalQueue()
2. Frontend: checkGlobalQueue() -> ws.send({type:'generarStoryboard', ...})
3. Server: recibir mensaje -> await generarStoryboard() -> POST /prompt a ComfyUI -> prompt_id
4. Server: promptDetails[promptId] = {type:'storyboard', ...}
5. Server: ws.send({type:'prompt_queued', prompt_id, queueItemId})
6. Frontend: recibe prompt_queued -> item.prompt_id = message.prompt_id
7. ComfyUI: procesa, envia progress_state, executing, executed
8. Server: handler 'executed' -> busca output.images -> downloadImage() -> guarda archivo
9. Server: ws.send({type:'storyboard_generated', url, filename, prompt_id})
10. Frontend: recibe storyboard_generated -> handleStoryboardGenerated() -> loadExistingImages()

PUNTOS DE FALLA IDENTIFICADOS:

FALLA #1 (ALTA PROBABILIDAD): FRONTEND WEBSOCKET SIN RECONEXION
- script.js line 8: const ws = new WebSocket(...)
- NO hay handler ws.onclose ni ws.onerror en ninguna parte
- Si el frontend desconecta del servidor (server restart, timeout, red), 
  NUNCA se reconecta y todos los mensajes posteriores se pierden
- El flag isGeneratingGlobal queda en true permanentemente
- La cola se traba para siempre

FALLA #2 (ALTA PROBABILIDAD): SIN TIMEOUT EN GENERACION
- server.js: NO hay timeout para promesas de generacion
- Si ComfyUI se cuelga o tarda demasiado, no hay manera de recuperarse
- No se envia queue_timeout al frontend (aunque el frontend SI tiene handler para queue_timeout)
- El frontend espera indefinidamente

FALLA #3 (MEDIA PROBABILIDAD): ERROR DE DOWNLOAD SILENCIOSO
- server.js line 274-276: catch block solo loggea, NO notifica al frontend
- Si downloadImage() falla (ComfyUI no responde, archivo corrupto, etc.)
  el frontend NUNCA se entera y espera para siempre
- item.status nunca se marca como 'failed'

FALLA #4 (BAJA PROBABILIDAD): output.images VACIO
- server.js lines 141-157: Si output.images es array vacio []
- assetFound queda null, solo se loggea warning
- La imagen existe en ComfyUI pero nunca se descarga

FIXES IMPLEMENTADOS:

1. Frontend WebSocket reconnection + auto-sync queue state
2. Frontend generation timeout (10 min default)
3. Server-side generation timeout + queue_timeout notification
4. Server: send generation_error when download fails
