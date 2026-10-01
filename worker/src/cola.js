// Cola de envíos salientes, con los límites anti-bloqueo de la pantalla de
// Conexión (5.4 del plan): horario permitido, días hábiles, intervalo
// aleatorio entre mensajes y máximo por día. El panel inserta filas en
// `mensajes` con estado='pendiente' (desde el chat o una plantilla) y esto
// las va mandando de a una, nunca en ráfaga.

const pino = require('pino');
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

const POLL_MS = 4000;

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

async function enviarUno(sock, supabase, userId, sesion) {
  const { data: pendiente } = await supabase
    .from('mensajes')
    .select('*, conversaciones!inner(id, jid, user_id)')
    .eq('direccion', 'saliente')
    .eq('estado', 'pendiente')
    .eq('conversaciones.user_id', userId)
    .order('creado_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pendiente) return false;

  try {
    await sock.sendMessage(pendiente.conversaciones.jid, { text: pendiente.texto || '' });
    await supabase.from('mensajes').update({ estado: 'enviado' }).eq('id', pendiente.id);
    await supabase.from('wa_sesion').update({ enviados_hoy: (sesion.enviados_hoy || 0) + 1 }).eq('user_id', userId);
    logger.info({ a: pendiente.conversaciones.jid }, 'Mensaje enviado');
  } catch (e) {
    logger.error({ err: e }, 'Error enviando mensaje, se reintenta en el próximo ciclo');
    await supabase.from('mensajes').update({ estado: 'error' }).eq('id', pendiente.id);
  }
  return true;
}

function iniciarColaEnvios({ supabase, userId, getSock }) {
  let enviandoAhora = false;
  let proximoEnvioPermitidoEn = 0;

  setInterval(async () => {
    if (enviandoAhora) return;
    const sock = getSock();
    if (!sock) return;
    if (Date.now() < proximoEnvioPermitidoEn) return;

    enviandoAhora = true;
    try {
      let sesion = await leerSesion(supabase, userId);
      if (!sesion) return;
      sesion = await resetearContadorSiCambioDeDia(supabase, userId, sesion);

      if (!diaHabilHoy(sesion.dias_habiles)) return;
      if (!horaActualEntre(sesion.horario_desde, sesion.horario_hasta)) return;
      if ((sesion.enviados_hoy || 0) >= (sesion.limite_diario || 250)) return;

      const envio = await enviarUno(sock, supabase, userId, sesion);
      if (envio) {
        const min = (sesion.intervalo_min || 25) * 1000;
        const max = (sesion.intervalo_max || 60) * 1000;
        proximoEnvioPermitidoEn = Date.now() + min + Math.random() * Math.max(0, max - min);
      }
    } catch (e) {
      logger.error({ err: e }, 'Error en el ciclo de la cola de envíos');
    } finally {
      enviandoAhora = false;
    }
  }, POLL_MS);
}

module.exports = { iniciarColaEnvios };
