@echo off
REM ============================================================
REM  ComfyUI desde la carpeta de videocomfy
REM ------------------------------------------------------------
REM  Antes este archivo apuntaba a "%~dp0venv\Scripts\python.exe" y
REM  "main.py" del directorio de videocomfy, que NO existen: por eso
REM  "no funcionaba". Ahora delega en el launcher real de ComfyUI
REM  (que ademas libera el puerto 8188 si ya hay una instancia).
REM ============================================================
call "D:\IA\comfynew\ComfyUI\start_network.bat"
