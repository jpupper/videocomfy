# Video Blending Feature

## Descripción

Esta funcionalidad permite combinar múltiples videos generados con transiciones suaves (blending) entre ellos, creando un video continuo con efectos de fundido.

## Requisitos

### FFmpeg
El blending de videos requiere **FFmpeg** instalado en el sistema.

#### Instalación en Windows:
1. Descarga FFmpeg desde: https://www.gyan.dev/ffmpeg/builds/
2. Extrae el archivo ZIP
3. Agrega la carpeta `bin` de FFmpeg al PATH del sistema:
   - Busca "Variables de entorno" en Windows
   - Edita la variable PATH
   - Agrega la ruta completa a la carpeta `bin` (ejemplo: `C:\ffmpeg\bin`)
4. Verifica la instalación abriendo PowerShell y ejecutando:
   ```powershell
   ffmpeg -version
   ```

## Cómo Usar

### 1. Activar Modo Blending
- Haz clic en el botón **"🎞️ Modo Blending de Videos"** en el panel de controles
- El botón cambiará a rojo indicando que el modo está activo
- Aparecerán los controles de blending en la parte superior del panel de salida

### 2. Seleccionar Videos
- Haz clic en los videos de la galería que deseas combinar
- Los videos seleccionados mostrarán:
  - Un borde verde brillante
  - Un número en la esquina superior izquierda indicando el orden
  - Una marca de verificación (✓) en la esquina superior derecha
- Puedes seleccionar 2 o más videos
- El orden de selección determina el orden en el video final

### 3. Configurar Transición
- Ajusta el slider **"Duración de Transición"** (0.5 a 3 segundos)
- Este valor determina cuánto tiempo dura el efecto de fundido entre videos

### 4. Crear Video
- Haz clic en **"🎬 Crear Video con Blending"**
- El proceso puede tomar varios minutos dependiendo de:
  - Cantidad de videos
  - Duración de cada video
  - Resolución de los videos
- El progreso se mostrará en la barra de estado
- El video resultante aparecerá automáticamente en la galería

### 5. Cancelar
- Haz clic en **"❌ Cancelar Selección"** para limpiar la selección
- O haz clic nuevamente en **"❌ Salir de Modo Blending"** para desactivar el modo

## Características Técnicas

### Transiciones
- Utiliza el filtro `xfade` de FFmpeg con transición tipo `fade`
- Crea fundidos suaves entre videos consecutivos
- Mantiene la calidad de video original

### Formato de Salida
- Codec: VP9 (WebM)
- Bitrate: 2 Mbps
- Nombre: `blended_[timestamp].webm`

### Limitaciones
- Todos los videos deben tener la misma resolución (recomendado)
- Si las resoluciones difieren, FFmpeg las ajustará automáticamente
- El proceso es intensivo en CPU

## Solución de Problemas

### Error: "FFmpeg no encontrado"
- Verifica que FFmpeg esté instalado
- Asegúrate de que esté en el PATH del sistema
- Reinicia el servidor después de instalar FFmpeg

### El blending tarda mucho
- Es normal para videos largos o de alta resolución
- Considera reducir la duración de transición
- Usa menos videos en la secuencia

### El video resultante tiene problemas
- Verifica que todos los videos originales se reproduzcan correctamente
- Asegúrate de que tengan resoluciones similares
- Revisa los logs del servidor para más detalles

## API Endpoint

### POST `/api/blend-videos`

**Request Body:**
```json
{
  "videos": ["video1.webm", "video2.webm", "video3.webm"],
  "blendDuration": 1.0,
  "outputName": "mi_video_blended.webm" // opcional
}
```

**Response:**
```json
{
  "success": true,
  "filename": "blended_1234567890.webm",
  "url": "/videos/blended_1234567890.webm"
}
```

## Ejemplos de Uso

### Crear una secuencia narrativa
1. Genera varios videos con prompts relacionados
2. Selecciónalos en orden cronológico
3. Usa una transición de 1-1.5 segundos para fluidez

### Crear un loop continuo
1. Genera videos con temas similares
2. Selecciónalos en el orden deseado
3. Usa transiciones cortas (0.5-0.8 segundos)
4. El video resultante puede reproducirse en loop

### Crear un montaje artístico
1. Genera videos con diferentes estilos
2. Experimenta con diferentes órdenes
3. Usa transiciones más largas (2-3 segundos) para efectos dramáticos
