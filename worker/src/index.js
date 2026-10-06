require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');
const { iniciarWhatsApp } = require('./wa');
const { iniciarColaEnvios } = require('./cola');
const { iniciarMoraDiaria } = require('./mora-diaria');
const { iniciarComandosUsuarios } = require('./usuarios');
const { iniciarLeidosEnCelular } = require('./leer-en-celular');

const AUTH_DIR = path.join(__dirname, '..', 'auth');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Esto tiene que quedar corriendo 24/7 — un error suelto que no se
// previó no puede tirar abajo todo el proceso (como pasó con el bug de
// wa.js que cortaba la reconexión justo después de escanear el QR). Se
// loguea y sigue, en vez de que Node mate el proceso entero.
process.on('uncaughtException', (err) => logger.error({ err }, 'uncaughtException (el worker sigue corriendo)'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection (el worker sigue corriendo)'));

// libsignal (dependencia de Baileys, el protocolo de cifrado de WhatsApp)
// avisa con console.error "a mano" —no se puede configurar por opciones—
// cuando le llega un mensaje cifrado con una sesión que ya no tiene (pasa
// seguido después de reescanear el QR varias veces, o con Estados de
// contactos): son líneas inofensivas, el mensaje se descarta solo y la
// sesión se resincroniza con el próximo mensaje de esa conversación. Se
// filtran acá esas dos líneas puntuales para no inundar la consola;
// cualquier otro console.error (nuestro o de otra librería) sigue
// mostrándose igual.
const consoleErrorOriginal = console.error.bind(console);
console.error = (...args) => {
  const primero = typeof args[0] === 'string' ? args[0] : '';
  if (primero.startsWith('Failed to decrypt message with any known session') || primero.startsWith('Session error:')) return;
  consoleErrorOriginal(...args);
};

// Mismo caso que arriba pero con console.warn/console.info: libsignal
// avisa "a mano" cuando cierra una sesión vieja para abrir una nueva a
// partir de una prekey bundle que llegó (normal al resincronizar), y lo
// hace volcando el objeto completo de la sesión (claves, contadores, todo)
// — inofensivo pero larguísimo en la consola.
const consoleWarnOriginal = console.warn.bind(console);
console.warn = (...args) => {
  const primero = typeof args[0] === 'string' ? args[0] : '';
  if (primero.startsWith('Closing open session in favor of incoming prekey bundle')) return;
  consoleWarnOriginal(...args);
};
const consoleInfoOriginal = console.info.bind(console);
console.info = (...args) => {
  const primero = typeof args[0] === 'string' ? args[0] : '';
  if (primero.startsWith('Closing session:')) return;
  consoleInfoOriginal(...args);
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WORKER_USER_ID = process.env.WORKER_USER_ID;
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'comprobantes';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !WORKER_USER_ID) {
  logger.error('Faltan variables en .env — copiá worker/.env.example a worker/.env y completalo (ver la sección 9 del plan).');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

async function asegurarBucket() {
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) { logger.error({ err: error }, 'No se pudo listar los buckets de Storage'); return; }
  if (!buckets.some(b => b.name === BUCKET)) {
    const { error: errCrear } = await supabase.storage.createBucket(BUCKET, { public: false });
    if (errCrear) logger.error({ err: errCrear }, `No se pudo crear el bucket "${BUCKET}"`);
    else logger.info(`Bucket "${BUCKET}" creado.`);
  }
}

// Comandos desde la pantalla de Conexión (5.4: "Reiniciar sesión" /
// "Desvincular") que el worker no puede recibir en vivo porque vive en
// otra máquina — los deja pendientes en wa_sesion.comando y acá se
// revisan junto con el latido.
async function revisarComandoPendiente(getSock, setSock) {
  const { data } = await supabase.from('wa_sesion').select('comando').eq('user_id', WORKER_USER_ID).maybeSingle();
  if (!data || !data.comando) return;

  logger.warn({ comando: data.comando }, 'Comando pendiente recibido desde el panel');
  const sock = getSock();

  if (data.comando === 'desvincular') {
    try { if (sock) await sock.logout(); } catch (e) { logger.error({ err: e }, 'Error en logout'); }
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    setSock(null);
    await supabase.from('wa_sesion').update({ comando: null, estado: 'desconectado', qr: null, numero: null }).eq('user_id', WORKER_USER_ID);
    logger.warn('Sesión desvinculada — reiniciá el worker para generar un QR nuevo.');
    process.exit(0); // más simple y seguro que reconectar en caliente tras un logout
  }

  if (data.comando === 'reiniciar') {
    await supabase.from('wa_sesion').update({ comando: null }).eq('user_id', WORKER_USER_ID);
    try { if (sock) sock.end(new Error('Reinicio pedido desde el panel')); } catch (e) { /* ya estaba cerrado */ }
    // iniciarWhatsApp ya reconecta solo al detectar el cierre (ver wa.js).
  }
}

function iniciarLatido(getSock, setSock) {
  setInterval(async () => {
    const { error } = await supabase.from('wa_sesion').update({ ultimo_latido: new Date().toISOString() }).eq('user_id', WORKER_USER_ID);
    if (error) logger.error({ err: error }, 'No se pudo actualizar el latido');
    await revisarComandoPendiente(getSock, setSock).catch(e => logger.error({ err: e }, 'Error revisando comando pendiente'));
  }, 10_000);
}

async function main() {
  logger.info('Arrancando worker de WhatsApp...');
  await asegurarBucket();

  let sockActual = null;
  await iniciarWhatsApp({
    supabase,
    userId: WORKER_USER_ID,
    config: { bucket: BUCKET },
    onReady: (sock) => { sockActual = sock; },
  });

  iniciarColaEnvios({ supabase, userId: WORKER_USER_ID, getSock: () => sockActual, bucket: BUCKET });
  iniciarLatido(() => sockActual, (s) => { sockActual = s; });
  // Chats leídos en el CRM -> leídos también en el celular (ver leer-en-celular.js).
  iniciarLeidosEnCelular({ supabase, userId: WORKER_USER_ID, getSock: () => sockActual });
  // No depende de WhatsApp: recalcula cuotas vencidas y días de atraso
  // aunque el celular esté desconectado (ver mora-diaria.js).
  iniciarMoraDiaria({ supabase, userId: WORKER_USER_ID });
  // Pedidos de la pantalla 👥 Usuarios del Panel de supervisor (crear
  // agentes, contraseñas, deshabilitar): necesitan la clave service, que
  // solo está acá (ver usuarios.js).
  iniciarComandosUsuarios({ supabase, logger });

  logger.info('Worker corriendo. Ctrl+C para cortar.');
}

main().catch((e) => {
  logger.error({ err: e }, 'Error fatal arrancando el worker');
  process.exit(1);
});
