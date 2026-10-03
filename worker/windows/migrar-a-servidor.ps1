# Pasa el worker de esta PC al servidor Linux (Oracle Cloud): corta el
# worker de la PC, copia el codigo con el .env y la sesion de WhatsApp
# (auth\, asi no hay que escanear el QR) y lo instala alla como servicio.
# Si algo falla en el servidor, vuelve a dejar el worker andando en la PC.
#
# Uso: migrar-a-servidor.cmd (pide la IP) o
#   powershell -ExecutionPolicy Bypass -File migrar-a-servidor.ps1 -Ip 1.2.3.4

param(
  [string]$Ip,
  [string]$Usuario = 'ubuntu',
  [string]$Llave = (Join-Path $HOME '.ssh\oracle_worker')
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'comun.ps1')

if (-not $Ip) { $Ip = (Read-Host 'IP publica del servidor').Trim() }
if (-not (Test-Path $Llave)) { Write-Host "No se encontro la llave SSH en $Llave" -ForegroundColor Red; exit 1 }
foreach ($archivo in @('.env', 'auth')) {
  if (-not (Test-Path (Join-Path $WorkerDir $archivo))) { Write-Host "Falta worker\$archivo en esta PC." -ForegroundColor Red; exit 1 }
}

$destino = "$Usuario@$Ip"
$opcionesSsh = @('-i', $Llave, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15')
function Remoto([string]$comando) {
  & ssh.exe @opcionesSsh $destino $comando
  if ($LASTEXITCODE -ne 0) { throw "Fallo en el servidor: $comando" }
}

Write-Host "Probando la conexion con $destino..."
Remoto 'echo ok' | Out-Null

# Si el servidor ya tiene el worker andando, su sesion de WhatsApp es la
# buena: pisarla con la de la PC (vieja) la romperia.
& ssh.exe @opcionesSsh $destino 'systemctl is-active --quiet cash-market-worker'
if ($LASTEXITCODE -eq 0) {
  Write-Host 'El worker ya esta corriendo en el servidor; no se copia nada.' -ForegroundColor Yellow
  exit 0
}

Write-Host 'Cortando el worker de esta PC (dos workers con la misma sesion se pisan)...'
& (Join-Path $PSScriptRoot 'desinstalar.ps1') | Out-Null

$paquete = Join-Path $env:TEMP 'worker-cash-market.tgz'
try {
  Write-Host 'Empaquetando el worker con .env y auth...'
  # Sin los .log sueltos ni las copias viejas de auth\: en la PC pueden
  # pesar cientos de MB y el servidor no los usa.
  & tar.exe -czf $paquete --exclude=node_modules --exclude=logs --exclude=*.log --exclude=auth_respaldo* -C $WorkerDir .
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo empaquetar el worker.' }

  Write-Host 'Subiendo al servidor...'
  & scp.exe @opcionesSsh $paquete "${destino}:/tmp/worker-cash-market.tgz"
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo copiar el worker al servidor.' }

  # El worker reusa archivos del panel (src/telefonos.js y mora-diaria.js
  # hacen require('../../js/...')): van a ~/js, al lado de ~/worker.
  Remoto 'mkdir -p ~/js'
  $jsPanel = Join-Path (Split-Path $WorkerDir -Parent) 'js'
  & scp.exe @opcionesSsh (Join-Path $jsPanel 'telefonos.js') (Join-Path $jsPanel 'mora.js') "${destino}:js/"
  if ($LASTEXITCODE -ne 0) { throw 'No se pudieron copiar js\telefonos.js y js\mora.js al servidor.' }

  Write-Host 'Instalando en el servidor (puede tardar unos minutos)...'
  Remoto 'mkdir -p ~/worker && tar -xzf /tmp/worker-cash-market.tgz -C ~/worker && rm /tmp/worker-cash-market.tgz && bash ~/worker/linux/instalar.sh'

  Start-Sleep -Seconds 20
  Remoto 'journalctl -u cash-market-worker -n 15 --no-pager -o cat'
  # systemd lo relanza aunque falle al arrancar: mirar si llego a conectar
  # (o a pedir QR, que tambien es estar andando).
  & ssh.exe @opcionesSsh $destino 'journalctl -u cash-market-worker --since "-1min" -o cat | grep -qE "WhatsApp conectado|QR nuevo generado"'
  if ($LASTEXITCODE -ne 0) {
    Remoto 'sudo systemctl disable --now cash-market-worker'
    throw 'El worker no llego a conectarse en el servidor (ver el log de arriba).'
  }
  Write-Host ''
  Write-Host 'Listo: el worker corre en el servidor. En la PC quedo desinstalado (los archivos siguen ahi).' -ForegroundColor Green
} catch {
  Write-Host $_ -ForegroundColor Red
  Write-Host 'Vuelvo a dejar el worker andando en esta PC.' -ForegroundColor Yellow
  & (Join-Path $PSScriptRoot 'instalar.ps1')
  exit 1
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $paquete
}
