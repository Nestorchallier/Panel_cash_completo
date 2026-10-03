# Rutas y nombres compartidos por los scripts de esta carpeta.
# Se calcula todo a partir de donde esta este archivo, asi funciona igual
# si la carpeta del panel esta en C:\, en el Escritorio o en otro disco.

$WorkerDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$LogsDir   = Join-Path $WorkerDir 'logs'
$LogFile   = Join-Path $LogsDir 'worker.log'
$PidFile   = Join-Path $LogsDir 'worker.pid'

# Un nombre por carpeta: si hay un segundo cobrador con otra copia del
# worker (ver .env.example), cada copia tiene su propia tarea y no se pisan.
$CarpetaPanel = Split-Path (Split-Path $WorkerDir -Parent) -Leaf
$TaskName     = "CRM Panel Unificado - Worker WhatsApp ($CarpetaPanel)"

$sha = [System.Security.Cryptography.SHA1]::Create()
$hash = ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($WorkerDir.ToLowerInvariant())) |
  ForEach-Object { $_.ToString('x2') }) -join ''
$MutexName = "Local\CashMarketWaWorker_$($hash.Substring(0, 16))"
