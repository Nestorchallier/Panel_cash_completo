// Recálculo diario de la mora (cuotas vencidas, días de atraso, importe en
// atraso, próximo vencimiento, saldo) de todos los préstamos.
//
// Por qué existe: los Excel se suben una vez por mes, pero una cuota pasa a
// estar vencida el día siguiente a su vencimiento — sin esto el Kanban, la
// Bandeja y la Ficha mostrarían el atraso "congelado" en la fecha de la
// última importación. El usuario: "si yo los días 1ro te paso los archivos,
// solo el sistema día a día debe actualizar todo".
//
// Usa exactamente la misma cuenta que el panel (js/mora.js, mismo patrón
// que telefonos.js): la fuente de verdad son las filas de `cuotas` con lo
// pagado de cada una; acá solo se vuelve a mirar la fecha de hoy y se
// guarda lo que cambió.

const pino = require('pino');
const M = require('../../js/mora.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Mientras no exista esta fila en kv_store NO se recalcula nada: hoy las
// cuotas de la base están mal (un bug de la importación marcó casi todas
// como 'pagada') y recalcular sobre eso marcaría ~280 préstamos como
// cancelados. El script de reparación de cuotas deja esta fila al terminar.
const CLAVE_REPARACION = 'reparacion_cuotas_v1';
const INTERVALO_MS = 30 * 60 * 1000;
const PAGINA = 1000;
// De a cuántos préstamos se piden sus cuotas (con 1000 ids juntos la URL
// del pedido queda demasiado larga).
const TANDA_CUOTAS = 100;

let ultimoAvisoPausa = null;

const CAMPOS_PRESTAMO =['cuotas_pagas', 'cuotas_vencidas', 'dias_atraso', 'importe_atraso', 'proximo_vencimiento', 'saldo_total', 'estado'];

async function reparacionHecha(supabase, userId) {
  const { data, error } = await supabase.from('kv_store').select('key')
    .eq('user_id', userId).eq('key', CLAVE_REPARACION).maybeSingle();
  if (error) throw error;
  return !!data;
}

// Supabase devuelve como máximo 1000 filas por pedido: se pide de a páginas
// hasta que viene una incompleta.
async function traerTodo(armarConsulta) {
  const filas = [];
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await armarConsulta().range(desde, desde + PAGINA - 1);
    if (error) throw error;
    filas.push(...(data || []));
    if (!data || data.length < PAGINA) break;
  }
  return filas;
}

// Los numeric de Postgres pueden venir como número o como texto según el
// caso; se comparan como números para no "cambiar" 1500 por "1500".
function mismoValor(campo, antes, despues) {
  if (antes === null || antes === undefined) return despues === null || despues === undefined;
  if (despues === null || despues === undefined) return false;
  if (campo === 'proximo_vencimiento' || campo === 'estado') return String(antes).slice(0, 10) === String(despues).slice(0, 10);
  return Number(antes) === Number(despues);
}

// Qué habría que guardar para un préstamo: { prestamo: {campos cambiados},
// cuotas: [{id, estado}] }. Exportada aparte para poder probarla sin base.
function cambiosDePrestamo(prestamo, cuotas, hoy) {
  const mora = M.calcularMora(cuotas, hoy);
  if (!mora) return null; // sin cuotas no hay de dónde recalcular: no se toca
  const nuevo = {
    cuotas_pagas: mora.cuotas_pagas,
    cuotas_vencidas: mora.cuotas_vencidas,
    dias_atraso: mora.dias_atraso,
    importe_atraso: mora.importe_atraso,
    proximo_vencimiento: mora.proximo_vencimiento,
    saldo_total: mora.saldo_total,
    estado: mora.cancelado ? 'cancelado' : 'activo',
  };
  const cambiosPrestamo = {};
  for (const campo of CAMPOS_PRESTAMO) {
    if (!mismoValor(campo, prestamo[campo], nuevo[campo])) cambiosPrestamo[campo] = nuevo[campo];
  }
  const porId = new Map(cuotas.map(c => [c.id, c]));
  const cambiosCuotas = mora.cuotas
    .filter(c => porId.get(c.id) && porId.get(c.id).estado !== c.estado)
    .map(c => ({ id: c.id, estado: c.estado }));
  return { prestamo: cambiosPrestamo, cuotas: cambiosCuotas, mora };
}

// Recorre los préstamos del usuario y guarda lo que cambió. Devuelve
// { prestamos, conCambios, cuotasCambiadas } o null si no corrió (falta la
// reparación). opciones.simular: no escribe nada (para probar contra la
// base real); opciones.ignorarGuardia solo se acepta junto con simular.
async function recalcularMora(supabase, userId, opciones = {}) {
  const { hoy = M.hoyISO(), simular = false, ignorarGuardia = false, log = logger } = opciones;

  if (!(simular && ignorarGuardia) && !(await reparacionHecha(supabase, userId))) {
    // Se revisa cada 30 minutos: el aviso sale una vez por día, no 48.
    if (ultimoAvisoPausa === hoy) return null;
    ultimoAvisoPausa = hoy;
    log.warn(`Recálculo de mora en pausa: falta la marca "${CLAVE_REPARACION}" en kv_store (primero hay que correr la reparación de cuotas).`);
    return null;
  }

  // Los refinanciados quedan como están: su deuda pasó a otro préstamo y
  // recalcularlos los volvería a poner 'activo' con atraso.
  const prestamos = await traerTodo(() => supabase.from('prestamos')
    .select('id, nro, estado, ' + CAMPOS_PRESTAMO.filter(c => c !== 'estado').join(', '))
    .eq('user_id', userId).neq('estado', 'refinanciado').order('id', { ascending: true }));

  let procesados = 0, conCambios = 0, cuotasCambiadas = 0, errores = 0;
  const detalle = [];

  for (let i = 0; i < prestamos.length; i += TANDA_CUOTAS) {
    const tanda = prestamos.slice(i, i + TANDA_CUOTAS);
    const cuotas = await traerTodo(() => supabase.from('cuotas')
      .select('id, prestamo_id, numero, vencimiento, monto, monto_pagado, estado')
      .in('prestamo_id', tanda.map(p => p.id))
      .order('prestamo_id', { ascending: true }).order('numero', { ascending: true }));
    const cuotasPorPrestamo = new Map();
    cuotas.forEach(c => {
      if (!cuotasPorPrestamo.has(c.prestamo_id)) cuotasPorPrestamo.set(c.prestamo_id, []);
      cuotasPorPrestamo.get(c.prestamo_id).push(c);
    });

    // Cuotas a cambiar de toda la tanda, agrupadas por estado nuevo: un
    // pedido por estado en vez de uno por cuota.
    const cuotasPorEstado = {};
    for (const p of tanda) {
      const filas = cuotasPorPrestamo.get(p.id);
      if (!filas || !filas.length) continue;
      const cambios = cambiosDePrestamo(p, filas, hoy);
      if (!cambios) continue;
      procesados++;
      const hayCambioPrestamo = Object.keys(cambios.prestamo).length > 0;
      if (!hayCambioPrestamo && !cambios.cuotas.length) continue;
      conCambios++;
      cuotasCambiadas += cambios.cuotas.length;
      cambios.cuotas.forEach(c => { (cuotasPorEstado[c.estado] = cuotasPorEstado[c.estado] || []).push(c.id); });
      if (simular) {
        detalle.push({ nro: p.nro, antes: Object.fromEntries(Object.keys(cambios.prestamo).map(k => [k, p[k]])), despues: cambios.prestamo, cuotas: cambios.cuotas.length });
        continue;
      }
      if (hayCambioPrestamo) {
        const { error } = await supabase.from('prestamos').update(cambios.prestamo).eq('id', p.id).neq('estado', 'refinanciado');
        if (error) { errores++; log.error({ err: error, nro: p.nro }, 'No se pudo actualizar la mora de un préstamo'); }
      }
    }
    if (!simular) {
      for (const [estado, ids] of Object.entries(cuotasPorEstado)) {
        const { error } = await supabase.from('cuotas').update({ estado }).in('id', ids);
        if (error) { errores++; log.error({ err: error, estado, cantidad: ids.length }, 'No se pudo actualizar el estado de las cuotas'); }
      }
    }
  }

  log.info({ hoy, cuotasCambiadas, errores, simulacion: simular || undefined }, `Mora recalculada: ${procesados} préstamos, ${conCambios} con cambios`);
  if (errores) throw new Error(`Recálculo de mora con ${errores} errores`);
  return { prestamos: procesados, conCambios, cuotasCambiadas, detalle };
}

// Corre al arrancar y después cada 30 minutos, pero solo trabaja si cambió
// el día desde la última vez que salió bien (o si todavía no salió bien
// nunca: así, apenas aparezca la marca de la reparación, arranca solo sin
// reiniciar el worker).
function iniciarMoraDiaria({ supabase, userId }) {
  let ultimoDiaOk = null;
  let corriendo = false;

  const revisar = async () => {
    const hoy = M.hoyISO();
    if (corriendo || ultimoDiaOk === hoy) return;
    corriendo = true;
    try {
      const resultado = await recalcularMora(supabase, userId, { hoy });
      if (resultado) ultimoDiaOk = hoy;
    } catch (e) {
      logger.error({ err: e }, 'Error recalculando la mora (se reintenta en 30 minutos)');
    } finally {
      corriendo = false;
    }
  };

  revisar();
  setInterval(revisar, INTERVALO_MS);
}

module.exports = { iniciarMoraDiaria, recalcularMora, cambiosDePrestamo, CLAVE_REPARACION };
