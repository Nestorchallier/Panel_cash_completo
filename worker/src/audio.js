// Notas de voz que se graban desde el panel (🎤 en el chat).
//
// WhatsApp solo muestra un audio como "nota de voz" (con la onda y el
// botón de play verde) si es OGG con códec Opus y va con ptt: true. Chrome
// y Edge graban en WebM/Opus (MediaRecorder no sabe grabar OGG); Firefox
// sí graba OGG. Por eso, si lo que llega del panel no es OGG, se convierte
// con ffmpeg (en el servidor Linux lo instala linux/instalar.sh). Si ya es
// OGG se manda tal cual.

const { spawn } = require('child_process');

const MIMETYPE_NOTA_DE_VOZ = 'audio/ogg; codecs=opus';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const TIMEOUT_MS = 60000;

// Los archivos OGG empiezan con "OggS".
function esOgg(buffer) {
  return !!buffer && buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'OggS';
}

// WebM / OGG / lo que sea → OGG Opus mono 48 kHz (lo que graba el celular).
// Entra y sale por pipes, sin archivos temporales.
function convertirAOggOpus(buffer, { ffmpeg = FFMPEG, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let proceso;
    try {
      proceso = spawn(ffmpeg, [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        '-vn', '-ac', '1', '-ar', '48000',
        '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip',
        '-f', 'ogg', 'pipe:1',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    const salida = [];
    let errores = '';
    let terminado = false;
    const terminar = (err, valor) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(reloj);
      if (err) reject(err); else resolve(valor);
    };
    const reloj = setTimeout(() => {
      proceso.kill('SIGKILL');
      terminar(new Error('ffmpeg tardó demasiado convirtiendo la nota de voz'));
    }, timeoutMs);
    proceso.on('error', (e) => {
      // ENOENT: ffmpeg no está instalado.
      if (e && e.code === 'ENOENT') e.message = 'Falta ffmpeg en el servidor (sudo apt-get install -y ffmpeg): ' + e.message;
      terminar(e);
    });
    proceso.stdout.on('data', (d) => salida.push(d));
    proceso.stderr.on('data', (d) => { errores += d; });
    proceso.on('close', (codigo) => {
      const ogg = Buffer.concat(salida);
      if (codigo === 0 && esOgg(ogg)) terminar(null, ogg);
      else terminar(new Error(`ffmpeg no pudo convertir la nota de voz (código ${codigo}): ${errores.trim().slice(0, 300)}`));
    });
    // Si ffmpeg corta antes de leer todo (archivo roto), el pipe tira EPIPE:
    // el error real llega por 'close'.
    proceso.stdin.on('error', () => {});
    proceso.stdin.end(buffer);
  });
}

// Devuelve el audio listo para mandar como nota de voz. Si no es OGG y no
// se puede convertir (falta ffmpeg, archivo roto), tira el error: un WebM
// mandado como OGG le llega al cliente como un audio que no se reproduce.
async function audioParaNotaDeVoz(buffer, { convertir = convertirAOggOpus } = {}) {
  if (esOgg(buffer)) return buffer;
  return convertir(buffer);
}

module.exports = { MIMETYPE_NOTA_DE_VOZ, esOgg, convertirAOggOpus, audioParaNotaDeVoz };
