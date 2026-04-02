---
name: Prompt Master LTX-2 & Flux (ULTRA)
description: Guía maestra definitiva para generación de video de alta calidad. Incluye Flux, LTX-2 y el sistema de batches JSON.
---

# 🚀 MEGA-Guía: El Sistema Maestro de Prompting (Flux + LTX-2)

Esta guía define el estándar absoluto para generar clips detallados y videos cinemáticos. La clave del éxito es entender cómo cada motor (Flux y LTX-2) se complementa dentro del flujo de trabajo de VideoComfy.

---

## 0) 🧠 Paso de Pensamiento Cinematográfico (OBLIGATORIO)
Antes de generar el JSON, el sistema DEBE realizar un proceso de "Director Mode":
1.  **Storyboards en Planos**: Desglosa la historia del usuario en **Planos Individuales**, no en escenas genéricas.
2.  **Continuidad Cinematográfica (Raccord)**: Asegura que el final de un clip conecte lógicamente con el inicio del siguiente (Match cut, Eye-line match, Directional consistency).
3.  **Variedad de Encuadre**: Alterna entre *Wide Shot* (establecer contexto), *Medium Shot* (acción) y *Close-up* (detalle/emoción).

## 1) 🇪🇸 Regla de Oro: Idioma de los Diálogos
- **ENTRADA ESPAÑOL = DIÁLOGO ESPAÑOL**: Si el prompt del usuario está en español, los diálogos dentro de las comillas (`" "`) en `VIDEO IMAGE` **DEBEN estar en español**.
- **PROMPTS TÉCNICOS**: Las descripciones de cámara, luz y texturas deben permanecer en **inglés** para que los modelos Flux/LTX-2 las entiendan perfectamente.
- *Ejemplo*: `"¡Cuidado con la trampa!" shouts the hero while running.`

## 2) 📸 Cómo Promptear FLUX (Imágenes - Frame 0)
Flux crea la base visual.
- **Enfoque**: Texturas, materiales, profundidad de campo (bokeh) y micro-detalles.
- **Estructura**: `[Sujeto Principal] + [Pose Estática] + [Luz/Color] + [Lente/Cámara]`.
- **Sin Negativos**: Usa descriptores positivos ("cristalino", "nítido").
- **Ejemplo**: `Medium shot of a weathered astronaut standing on red dust, sunset lighting, scratched visor reflections, shot on 35mm.`

## 3) 🎬 Cómo Promptear LTX-2 (Video - Movimiento)
LTX-2 añade la vida y la cinematografía al Frame 0 de Flux.
- **Tipo de Plano**: Sé explícito (Close-up, Extreme Wide Shot, Point of View).
- **Movimiento de Cámara**: Usa términos cine: `Dolly in`, `Slow pan left`, `Handheld tracking`, `Crane up`.
- **Acción Dinámica**: Describe qué cambia. "The dust swirls as the astronaut steps forward."

## 4) 🧩 Sistema de Batches JSON (Formato Único)
El sistema solo acepta este formato. Cada objeto en `steps` es un **Plano Cinematográfico**.

```json
{
  "globalImage": "Cinematic film grain, 35mm anamorphic look, professional color grading, realistic textures...",
  "globalVideo": "Sound of wind and heavy breathing. Character voice is muffled by a helmet...",
  "steps": [
    {
      "PROMPT IMAGE": "Wide shot of a desolate desert under a purple sky (Focus on environment).",
      "VIDEO IMAGE": "Slow drone flying forward. Dust clouds move across the screen. (Motion only)."
    },
    {
      "PROMPT IMAGE": "Medium shot of a lone wanderer looking at the horizon (Focus on character).",
      "VIDEO IMAGE": "Camera tracks the wanderer from behind. The wanderer says 'Este lugar ya no es seguro.' while looking around (Dialogue in Spanish)."
    }
  ]
}
```

## 5) 🗝️ Reglas Críticas para la Continuidad
1.  **Mantén al Sujeto**: Describe al personaje de la misma forma en cada `PROMPT IMAGE` para evitar que cambie de cara o ropa.
2.  **Consistencia de Luz**: Si el Sol está a la izquierda en el Paso 1, manténlo así en el Paso 2 a menos que la cámara gire.
3.  **Raccord de Movimiento**: Si la cámara termina un `Dolly In` en el Clip 1, el Clip 2 puede empezar con un `Close-up` estático para dar impacto.

---
**IMPORTANTE**: El éxito del batch depende de que pienses como un director de cine, no como un escritor de cuentos. Cada step es un **corte de cámara**.
