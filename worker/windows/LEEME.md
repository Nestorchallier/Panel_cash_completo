# Arrancar el worker solo en Windows

Estos scripts dejan el worker de WhatsApp corriendo en segundo plano, sin
ventana de consola, y hacen que arranque solo cada vez que se inicia sesión
en Windows. No hace falta ser administrador.

## Primera vez

1. Instalar [Node.js](https://nodejs.org) 20 o superior.
2. En `worker\`, copiar `.env.example` a `.env` y completarlo.
3. Abrir una consola en `worker\` y correr `npm install` (una sola vez).
4. Doble clic en **`instalar.cmd`**.

Listo: el worker queda corriendo y vuelve a arrancar solo después de
reiniciar la PC. El QR se escanea desde la pantalla de **Conexión** del
panel, como siempre.

## Archivos

| Archivo | Para qué |
|---|---|
| `instalar.cmd` | Crea la tarea programada y arranca el worker. Se puede repetir. |
| `iniciar.cmd` | Arranca el worker si se había detenido. |
| `detener.cmd` | Corta el worker (vuelve a arrancar en el próximo inicio de sesión). |
| `desinstalar.cmd` | Corta el worker y deja de arrancarlo solo. |

## Cómo funciona

- `instalar.ps1` registra la tarea programada
  *Cash Market - Worker WhatsApp (nombre de la carpeta)* con disparador
  "al iniciar sesión" de este usuario.
- La tarea corre `iniciar-worker.ps1`, que lanza `node src\index.js` oculto
  y lo relanza si se cae (5 s después; si se cae enseguida varias veces,
  espera cada vez más, hasta 1 minuto). También lo relanza después de
  "Desvincular" desde el panel, así aparece el QR nuevo sin tocar nada.
- Toda la salida va a `worker\logs\worker.log` (al pasar los 20 MB se
  renombra a `worker.log.1`).
- No deja correr dos workers a la vez sobre la misma carpeta. Mientras esté
  instalado, no correr también `npm start` a mano: usar `detener.cmd` antes.

Si hay un segundo cobrador con otra copia del panel en otra carpeta, se
corre `instalar.cmd` en esa copia y queda con su propia tarea.

Nota: el worker corre mientras la sesión de Windows esté iniciada (puede
estar bloqueada). Si la PC se reinicia y nadie inicia sesión, no arranca.
