# Worker en un servidor Linux (Oracle Cloud gratis)

Para que WhatsApp quede conectado aunque la PC esté apagada, el worker
puede correr en un servidor Ubuntu siempre prendido. Oracle Cloud tiene uno
gratis para siempre ("Always Free").

## Crear el servidor (una vez)

1. Crear la cuenta en oracle.com/cloud/free con Home Region
   **Brazil East (Sao Paulo)**. No pasar la cuenta a "Pay As You Go": así
   nunca cobra.
2. Compute → Instances → Create instance: imagen **Ubuntu 24.04**, shape
   **VM.Standard.A1.Flex** (1 OCPU, 6 GB, "Always Free-eligible"; si no hay
   capacidad, **VM.Standard.E2.1.Micro**). En "Add SSH keys" pegar la clave
   pública de la PC (`C:\Users\usuario\.ssh\oracle_worker.pub`).
3. Anotar la IP pública.

## Pasar el worker de la PC al servidor

En la PC, con la carpeta del panel actualizada (`git pull`), doble clic en
`worker\windows\migrar-a-servidor.cmd` y pegar la IP. El script:

1. Prueba la conexión con el servidor (llave `C:\Users\usuario\.ssh\oracle_worker`).
2. Corta y desinstala el worker de la PC: dos workers con la misma sesión
   se pisan.
3. Copia `worker\` con el `.env` y la carpeta `auth\`, así el servidor usa
   la misma sesión de WhatsApp y no hace falta escanear el QR.
4. Corre `linux/instalar.sh` en el servidor y muestra el log.

Si algo falla en el servidor, vuelve a dejar el worker andando en la PC. Si
el servidor ya tiene el worker corriendo, no copia nada (para no pisar su
sesión con la de la PC).

`instalar.sh` instala Node.js si falta, ffmpeg (convierte las notas de voz
🎤 que se graban desde el panel), las dependencias, pone el servidor
en hora argentina (los horarios de envío usan la hora local) y registra el
servicio `cash-market-worker`, que arranca solo y se relanza si se cae.

## Uso diario

```
journalctl -u cash-market-worker -f          # log en vivo
systemctl status cash-market-worker          # estado
sudo systemctl restart cash-market-worker    # reiniciar
```

Para actualizar el código: volver a copiar los archivos de `worker/src`
(y `js/telefonos.js` y `js/mora.js` del panel a `~/js`, que el worker los
reusa) y correr `bash ~/worker/linux/instalar.sh` de nuevo.
