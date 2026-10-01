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
const QRCode = require('qrcode');
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

function previewTexto(texto, tipo) {
  return texto || (tipo === 'imagen' ? '📷 Imagen' : tipo === 'pdf' ? '📄 PDF' : tipo === 'audio' ? '🎙️ Audio' : '...');
}

// Guarda un mensaje (en vivo o del historial) en conversaciones/mensajes.
// opciones.descargarAdjuntos: false durante la sincronización inicial del
// historial (puede traer cientos de mensajes viejos de una — bajar y subir
// a Storage cada foto vieja sería lento y llenaría el bucket de golpe; los
// mensajes nuevos que lleguen de ahí en adelante sí bajan el adjunto).
// opciones.aplicarAutomatizacion: false para el historial — no tiene
// sentido que las reglas muevan tarjetas del Kanban por mensajes de hace
// semanas que ya se gestionaron a mano.
async function guardarMensaje(sock, supabase, userId, config, msg, opciones = {}) {
  const { descargarAdjuntos = true, aplicarAutomatizacion = true, silencioso = false } = opciones;
  const direccion = msg.key.fromMe ? 'saliente' : 'entrante';

  const telefono = jidATelefono(msg.key.remoteJid);
  if (!telefono) {
    if (!silencioso) logger.warn({ remoteJid: msg.key.remoteJid }, 'No se pudo sacar un teléfono válido de este remitente — se descarta');
    return;
  }

  const waId = msg.key.id;
  const { data: yaExiste, error: errorExiste } = await supabase.from('mensajes').select('id').eq('wa_id', waId).maybeSingle();
  if (errorExiste) logger.error({ err: errorExiste }, 'Error chequeando duplicado de mensaje');
  if (yaExiste) return;

  const conversacion = await obtenerOCrearConversacion(supabase, userId, telefono, msg.key.remoteJid);
  const tipo = tipoDeMensaje(msg);
  const texto = textoDeMensaje(msg);
  if (!silencioso) logger.info({ telefono, direccion, conversacionId: conversacion.id, tipo, texto }, 'Guardando mensaje');

  let mediaPath = null;
  if (descargarAdjuntos && (tipo === 'imagen' || tipo === 'pdf' || tipo === 'audio')) {
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      const ext = tipo === 'imagen' ? 'jpg' : tipo === 'pdf' ? 'pdf' : 'ogg';
      mediaPath = await subirAdjunto(supabase, config.bucket, userId, buffer, ext);
    } catch (e) {
      logger.error({ err: e }, 'No se pudo descargar el adjunto');
    }
  }

  const creadoAt = msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000).toISOString() : new Date().toISOString();
  const { error: errorInsert } = await supabase.from('mensajes').insert({
    conversacion_id: conversacion.id,
    wa_id: waId,
    direccion,
    tipo,
    texto: texto || null,
    media_path: mediaPath,
    estado: direccion === 'entrante' ? 'entregado' : 'enviado',
    creado_at: creadoAt,
  });
  if (errorInsert) { logger.error({ err: errorInsert }, 'No se pudo guardar el mensaje'); return; }

  const esMasNuevo = !conversacion.ultimo_at || creadoAt >= conversacion.ultimo_at;
  const { error: errorUpdate } = await supabase.from('conversaciones').update({
    ...(esMasNuevo ? { ultimo_texto: previewTexto(texto, tipo), ultimo_at: creadoAt } : {}),
    ...(direccion === 'entrante' && !opciones.noContarNoLeido ? { no_leidos: (conversacion.no_leidos || 0) + 1 } : {}),
  }).eq('id', conversacion.id);
  if (errorUpdate) logger.error({ err: errorUpdate }, 'No se pudo actualizar la conversación');

  if (aplicarAutomatizacion && direccion === 'entrante') {
    await aplicarReglas(supabase, userId, conversacion, texto, tipo).catch(e => logger.error({ err: e }, 'Error aplicando reglas'));
  }
}

// Primera vinculación (o reconexión): WhatsApp manda de a tandas todo el
// historial de chats que había antes de conectar el panel. Se guarda todo
// (sin bajar adjuntos viejos ni mover tarjetas del Kanban por mensajes
// pasados, ver guardarMensaje) y al final se corrige no_leidos de cada
// chat con el contador real que manda WhatsApp.
async function sincronizarHistorial(sock, supabase, userId, config, { chats, messages }) {
  logger.info({ chats: chats?.length || 0, mensajes: messages?.length || 0 }, 'Sincronizando historial de WhatsApp...');
  let guardados = 0;
  for (const msg of messages || []) {
    if (!msg.message) continue;
    try {
      await guardarMensaje(sock, supabase, userId, config, msg, {
        descargarAdjuntos: false, aplicarAutomatizacion: false, noContarNoLeido: true, silencioso: true,
      });
      guardados++;
      if (guardados % 50 === 0) logger.info({ guardados, de: messages.length }, 'Importando historial...');
    } catch (e) {
      logger.error({ err: e }, 'Error importando un mensaje del historial');
    }
  }
  for (const chat of chats || []) {
    const telefono = jidATelefono(chat.id);
    if (!telefono) continue;
    await supabase.from('conversaciones').update({ no_leidos: chat.unreadCount || 0 })
      .eq('user_id', userId).eq('telefono', telefono);
  }
  logger.info({ guardados }, 'Historial de WhatsApp importado.');
}

async function iniciarWhatsApp({ supabase, userId, config, onReady }) {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Cash Market CRM', 'Chrome', '1.0'],
    syncFullHistory: true, // trae todos los chats/mensajes previos, no solo los recientes
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Se manda ya dibujado como imagen (data URL) en vez del texto crudo
      // del QR: así el panel solo tiene que mostrar un <img>, sin depender
      // de ninguna librería externa en el navegador (algunas redes de
      // oficina bloquean los CDN de JS y el QR quedaba sin poder dibujarse).
      const qrImagen = await QRCode.toDataURL(qr, { width: 300, margin: 1 });
      await supabase.from('wa_sesion').upsert({ user_id: userId, estado: 'conectando', qr: qrImagen });
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
      try {
        await supabase.from('wa_sesion').upsert({ user_id: userId, estado: 'desconectado' });
      } catch (e) {
        logger.error({ err: e }, 'No se pudo marcar la sesión como desconectada');
      }
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

  sock.ev.on('messaging-history.set', async (payload) => {
    try {
      await sincronizarHistorial(sock, supabase, userId, config, payload);
    } catch (e) {
      logger.error({ err: e }, 'Error sincronizando el historial de WhatsApp');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message) continue;
      try {
        await guardarMensaje(sock, supabase, userId, config, msg);
      } catch (e) {
        logger.error({ err: e }, 'Error procesando mensaje entrante');
      }
    }
  });

  return sock;
}

module.exports = { iniciarWhatsApp, jidATelefono };
