# Mantiene el worker corriendo sin ventana: lo lanza, y si se cae (o sale
# a proposito, como al "Desvincular" desde la pantalla de Conexion) lo
# vuelve a lanzar. Lo ejecuta la tarea programada que crea instalar.ps1;
# no hace falta correrlo a mano.
#
# La salida del worker va a worker\logs\worker.log (el QR no hace falta
# verlo aca: el worker lo sube a Supabase y se escanea desde conexion.html).

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'comun.ps1')

New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

function Escribir-Log([string]$texto) {
  $linea = '[{0}] [arranque] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $texto
  # Mientras node corre, cmd.exe tiene worker.log abierto sin dejar que
  # otro escriba: en ese caso va a arranque.log. Un error al escribir el
  # log nunca tiene que cortar al vigilante.
  foreach ($archivo in @($LogFile, (Join-Path $LogsDir 'arranque.log'))) {
    try { Add-Content -Path $archivo -Value $linea -Encoding UTF8 -ErrorAction Stop; return } catch { }
  }
}

# Dos workers con la misma carpeta auth\ conectados a la vez se pelean la
# sesion de WhatsApp: si ya hay uno corriendo para esta carpeta, salir.
$mutex = New-Object System.Threading.Mutex($false, $MutexName)
try { $libre = $mutex.WaitOne(0) }
catch [System.Threading.AbandonedMutexException] { $libre = $true }  # el vigilante anterior murio sin soltarlo
if (-not $libre) {
  Escribir-Log 'Ya hay un worker corriendo para esta carpeta; no se lanza otro.'
  exit 0
}

Set-Content -Path $PidFile -Value $PID -Encoding ASCII

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
if (-not (Test-Path $node)) {
  Escribir-Log 'No se encontro node.exe (instalar Node.js 20 o superior).'
  exit 1
}

$espera = 5
try {
  while ($true) {
    # Rotacion simple para que el log no crezca sin limite.
    if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 20MB) {
      Move-Item -Force $LogFile "$LogFile.1" -ErrorAction SilentlyContinue
    }

    Escribir-Log "Lanzando worker ($node)"
    $inicio = Get-Date
    # Via cmd.exe para que la salida se agregue al log tal cual (UTF-8),
    # sin la conversion a UTF-16 que hace PowerShell 5 con >>.
    $proc = Start-Process -FilePath $env:ComSpec `
      -ArgumentList '/d', '/c', "`"`"$node`" src\index.js >> `"$LogFile`" 2>&1`"" `
      -WorkingDirectory $WorkerDir -WindowStyle Hidden -PassThru
    $proc.WaitForExit()
    $duracion = ((Get-Date) - $inicio).TotalSeconds

    # Si se cae enseguida (sin internet, .env mal), esperar cada vez mas
    # (hasta 1 minuto) para no reintentar en loop sin parar.
    if ($duracion -gt 120) { $espera = 5 } else { $espera = [Math]::Min($espera * 2, 60) }
    Escribir-Log ("El worker termino (codigo {0}). Se relanza en {1} s." -f $proc.ExitCode, $espera)
    Start-Sleep -Seconds $espera
  }
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $PidFile
  $mutex.ReleaseMutex()
}
