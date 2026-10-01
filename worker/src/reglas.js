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
  const texto = normalizar(textoOriginal);
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
    let d = new Date(Date.UTC(hoy.getUTCFullYear(), mes, dia));
    if (d < hoy) d = new Date(Date.UTC(hoy.getUTCFullYear() + 1, mes, dia));
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

// reglas: filas de la tabla `reglas` (ya ordenadas por prioridad asc).
// contexto: { texto, tieneAdjunto, tipoAdjunto: 'imagen'|'pdf'|null, etapaActualClave }
function clasificarMensaje(reglas, contexto) {
  const texto = normalizar(contexto.texto || '');
  for (const regla of reglas) {
    if (!regla.activa) continue;

    const accion = regla.accion || {};
    const palabras = regla.palabras || [];
    const matchPalabra = palabras.some(p => texto.includes(normalizar(p)));
    const matchAdjunto = !!regla.tipo_adjunto && !!contexto.tieneAdjunto
      && (regla.tipo_adjunto === 'imagen_o_pdf' || regla.tipo_adjunto === contexto.tipoAdjunto);

    // Regla con adjunto Y palabras clave (ej. "Comprobante": "imagen o PDF
    // recibido, transferí, comprobante, ya pagué" — sección 6 del plan):
    // alcanza con cualquiera de las dos. Antes se exigían las dos juntas, y
    // la foto del comprobante sola (sin texto, lo más común) no entraba y
    // terminaba cayendo en "Respondió".
    if (regla.tipo_adjunto && palabras.length) {
      if (!matchAdjunto && !matchPalabra) continue;
      const fechaDetectada = accion.detecta_fecha ? detectarFecha(contexto.texto, new Date()) : null;
      return { regla, fechaDetectada };
    }
    // Solo adjunto: tiene que venir el adjunto.
    if (regla.tipo_adjunto && !matchAdjunto) continue;

    // Regla catch-all ("Respondió"): sin palabras clave, solo aplica si el
    // chat está en la etapa de la que se supone que tiene que salir.
    if (palabras.length === 0 && !regla.tipo_adjunto) {
      if (accion.mueve_de && accion.mueve_de !== contexto.etapaActualClave) continue;
      return { regla, fechaDetectada: null };
    }

    if (!matchPalabra && !regla.tipo_adjunto) continue;

    const fechaDetectada = accion.detecta_fecha ? detectarFecha(contexto.texto, new Date()) : null;
    return { regla, fechaDetectada };
  }
  return null;
}

// Dual CommonJS (worker) / navegador (pantalla de Conexión, "Probar reglas"
// de la sección 5.4): mismo archivo, un solo lugar donde corregir esta
// lógica si cambia.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { clasificarMensaje, detectarFecha, normalizar };
}
if (typeof window !== 'undefined') {
  window.clasificarMensaje = clasificarMensaje;
  window.detectarFecha = detectarFecha;
  window.normalizar = normalizar;
}
