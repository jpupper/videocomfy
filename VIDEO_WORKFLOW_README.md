# Video Workflow Integration - uisatocomfy.json

## Cambios Realizados

### 1. Estructura de Archivos
- ✅ Creado directorio `public/videos/` para almacenar videos generados
- ✅ Workflow configurado para usar `uisatocomfy.json` en lugar de `workflow_api.json`

### 2. Backend (server.js)

#### Cambios principales:
- **Workflow actualizado**: Ahora lee `uisatocomfy.json` que genera videos en formato WEBM
- **Soporte de progreso**: Captura mensajes de tipo `progress` desde ComfyUI y los reenvía al frontend
- **Detección de videos**: Detecta cuando el output contiene `gifs` (videos) en lugar de solo `images`
- **Descarga de videos**: Los videos se descargan a `public/videos/` y se sirven al cliente

#### Nodos del workflow modificados:
```javascript
// Node 6: Prompt positivo
promptWorkflow["6"]["inputs"]["text"] = promptText;

// Node 3: Seed aleatorio
promptWorkflow["3"]["inputs"]["seed"] = Math.floor(Math.random() * 18446744073709551614) + 1;

// Node 47: Prefijo del archivo de video
promptWorkflow["47"]["inputs"]["filename_prefix"] = "video/comfy_video";
```

### 3. Frontend

#### HTML (index.html)
- ✅ Agregada barra de progreso con estilos modernos
- ✅ Contenedor de video separado del contenedor de imágenes
- ✅ Botón actualizado: "Generar Video" en lugar de "Generar Imagen"

#### JavaScript (script.js)
- **Manejo de progreso**: Actualiza la barra de progreso en tiempo real
  - Muestra porcentaje completado
  - Muestra "X de Y pasos"
  
- **Manejo de videos**: 
  - Crea elemento `<video>` con controles
  - Autoplay y loop activados
  - Oculta contenedor de imágenes cuando se muestra video
  
- **Comunicación con TouchDesigner**:
  - Envía mensaje `terminoVideo` cuando el video está listo
  - Incluye prompt y URL del video

### 4. Flujo de Trabajo

```
1. Usuario ingresa prompt y presiona "Generar Video"
   ↓
2. Frontend muestra barra de progreso (0%)
   ↓
3. Backend envía workflow a ComfyUI
   ↓
4. ComfyUI procesa y envía actualizaciones de progreso
   ↓
5. Frontend actualiza barra de progreso en tiempo real
   ↓
6. ComfyUI completa y genera archivo WEBM
   ↓
7. Backend descarga video a public/videos/
   ↓
8. Frontend muestra video con controles
   ↓
9. Se envía notificación a TouchDesigner
```

### 5. Características de la Barra de Progreso

- **Visual**: Gradiente verde con animación suave
- **Información**: Muestra porcentaje y pasos completados
- **Estados**:
  - "Iniciando generación de video..." (al comenzar)
  - "Generando video... X de Y pasos" (durante procesamiento)
  - Se oculta automáticamente cuando el video está listo

### 6. Compatibilidad

El sistema mantiene compatibilidad con workflows de imágenes:
- Si el output contiene `images`, se manejan como antes
- Si el output contiene `gifs`, se manejan como videos
- Ambos tipos pueden coexistir

## Cómo Usar

1. Asegúrate de que ComfyUI esté corriendo en `192.168.0.13:8188`
2. Ejecuta el servidor: `node server.js`
3. Abre el navegador en `http://localhost:5634`
4. Ingresa un prompt y presiona "Generar Video"
5. Observa la barra de progreso mientras se genera
6. El video se mostrará automáticamente cuando esté listo

## Notas Técnicas

- **Formato de video**: WEBM (VP9 codec)
- **FPS**: 24 (configurado en el workflow)
- **Progreso**: Actualizado en tiempo real desde ComfyUI
- **Autoplay**: El video se reproduce automáticamente al cargar
- **Loop**: El video se repite en bucle

## Troubleshooting

Si no se muestra el progreso:
- Verifica que ComfyUI esté enviando mensajes de tipo `progress`
- Revisa la consola del navegador para errores

Si el video no se descarga:
- Verifica que el nodo 47 (SaveWEBM) esté activo en el workflow
- Asegúrate de que la carpeta `public/videos/` tenga permisos de escritura

Si el video no se reproduce:
- Verifica que el navegador soporte formato WEBM
- Revisa la ruta del video en la consola del navegador
