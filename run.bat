@echo off
setlocal EnableDelayedExpansion

REM ============================================================
REM  COMFYLATAM - lanzador
REM ------------------------------------------------------------
REM  PUERTOS:
REM    App COMFYLATAM (editor + nodo de la red) ... 5634
REM    ComfyUI (el motor que genera) ............. 8188
REM
REM  Orden: PRIMERO levanta LA APP, y en paralelo el ComfyUI.
REM  La app NO espera al motor: si ComfyUI tarda, igual arranca y se
REM  conecta cuando esté (mientras tanto el panel dice "sin ComfyUI").
REM ============================================================

set "APP_PORT=5634"
set "COMFY_URL=http://127.0.0.1:8188"
set "COMFY_DIR=D:\IA\comfynew\ComfyUI"
set "COMFY_BAT=%COMFY_DIR%\start_network.bat"
set "APP_URL=http://127.0.0.1:%APP_PORT%"

REM Si tenes el motor en otra carpeta, no hace falta editar este archivo:
REM   set COMFY_BAT_OVERRIDE=D:\otra\ruta\ComfyUI\start_network.bat
if defined COMFY_BAT_OVERRIDE set "COMFY_BAT=%COMFY_BAT_OVERRIDE%"

echo.
echo ============================================================
echo   COMFYLATAM
echo   App + editor + nodo de la red ..... http://127.0.0.1:%APP_PORT%
echo   Motor ComfyUI .................... %COMFY_URL%
echo ============================================================
echo.

REM ------------------------------------------------------------
REM [1/4] Liberar el puerto de la app (si quedo una instancia vieja).
REM       Se mata el DUENO del puerto UNA vez por PID: antes se mataba
REM       el mismo PID una vez por cada linea de netstat (LISTENING,
REM       IPv6, conexiones establecidas) y salian 14 "Killing PID ...".
REM ------------------------------------------------------------
echo [1/4] Liberando el puerto %APP_PORT% si hay una app vieja...
set "MATADOS=0"
for /f "usebackq tokens=*" %%p in (`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort %APP_PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`) do (
    if not "%%p"=="0" (
        echo       matando PID %%p
        taskkill /F /PID %%p >nul 2>&1
        set /a MATADOS+=1
    )
)
if "!MATADOS!"=="0" echo       ^(no habia ninguna: puerto libre^)
timeout /t 1 /nobreak >nul

REM ------------------------------------------------------------
REM [2/4] PRIMERO la app, en su propia ventana (con mas memoria)
REM ------------------------------------------------------------
echo.
echo [2/4] Levantando COMFYLATAM...
start "COMFYLATAM app %APP_PORT%" /D "%~dp0" cmd /k "node --max-old-space-size=4096 server.js"

REM ------------------------------------------------------------
REM [3/4] EN PARALELO, el motor (solo si no esta escuchando)
REM ------------------------------------------------------------
echo.
set "COMFY_CODE="
curl -s -o nul -w "%%{http_code}" --max-time 3 %COMFY_URL% > "%TEMP%\comfy_check.txt" 2>nul
set /p COMFY_CODE=<"%TEMP%\comfy_check.txt"
del "%TEMP%\comfy_check.txt" >nul 2>&1

if "%COMFY_CODE%"=="200" (
    echo [3/4] ComfyUI ya estaba corriendo en %COMFY_URL% - no lo toco.
) else (
    if exist "%COMFY_BAT%" (
        echo [3/4] Levantando ComfyUI en paralelo: %COMFY_BAT%
        start "ComfyUI motor 8188" /D "%COMFY_DIR%" cmd /k "%COMFY_BAT%"
    ) else (
        echo [3/4] No encontre el launcher de ComfyUI en "%COMFY_BAT%".
        echo       La app arranca igual; cuando levantes ComfyUI se conecta sola.
        echo       Si lo tenes en otra carpeta: set COMFY_BAT_OVERRIDE=D:\ruta\ComfyUI\start_network.bat
    )
)

REM ------------------------------------------------------------
REM [4/4] Esperar a que la app responda y abrir el navegador
REM ------------------------------------------------------------
echo.
echo [4/4] Esperando a la app en %APP_URL% ...
set /a INTENTOS=0

:esperar
set /a INTENTOS+=1
set "APP_CODE="
curl -s -o nul -w "%%{http_code}" --max-time 3 "%APP_URL%/api/status" > "%TEMP%\app_check.txt" 2>nul
set /p APP_CODE=<"%TEMP%\app_check.txt"
del "%TEMP%\app_check.txt" >nul 2>&1

if "%APP_CODE%"=="200" (
    echo       App lista ^(intento %INTENTOS%^).
    start "" "%APP_URL%"
    goto :fin
)
if %INTENTOS% GEQ 20 (
    echo       La app todavia no responde. Mira su ventana: ahi esta el error.
    goto :fin
)
timeout /t 1 /nobreak >nul
goto :esperar

:fin
echo.
echo ============================================================
echo   Listo.
echo     App ...... %APP_URL%      (puerto %APP_PORT%)
echo     ComfyUI .. %COMFY_URL%
echo   En la pestana RED se ve si esta PC quedo publicada en la red.
echo ============================================================
echo.
echo Esta ventana se puede cerrar: la app y el motor siguen en las suyas.
echo.
endlocal
