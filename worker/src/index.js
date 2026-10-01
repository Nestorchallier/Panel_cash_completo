require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');
const { iniciarWhatsApp } = require('./wa');
const { iniciarColaEnvios } = require('./cola');

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

function iniciarLatido() {
  setInterval(() => {
    supabase.from('wa_sesion').update({ ultimo_latido: new Date().toISOString() }).eq('user_id', WORKER_USER_ID)
      .then(({ error }) => { if (error) logger.error({ err: error }, 'No se pudo actualizar el latido'); });
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
  iniciarLatido();

  logger.info('Worker corriendo. Ctrl+C para cortar.');
}

main().catch((e) => {
  logger.error({ err: e }, 'Error fatal arrancando el worker');
  process.exit(1);
});
