#!/usr/bin/env python3
"""Generate Canasta images one by one via ComfyUI REST API."""
import json, time, os, shutil, random, urllib.request, urllib.error

COMFY = "http://127.0.0.1:8188"
COMFY_OUTPUT = r"D:\IA\comfynew\ComfyUI\output"
CANASTA_PROD = r"D:\Programacion\caminosysabores\canasta\img\productos"
CANASTA_BAD = r"D:\Programacion\caminosysabores\canasta\img\malos"

PRODUCTS = [
    ("vinos", "A premium wine bottle and a glass of red wine on a rustic wooden table, warm ambient lighting, product photography, centered composition, clean white background"),
    ("aceite-oliva", "A glass bottle of extra virgin olive oil with golden liquid, olives next to it, rustic style, product photography, centered on clean white background, soft studio lighting"),
    ("miel-dulces", "A jar of golden honey with honeycomb, and traditional Argentine sweets (dulces) on a rustic wooden surface, warm lighting, product photography, centered composition"),
    ("tomate-triturado", "A glass jar of crushed tomatoes (tomate triturado), fresh tomatoes and basil leaves around it, Italian style, product photography, centered on clean background"),
    ("frutos-secos", "A wooden bowl filled with mixed nuts and dried fruits: almonds, walnuts, raisins, hazelnuts, rustic style, product photography, centered on warm background"),
    ("conservas", "Assorted canned preserves in glass jars: pickles, vegetables in oil, arranged on a wooden shelf, rustic Argentine style, product photography, centered composition"),
    ("gin", "A premium gin bottle with juniper berries and a slice of lime, crystal clear liquid, elegant style, product photography, centered on white background"),
    ("licor", "A bottle of Argentine liquor like licor de menta or crema de whiskey, with a small glass, warm lighting, product photography, centered composition"),
    ("yerba-mate", "A bag of yerba mate with a traditional mate gourd (mate) and bombilla, Argentine tradition, product photography, centered on clean background"),
    ("banana", "A bunch of fresh yellow bananas on a wooden surface, tropical fruit, product photography, centered on white background, studio lighting"),
    ("cafe", "A bag of roasted coffee beans with a cup of black coffee, steam rising, warm tones, product photography, centered composition"),
    ("cacao", "Cacao beans and cocoa powder on a rustic surface, dark chocolate pieces, product photography, centered on warm background"),
    ("coco", "A whole coconut cut in half showing white flesh and milk, tropical, on a wooden surface, product photography, centered composition"),
    ("anana", "A whole fresh pineapple with green leaves, tropical fruit, bright studio lighting, product photography, centered on white background"),
    ("palta", "A ripe avocado cut in half showing the pit, green flesh, on a wooden surface, product photography, centered composition"),
]

os.makedirs(CANASTA_PROD, exist_ok=True)
os.makedirs(CANASTA_BAD, exist_ok=True)

def make_wf(prod_id, prompt_text):
    seed = random.randint(0, 2**32 - 1)
    return {
        "38": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux1-dev.safetensors", "weight_dtype": "default"}},
        "39": {"class_type": "VAELoader", "inputs": {"vae_name": "ae.safetensors"}},
        "40": {"class_type": "DualCLIPLoader", "inputs": {"clip_name1": "clip_l.safetensors", "clip_name2": "t5xxl_fp16.safetensors", "type": "flux", "device": "default"}},
        "27": {"class_type": "EmptySD3LatentImage", "inputs": {"width": 1024, "height": 1024, "batch_size": 1}},
        "41": {"class_type": "CLIPTextEncodeFlux", "inputs": {"clip": ["40", 0], "clip_l": prompt_text, "t5xxl": prompt_text, "guidance": 3.5}},
        "42": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["41", 0]}},
        "31": {"class_type": "KSampler", "inputs": {"model": ["38", 0], "positive": ["41", 0], "negative": ["42", 0], "latent_image": ["27", 0], "seed": seed, "control_after_generate": "randomize", "steps": 30, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["31", 0], "vae": ["39", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": f"canasta/{prod_id}"}},
    }

def curl_or_die(endpoint, data=None, method="GET"):
    """Make HTTP request to ComfyUI using urllib."""
    url = f"{COMFY}{endpoint}"
    if data is not None:
        body = json.dumps(data).encode() if isinstance(data, dict) else data
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method=method)
    else:
        req = urllib.request.Request(url, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code}: {e.read().decode()[:200]}")
        return None
    except Exception as e:
        print(f"  Error: {e}")
        return None

def find_file(prod_id):
    """Find the generated file for this product."""
    # Check subfolder
    subfolder = os.path.join(COMFY_OUTPUT, "canasta")
    if os.path.isdir(subfolder):
        for f in sorted(os.listdir(subfolder)):
            if f.startswith(prod_id) and f.endswith(".png"):
                return os.path.join(subfolder, f), f
    # Fallback: main output
    for f in sorted(os.listdir(COMFY_OUTPUT)):
        if f.startswith(prod_id) and f.endswith(".png"):
            return os.path.join(COMFY_OUTPUT, f), f
    # Recursive
    for root, dirs, files in os.walk(COMFY_OUTPUT):
        for f in files:
            if f.startswith(prod_id) and f.endswith(".png"):
                return os.path.join(root, f), f
    return None, None


print("=== Generando imagenes Canasta (una por una) ===")
print(f"Total: {len(PRODUCTS)} imagenes\n")

results = []

for i, (prod_id, prompt) in enumerate(PRODUCTS):
    print(f"[{i+1}/{len(PRODUCTS)}] {prod_id}...", end=" ", flush=True)
    
    # Submit
    wf = make_wf(prod_id, prompt)
    resp = curl_or_die("/prompt", {"prompt": wf}, method="POST")
    if not resp or "prompt_id" not in resp:
        print("FAILED to submit")
        results.append((prod_id, "submit_failed"))
        continue
    
    prompt_id = resp["prompt_id"]
    print(f"id={prompt_id[:8]}...", end=" ", flush=True)
    
    # Wait for completion
    for attempt in range(120):  # 10 min
        time.sleep(5)
        history = curl_or_die(f"/history/{prompt_id}")
        if history and prompt_id in history:
            entry = history[prompt_id]
            if entry.get("status", {}).get("completed", False):
                time.sleep(2)  # Let file write settle
                src, fname = find_file(prod_id)
                if src:
                    dst_folder = CANASTA_PROD if i < 8 else CANASTA_BAD
                    dst = os.path.join(dst_folder, f"{prod_id}.png")
                    shutil.copy2(src, dst)
                    print(f"OK -> {fname}")
                    results.append((prod_id, "ok"))
                else:
                    print("OK pero no se encontro archivo")
                    results.append((prod_id, "completed_no_file"))
                break
    else:
        print("TIMEOUT")
        results.append((prod_id, "timeout"))
    
    # Brief pause
    time.sleep(2)

print("\n=== RESUMEN ===")
ok_count = sum(1 for _, s in results if s == "ok")
print(f"OK: {ok_count}/{len(results)}")
for pid, status in results:
    print(f"  {pid}: {status}")

print("\n=== Archivos generados ===")
for folder_name, folder_path in [("productos", CANASTA_PROD), ("malos", CANASTA_BAD)]:
    print(f"\nimg/{folder_name}/:")
    for f in sorted(os.listdir(folder_path)):
        size = os.path.getsize(os.path.join(folder_path, f))
        print(f"  {f} ({size/1024:.0f} KB)")
