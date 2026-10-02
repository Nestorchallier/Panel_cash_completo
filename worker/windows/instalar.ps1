# Registra una tarea programada de Windows que arranca el worker solo,
# oculto, cada vez que este usuario inicia sesion, y lo lanza ya mismo.
# No pide permisos de administrador. Se puede correr de nuevo sin problema
# (reemplaza la tarea anterior).

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'comun.ps1')

if (-not (Test-Path (Join-Path $WorkerDir '.env'))) {
  Write-Host "Falta $WorkerDir\.env - copia .env.example a .env y completalo antes de instalar." -ForegroundColor Red
  exit 1
}
if (-not (Test-Path (Join-Path $WorkerDir 'node_modules'))) {
  Write-Host "Falta instalar dependencias: abri una consola en $WorkerDir y corre 'npm install' una vez." -ForegroundColor Red
  exit 1
}
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue) -and
    -not (Test-Path (Join-Path $env:ProgramFiles 'nodejs\node.exe'))) {
  Write-Host 'No se encontro Node.js. Instalalo (version 20 o superior) desde https://nodejs.org' -ForegroundColor Red
  exit 1
}

# Si estaba corriendo una version anterior, cortarla antes de reemplazarla.
& (Join-Path $PSScriptRoot 'detener.ps1') | Out-Null

$script = Join-Path $PSScriptRoot 'iniciar-worker.ps1'
$accion = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`"" `
  -WorkingDirectory $WorkerDir
$usuario = "$env:USERDOMAIN\$env:USERNAME"
$disparador = New-ScheduledTaskTrigger -AtLogOn -User $usuario
# Sin limite de tiempo y aunque la notebook este a bateria. Los reinicios
# si el worker se cae los hace iniciar-worker.ps1, no Windows (asi
# detener.ps1 puede cortarlo sin que la tarea lo vuelva a levantar).
$ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $usuario -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $accion -Trigger $disparador `
  -Settings $ajustes -Principal $principal `
  -Description "Mantiene corriendo el worker de WhatsApp de $WorkerDir" -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host ''
Write-Host "Listo: el worker quedo corriendo en segundo plano y va a arrancar solo cada vez que inicies sesion en Windows." -ForegroundColor Green
Write-Host "Tarea programada: $TaskName"
Write-Host "Log: $LogFile"
Write-Host 'Si hace falta escanear el QR, hacelo desde la pantalla de Conexion del panel.'
