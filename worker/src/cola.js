// Cola de envíos salientes, con los límites anti-bloqueo de la pantalla de
// Conexión (5.4 del plan): horario permitido, días hábiles, intervalo
// aleatorio entre mensajes y máximo por día. El panel inserta filas en
// `mensajes` con estado='pendiente' (desde el chat o una plantilla) y esto
// las va mandando de a una, nunca en ráfaga.

const pino = require('pino');
const { generateMessageIDV2 } = require('@whiskeysockets/baileys');
const { aplicarPromesaConfirmada } = require('./aplicar-reglas');
const { MIMETYPE_NOTA_DE_VOZ, audioParaNotaDeVoz } = require('./audio');
// En 'info' queda en el log cada envío ("Mensaje enviado"), para poder
// auditar si un mensaje salió o no.
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const POLL_MS = 1500;
// Una respuesta en un chat donde el cliente escribió en las últimas 24 h es
// una conversación, no un envío masivo: sale casi enseguida (con un respiro
// corto entre una y otra) en vez de esperar el intervalo anti-bloqueo.
const PAUSA_RESPUESTA_MS = 3000;
const VENTANA_RESPUESTA_MS = 24 * 3600000;

async function esRespuesta(supabase, conversacionId) {
  const desde = new Date(Date.now() - VENTANA_RESPUESTA_MS).toISOString();
  const { data } = await supabase.from('mensajes').select('id')
    .eq('conversacion_id', conversacionId).eq('direccion', 'entrante').gte('creado_at', desde).limit(1);
  return !!(data && data.length);
}

function horaActualEntre(desde, hasta, ahora = new Date()) {
  const hhmm = ahora.toTimeString().slice(0, 5);
  return hhmm >= desde.slice(0, 5) && hhmm <= hasta.slice(0, 5);
}

function diaHabilHoy(diasHabiles, ahora = new Date()) {
  return (diasHabiles || [1, 2, 3, 4, 5, 6]).includes(ahora.getDay());
}

async function leerSesion(supabase, userId) {
  const { data } = await supabase.from('wa_sesion').select('*').eq('user_id', userId).maybeSingle();
  return data;
}

async function resetearContadorSiCambioDeDia(supabase, userId, sesion) {
  const hoyISO = new Date().toISOString().slice(0, 10);
  const ultimoISO = sesion.actualizado_at ? sesion.actualizado_at.slice(0, 10) : null;
  if (ultimoISO !== hoyISO && sesion.enviados_hoy > 0) {
    await supabase.from('wa_sesion').update({ enviados_hoy: 0 }).eq('user_id', userId);
    sesion.enviados_hoy = 0;
  }
  return sesion;
}

// Lo que se le pasa a sock.sendMessage. Las notas de voz grabadas en el
// panel (tipo 'audio') quedan en Storage (media_path): se bajan, se pasan a
// OGG/Opus si hace falta (audio.js) y salen con ptt: true, así le llegan al
// cliente como nota de voz y no como archivo.
async function contenidoParaEnviar(supabase, bucket, mensaje, { convertirAudio } = {}) {
  if (mensaje.tipo === 'audio' && mensaje.media_path) {
    const { data, error } = await supabase.storage.from(bucket).download(mensaje.media_path);
    if (error || !data) throw error || new Error('No se encontró la nota de voz en Storage: ' + mensaje.media_path);
    const original = Buffer.isBuffer(data) ? data : Buffer.from(await data.arrayBuffer());
    const audio = await audioParaNotaDeVoz(original, convertirAudio ? { convertir: convertirAudio } : {});
    return { audio, ptt: true, mimetype: MIMETYPE_NOTA_DE_VOZ };
  }
  return { text: mensaje.texto || '' };
}

// soloRespuesta: durante el intervalo anti-bloqueo solo se mandan respuestas
// a chats activos. Devuelve false si no mandó nada, o { respuesta } si mandó.
// bucket / convertirAudio: para las notas de voz (las pruebas pasan un
// convertidor de mentira).
async function enviarUno(sock, supabase, userId, sesion, { soloRespuesta = false, bucket = 'comprobantes', convertirAudio } = {}) {
  const { data: pendiente } = await supabase
    .from('mensajes')
    .select('*, conversaciones!inner(id, jid, user_id, cliente_id)')
    .eq('direccion', 'saliente')
    .eq('estado', 'pendiente')
    .eq('conversaciones.user_id', userId)
    .order('creado_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pendiente) return false;
  const respuesta = await esRespuesta(supabase, pendiente.conversaciones.id);
  if (soloRespuesta && !respuesta) return false;

  // El id de WhatsApp (wa_id) se elige ACÁ y se guarda en la fila ANTES de
  // mandar. Por dos motivos:
  //   - los tildes (entregado / leído) llegan por messages.update con ese
  //     id: si la fila no lo tiene, nunca se encuentran (ver wa.js);
  //   - si WhatsApp devuelve el mismo mensaje por messages.upsert antes de
  //     que termine el envío, guardarMensaje lo reconoce por wa_id y no lo
  //     duplica. Guardarlo recién después dejaba una ventana donde podía
  //     entrar como fila nueva y el UPDATE de acá chocaba contra el índice
  //     único de wa_id (la fila quedaba 'pendiente' y se volvía a mandar).
  // El .eq('estado', 'pendiente') es la reserva: si desde el panel se
  // canceló o ya lo tomó otro ciclo, no se manda.
  const waId = generateMessageIDV2(sock.user?.id);
  const { data: reservado, error: errorReserva } = await supabase.from('mensajes')
    .update({ wa_id: waId }).eq('id', pendiente.id).eq('estado', 'pendiente').select('id');
  if (errorReserva) {
    logger.error({ err: errorReserva }, 'No se pudo preparar el mensaje para enviar, se reintenta en el próximo ciclo');
    return false;
  }
  if (!reservado || !reservado.length) return false;

  try {
    const contenido = await contenidoParaEnviar(supabase, bucket, pendiente, { convertirAudio });
    const resultado = await sock.sendMessage(pendiente.conversaciones.jid, contenido, { messageId: waId });
    const idFinal = resultado?.key?.id || waId;
    // Solo pasa de 'pendiente' a 'enviado': si en el medio ya llegó el
    // tilde de entregado/leído (WhatsApp es rápido), no se lo pisa.
    await supabase.from('mensajes').update({ estado: 'enviado', ...(idFinal !== waId ? { wa_id: idFinal } : {}) })
      .eq('id', pendiente.id).eq('estado', 'pendiente');
    await supabase.from('wa_sesion').update({ enviados_hoy: (sesion.enviados_hoy || 0) + 1 }).eq('user_id', userId);
    logger.info({ a: pendiente.conversaciones.jid, tipo: pendiente.tipo || 'texto' }, 'Mensaje enviado');
    // "Dale, el 5" contestando a "¿te puedo pagar el 5?": queda la promesa.
    await aplicarPromesaConfirmada(supabase, userId, pendiente.conversaciones, pendiente.texto, new Date().toISOString())
      .catch(e => logger.error({ err: e }, 'Error aplicando promesa confirmada'));
  } catch (e) {
    logger.error({ err: e }, 'Error enviando mensaje, se reintenta en el próximo ciclo');
    await supabase.from('mensajes').update({ estado: 'error' }).eq('id', pendiente.id);
  }
  return { respuesta };
}

function iniciarColaEnvios({ supabase, userId, getSock, bucket = 'comprobantes' }) {
  let enviandoAhora = false;
  let proximoEnvioPermitidoEn = 0;
  let ultimoEnvio = 0;

  setInterval(async () => {
    if (enviandoAhora) return;
    const sock = getSock();
    if (!sock) return;
    const enIntervalo = Date.now() < proximoEnvioPermitidoEn;
    if (enIntervalo && Date.now() - ultimoEnvio < PAUSA_RESPUESTA_MS) return;

    enviandoAhora = true;
    try {
      let sesion = await leerSesion(supabase, userId);
      if (!sesion) return;
      sesion = await resetearContadorSiCambioDeDia(supabase, userId, sesion);

      if (!diaHabilHoy(sesion.dias_habiles)) return;
      if (!horaActualEntre(sesion.horario_desde, sesion.horario_hasta)) return;
      if ((sesion.enviados_hoy || 0) >= (sesion.limite_diario || 250)) return;

      const envio = await enviarUno(sock, supabase, userId, sesion, { soloRespuesta: enIntervalo, bucket });
      if (envio) {
        ultimoEnvio = Date.now();
        // Solo los envíos "en frío" (sin charla reciente) abren el intervalo
        // anti-bloqueo; una respuesta no lo alarga.
        if (!envio.respuesta) {
          const min = (sesion.intervalo_min || 25) * 1000;
          const max = (sesion.intervalo_max || 60) * 1000;
          proximoEnvioPermitidoEn = Date.now() + min + Math.random() * Math.max(0, max - min);
        }
      }
    } catch (e) {
      logger.error({ err: e }, 'Error en el ciclo de la cola de envíos');
    } finally {
      enviandoAhora = false;
    }
  }, POLL_MS);
}

module.exports = { iniciarColaEnvios, enviarUno, contenidoParaEnviar };
