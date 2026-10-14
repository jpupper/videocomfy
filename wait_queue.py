"""
Wait for ComfyUI queue to empty, copy images to videocomfy uploads.
"""
import urllib.request, json, time, os, shutil

COMFY_URL = "http://127.0.0.1:8188"
COMFY_OUTPUT = "D:/IA/comfynew/ComfyUI/output/storyboard"
VIDEO_UPLOADS = "D:/Programacion/videocomfy/public/uploads"

os.makedirs(VIDEO_UPLOADS, exist_ok=True)

# Get current image count in videocomfy uploads
existing = [f for f in os.listdir(VIDEO_UPLOADS) if f.startswith("Flux_") and f.endswith(".png")]
print(f"Imágenes existentes en uploads: {len(existing)}")
last_upload_count = len(existing)

# Poll until queue empty
stalled = 0
while True:
    try:
        req = urllib.request.urlopen(f"{COMFY_URL}/queue", timeout=10)
        q = json.loads(req.read())
        running = q.get("queue_running", [])
        pending = q.get("queue_pending", [])
        total = len(running) + len(pending)
        
        # Check if new images appeared in Comfy output
        if os.path.isdir(COMFY_OUTPUT):
            comfy_files = sorted([f for f in os.listdir(COMFY_OUTPUT) if f.startswith("Flux_")])
        else:
            comfy_files = []
        
        # Copy new ones to videocomfy uploads
        copied = 0
        for f in comfy_files:
            src = os.path.join(COMFY_OUTPUT, f)
            dst = os.path.join(VIDEO_UPLOADS, f)
            if not os.path.exists(dst):
                shutil.copy2(src, dst)
                copied += 1
        
        if total == 0:
            print(f"\n✅ Cola vacía! Todas las imágenes generadas.")
            print(f"Copiadas ahora: {copied}")
            break
        
        # Show progress
        current_uploads = [f for f in os.listdir(VIDEO_UPLOADS) if f.startswith("Flux_")]
        new_images = len(current_uploads) - last_upload_count
        if new_images != last_upload_count:
            print(f"  +{new_images} nuevas | Cola: {total} ({len(running)} run, {len(pending)} pend)", flush=True)
            last_upload_count = new_images
            stalled = 0
        else:
            stalled += 1
            if stalled % 12 == 0:  # every ~60s
                print(f"  Cola: {total} procesando... ({stalled*5}s)", flush=True)
        
    except Exception as e:
        print(f"\n  Error: {e}", flush=True)
        stalled += 1
        if stalled > 120:  # 10 min error
            break
    
    time.sleep(5)

# Final report
print(f"\n--- IMÁGENES GENERADAS ---")
current_uploads = sorted([f for f in os.listdir(VIDEO_UPLOADS) if f.startswith("Flux_")])
print(f"Total en uploads: {len(current_uploads)}")
print(f"Últimas 15:")
for f in current_uploads[-15:]:
    sz = os.path.getsize(os.path.join(VIDEO_UPLOADS, f)) // 1024
    print(f"  {f:40s} {sz} KB")
print(f"\nCarpeta: {VIDEO_UPLOADS}")
