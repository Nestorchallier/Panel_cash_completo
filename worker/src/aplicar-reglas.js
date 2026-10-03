// Aplica las reglas automáticas a un cliente: mueve la tarjeta, carga la
// promesa, suma etiquetas y deja el evento en el historial. La clasificación
// del texto está en reglas.js (compartido con el panel); acá está lo que
// toca la base. Lo usan wa.js (mensajes que llegan o se escriben desde el
// celular) y cola.js (mensajes que se mandan desde el panel).
const pino = require('pino');
const { clasificarMensaje, promesaConfirmada } = require('./reglas');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Cuánto para atrás se mira el chat para ver si el saliente confirma una
// fecha que propuso el cliente.
const VENTANA_CONFIRMACION_MS = 48 * 3600000;

// reglas.js (detectarFecha) toma el DÍA en UTC de la fecha que recibe. Un
// mensaje de las 22:00 de Argentina ya es el día siguiente en UTC, y
// "mañana" quedaba dos días después. Se le pasa el mediodía UTC del día
// LOCAL del mensaje: así su día en UTC es siempre el día de acá.
function fechaParaReglas(fechaISO) {
  const d = fechaISO ? new Date(fechaISO) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  const dia = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${dia}T12:00:00.000Z`;
}

async function clienteYEtapa(supabase, clienteId) {
  const { data: cliente } = await supabase.from('clientes').select('*').eq('id', clienteId).single();
  const { data: etapaActual } = cliente?.etapa_id
    ? await supabase.from('etapas').select('clave, orden').eq('id', cliente.etapa_id).maybeSingle()
    : { data: null };
  return { cliente, etapaActual };
}

async function aplicarReglas(supabase, userId, conversacion, mensajeTexto, tipo, fechaMensaje) {
  if (!conversacion.cliente_id) return; // sin cliente vinculado no hay tarjeta que mover

  const { cliente, etapaActual } = await clienteYEtapa(supabase, conversacion.cliente_id);
  if (!cliente) return;

  const { data: reglas } = await supabase
    .from('reglas').select('*').eq('user_id', userId).order('prioridad', { ascending: true });

  const resultado = clasificarMensaje(reglas || [], {
    texto: mensajeTexto,
    tieneAdjunto: tipo === 'imagen' || tipo === 'pdf',
    tipoAdjunto: tipo === 'imagen' || tipo === 'pdf' ? tipo : null,
    etapaActualClave: etapaActual?.clave || null,
    // "mañana" / "el viernes" se cuentan desde el día en que se escribió el
    // mensaje, no desde que el worker lo procesa (si estuvo caído un rato
    // y lo recibe tarde, la promesa no se corre un día).
    fecha: fechaParaReglas(fechaMensaje),
    hora: fechaMensaje || new Date().toISOString(),
  });
  if (!resultado) return;

  await aplicarResultado(supabase, userId, cliente, etapaActual, resultado.regla, resultado.fechaDetectada, mensajeTexto);
}

// Saliente (desde el celular o desde el panel) que confirma la fecha que
// propuso el cliente: se aplica la regla de promesa con esa fecha.
async function aplicarPromesaConfirmada(supabase, userId, conversacion, mensajeTexto, fechaMensaje) {
  if (!conversacion || !conversacion.cliente_id || !mensajeTexto) return;
  const fechaRef = fechaParaReglas(fechaMensaje);
  if (!fechaRef) return;

  const hasta = fechaMensaje ? new Date(fechaMensaje) : new Date();
  const desde = new Date(hasta.getTime() - VENTANA_CONFIRMACION_MS);
  const { data: entrantes } = await supabase.from('mensajes').select('texto, creado_at')
    .eq('conversacion_id', conversacion.id).eq('direccion', 'entrante')
    .gte('creado_at', desde.toISOString()).lte('creado_at', hasta.toISOString())
    .order('creado_at', { ascending: false }).limit(10);
  const lista = (entrantes || []).filter(m => m.texto).map(m => ({ texto: m.texto, fecha: fechaParaReglas(m.creado_at) }));
  if (!lista.length) return;

  const fecha = promesaConfirmada(mensajeTexto, fechaRef, lista);
  if (!fecha) return;

  const { data: reglas } = await supabase.from('reglas').select('*').eq('user_id', userId).eq('activa', true)
    .order('prioridad', { ascending: true });
  const regla = (reglas || []).find(r => r.accion && r.accion.detecta_fecha);
  if (!regla) return; // el cobrador apagó la regla de promesas

  const { cliente, etapaActual } = await clienteYEtapa(supabase, conversacion.cliente_id);
  if (!cliente || cliente.promesa_fecha === fecha) return; // ya estaba cargada
  logger.info({ cliente: cliente.id, fecha }, 'Promesa confirmada en un mensaje nuestro');
  await aplicarResultado(supabase, userId, cliente, etapaActual, regla, fecha, mensajeTexto, { confirmada: true });
}

async function aplicarResultado(supabase, userId, cliente, etapaActual, regla, fechaDetectada, mensajeTexto, extraDetalle) {
  const accion = regla.accion || {};
  const cambios = {};

  // Reglas de convivencia con el trabajo manual (sección 6 del plan): las
  // reglas solo AVANZAN tarjetas según el orden de las columnas, nunca las
  // devuelven hacia atrás, y nada saca a un cliente de "Cerrado (Cobrado)"
  // ni de "Refinanciado" (ahí solo se agregan etiquetas).
  const etapaBloqueada = etapaActual && ['cerrado', 'refinanciado'].includes(etapaActual.clave);
  if (accion.mueve_a && !etapaBloqueada) {
    const { data: etapaDestino } = await supabase
      .from('etapas').select('id, orden').eq('user_id', userId).eq('clave', accion.mueve_a).maybeSingle();
    const avanza = !etapaActual || etapaActual.orden == null || etapaDestino?.orden == null || etapaDestino.orden > etapaActual.orden;
    if (etapaDestino && avanza) cambios.etapa_id = etapaDestino.id;
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
    detalle: { regla: regla.nombre, accion, fecha_detectada: fechaDetectada, ...(extraDetalle || {}) },
  });
}

module.exports = { aplicarReglas, aplicarPromesaConfirmada, fechaParaReglas };
