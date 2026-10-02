@echo off
rem Arranca el worker en segundo plano usando la tarea ya instalada.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ". '%~dp0comun.ps1'; Start-ScheduledTask -TaskName $TaskName; Write-Host 'Worker iniciado.'"
pause
