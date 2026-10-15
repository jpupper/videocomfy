#!/usr/bin/env python3
"""
Crystal Demons Video Generator
Uses ComfyUI HTTP API directly. More reliable than Node.js for long-running tasks.
"""
import urllib.request, urllib.error
import json, time, os, sys, re

COMFY_HOST = "127.0.0.1"
COMFY_PORT = 8188
PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(PROJECT_DIR, "public", "uploads")
VIDEOS_DIR = os.path.join(PROJECT_DIR, "public", "videos")

# Ensure dirs exist
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(VIDEOS_DIR, exist_ok=True)

def http_json(method, url_path, data=None):
    """HTTP JSON request to ComfyUI"""
    payload = json.dumps(data).encode() if data else None
    req = urllib.request.Request(
        f"http://{COMFY_HOST}:{COMFY_PORT}{url_path}",
        data=payload,
        headers={"Content-Type": "application/json"} if data else {},
        method=method
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())

def upload_image(filepath, filename):
    """Upload image to ComfyUI input folder"""
    import http.client
    import mimetypes
    from io import BytesIO
    
    boundary = "----WebKitFormBoundary" + os.urandom(16).hex()
    
    # Build multipart form
    body = BytesIO()
    body.write(f"--{boundary}\r\n".encode())
    body.write(f'Content-Disposition: form-data; name="image"; filename="{filename}"\r\n'.encode())
    body.write(f"Content-Type: {mimetypes.guess_type(filename)[0] or 'image/png'}\r\n\r\n".encode())
    with open(filepath, "rb") as f:
        body.write(f.read())
    body.write(f"\r\n--{boundary}--\r\n".encode())
    
    conn = http.client.HTTPConnection(COMFY_HOST, COMFY_PORT, timeout=30)
    conn.request("POST", "/upload/image", body.getvalue(),
                 {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    resp = conn.getresponse()
    result = json.loads(resp.read())
    conn.close()
    return result

def queue_prompt(workflow):
    """Queue a prompt and return prompt_id"""
    data = {"prompt": workflow, "client_id": f"cd_{int(time.time()*1000)}"}
    result = http_json("POST", "/prompt", data)
    pid = result["prompt_id"]
    print(f"  ✅ Queued: {pid[:8]}...")
    return pid

def wait_for_prompt(pid, poll_interval=15, max_wait=600):
    """Poll history until prompt completes"""
    start = time.time()
    while time.time() - start < max_wait:
        hist = http_json("GET", f"/history/{pid}")
        if pid in hist:
            h = hist[pid]
            if h.get("status", {}).get("completed"):
                elapsed = time.time() - start
                print(f"  ✅ Done! ({elapsed:.0f}s)")
                return h.get("outputs", {})
            if h.get("status", {}).get("error"):
                raise Exception(f"ComfyUI error: {h['status']['error']}")
        
        # Show progress indicator
        elapsed = int(time.time() - start)
        sys.stdout.write(f"\r  ⏳ {elapsed}s elapsed...")
        sys.stdout.flush()
        time.sleep(poll_interval)
    
    raise TimeoutError(f"Prompt {pid} didn't complete in {max_wait}s")

def download_file(filename, subfolder, file_type, save_dir, new_name=None):
    """Download a file from ComfyUI output"""
    ext = os.path.splitext(filename)[1]
    local_name = new_name or f"download_{int(time.time()*1000)}{ext}"
    
    parts = [
        f"filename={urllib.parse.quote(filename)}",
    ]
    if subfolder:
        parts.append(f"subfolder={urllib.parse.quote(subfolder)}")
    parts.append(f"type={urllib.parse.quote(file_type or 'output')}")
    
    url = f"http://{COMFY_HOST}:{COMFY_PORT}/view?{'&'.join(parts)}"
    
    target_path = os.path.join(save_dir, local_name)
    
    with urllib.request.urlopen(url, timeout=60) as resp:
        data = resp.read()
    
    with open(target_path, "wb") as f:
        f.write(data)
    
    size_mb = len(data) / (1024*1024)
    print(f"  💾 Saved: {local_name} ({size_mb:.1f} MB)")
    return local_name

def extract_output_files(outputs):
    """Extract all output files from ComfyUI outputs dict"""
    files = []
    for node_id, node_out in outputs.items():
        for key in ("images", "gifs", "video"):
            if key in node_out:
                items = node_out[key]
                if not isinstance(items, list):
                    items = [items]
                for item in items:
                    files.append(item)
    return files

def generate_image(prompt, index, batch_id):
    """Generate a FLUX image from text prompt"""
    print(f"\n🖼️ [{batch_id}] Step {index}: Generating image...")
    
    with open(os.path.join(PROJECT_DIR, "flux_dev_full_text_to_image_api.json")) as f:
        workflow = json.load(f)
    
    workflow["41"]["inputs"]["clip_l"] = prompt
    workflow["41"]["inputs"]["t5xxl"] = prompt
    workflow["31"]["inputs"]["seed"] = int(time.time() * 1000) % 1000000000000000
    workflow["27"]["inputs"]["width"] = 1280
    workflow["27"]["inputs"]["height"] = 720
    workflow["31"]["inputs"]["steps"] = 25
    
    pid = queue_prompt(workflow)
    outputs = wait_for_prompt(pid, poll_interval=5, max_wait=180)
    
    files = extract_output_files(outputs)
    if not files:
        print("  ⚠️ No output files")
        return None
    
    img = files[0]
    local_name = download_file(img["filename"], img.get("subfolder", ""),
                               img.get("type", "output"), UPLOAD_DIR,
                               f"storyboard_{batch_id}_{index}.png")
    
    # Upload to ComfyUI input for I2V
    local_path = os.path.join(UPLOAD_DIR, local_name)
    upload_image(local_path, local_name)
    print(f"  ✅ Image ready: {local_name}")
    
    return local_name

def generate_video_from_image(prompt, img_filename, index, batch_id, params=None):
    """Generate LTX-2 video from image"""
    print(f"\n🎬 [{batch_id}] Step {index}: Generating video from image...")
    
    with open(os.path.join(PROJECT_DIR, "video_ltx2_i2v_api.json")) as f:
        workflow = json.load(f)
    
    params = params or {}
    
    workflow["3"]["inputs"]["text"] = prompt
    workflow["200"]["inputs"]["image"] = img_filename
    workflow["201"]["inputs"]["resize_type.width"] = params.get("width", 1280)
    workflow["201"]["inputs"]["resize_type.height"] = params.get("height", 720)
    workflow["62"]["inputs"]["value"] = params.get("frames", 121)
    workflow["47"]["inputs"]["cfg"] = params.get("cfg", 4.0)
    workflow["9"]["inputs"]["steps"] = params.get("steps", 20)
    
    seed = int(time.time() * 100000) % 1000000000
    workflow["11"]["inputs"]["noise_seed"] = seed
    workflow["67"]["inputs"]["noise_seed"] = seed
    
    ref_str = params.get("refStrength")
    if ref_str is not None:
        workflow["107"]["inputs"]["strength"] = ref_str
        workflow["108"]["inputs"]["strength"] = ref_str
    
    pid = queue_prompt(workflow)
    outputs = wait_for_prompt(pid, poll_interval=15, max_wait=600)
    
    files = extract_output_files(outputs)
    if not files:
        print("  ⚠️ No output video found")
        return None
    
    # The I2V output is mp4, stored in images array with subfolder "video"
    # Find the largest file
    best = max(files, key=lambda f: os.path.splitext(f.get("filename", ""))[1] in (".mp4", ".webm"))
    
    ext = os.path.splitext(best["filename"])[1]
    local_name = download_file(best["filename"], best.get("subfolder", ""),
                               best.get("type", "output"), VIDEOS_DIR,
                               f"crystal_{batch_id}_{index}{ext}")
    print(f"  ✅ Video ready: {local_name}")
    
    return local_name

def main():
    batch_id = f"cd_{int(time.time())}"
    
    print("=" * 70)
    print(f"🔮 CRYSTAL DEMONS VIDEO WORKFLOW")
    print(f"   Batch: {batch_id}")
    print(f"   ComfyUI: {COMFY_HOST}:{COMFY_PORT}")
    print("=" * 70)
    
    # Load workflow config
    cfg_path = os.path.join(PROJECT_DIR, "crystal_demons_workflow.json")
    with open(cfg_path) as f:
        config = json.load(f)
    
    steps = config["steps"]
    clips = []
    
    for i, step in enumerate(steps):
        step_num = i + 1
        print(f"\n{'─' * 60}")
        print(f"📌 STEP {step_num}/{len(steps)}: {step['title']}")
        print(f"{'─' * 60}")
        
        # Phase 1: Generate image
        try:
            img_file = generate_image(step["imagePrompt"], i, batch_id)
        except Exception as e:
            print(f"  ❌ Image failed: {e}")
            continue
        
        if not img_file:
            continue
        
        # Small pause between phases
        time.sleep(2)
        
        # Phase 2: Generate video from image
        try:
            vid_file = generate_video_from_image(step["videoPrompt"], img_file, i, batch_id, step.get("params", {}))
        except Exception as e:
            print(f"  ❌ Video failed: {e}")
            continue
        
        if not vid_file:
            continue
        
        clips.append({
            "filename": vid_file,
            "prompt": step["title"],
            "duration": step.get("duration", 5)
        })
        
        print(f"\n  ✅ Step {step_num} COMPLETE!")
    
    # Summary
    print(f"\n{'=' * 70}")
    print(f"📊 RESULTS")
    print(f"{'=' * 70}")
    print(f"   Generated {len(clips)}/{len(steps)} clips")
    
    for clip in clips:
        path = os.path.join(VIDEOS_DIR, clip["filename"])
        if os.path.exists(path):
            size_mb = os.path.getsize(path) / (1024*1024)
            print(f"   🎬 {clip['filename']} ({size_mb:.1f} MB)")
        else:
            print(f"   🎬 {clip['filename']} (NOT FOUND)")
    
    result_path = os.path.join(PROJECT_DIR, f"crystal_demons_result_{batch_id}.json")
    with open(result_path, "w") as f:
        json.dump({"clips": clips, "batch_id": batch_id}, f, indent=2)
    
    print(f"\n   📄 Results: {result_path}")
    print(f"   📁 Videos: {VIDEOS_DIR}")
    
    return clips

if __name__ == "__main__":
    import urllib.parse
    try:
        clips = main()
        print(f"\n✅ Workflow finished with {len(clips)} clips!")
    except KeyboardInterrupt:
        print("\n\n⚠️ Interrupted by user")
    except Exception as e:
        print(f"\n❌ Fatal: {e}")
