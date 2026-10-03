# Worker en un servidor Linux (Oracle Cloud gratis)

Para tener el worker andando las 24 h sin depender de una PC prendida.

## Primera vez

1. Copiar la carpeta `worker/` al servidor **con** `.env` y `auth/` (así no
   hay que volver a escanear el QR). No hace falta copiar `node_modules`.
2. **Antes de arrancarlo en el servidor, apagar el de la PC** (en Windows:
   `worker\windows\desinstalar.cmd`). Dos workers con la misma sesión de
   WhatsApp se pisan.
3. En el servidor, dentro de `worker/`: `bash linux/instalar.sh`.

## Del día a día

| Para | Comando |
|---|---|
| Ver el log en vivo | `journalctl -u cash-market-worker -f` |
| Estado | `systemctl status cash-market-worker` |
| Reiniciar | `sudo systemctl restart cash-market-worker` |
| Detener | `sudo systemctl stop cash-market-worker` |

El servicio arranca solo al prender el servidor y se relanza 5 s después
si se cae o si se desvincula desde la pantalla de Conexión.
