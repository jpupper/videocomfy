"""
Esperar a que ComfyUI termine la cola y copiar las imágenes a videocomfy.
"""
import urllib.request
import json
import time
import os
import shutil
import sys

COMFY_URL = "http://127.0.0.1:8188"

# Find ComfyUI output directory
possible_dirs = [
    "D:/IA/comfynew/ComfyUI/output",
    "D:/IA/ComfyUI/output",
    "C:/Users/JPupper/ComfyUI/output",
]
comfy_output = None
for d in possible_dirs:
    if os.path.isdir(d):
        comfy_output = d
        break

if not comfy_output:
    print("No se encontró carpeta output de ComfyUI")
    # Try to find it
    import subprocess
    result = subprocess.run(["where", "python"], capture_output=True, text=True, shell=True)
    # Just guess
    comfy_output = "D:/IA/comfynew/ComfyUI/output"

target_dir = "D:/Programacion/videocomfy/public/uploads"
os.makedirs(target_dir, exist_ok=True)

# Get initial image count
initial_images = [f for f in os.listdir(target_dir) if f.startswith("Flux_") and f.endswith(".png")]
print(f"Imágenes iniciales en uploads: {len(initial_images)}")

# Poll queue until empty
print("Esperando que la cola termine...", flush=True)
last_count = 0
stall_count = 0
while True:
    try:
        req = urllib.request.urlopen(f"{COMFY_URL}/queue", timeout=10)
        q = json.loads(req.read())
        running = q.get("queue_running", [])
        pending = q.get("queue_pending", [])
        total = len(running) + len(pending)
        
        if total == 0:
            print(f"\n✅ Cola vacía! Todas las imágenes generadas.")
            break
        
        # Look for new images
        current_images = [f for f in os.listdir(target_dir) if f.startswith("Flux_") and f.endswith(".png")]
        new_count = len(current_images) - len(initial_images)
        
        if new_count != last_count:
            print(f"\n  +{new_count} nuevas imágenes | Cola: {total} ({len(running)} running, {len(pending)} pending)", flush=True)
            last_count = new_count
            stall_count = 0
        else:
            stall_count += 1
        
        if stall_count > 60:
            print(f"\n  Sin cambios por 5 min... cola: {total}")
            stall_count = 0
            
    except Exception as e:
        print(f"\n  Error: {e}", flush=True)
    
    time.sleep(5)

# Now look for new FLUX images in the uploads folder
current_images = sorted([f for f in os.listdir(target_dir) if f.startswith("Flux_") and f.endswith(".png")])
new_images = current_images[-15:] if len(current_images) >= 15 else current_images

print(f"\n--- Imágenes generadas (últimas {len(new_images)}) ---")
for img in new_images:
    fpath = os.path.join(target_dir, img)
    size_kb = os.path.getsize(fpath) / 1024
    print(f"  {img:40s} {size_kb:.0f} KB")

print(f"\nCarpeta: {target_dir}")
print(f"Total Flux_: {len(current_images)}")
