// Motor de clasificación automática (sección 6 del plan). Recorre las
// reglas del cobrador en orden de prioridad y devuelve la primera que
// coincide con el mensaje entrante. Si ninguna coincide, el chat queda
// marcado como no leído y nada más — lo normal para la mayoría de los
// mensajes de cobranza del día a día.

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // saca tildes
    .replace(/(.)\1{2,}/g, '$1$1'); // "mananaaaa" -> "manaana" (corta repeticiones largas)
}

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

function addDias(base, n) {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}
function toISO(d) { return d.toISOString().slice(0, 10); }
function ultimoDiaHabilDelMes(base) {
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

// Intenta sacar una fecha de una promesa de pago en texto libre, con "hoy"
// (ahora, momento del mensaje) como referencia. Ver tabla de ejemplos de la
// sección 6 del plan — esto cubre los mismos casos.
function detectarFecha(textoOriginal, ahora = new Date()) {
  // "el día 10" / "el dia 10/5" -> "el 10" / "el 10/5"
  const texto = normalizar(textoOriginal).replace(/\bel\s+dia\s+(?=\d)/g, 'el ');
  const hoy = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate()));

  if (/\bhoy\b/.test(texto)) return toISO(hoy);
  if (/pasado\s*manana/.test(texto)) return toISO(addDias(hoy, 2));
  if (/\bmanana\b/.test(texto)) return toISO(addDias(hoy, 1));

  // "el viernes", "el lunes que viene"...
  for (let i = 0; i < DIAS_SEMANA.length; i++) {
    const re = new RegExp(`\\bel\\s+${DIAS_SEMANA[i]}\\b`);
    if (re.test(texto)) {
      let diff = (i - hoy.getUTCDay() + 7) % 7;
      if (diff === 0) diff = 7; // "el viernes" dicho un viernes = el que viene
      return toISO(addDias(hoy, diff));
    }
  }

  // "el 10", "el 10/5"
  let m = /\bel\s+(\d{1,2})\/(\d{1,2})\b/.exec(texto);
  if (m) {
    const dia = parseInt(m[1], 10), mes = parseInt(m[2], 10) - 1;
    // "el 13/14" es "el 13 o el 14", no una fecha: el mes tiene que existir.
    if (mes < 0 || mes > 11 || dia < 1 || dia > 31) return null;
    let d = new Date(Date.UTC(hoy.getUTCFullYear(), mes, dia));
    // Una fecha con mes que ya pasó hace poco ("pago el 05/9" escrito el
    // 24/9) es de este año, no del que viene: queda como promesa vencida.
    if (d < addDias(hoy, -180)) d = new Date(Date.UTC(hoy.getUTCFullYear() + 1, mes, dia));
    return toISO(d);
  }
  m = /\bel\s+(\d{1,2})\b(?!\/)/.exec(texto);
  if (m) {
    const dia = parseInt(m[1], 10);
    let d = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), dia));
    if (d < hoy) d = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() + 1, dia));
    return toISO(d);
  }

  if (/fin\s*de\s*mes/.test(texto)) return toISO(ultimoDiaHabilDelMes(hoy));
  if (/cuando\s*cobro/.test(texto)) {
    // Día 5 del mes siguiente, configurable — ver sección 6 del plan.
    const d = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() + 1, 5));
    return toISO(d);
  }

  return null; // sin fecha clara: la promesa queda sin fecha, el cobrador la completa
}

// Texto (ya normalizado) que anuncia un pago que todavía no se hizo.
function hablaEnFuturo(texto) {
  // "ya pagué", "te transferí", "ahí pagué": pasado, sí es comprobante.
  if (/\b(ya|ahi|recien|hoy) (te )?(pague|transferi|deposite|abone|pase)\b|\b(transferi|deposite|abone)\b/.test(texto)) return false;
  return /\b(voy a|vamos a|va a|iba a|pienso|quiero|puedo|podria|cuando|apenas|si puedo|ni bien|despues|te aviso|el dia|manana|pasado|la semana|el (lunes|martes|miercoles|jueves|viernes|sabado|domingo)|no pude|no puedo|todavia no|aun no)\b|transferire|pagare|depositare|abonare|transfiera|pagaria/.test(texto);
}

// Palabra o frase clave como palabra entera: "saldo" no tiene que saltar
// con "saldos" escrito dentro de otra palabra, ni "acoso" dentro de
// "acosomado". Antes se buscaba como pedazo de texto y una regla (la de
// reclamo, sobre todo) saltaba con mensajes que no la decían.
function contienePalabra(texto, palabra) {
  const p = normalizar(palabra).trim();
  if (!p) return false;
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|[^a-z0-9])${esc}(?=$|[^a-z0-9])`).test(texto);
}

// Mensaje que anuncia un pago a futuro aunque no use las palabras de la
// regla: "te puedo transferir el 5", "el lunes te deposito", "voy a pagar
// el viernes", "mañana te abono". Hace falta un verbo de pago y una fecha:
// sin fecha había demasiadas consultas y quejas tomadas como promesa. Lo que está en pasado ("ya te transferí")
// es un comprobante, no una promesa.
function anunciaPago(texto, fechaDetectada) {
  const verboPago = /\b(pag(o|ar|arte|arle|arles|aria|are|amos)|transf(iero|erir|erirte|erirle|erirles|eriria|erire|iera)|deposit(o|ar|arte|arle|arles|aria|are)|abon(o|ar|arte|arle|arles|aria|are)|cancel(o|ar|aria|are)|te (mando|paso|giro) (la plata|el dinero|la guita)|regulariz(o|ar))\b/;
  if (!verboPago.test(texto)) return false;
  // "si pago, ¿cuánto puedo sacar?" es una pregunta, no una promesa; y lo
  // que habla del comprobante es para la regla de comprobantes.
  if (/\bsi (te |les )?(pago|transfiero|deposito|abono|cancelo)\b|comprobante/.test(texto)) return false;
  // "no pude juntar la plata para el pago", "no puedo pagar": lo contrario.
  if (/\bno (pude|puedo|voy a poder|tengo|llego|me pagaron|me depositaron)\b/.test(texto)) return false;
  if (/\b(ya|ahi|recien) (te )?(pague|transferi|deposite|abone|pase|cancele)\b|\b(transferi|deposite|abone|cancele)\b/.test(texto)) return false;
  return !!fechaDetectada;
}

// Un mensaje NUESTRO que confirma la fecha que propuso el cliente: el
// cliente escribe "puedo transferirles el 5?" y contestamos "sisi el 5 si".
// Devuelve la fecha de la promesa si el saliente nombra una fecha y algún
// entrante reciente del cliente anuncia un pago para ese mismo día (o sin
// día, ej. "te pago la semana que viene" + "dale, el lunes").
// entrantes: [{ texto, fecha }] de las últimas horas, del más nuevo al más viejo.
function promesaConfirmada(textoSaliente, fechaSaliente, entrantes) {
  const fecha = detectarFecha(textoSaliente, fechaSaliente ? new Date(fechaSaliente) : new Date());
  if (!fecha) return null;
  for (const m of entrantes || []) {
    const texto = normalizar(m.texto || '');
    const suya = detectarFecha(m.texto || '', m.fecha ? new Date(m.fecha) : new Date());
    if ((suya === fecha || !suya) && anunciaPago(texto, suya || fecha)) return fecha;
  }
  return null;
}

// hora: ISO del momento real del mensaje. Argentina es UTC-3 todo el año.
function fueraDeHorario(hora, desde, hasta) {
  const d = hora ? new Date(hora) : null;
  if (!d || Number.isNaN(d.getTime())) return false;
  const local = new Date(d.getTime() - 3 * 3600000);
  const min = local.getUTCHours() * 60 + local.getUTCMinutes();
  const aMin = t => { const [h, m] = String(t).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const dia = local.getUTCDay();
  if (dia === 0) return true; // domingo
  return min < aMin(desde) || min >= aMin(hasta);
}

// reglas: filas de la tabla `reglas` (ya ordenadas por prioridad asc).
// contexto: { texto, tieneAdjunto, tipoAdjunto: 'imagen'|'pdf'|null, etapaActualClave, fecha?, hora? }
// hora (opcional): ISO real del mensaje, para "Fuera de horario".
// fecha (opcional): cuándo se mandó el mensaje. Las fechas de promesa
// ("mañana", "el viernes") se calculan desde ese día — importa al releer
// mensajes viejos del historial; si no viene, se usa hoy.
function clasificarMensaje(reglas, contexto) {
  const fechaMensaje = contexto.fecha ? new Date(contexto.fecha) : new Date();
  const texto = normalizar(contexto.texto || '');
  for (const regla of reglas) {
    if (!regla.activa) continue;

    const accion = regla.accion || {};
    const palabras = regla.palabras || [];
    const matchPalabra = palabras.some(p => contienePalabra(texto, p));
    const matchAdjunto = !!regla.tipo_adjunto && !!contexto.tieneAdjunto
      && (regla.tipo_adjunto === 'imagen_o_pdf' || regla.tipo_adjunto === contexto.tipoAdjunto);

    // Regla con adjunto Y palabras clave (ej. "Comprobante": "imagen o PDF
    // recibido, transferí, comprobante, ya pagué" — sección 6 del plan):
    // alcanza con cualquiera de las dos. Antes se exigían las dos juntas, y
    // la foto del comprobante sola (sin texto, lo más común) no entraba y
    // terminaba cayendo en "Respondió".
    if (regla.tipo_adjunto && palabras.length) {
      if (!matchAdjunto && !matchPalabra) continue;
      // Sin foto/PDF y hablando en futuro ("voy a transferir el 10",
      // "cuando transfiera te mando el comprobante") no es un comprobante:
      // es una promesa, que la tome la regla siguiente.
      if (!matchAdjunto && hablaEnFuturo(texto)) continue;
      const fechaDetectada = accion.detecta_fecha ? detectarFecha(contexto.texto, fechaMensaje) : null;
      return { regla, fechaDetectada };
    }
    // Solo adjunto: tiene que venir el adjunto.
    if (regla.tipo_adjunto && !matchAdjunto) continue;

    // "Fuera de horario": solo para mensajes escritos fuera del horario
    // (hora de Argentina). Antes no se miraba la hora y saltaba con todo
    // mensaje que no tomara otra regla. Sin la hora del mensaje no aplica.
    if (accion.horario_desde || accion.horario_hasta) {
      if (!fueraDeHorario(contexto.hora, accion.horario_desde || '00:00', accion.horario_hasta || '23:59')) continue;
      return { regla, fechaDetectada: null };
    }

    // Regla catch-all ("Respondió"): sin palabras clave, solo aplica si el
    // chat está en la etapa de la que se supone que tiene que salir.
    if (palabras.length === 0 && !regla.tipo_adjunto) {
      if (accion.mueve_de && accion.mueve_de !== contexto.etapaActualClave) continue;
      return { regla, fechaDetectada: null };
    }

    const fechaDetectada = accion.detecta_fecha ? detectarFecha(contexto.texto, fechaMensaje) : null;
    // La regla de promesa también toma los anuncios de pago con fecha o en
    // futuro, aunque no usen ninguna de sus palabras ("te puedo transferir
    // el 5" no decía "te pago" ni "el 10" y quedaba sin tomar).
    if (!matchPalabra && !regla.tipo_adjunto && !(accion.detecta_fecha && anunciaPago(texto, fechaDetectada))) continue;

    return { regla, fechaDetectada };
  }
  return null;
}

// Dual CommonJS (worker) / navegador (pantalla de Conexión, "Probar reglas"
// de la sección 5.4): mismo archivo, un solo lugar donde corregir esta
// lógica si cambia.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { clasificarMensaje, detectarFecha, normalizar, contienePalabra, anunciaPago, promesaConfirmada };
}
if (typeof window !== 'undefined') {
  window.clasificarMensaje = clasificarMensaje;
  window.detectarFecha = detectarFecha;
  window.normalizar = normalizar;
}
