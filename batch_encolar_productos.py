"""
Queue all 15 product images directly into ComfyUI via API.
ComfyUI handles the internal queue natively.
"""
import urllib.request
import json
import time
import os
import sys

COMFY_URL = "http://127.0.0.1:8188"
WORKFLOW_PATH = "D:/Programacion/videocomfy/flux_dev_full_text_to_image_api.json"

PRODUCTOS = [
    # Correctos (suman punto)
    ("vino", "Botella de vino tinto, etiqueta clásica, aislado sobre fondo blanco, fotografía de producto, iluminación de estudio, ultra detallado, 8k"),
    ("aceite-oliva", "Botella de aceite de oliva virgen extra, vidrio verde oscuro, etiqueta rústica dorada, aislado sobre fondo blanco, fotografía de producto, iluminación de estudio, ultra detallado"),
    ("miel-dulces", "Tarro de miel artesanal con panal de cera, etiqueta dorada, rodeado de dulces regionales, aislado sobre fondo blanco, fotografía de producto, ultra detallado"),
    ("tomate", "Tarro de vidrio de tomate triturado, salsa roja brillante, etiqueta italiana clásica, aislado sobre fondo blanco, fotografía de producto, ultra detallado"),
    ("frutos-secos", "Cuenco de madera con frutos secos variados: almendras, nueces, pasas, avellanas, estilo rústico, fotografía de producto, centrado sobre fondo blanco, ultra detallado"),
    ("conservas", "Latas de conservas artesanales, verduras en escabeche, etiqueta vintage, aislado sobre fondo blanco, fotografía de producto, iluminación de estudio, ultra detallado, 8k"),
    ("gin", "Botella de ginebra artesanal premium, vidrio azul oscuro, bayas de enebro, rodaja de lima, etiqueta vintage dorada, aislado sobre fondo blanco, fotografía de producto"),
    ("licor", "Botella de licor dulce artesanal, vidrio ámbar, etiqueta dorada clásica, aislado sobre fondo blanco, fotografía de producto, iluminación de estudio, ultra detallado, 8k"),
    # Incorrectos (restan punto)
    ("yerba-mate", "Paquete de yerba mate tradicional argentina, hojas verdes, envase con tipografía clásica, aislado sobre fondo blanco, fotografía de producto, ultra detallado"),
    ("banana", "Bananas frescas maduras, racimo amarillo brillante con detalles verdes, aislado sobre fondo blanco, fotografía de producto, iluminación de estudio, ultra detallado, 8k"),
    ("cafe", "Granos de café tostado oscuro recién molido, bolsa artesanal de arpillera, aislado sobre fondo blanco, fotografía de producto, iluminación de estudio, ultra detallado"),
    ("cacao", "Semillas de cacao crudo y tableta de chocolate artesanal oscuro, envase rústico, aislado sobre fondo blanco, fotografía de producto, ultra detallado"),
    ("coco", "Coco fresco partido mostrando pulpa blanca y agua de coco en vidrio, aislado sobre fondo blanco, fotografía de producto, iluminación de estudio"),
    ("anana", "Piña tropical fresca entera con hojas verdes brillantes, aislado sobre fondo blanco, fotografía de producto, iluminación de estudio, ultra detallado, 8k"),
    ("palta", "Aguacate palta fresco entero y corte transversal mostrando pulpa verde cremosa, aislado sobre fondo blanco, fotografía de producto"),    
]

# Load workflow template
with open(WORKFLOW_PATH, 'r') as f:
    template = json.load(f)

# Verify key nodes exist
required_nodes = ["41", "9", "38", "39", "40", "27", "31", "42", "8"]
for n in required_nodes:
    assert n in template, f"Missing node {n} in workflow"

submitted = []
errors = []

for name, prompt_text in PRODUCTOS:
    # Deep copy the workflow
    wf = json.loads(json.dumps(template))
    
    # Inject the prompt
    wf["41"]["inputs"]["clip_l"] = prompt_text
    wf["41"]["inputs"]["t5xxl"] = prompt_text
    
    # Randomize seed
    import random
    wf["31"]["inputs"]["seed"] = random.randint(0, 2**63 - 1)
    
    # Queue to ComfyUI
    body = json.dumps({"prompt": wf}).encode()
    req = urllib.request.Request(
        f"{COMFY_URL}/prompt",
        data=body,
        headers={"Content-Type": "application/json"}
    )
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        result = json.loads(resp.read())
        pid = result.get("prompt_id", "?")
        submitted.append((name, prompt_text[:60], pid))
        print(f"✅ [{name:15s}] encolado → PID: {pid[:20]}...")
    except Exception as e:
        errors.append((name, str(e)))
        print(f"❌ [{name:15s}] ERROR: {e}")

print(f"\n--- Resumen ---")
print(f"Encolados: {len(submitted)}")
print(f"Errores: {len(errors)}")
print(f"\nItems en cola:")
for name, p, pid in submitted:
    print(f"  [{name:15s}] {p}")

if errors:
    print(f"\nErrores:")
    for name, e in errors:
        print(f"  [{name:15s}] {e}")

print(f"\nLas imágenes se guardarán en ComfyUI/output/ (subcarpeta storyboard/)")
print(f"Luego las copio a videocomfy/public/uploads/")
