@echo off
setlocal

set "COMFY_URL=http://127.0.0.1:8188"
set "COMFY_BAT=D:\IA\comfynew\ComfyUI\start_network.bat"
set "COMFY_DIR=D:\IA\comfynew\ComfyUI"

echo.
echo === VideoComfy Launcher ===
echo.

REM --- Check if ComfyUI is already running ---
echo [1/3] Checking if ComfyUI is running at %COMFY_URL% ...
set "COMFY_CODE="
curl -s -o nul -w "%%{http_code}" --max-time 3 %COMFY_URL% > "%TEMP%\comfy_check.txt" 2>nul
set /p COMFY_CODE=<"%TEMP%\comfy_check.txt"
del "%TEMP%\comfy_check.txt" >nul 2>&1

if "%COMFY_CODE%"=="200" (
    echo     ComfyUI is already running. Skipping launch.
    goto :start_server
)

REM --- ComfyUI not running: launch start_network.bat ---
echo     ComfyUI not detected ^(response: "%COMFY_CODE%"^).
echo.
echo [2/3] Launching ComfyUI via %COMFY_BAT% ...

if not exist "%COMFY_BAT%" (
    echo.
    echo     ERROR: %COMFY_BAT% not found.
    echo     Please verify the path and try again.
    echo.
    pause
    exit /b 1
)

start "ComfyUI" /D "%COMFY_DIR%" cmd /k "%COMFY_BAT%"

REM --- Wait for ComfyUI to be ready (poll every 2s, up to 120s) ---
echo     Waiting for ComfyUI to become available ^(up to 120s^)...
set /a ATTEMPTS=0
set /a MAX_ATTEMPTS=60

:wait_loop
set /a ATTEMPTS+=1
timeout /t 2 /nobreak >nul

set "COMFY_CODE="
curl -s -o nul -w "%%{http_code}" --max-time 3 %COMFY_URL% > "%TEMP%\comfy_check.txt" 2>nul
set /p COMFY_CODE=<"%TEMP%\comfy_check.txt"
del "%TEMP%\comfy_check.txt" >nul 2>&1

if "%COMFY_CODE%"=="200" (
    echo     ComfyUI is ready! ^(took ~%ATTEMPTS% checks^)
    goto :start_server
)

if %ATTEMPTS% GEQ %MAX_ATTEMPTS% (
    echo.
    echo     WARNING: ComfyUI did not respond after 120s.
    echo     Starting the server anyway ^(it will auto-reconnect^).
    goto :start_server
)

REM Progress indicator every ~10s
set /a MOD=%ATTEMPTS% %% 5
if %MOD%==0 echo     ... still waiting ^(%ATTEMPTS%/%MAX_ATTEMPTS%^)
goto :wait_loop

:start_server
echo.
echo [3/3] Killing any previous VideoComfy server on port 5634...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r ":5634 "') do (
    if not "%%a"=="0" (
        echo     Killing PID %%a ...
        taskkill /F /PID %%a >nul 2>&1
        timeout /t 2 /nobreak >nul
    )
)
echo.
echo [4/4] Starting VideoComfy server...
echo.
node server.js

endlocal
