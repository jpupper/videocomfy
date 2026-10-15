#!/usr/bin/env python3
"""Generate all Canasta product images via direct ComfyUI REST API."""
import json, time, os, sys, urllib.request, urllib.error, shutil, random

COMFY = "http://127.0.0.1:8188"
COMFY_OUTPUT = r"D:\IA\comfynew\ComfyUI\output"
CANASTA_PROD = r"D:\Programacion\caminosysabores\canasta\img\productos"
CANASTA_BAD = r"D:\Programacion\caminosysabores\canasta\img\malos"

PRODUCTS = [
    # Correctos (suman punto)
    {"id": "vinos", "prompt": "A premium wine bottle and a glass of red wine on a rustic wooden table, warm ambient lighting, product photography, centered composition, clean white background"},
    {"id": "aceite-oliva", "prompt": "A glass bottle of extra virgin olive oil with golden liquid, olives next to it, rustic style, product photography, centered on clean white background, soft studio lighting"},
    {"id": "miel-dulces", "prompt": "A jar of golden honey with honeycomb, and traditional Argentine sweets (dulces) on a rustic wooden surface, warm lighting, product photography, centered composition"},
    {"id": "tomate-triturado", "prompt": "A glass jar of crushed tomatoes (tomate triturado), fresh tomatoes and basil leaves around it, Italian style, product photography, centered on clean background"},
    {"id": "frutos-secos", "prompt": "A wooden bowl filled with mixed nuts and dried fruits: almonds, walnuts, raisins, hazelnuts, rustic style, product photography, centered on warm background"},
    {"id": "conservas", "prompt": "Assorted canned preserves in glass jars: pickles, vegetables in oil, arranged on a wooden shelf, rustic Argentine style, product photography, centered composition"},
    {"id": "gin", "prompt": "A premium gin bottle with juniper berries and a slice of lime, crystal clear liquid, elegant style, product photography, centered on white background"},
    {"id": "licor", "prompt": "A bottle of Argentine liquor like licor de menta or crema de whiskey, with a small glass, warm lighting, product photography, centered composition"},
    # Incorrectos (restan punto)
    {"id": "yerba-mate", "prompt": "A bag of yerba mate with a traditional mate gourd (mate) and bombilla, Argentine tradition, product photography, centered on clean background"},
    {"id": "banana", "prompt": "A bunch of fresh yellow bananas on a wooden surface, tropical fruit, product photography, centered on white background, studio lighting"},
    {"id": "cafe", "prompt": "A bag of roasted coffee beans with a cup of black coffee, steam rising, warm tones, product photography, centered composition"},
    {"id": "cacao", "prompt": "Cacao beans and cocoa powder on a rustic surface, dark chocolate pieces, product photography, centered on warm background"},
    {"id": "coco", "prompt": "A whole coconut cut in half showing white flesh and milk, tropical, on a wooden surface, product photography, centered composition"},
    {"id": "anana", "prompt": "A whole fresh pineapple with green leaves, tropical fruit, bright studio lighting, product photography, centered on white background"},
    {"id": "palta", "prompt": "A ripe avocado cut in half showing the pit, green flesh, on a wooden surface, product photography, centered composition"},
]

def make_workflow(prompt_text, prod_id, seed=None):
    if seed is None:
        seed = random.randint(0, 2**32 - 1)
    return {
        "38": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux1-dev.safetensors", "weight_dtype": "default"}},
        "39": {"class_type": "VAELoader", "inputs": {"vae_name": "ae.safetensors"}},
        "40": {"class_type": "DualCLIPLoader", "inputs": {"clip_name1": "clip_l.safetensors", "clip_name2": "t5xxl_fp16.safetensors", "type": "flux", "device": "default"}},
        "27": {"class_type": "EmptySD3LatentImage", "inputs": {"width": 1024, "height": 1024, "batch_size": 1}},
        "41": {"class_type": "CLIPTextEncodeFlux", "inputs": {"clip": ["40", 0], "clip_l": prompt_text, "t5xxl": prompt_text, "guidance": 3.5}},
        "42": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["41", 0]}},
        "31": {"class_type": "KSampler", "inputs": {"model": ["38", 0], "positive": ["41", 0], "negative": ["42", 0], "latent_image": ["27", 0], "seed": seed, "control_after_generate": "fixed", "steps": 30, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["31", 0], "vae": ["39", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": f"canasta/{prod_id}"}},
    }

def post_json(endpoint, data):
    req = urllib.request.Request(f"{COMFY}{endpoint}",
        data=json.dumps(data).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"  HTTP Error {e.code}: {e.read().decode()[:200]}")
    except Exception as e:
        print(f"  Error: {e}")
    return None

def get_history(prompt_id):
    try:
        with urllib.request.urlopen(f"{COMFY}/history/{prompt_id}", timeout=10) as resp:
            data = json.loads(resp.read().decode())
            return data.get(prompt_id)
    except:
        return None

def find_output_file(prod_id):
    """Find the generated file for this product in ComfyUI output."""
    # Check subfolder first (prefix: canasta/vinos)
    subfolder = os.path.join(COMFY_OUTPUT, "canasta")
    if os.path.isdir(subfolder):
        for f in os.listdir(subfolder):
            if f.startswith(prod_id) and f.endswith(".png") and not f.startswith("._"):
                return os.path.join(subfolder, f)
    # Fallback: main output dir (in case subfolder wasn't created)
    for f in os.listdir(COMFY_OUTPUT):
        if f.startswith(prod_id) and f.endswith(".png") and not f.startswith("._"):
            return os.path.join(COMFY_OUTPUT, f)
    # Second fallback: recursive search
    for root, dirs, files in os.walk(COMFY_OUTPUT):
        for f in files:
            if f.startswith(prod_id) and f.endswith(".png"):
                return os.path.join(root, f)
    return None


print("=== Generando imagenes Canasta (via ComfyUI REST) ===")
print(f"Total: {len(PRODUCTS)} productos\n")

os.makedirs(CANASTA_PROD, exist_ok=True)
os.makedirs(CANASTA_BAD, exist_ok=True)

results = []

for i, prod in enumerate(PRODUCTS):
    print(f"[{i+1}/{len(PRODUCTS)}] {prod['id']}...", end=" ", flush=True)

    wf = make_workflow(prod["prompt"], prod["id"])
    resp = post_json("/prompt", {"prompt": wf})
    if not resp or "prompt_id" not in resp:
        print("FAILED to submit")
        results.append({"id": prod["id"], "status": "error"})
        continue

    prompt_id = resp["prompt_id"]
    print(f"id={prompt_id[:8]}...", end=" ", flush=True)

    timeout = 300
    waited = 0
    done = False
    while waited < timeout:
        time.sleep(5)
        waited += 5
        history = get_history(prompt_id)
        if history and history.get("status", {}).get("completed"):
            # Wait a moment for file to be written
            time.sleep(2)
            src = find_output_file(prod["id"])
            if src:
                print(f"OK -> {os.path.basename(src)}")
                dst_folder = CANASTA_PROD if i < 8 else CANASTA_BAD
                dst = os.path.join(dst_folder, f"{prod['id']}.png")
                shutil.copy2(src, dst)
                print(f"    Copiado a: {dst}")
                results.append({"id": prod["id"], "filename": os.path.basename(src)})
                done = True
                break
            else:
                print("OK pero no se encontro archivo")
                results.append({"id": prod["id"], "status": "completed_but_not_found"})
                done = True
                break
        if done:
            break

    if not done:
        print("TIMEOUT")
        results.append({"id": prod["id"], "status": "timeout"})

    # Small pause
    time.sleep(2)

print("\n=== RESUMEN ===")
ok = sum(1 for r in results if r.get("filename"))
fail = sum(1 for r in results if r.get("status", "").startswith("error") or r.get("status") == "timeout")
print(f"OK: {ok}, Fallos: {fail}")
for r in results:
    print(f"  {r['id']}: {r.get('filename', r.get('status', '?'))}")

print("\n=== Archivos en img/productos/ ===")
for f in sorted(os.listdir(CANASTA_PROD)):
    print(f"  {f}")
print("\n=== Archivos en img/malos/ ===")
for f in sorted(os.listdir(CANASTA_BAD)):
    print(f"  {f}")
