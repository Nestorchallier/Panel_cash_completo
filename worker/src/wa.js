// Conexión a WhatsApp con Baileys (librería no oficial, igual que usa
// Whaticket — ver sección 8 del plan sobre el riesgo de esto). Expone
// iniciarWhatsApp(), que:
//   - mantiene la sesión en worker/auth/ (NO se sube al repo, ver .gitignore)
//   - publica el QR y el estado de conexión en wa_sesion
//   - por cada mensaje entrante: normaliza el teléfono, busca/crea el
//     cliente y la conversación, guarda el mensaje (con el adjunto en
//     Storage si trae uno) y corre las reglas de clasificación
//   - deja la cola de salida (cola.js) mandar lo que esté 'pendiente' en
//     la tabla mensajes, respetando los límites de wa_sesion.

const path = require('node:path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const { normalizarTelefonoAR } = require('./telefonos');
const { clasificarMensaje } = require('./reglas');

const AUTH_DIR = path.join(__dirname, '..', 'auth');
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

function jidATelefono(jid) {
  // "5491145327781@s.whatsapp.net" -> "5491145327781". Los jid de grupo
  // (@g.us) se descartan: este worker es 1 a 1 con clientes, no atiende grupos.
  if (!jid || jid.endsWith('@g.us')) return null;
  return normalizarTelefonoAR(jid.split('@')[0]);
}

function tipoDeMensaje(msg) {
  if (msg.message?.imageMessage) return 'imagen';
  if (msg.message?.documentMessage) return 'pdf';
  if (msg.message?.audioMessage || msg.message?.pttMessage) return 'audio';
  if (msg.message?.conversation || msg.message?.extendedTextMessage) return 'texto';
  return 'otro';
}

function textoDeMensaje(msg) {
  return msg.message?.conversation
    || msg.message?.extendedTextMessage?.text
    || msg.message?.imageMessage?.caption
    || msg.message?.documentMessage?.caption
    || '';
}

async function obtenerOCrearConversacion(supabase, userId, telefono, jid) {
  const { data: existente } = await supabase
    .from('conversaciones').select('*').eq('user_id', userId).eq('telefono', telefono).maybeSingle();
  if (existente) return existente;

  const { data: tel } = await supabase
    .from('clientes_telefonos').select('cliente_id, clientes!inner(user_id)').eq('telefono', telefono).maybeSingle();
  const clienteId = (tel && tel.clientes && tel.clientes.user_id === userId) ? tel.cliente_id : null;

  const { data: nueva, error } = await supabase
    .from('conversaciones')
    .insert({ user_id: userId, jid, telefono, cliente_id: clienteId, no_leidos: 0 })
    .select('*').single();
  if (error) throw error;
  return nueva;
}

async function subirAdjunto(supabase, bucket, userId, buffer, extension) {
  const nombre = `${userId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${extension}`;
  const { error } = await supabase.storage.from(bucket).upload(nombre, buffer, { upsert: false });
  if (error) { logger.error({ err: error }, 'No se pudo subir el adjunto a Storage'); return null; }
  return nombre;
}

async function aplicarReglas(supabase, userId, conversacion, mensajeTexto, tipo) {
  if (!conversacion.cliente_id) return; // sin cliente vinculado no hay tarjeta que mover

  const { data: cliente } = await supabase.from('clientes').select('*').eq('id', conversacion.cliente_id).single();
  const { data: etapaActual } = cliente?.etapa_id
    ? await supabase.from('etapas').select('clave').eq('id', cliente.etapa_id).maybeSingle()
    : { data: null };

  const { data: reglas } = await supabase
    .from('reglas').select('*').eq('user_id', userId).order('prioridad', { ascending: true });

  const resultado = clasificarMensaje(reglas || [], {
    texto: mensajeTexto,
    tieneAdjunto: tipo === 'imagen' || tipo === 'pdf',
    tipoAdjunto: tipo === 'imagen' || tipo === 'pdf' ? tipo : null,
    etapaActualClave: etapaActual?.clave || null,
  });
  if (!resultado) return;

  const { regla, fechaDetectada } = resultado;
  const accion = regla.accion || {};
  const cambios = {};

  if (accion.mueve_a) {
    const { data: etapaDestino } = await supabase
      .from('etapas').select('id').eq('user_id', userId).eq('clave', accion.mueve_a).maybeSingle();
    if (etapaDestino) cambios.etapa_id = etapaDestino.id;
  }
  if (fechaDetectada) cambios.promesa_fecha = fechaDetectada;
  if (accion.etiqueta) cambios.etiquetas = Array.from(new Set([...(cliente.etiquetas || []), accion.etiqueta]));

  if (Object.keys(cambios).length) {
    await supabase.from('clientes').update(cambios).eq('id', cliente.id);
  }
  if (fechaDetectada && accion.crea_recordatorio) {
    await supabase.from('recordatorios').insert({
      user_id: userId, cliente_id: cliente.id, fecha: fechaDetectada, tipo: 'promesa',
      texto: `Promesa detectada por WhatsApp: "${mensajeTexto}"`,
    });
  }
  await supabase.from('eventos').insert({
    user_id: userId, cliente_id: cliente.id, tipo: 'regla',
    detalle: { regla: regla.nombre, accion, fecha_detectada: fechaDetectada },
  });
}

async function manejarMensajeEntrante(sock, supabase, userId, config, msg) {
  const telefono = jidATelefono(msg.key.remoteJid);
  if (!telefono) return;

  const waId = msg.key.id;
  const { data: yaExiste } = await supabase.from('mensajes').select('id').eq('wa_id', waId).maybeSingle();
  if (yaExiste) return; // Baileys puede reentregar el mismo mensaje

  const conversacion = await obtenerOCrearConversacion(supabase, userId, telefono, msg.key.remoteJid);
  const tipo = tipoDeMensaje(msg);
  const texto = textoDeMensaje(msg);

  let mediaPath = null;
  if (tipo === 'imagen' || tipo === 'pdf' || tipo === 'audio') {
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      const ext = tipo === 'imagen' ? 'jpg' : tipo === 'pdf' ? 'pdf' : 'ogg';
      mediaPath = await subirAdjunto(supabase, config.bucket, userId, buffer, ext);
    } catch (e) {
      logger.error({ err: e }, 'No se pudo descargar el adjunto');
    }
  }

  await supabase.from('mensajes').insert({
    conversacion_id: conversacion.id,
    wa_id: waId,
    direccion: 'entrante',
    tipo,
    texto: texto || null,
    media_path: mediaPath,
    estado: 'entregado',
  });

  await supabase.from('conversaciones').update({
    ultimo_texto: texto || (tipo === 'imagen' ? '📷 Imagen' : tipo === 'pdf' ? '📄 PDF' : tipo === 'audio' ? '🎙️ Audio' : '...'),
    ultimo_at: new Date().toISOString(),
    no_leidos: (conversacion.no_leidos || 0) + 1,
  }).eq('id', conversacion.id);

  await aplicarReglas(supabase, userId, conversacion, texto, tipo).catch(e => logger.error({ err: e }, 'Error aplicando reglas'));
}

async function iniciarWhatsApp({ supabase, userId, config, onReady }) {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Cash Market CRM', 'Chrome', '1.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      await supabase.from('wa_sesion').upsert({ user_id: userId, estado: 'conectando', qr });
      logger.info('QR nuevo generado — escanealo desde el panel (Conexión WhatsApp) o la terminal.');
    }

    if (connection === 'open') {
      await supabase.from('wa_sesion').upsert({
        user_id: userId, estado: 'conectado', qr: null,
        numero: sock.user?.id?.split(':')[0] || null,
        nombre_whatsapp: sock.user?.name || null,
        conectado_desde: new Date().toISOString(),
      });
      logger.info('WhatsApp conectado.');
      if (onReady) onReady(sock);
    }

    if (connection === 'close') {
      await supabase.from('wa_sesion').upsert({ user_id: userId, estado: 'desconectado' }).catch(() => {});
      const statusCode = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : null;
      const deslogueado = statusCode === DisconnectReason.loggedOut;
      logger.warn({ statusCode, deslogueado }, 'Conexión cerrada.');
      if (!deslogueado) {
        setTimeout(() => iniciarWhatsApp({ supabase, userId, config, onReady }), 5000);
      } else {
        logger.error('Sesión cerrada desde el celular — hay que volver a escanear el QR (borrar worker/auth/ y reiniciar).');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      try {
        await manejarMensajeEntrante(sock, supabase, userId, config, msg);
      } catch (e) {
        logger.error({ err: e }, 'Error procesando mensaje entrante');
      }
    }
  });

  return sock;
}

module.exports = { iniciarWhatsApp, jidATelefono };
