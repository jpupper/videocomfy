@echo off
:: Deja iguales los dos fronts del editor (la web y el local videocomfy).
:: La fuente es public\ del repo (lo que se sube al FTP); el destino es
:: D:\Programacion\videocomfy\public (lo que sirve la app local :5634).
:: Uso:  sync_front.bat          (copia)
::       sync_front.bat --check  (solo compara)
node "%~dp0sync_front.js" %*
pause
