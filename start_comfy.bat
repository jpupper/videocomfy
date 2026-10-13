@echo off
cd /d D:\IA\comfynew\ComfyUI
D:\IA\comfynew\ComfyUI\venv\Scripts\python.exe -u main.py --listen 0.0.0.0 --port 8188 --disable-cuda-malloc --reserve-vram 1 > D:\IA\comfynew\ComfyUI\comfy_start.log 2>&1
