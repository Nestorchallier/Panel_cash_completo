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
   capacidad, **VM.Standard.E2.1.Micro**). Generar y guardar la clave SSH.
3. Anotar la IP pública.

## Instalar el worker

Desde la PC, con la clave guardada (PowerShell, en la carpeta del panel):

```
scp -i $HOME\.ssh\oracle-worker.key -r worker ubuntu@IP:~/
ssh -i $HOME\.ssh\oracle-worker.key ubuntu@IP "rm -rf ~/worker/node_modules ~/worker/logs; bash ~/worker/linux/instalar.sh"
```

La copia lleva el `.env` y la carpeta `auth/`, así que el servidor usa la
misma sesión de WhatsApp y no hace falta escanear el QR. **Antes** de
copiar, detener el worker de la PC (`worker\windows\desinstalar.cmd`): dos
workers con la misma sesión se pisan.

`instalar.sh` instala Node.js si falta, las dependencias, pone el servidor
en hora argentina (los horarios de envío usan la hora local) y registra el
servicio `cash-worker`, que arranca solo y se relanza si se cae.

## Uso diario

```
journalctl -u cash-worker -f          # log en vivo
systemctl status cash-worker          # estado
sudo systemctl restart cash-worker    # reiniciar
```

Para actualizar el código: volver a copiar los archivos de `worker/src`
y correr `bash ~/worker/linux/instalar.sh` de nuevo.
