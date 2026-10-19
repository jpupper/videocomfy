# GUÍA DE ESTILOS · COMFYLATAM

La única fuente de color y de forma es **`css/tema.css`**. Si algo no está ahí, se agrega como
token y se define en cada tema. **Nunca** un `#hex` a mano en un contenedor nuevo.

## 1. Tokens (los usa todo)

| token | para qué |
|---|---|
| `--ck-bg` | fondo de la página |
| `--ck-bg-2` | fondo hundido (consola, inputs, barra de progreso) |
| `--ck-panel` | fondo de tarjeta / panel |
| `--ck-panel-2` | tarjeta secundaria, fila alterna, botón normal |
| `--ck-borde` | líneas y bordes |
| `--ck-texto` | texto principal |
| `--ck-texto-2` | texto secundario, pistas, unidades |
| `--ck-acento` | marca: botón fuerte, foco, links, barra de progreso |
| `--ck-acento-2` | segundo acento (púrpura / cian) |
| `--ck-ok` / `--ck-aviso` / `--ck-error` | estados |
| `--ck-radio` | radio de esquinas de tarjetas |
| `--ck-sombra` | sombra de tarjeta |
| `--ck-fuente` | familia tipográfica |
| `--ck-velo` | opacidad del velo sobre el fondo animado |

Uso: `color: var(--ck-texto-2, #94a3b8);` — siempre con el respaldo del tema NOCHE, así si el
CSS se carga sin tema igual se ve bien.

## 2. Componentes

Todo contenedor nuevo se arma con estas clases (no se inventan estilos sueltos):

```html
<div class="ck-caja">
  <div class="ck-caja-hd">
    <h3 class="ck-titulo">TÍTULO</h3>
    <span class="ck-chip ok">LISTO</span>
  </div>
  <p class="ck-sub">texto secundario</p>
  <div class="ck-barra"><i style="width:42%"></i></div>
  <button class="ck-btn ck-fuerte">ACEPTAR</button>
</div>
```

- `.ck-caja` tarjeta · `.ck-caja-hd` cabecera · `.ck-titulo` / `.ck-sub` tipografía
- `.ck-btn` (+ `.ck-fuerte`) · `.ck-chip` (+ `.ok` `.aviso` `.error`)
- `.ck-campo` inputs y selects · `.ck-tabla` tablas · `.ck-barra` progreso
- `.ck-subtabs` submenús (rectos, pegados, gap 0) · `.ck-sep` separador

## 3. Reglas de la casa (no se negocian)

1. **Submenús rectos**: `border-radius: 0`, botones pegados, `gap: 0`.
2. **Un indicador por estado**: un punto (`.cfs-dot`, `.red-punto`), nunca punto + emoji.
3. **Sin iconitos decorativos** en botones de acción.
4. **El gris de WORKFLOWS no se toca** (es el color de "no compartido").
5. **Una sola fuente de estilo por pestaña**: si dos CSS pintan lo mismo, se borra el viejo.

## 4. Temas

Se aplican con `data-tema` en `<html>`: `noche` (default), `matrix`, `amoled`, `cyber`, `brasa`,
`hielo`. El selector está en el botón **🎨 TEMAS** de la barra superior (`js/temas.js`), que
también ofrece el **fondo animado** (include de JP Shader Editor, shader `neon-matrix-v6`:
líneas verticales y horizontales que se conectan, sin relleno) y el **velo**.

El tema se guarda en `localStorage` (`ck_tema`, `ck_tema_fondo`, `ck_tema_velo`) y se aplica en
`<head>` antes del primer pintado, así no hay flash.

## 5. Fondo animado

Con `html.ck-shader`: el `html` lleva el color del tema, el `body` queda transparente y el canvas
del include (z-index −1) se ve detrás de los paneles, atenuado por `--ck-velo`. Los paneles siguen
siendo opacos: la legibilidad no depende del shader.
