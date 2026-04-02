---
name: Prompt Master LTX-2 & Flux (ULTRA)
description: Guía maestra definitiva para generación de video de alta calidad. Incluye Flux, LTX-2 y el sistema de batches JSON.
---

# 🚀 MEGA-Guía: El Sistema Maestro de Prompting (Flux + LTX-2)

Esta guía define el estándar absoluto para generar clips detallados y videos cinemáticos. La clave del éxito es entender cómo cada motor (Flux y LTX-2) se complementa dentro del flujo de trabajo de VideoComfy.

---

## 1) Cómo Promptear FLUX (Imágenes)
Flux es el motor de **Calidad Visual Extrema**. Su objetivo es crear el "Frame 0" con la máxima nitidez, detalle y fidelidad.
- **Enfoque**: Describe texturas, materiales, profundidades de campo y micro-detalles.
- **Lenguaje**: Usa lenguaje natural descriptivo. Imagina que describes una fotografía de National Geographic o un cuadro de 4k.
- **Sin Negativos**: Flux no entiende lo que NO quieres. Usa descriptores positivos como "cristalino", "foco nítido", "detalles granulares".

## 2) Cómo Promptear LTX-2 (Video)
LTX-2 es el motor de **Movimiento y Plot**. Su trabajo no es "dibujar" el detalle (eso lo hace Flux), sino moverlo cinematográficamente.
- **Movimientos de Cámara**: Debes ser explícito. Usa términos como `slow pan right`, `dolly in`, `crane up`, o `handheld tracking`.
- **Acción Presente**: Describe la acción en tiempo presente: "La cámara sigue al corredor mientras las chispas saltan".
- **Diálogos**: Siempre entre **comillas**. Ej: `"¡Corran por sus vidas!" gritó el hombre.`

## 3) Cómo funciona el Sistema de Global Prompts
Los Global Prompts son el "pegamento" de consistencia para todo el Batch. Evitan que las imágenes o videos de una secuencia parezcan de películas diferentes.
- Se aplican como prefijo a cada paso de la secuencia.
- Sirven para inyectar el **Style Code** general (ej: "estética de película de los 70, grano de 35mm").

## 4) Cómo funciona el Sistema de Global Prompt de Imagen
Este campo afecta exclusivamente a Flux.
- **Uso**: Inyecta la "Personalidad Visual".
- **Ejemplo**: `Cinematic masterpiece, shot on Sony A7R IV, 85mm lens, f/1.8, soft bokeh, warm sunset lighting.`
- Todo lo que pongas aquí se sumará a los prompts individuales de cada paso, garantizando que el color y la textura sean iguales en toda la secuencia.

## 5) Cómo funciona el Sistema de Global Prompt de Video
Este campo afecta exclusivamente a LTX-2. 
- **Voz del Personaje**: Aquí es donde se define el tono y la voz. Ej: `The main character speaks with a raspy, deep male voice, southern accent.`
- **Consistencia de Cámara**: Puedes definir un estilo de cámara global, ej: `Shaky handheld camera style, intense cinematic movement.`

## 6) Cómo funciona el Prompt Ideal para FLUX
El prompt ideal para Flux es **Front-Loaded** (sujeto al principio) y **Técnico**.
- **Estructura**: `[Sujeto Principal] + [Acción Estática/Pose] + [Luz/Color] + [Referencia de Cámara/Lente]`.
- **Ejemplo**: `Close-up de un caballero robótico oxidado parado en un campo de flores azules, luz de atardecer filtrada, texturas de metal rayado, 8k, shot on 35mm lens.`

## 7) Cómo funciona el Prompt Ideal para LTX-2
El prompt ideal para LTX-2 se enfoca en la **Transformación y Cinematografía**.
- **Estructura**: `[Toma de Cámara] + [Acción del Sujeto] + [Evolución de la Escena] + [Audio/Voces]`.
- **Ejemplo**: `Slow dolly in on the robot. The robot raises its hand slowly while humming a mechanical tune. At the same time, the wind blows the flowers violently. Camera tracks the robot's hand as it touches a butterfly.`

## 8) Cómo se escriben específicamente los JSONs (Único Formato Admisible)
El sistema de batches **SOLO** acepta este formato JSON. No se admiten variaciones. Cada objeto en el array `steps` representa un **Clip** completo.

```json
{
  "globalImage": "Style, lighting and film stock for ALL images...",
  "globalVideo": "Voice description and character tone for ALL videos...",
  "steps": [
    {
      "PROMPT IMAGE": "The specific visual start frame for this clip (Flux).",
      "VIDEO IMAGE": "The motion, camera movement and dialogues for this clip (LTX-2)."
    },
    {
      "PROMPT IMAGE": "Second clip image description...",
      "VIDEO IMAGE": "Second clip animation and dialogues..."
    }
  ]
}
```

### 🗝️ Reglas Críticas del JSON
- **PROMPT IMAGE**: Siempre para la calidad visual inicial.
- **VIDEO IMAGE**: Siempre para la acción y los diálogos (usar "comillas").
- **Strict Format**: El JSON debe ser válido (comprobar comas y llaves). Este es el motor que permite la creación de películas completas por lotes. Siempre tiene que tener ese formato con esas variables de nombre.

