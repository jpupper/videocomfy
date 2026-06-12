#!/usr/bin/env python3
"""
LongCat-Video-Avatar-1.5 Wrapper for videocomfy
================================================
Wrapper Python que videocomfy (server.js) llama como subproceso.
Modos:
  --mode at2v   : Audio-Text-to-Video (solo audio + prompt)
  --mode ai2v   : Audio-Image-to-Video (audio + imagen + prompt)

Uso:
  python longcat_avatar.py --mode at2v --audio audio.mp3 --prompt "descripcion" --output video.mp4
  python longcat_avatar.py --mode ai2v --audio audio.mp3 --image foto.png --prompt "descripcion" --output video.mp4

Flags:
  --use_int8   : INT8 quantization (recommended for 24GB VRAM, ~12GB model)
  --no_distill : Disable DMD distillation (slower but more stable, fallback)

Requerimientos:
  - Git clone de LongCat-Video en el mismo directorio o en LONG_CAT_REPO_PATH env var
  - Modelo descargado en HF_CACHE_DIR o LONG_CAT_WEIGHTS_PATH env var
"""

import os
import sys
import json
import time
import subprocess
import argparse
import tempfile
import shutil
from pathlib import Path

# ============================================================
# CONFIGURACIÓN
# ============================================================

REPO_URL = "https://github.com/meituan-longcat/LongCat-Video.git"
MODEL_HF_ID = "meituan-longcat/LongCat-Video-Avatar-1.5"
BASE_MODEL_HF_ID = "meituan-longcat/LongCat-Video"

# Directorios
SCRIPT_DIR = Path(__file__).parent.absolute()
REPO_DIR = Path(os.environ.get("LONG_CAT_REPO_PATH", SCRIPT_DIR / "LongCat-Video"))
WEIGHTS_DIR = Path(os.environ.get("LONG_CAT_WEIGHTS_PATH", SCRIPT_DIR / "weights"))
AVATAR_WEIGHTS_DIR = WEIGHTS_DIR / "LongCat-Video-Avatar-1.5"
BASE_WEIGHTS_DIR = WEIGHTS_DIR / "LongCat-Video"
VENV_DIR = SCRIPT_DIR / "longcat_env"


def log(msg):
    """Log con timestamp a stderr (no interfiere con stdout que lleva el JSON de salida)."""
    print(f"[LONGCAT {time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


# ============================================================
# SETUP: Clonar repo y descargar modelo si no existen
# ============================================================

def ensure_repo():
    """Clona el repo LongCat-Video si no existe."""
    if REPO_DIR.exists():
        log(f"Repo ya existe en {REPO_DIR}")
        return True
    
    log(f"Clonando LongCat-Video desde {REPO_URL}...")
    result = subprocess.run(
        ["git", "clone", "--single-branch", "--branch", "main", REPO_URL, str(REPO_DIR)],
        capture_output=True, text=True, timeout=300
    )
    if result.returncode != 0:
        log(f"ERROR clonando repo: {result.stderr}")
        return False
    log("Repo clonado exitosamente.")
    return True


def ensure_venv():
    """Crea/actualiza el venv con dependencias de LongCat."""
    python = VENV_DIR / "bin" / "python"
    pip = VENV_DIR / "bin" / "pip"
    
    if VENV_DIR.exists() and python.exists():
        log(f"Venv ya existe en {VENV_DIR}")
        return str(python)
    
    log(f"Creando venv en {VENV_DIR}...")
    subprocess.run(
        [sys.executable, "-m", "venv", str(VENV_DIR)],
        check=True, timeout=60
    )
    
    log("Instalando torch 2.6.0+cu124...")
    subprocess.run(
        [str(pip), "install", "torch==2.6.0+cu124", "torchvision==0.21.0+cu124",
         "torchaudio==2.6.0", "--index-url", "https://download.pytorch.org/whl/cu124"],
        check=True, timeout=300
    )
    
    log("Instalando flash-attn-2...")
    subprocess.run(
        [str(pip), "install", "ninja", "psutil", "packaging"],
        check=True, timeout=120
    )
    subprocess.run(
        [str(pip), "install", "flash_attn==2.7.4.post1"],
        check=True, timeout=300
    )
    
    if REPO_DIR.exists():
        log("Instalando requirements del repo...")
        req_file = REPO_DIR / "requirements.txt"
        if req_file.exists():
            subprocess.run([str(pip), "install", "-r", str(req_file)], check=True, timeout=300)
        
        avatar_req = REPO_DIR / "requirements_avatar.txt"
        if avatar_req.exists():
            subprocess.run([str(pip), "install", "-r", str(avatar_req)], check=True, timeout=300)
    
    log("Instalando huggingface-hub...")
    subprocess.run([str(pip), "install", "huggingface_hub[cli]"], check=True, timeout=60)
    
    log("Instalando dependencias adicionales...")
    subprocess.run([str(pip), "install", "librosa", "ffmpeg", "Pillow"], check=True, timeout=120)
    
    log("Venv listo.")
    return str(python)


def ensure_models():
    """Descarga los modelos si no existen."""
    hf_cli = VENV_DIR / "bin" / "hf"
    if not hf_cli.exists():
        hf_cli = "hf"  # fallback al PATH
    
    # Descargar modelo base (text encoder, vae, scheduler)
    if not (BASE_WEIGHTS_DIR / "config.json").exists():
        log(f"Descargando modelo base {BASE_MODEL_HF_ID} (~20GB)...")
        WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [str(hf_cli), "download", BASE_MODEL_HF_ID, "--local-dir", str(BASE_WEIGHTS_DIR)],
            check=True, timeout=3600
        )
        log("Modelo base descargado.")
    else:
        log(f"Modelo base ya existe en {BASE_WEIGHTS_DIR}")
    
    # Descargar modelo avatar
    if not (AVATAR_WEIGHTS_DIR / "config.json").exists():
        log(f"Descargando modelo avatar {MODEL_HF_ID} (~75GB!)...")
        log("ATENCION: Esto puede tomar mucho tiempo y espacio!")
        AVATAR_WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
        # Solo descargar archivos esenciales para INT8
        subprocess.run(
            [str(hf_cli), "download", MODEL_HF_ID, "--local-dir", str(AVATAR_WEIGHTS_DIR)],
            check=True, timeout=7200
        )
        log("Modelo avatar descargado.")
    else:
        log(f"Modelo avatar ya existe en {AVATAR_WEIGHTS_DIR}")


# ============================================================
# INFERENCIA
# ============================================================

def run_inference(args):
    """
    Ejecuta la inferencia real usando los scripts del repo LongCat-Video.
    
    Crea un input JSON temporal, lo pasa al script run_demo_avatar_single_audio_to_video.py
    usando torchrun, y captura el output.
    """
    # Preparar paths
    audio_path = Path(args.audio)
    if not audio_path.is_absolute():
        audio_path = SCRIPT_DIR / args.audio
    
    input_json_path = SCRIPT_DIR / f"_longcat_input_{int(time.time())}.json"
    output_dir = SCRIPT_DIR / "longcat_outputs"
    output_dir.mkdir(exist_ok=True)
    
    # Copiar audio al directorio de trabajo del repo
    repo_audio_dir = REPO_DIR / "assets" / "avatar" / "single"
    repo_audio_dir.mkdir(parents=True, exist_ok=True)
    audio_filename = f"input_audio_{int(time.time())}.mp3"
    shutil.copy2(str(audio_path), str(repo_audio_dir / audio_filename))
    
    # Copiar imagen si existe (modo ai2v)
    image_filename = None
    if args.image and args.mode == 'ai2v':
        img_path = Path(args.image)
        if not img_path.is_absolute():
            img_path = SCRIPT_DIR / args.image
        if img_path.exists():
            image_filename = f"input_image_{int(time.time())}.png"
            shutil.copy2(str(img_path), str(repo_audio_dir / image_filename))
    
    # Crear input JSON
    input_data = {
        "prompt": args.prompt,
        "cond_image": f"assets/avatar/single/{image_filename}" if image_filename else "assets/avatar/single/man.png",
        "cond_audio": {
            "person1": f"assets/avatar/single/{audio_filename}"
        }
    }
    
    with open(input_json_path, 'w') as f:
        json.dump(input_data, f, indent=2)
    
    log(f"Input JSON creado: {input_json_path}")
    
    # Resolución
    resolution = args.resolution or "480p"
    stage = "ai2v" if args.mode == 'ai2v' else "at2v"
    
    # Construir comando
    python_bin = str(VENV_DIR / "bin" / "python")
    script = str(REPO_DIR / "run_demo_avatar_single_audio_to_video.py")
    
    cmd = [
        python_bin, script,
        f"--checkpoint_dir={AVATAR_WEIGHTS_DIR}",
        f"--stage_1={stage}",
        f"--input_json={input_json_path}",
        f"--resolution={resolution}",
        f"--output_dir={output_dir}",
        "--num_segments=1",
        "--model_type=avatar-v1.5",
    ]
    
    if args.use_int8:
        cmd.append("--use_int8")
    
    if not args.no_distill:
        cmd.append("--use_distill")
    
    if args.context_parallel_size:
        cmd.append(f"--context_parallel_size={args.context_parallel_size}")
    
    if args.num_inference_steps:
        cmd.append(f"--num_inference_steps={args.num_inference_steps}")
    
    # Si no hay torchrun (1 GPU), ejecutar directo
    # NOTA: El script espera torchrun/dist, usar RANK=0 WORLD_SIZE=1
    env = os.environ.copy()
    env["RANK"] = "0"
    env["WORLD_SIZE"] = "1"
    env["LOCAL_RANK"] = "0"
    env["MASTER_ADDR"] = "127.0.0.1"
    env["MASTER_PORT"] = "29500"
    
    log(f"Ejecutando: {' '.join(str(c) for c in cmd)}")
    log(f"Modo: {stage} | Res: {resolution} | INT8: {args.use_int8} | Distill: {not args.no_distill}")
    
    result = subprocess.run(
        cmd,
        env=env,
        capture_output=True,
        text=True,
        timeout=args.timeout or 600,  # 10 min default
        cwd=str(REPO_DIR)
    )
    
    # Log output del script
    if result.stdout:
        for line in result.stdout.strip().split('\n'):
            log(f"[stdout] {line}")
    if result.stderr:
        for line in result.stderr.strip().split('\n'):
            if 'Error' in line or 'error' in line or 'Traceback' in line:
                log(f"[stderr] {line}")
    
    # Buscar el output
    output_path = Path(args.output)
    if not output_path.is_absolute():
        output_path = SCRIPT_DIR / args.output
    
    # El script genera outputs con timestamp en output_dir
    generated_files = list(output_dir.glob("*.mp4")) + list(output_dir.glob("*.webm"))
    if generated_files:
        # Tomar el más reciente
        latest = max(generated_files, key=lambda p: p.stat().st_mtime)
        shutil.copy2(str(latest), str(output_path))
        log(f"Video copiado a: {output_path}")
        
        # Output JSON a stdout para que server.js lo lea
        result_data = {
            "success": True,
            "video": str(output_path),
            "filename": output_path.name,
            "duration_seconds": result.returncode
        }
        print(json.dumps(result_data))
    else:
        log(f"ERROR: No se encontró video generado en {output_dir}")
        log(f"Return code: {result.returncode}")
        log(f"Stderr snippet: {result.stderr[-1000:]}")
        result_data = {
            "success": False,
            "error": "No video output found",
            "stderr": result.stderr[-500:],
            "returncode": result.returncode
        }
        print(json.dumps(result_data))
    
    # Limpiar
    try:
        input_json_path.unlink()
    except:
        pass


# ============================================================
# MAIN
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="LongCat-Video-Avatar Wrapper")
    parser.add_argument("--mode", choices=["at2v", "ai2v"], default="at2v",
                        help="AT2V = Audio+Text, AI2V = Audio+Image+Text")
    parser.add_argument("--audio", required=True, help="Path al archivo de audio (mp3/wav)")
    parser.add_argument("--image", help="Path a la imagen (opcional, solo AI2V)")
    parser.add_argument("--prompt", required=True, help="Descripción del video")
    parser.add_argument("--output", default="longcat_output.mp4", help="Path de salida")
    parser.add_argument("--resolution", choices=["480p", "720p"], default="480p",
                        help="Resolución (480p recomendado para 24GB VRAM)")
    parser.add_argument("--use_int8", action="store_true", default=True,
                        help="Usar INT8 quantization (default: True)")
    parser.add_argument("--no_distill", action="store_true",
                        help="Deshabilitar DMD distillation")
    parser.add_argument("--no_setup", action="store_true",
                        help="Skip setup (si ya está instalado)")
    parser.add_argument("--context_parallel_size", type=int, default=1,
                        help="Parallel size (default: 1 para single GPU)")
    parser.add_argument("--num_inference_steps", type=int,
                        help="Pasos de inferencia (default: 8 con distill)")
    parser.add_argument("--timeout", type=int, default=600,
                        help="Timeout en segundos (default: 600)")
    
    args = parser.parse_args()
    
    # Setup (clonar repo, crear venv, descargar modelos)
    if not args.no_setup:
        log("=== LONGCAT SETUP ===")
        if not ensure_repo():
            sys.exit(1)
        python_path = ensure_venv()
        ensure_models()
        log("=== SETUP COMPLETE ===")
    
    # Correr inferencia
    log("=== LONGCAT INFERENCE ===")
    run_inference(args)
    log("=== DONE ===")


if __name__ == "__main__":
    main()
