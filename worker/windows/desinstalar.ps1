# Corta el worker y borra la tarea programada: deja de arrancar solo.

. (Join-Path $PSScriptRoot 'comun.ps1')

& (Join-Path $PSScriptRoot 'detener.ps1') | Out-Null

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Tarea '$TaskName' eliminada. El worker ya no arranca solo." -ForegroundColor Green
} else {
  Write-Host 'No habia tarea instalada para esta carpeta.'
}
