# Corta el worker que esta corriendo en segundo plano (no borra la tarea:
# vuelve a arrancar en el proximo inicio de sesion o con iniciar.cmd).

. (Join-Path $PSScriptRoot 'comun.ps1')

# Primero el arbol de procesos (vigilante -> cmd -> node), despues la
# tarea: si se corta la tarea primero, node queda huerfano corriendo.
if (Test-Path $PidFile) {
  $pidVigilante = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($pidVigilante) { & taskkill.exe /T /F /PID $pidVigilante 2>&1 | Out-Null }
  Remove-Item -Force -ErrorAction SilentlyContinue $PidFile
}

# Por las dudas: cualquier cmd que este escribiendo en el log de ESTA
# carpeta (y su node), por ejemplo si el vigilante ya no existia.
Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($LogFile) } |
  ForEach-Object { & taskkill.exe /T /F /PID $_.ProcessId 2>&1 | Out-Null }

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

Write-Host 'Worker detenido.'
