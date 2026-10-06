// Leído en el celular lo que se leyó en el CRM.
//
// Al abrir en la Bandeja un chat con mensajes sin leer, el panel deja
// conversaciones.leer_en_celular_hasta = ahora (ver crmMarcarConversacionLeida
// en supabase/crm.js y supabase/014_archivar_chats.sql). Acá se revisa cada
// pocos segundos: por cada chat marcado se le manda a WhatsApp el "leído"
// (sock.readMessages) de los entrantes que seguían sin leer hasta ese
// momento — así en el celular y en WhatsApp Web el chat también queda leído.
// OJO: igual que en WhatsApp, el contacto ve los tildes azules.
//
// Después se pasan esos mensajes a estado 'leido' y se borra la marca (solo
// si sigue siendo la misma: si mientras tanto se volvió a abrir el chat, la
// marca nueva queda para la vuelta siguiente).

const pino = require('pino');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const POLL_MS = 4000;
// Tope por chat y por vuelta (un chat viejo puede tener cientos de entrantes
// sin el aviso de leído; con los más nuevos alcanza para que el celular lo
// dé por leído).
const MAX_POR_CHAT = 100;
// Si WhatsApp rechaza el "leído" varias veces seguidas, se deja de insistir
// con ese chat (se borra la marca) para no trabar la vuelta.
const MAX_INTENTOS = 3;

// La clave que pide Baileys: remoteJid + id, y en grupos quién lo escribió
// (participant). Los mensajes de grupo guardados antes de la 014 no tienen
// el participante: no se pueden marcar y se saltean.
function claveDeMensaje(mensaje, conversacion) {
  const remoteJid = mensaje.wa_remote_jid || conversacion.jid;
  if (!mensaje.wa_id || !remoteJid) return null;
  const esGrupo = remoteJid.endsWith('@g.us');
  if (esGrupo && !mensaje.wa_participante) return null;
  const clave = { remoteJid, id: mensaje.wa_id, fromMe: false };
  if (esGrupo) clave.participant = mensaje.wa_participante;
  return clave;
}

// Procesa un chat marcado. Devuelve cuántos mensajes se marcaron como leídos
// en WhatsApp. Si readMessages falla, tira el error (la marca queda puesta).
async function leerConversacionEnCelular(sock, supabase, conversacion) {
  const hasta = conversacion.leer_en_celular_hasta;
  const { data: mensajes, error } = await supabase.from('mensajes')
    .select('id, wa_id, wa_remote_jid, wa_participante, creado_at')
    .eq('conversacion_id', conversacion.id)
    .eq('direccion', 'entrante')
    .eq('estado', 'entregado')
    .lte('creado_at', hasta)
    .order('creado_at', { ascending: false })
    .limit(MAX_POR_CHAT);
  if (error) throw error;

  const claves = [];
  const ids = [];
  for (const m of mensajes || []) {
    const clave = claveDeMensaje(m, conversacion);
    if (!clave) continue;
    claves.push(clave);
    ids.push(m.id);
  }
  if (claves.length) {
    await sock.readMessages(claves);
    const { error: eUpd } = await supabase.from('mensajes').update({ estado: 'leido' })
      .in('id', ids).eq('estado', 'entregado');
    if (eUpd) logger.error({ err: eUpd }, 'No se pudieron pasar a leído los mensajes marcados en el celular');
  }
  await borrarMarca(supabase, conversacion);
  return claves.length;
}

async function borrarMarca(supabase, conversacion) {
  const { error } = await supabase.from('conversaciones').update({ leer_en_celular_hasta: null })
    .eq('id', conversacion.id).eq('leer_en_celular_hasta', conversacion.leer_en_celular_hasta);
  if (error) logger.error({ err: error }, 'No se pudo borrar la marca de leído en el celular');
}

// Una vuelta: todos los chats marcados de este usuario.
async function revisarLeidosPendientes(sock, supabase, userId, intentos = new Map()) {
  const { data: pendientes, error } = await supabase.from('conversaciones')
    .select('id, jid, leer_en_celular_hasta')
    .eq('user_id', userId)
    .not('leer_en_celular_hasta', 'is', null)
    .limit(20);
  if (error) {
    // Falta correr la 014: no hay columna. No se llena el log cada 4 s.
    if (/leer_en_celular_hasta/.test(error.message || '')) return { sinColumna: true };
    throw error;
  }
  let marcados = 0;
  for (const conv of pendientes || []) {
    try {
      marcados += await leerConversacionEnCelular(sock, supabase, conv);
      intentos.delete(conv.id);
    } catch (e) {
      const n = (intentos.get(conv.id) || 0) + 1;
      logger.error({ err: e, conversacionId: conv.id, intento: n }, 'No se pudo marcar el chat como leído en WhatsApp');
      if (n >= MAX_INTENTOS) {
        intentos.delete(conv.id);
        await borrarMarca(supabase, conv);
      } else {
        intentos.set(conv.id, n);
      }
    }
  }
  if (marcados) logger.info({ marcados, chats: (pendientes || []).length }, 'Chats leídos en el CRM marcados como leídos en WhatsApp');
  return { marcados };
}

function iniciarLeidosEnCelular({ supabase, userId, getSock }) {
  let corriendo = false;
  // Sin la 014 se reintenta cada 5 min (por si la corren con el worker andando).
  let sinColumnaHasta = 0;
  const intentos = new Map();
  setInterval(async () => {
    if (corriendo || Date.now() < sinColumnaHasta) return;
    const sock = getSock();
    if (!sock) return;
    corriendo = true;
    try {
      const r = await revisarLeidosPendientes(sock, supabase, userId, intentos);
      if (r && r.sinColumna) {
        if (!sinColumnaHasta) logger.warn('Falta correr supabase/014_archivar_chats.sql: los chats leídos en el CRM no se marcan como leídos en el celular.');
        sinColumnaHasta = Date.now() + 5 * 60000;
      }
    } catch (e) {
      logger.error({ err: e }, 'Error revisando los chats leídos en el CRM');
    } finally {
      corriendo = false;
    }
  }, POLL_MS);
}

module.exports = { iniciarLeidosEnCelular, revisarLeidosPendientes, leerConversacionEnCelular, claveDeMensaje };
