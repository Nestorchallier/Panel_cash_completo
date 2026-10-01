require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');
const { iniciarWhatsApp } = require('./wa');
const { iniciarColaEnvios } = require('./cola');

const AUTH_DIR = path.join(__dirname, '..', 'auth');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

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

  iniciarColaEnvios({ supabase, userId: WORKER_USER_ID, getSock: () => sockActual });
  iniciarLatido(() => sockActual, (s) => { sockActual = s; });

  logger.info('Worker corriendo. Ctrl+C para cortar.');
}

main().catch((e) => {
  logger.error({ err: e }, 'Error fatal arrancando el worker');
  process.exit(1);
});
