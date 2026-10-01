// Importador de cartera completa (Fase 1): junta los dos Excel que exporta
// el CRM actual —
//   1) "Préstamos" (un renglón por préstamo, trae capital/cuotas/saldos)
//   2) "Hoja de Ruta" (un renglón por gestión del día, trae días/importe de
//      atraso más al día)
// — y los mergea en las tablas clientes / clientes_telefonos / prestamos /
// cuotas. El cruce es por DNI para el cliente y por Nro. de préstamo (Nro.
// Préstamo en el primer archivo, ID en el segundo) para cada préstamo, así
// que importar el mismo Excel dos veces actualiza en vez de duplicar.
//
// No toca etapa_id/notas/promesa_fecha/campos_extra de un cliente que ya
// existía: eso es estado del Kanban que gestiona el cobrador a mano, el
// importador no lo debe pisar. Solo arma la ficha (datos personales,
// teléfonos) y el historial de préstamos.

function _toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function _toInt(v) {
  const n = _toNum(v);
  return n === null ? null : Math.round(n);
}

function _toDateISO(v) {
  if (!v) return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  // yyyy-mm-dd ya viene listo (dateNF del parser).
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // dd/mm/yyyy
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

function _addMonthsISO(iso, n) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, d));
  return dt.toISOString().slice(0, 10);
}

function _leerExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        resolve(XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true }));
      } catch (err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

// El Excel de "Préstamos" trae el CUIL en la columna "Nro. Doc." (11 dígitos:
// 2 de prefijo + 8 del DNI + 1 verificador), mientras que "Hoja de Ruta" trae
// el DNI "pelado" (7-8 dígitos) en su columna DNI. Si no se homologan los dos
// quedan como personas distintas y no cruza nada (se probó con los Excel
// reales: 0 matches directos, 333/333 matches al sacar los 8 del medio del
// CUIL) — por eso toda la cadena pasa por esta función antes de usarse como
// clave de cliente.
function _dniLimpio(v) {
  const d = String(v || '').replace(/\D/g, '').trim();
  if (d.length === 11) return d.slice(2, 10); // CUIL -> DNI
  return d;
}

// La columna "Cel" de Hoja de Ruta suele traer dos números en la misma
// celda separados por "/" (ej. "5491130186053/+5491125485658", casi
// siempre el mismo número repetido con y sin el "+"). Se separan todos los
// candidatos antes de normalizar, para no perder el número por quedar
// pegado a otro y superar el largo válido.
function _telefonosDeFila(valores) {
  const out = [];
  const vistos = new Set();
  valores.forEach(({ v, etiqueta }) => {
    if (!v) return;
    String(v).split(/[\/;,]| o /i).forEach(parte => {
      const norm = window.normalizarTelefonoAR && window.normalizarTelefonoAR(parte);
      if (norm && !vistos.has(norm)) { vistos.add(norm); out.push({ telefono: norm, etiqueta }); }
    });
  });
  return out;
}

async function _parsearPrestamos(file) {
  const filas = await _leerExcel(file);
  return filas.map(r => ({
    dni: _dniLimpio(r['Nro. Doc.']),
    cuil: String(r['Nro. Doc.'] || '').replace(/\D/g, ''),
    nombre: String(r['Apellido y nombre'] || '').trim(),
    domicilio: String(r['Dirección'] || '').trim(),
    localidad: String(r['Localidad'] || '').trim(),
    empleador: String(r['Empleador'] || '').trim(),
    email: String(r['e-mail'] || '').trim().toLowerCase(),
    segmento: String(r['Segmento'] || '').trim(),
    cobrador: String(r['Cobrador'] || '').trim(),
    telefonos: _telefonosDeFila([
      { v: r['Celular'], etiqueta: 'Celular' },
      { v: r['Tel.'], etiqueta: 'Celular' },
      { v: r['Tel. Lab.'], etiqueta: 'Laboral' },
    ]),
    nro: String(r['Nro. Préstamo'] || r['Nro.'] || '').trim(),
    monto: _toNum(r['Capital']),
    cantCuotas: _toInt(r['Cuotas']),
    cuotaMonto: _toNum(r['Cuota prom.']),
    fechaAlta: _toDateISO(r['Alta']),
    primerVencimiento: _toDateISO(r['Primer vto.']),
    proximoVencimiento: _toDateISO(r['Próx. vto.']),
    fechaVencimientoFinal: _toDateISO(r['Vto']),
    cuotasPagas: _toInt(r['Pagas']) || 0,
    cuotasVencidas: _toInt(r['Vencidas']) || 0,
    ultimoPago: _toDateISO(r['Ult. Pago']),
    saldoCapital: _toNum(r['Saldo K']),
    saldoTotal: _toNum(r['Saldo Total']),
    saldoTotalPunitorios: _toNum(r['Saldo Total con pun.']),
    diasAtraso: _toInt(r['Días atraso']) || 0,
  })).filter(r => r.nro);
}

async function _parsearHojaRuta(file) {
  const filas = await _leerExcel(file);
  return filas.map(r => {
    const plan = String(r['Plan'] || '');
    const planMatch = /^(\d+)x([\d.,]+)/.exec(plan);
    return {
      dni: _dniLimpio(r['DNI']),
      nombre: String(r['Cliente'] || '').trim(),
      domicilio: String(r['Dirección'] || '').trim(),
      localidad: String(r['Localidad'] || '').trim(),
      segmento: String(r['Segmento'] || '').trim(),
      email: String(r['Correo'] || '').trim().toLowerCase(),
      telefonos: _telefonosDeFila([{ v: r['Cel'], etiqueta: 'Celular' }]),
      nro: String(r['ID'] || '').trim(),
      montoTotal: _toNum(r['Monto']),
      cantCuotasPlan: planMatch ? parseInt(planMatch[1], 10) : null,
      cuotaMontoPlan: planMatch ? _toNum(planMatch[2]) : null,
      cuotasPagas: _toInt(r['Pagas']) || 0,
      cuotasAtrasadas: _toInt(r['Atrasadas']) || 0,
      importeAtraso: _toNum(r['ImporteAtraso']) || 0,
      ultimoPago: _toDateISO(r['UltPago']),
      fechaGestion: _toDateISO(r['FechaGestion']),
      novedad: String(r['Novedad'] || '').trim(),
    };
  }).filter(r => r.nro);
}

// file1 = Excel "Préstamos" (universo completo de préstamos vigentes)
// file2 = Excel "Hoja de Ruta" (opcional: datos de atraso más al día)
async function importarCarteraDualExcel(file1, file2, onProgress) {
  const progreso = onProgress || (() => {});
  progreso('Leyendo Excel...');
  const prestamosFile1 = await _parsearPrestamos(file1);
  const hojaRutaFile2 = file2 ? await _parsearHojaRuta(file2) : [];
  const hojaRutaPorNro = new Map(hojaRutaFile2.map(r => [r.nro, r]));
  const hojaRutaPorDni = new Map();
  hojaRutaFile2.forEach(r => { if (r.dni && !hojaRutaPorDni.has(r.dni)) hojaRutaPorDni.set(r.dni, r); });

  // --- Arma un cliente por DNI, juntando lo que haya en cualquiera de los dos archivos ---
  const clientesPorDni = new Map();
  function upsertClienteDraft(dni, datos) {
    if (!dni) return null;
    let c = clientesPorDni.get(dni);
    if (!c) { c = { dni, telefonos: [] }; clientesPorDni.set(dni, c); }
    Object.keys(datos).forEach(k => {
      if (k === 'telefonos') { c.telefonos.push(...datos.telefonos); return; }
      if (datos[k] && !c[k]) c[k] = datos[k];
    });
    return c;
  }
  prestamosFile1.forEach(p => upsertClienteDraft(p.dni, {
    nombre: p.nombre, cuil: p.cuil, domicilio: p.domicilio, localidad: p.localidad,
    empleador: p.empleador, email: p.email, segmento: p.segmento,
    cobrador: p.cobrador, telefonos: p.telefonos,
  }));
  hojaRutaFile2.forEach(h => upsertClienteDraft(h.dni, {
    nombre: h.nombre, domicilio: h.domicilio, localidad: h.localidad,
    email: h.email, segmento: h.segmento, telefonos: h.telefonos,
  }));

  // --- Arma un préstamo por nro, con file1 como base (tiene el detalle
  //     completo) y file2 pisando solo los campos de atraso cuando matchea ---
  const prestamosPorNro = new Map();
  prestamosFile1.forEach(p => {
    const hr = hojaRutaPorNro.get(p.nro);
    prestamosPorNro.set(p.nro, {
      dni: p.dni, nro: p.nro,
      monto: p.monto, cantCuotas: p.cantCuotas, cuotaMonto: p.cuotaMonto,
      fechaAlta: p.fechaAlta, primerVencimiento: p.primerVencimiento,
      proximoVencimiento: p.proximoVencimiento, fechaVencimientoFinal: p.fechaVencimientoFinal,
      cuotasPagas: hr ? Math.max(p.cuotasPagas, hr.cuotasPagas) : p.cuotasPagas,
      cuotasVencidas: hr ? hr.cuotasAtrasadas : p.cuotasVencidas,
      ultimoPago: (hr && hr.ultimoPago) || p.ultimoPago,
      saldoCapital: p.saldoCapital, saldoTotal: p.saldoTotal,
      saldoTotalPunitorios: p.saldoTotalPunitorios,
      diasAtraso: p.diasAtraso,
      importeAtraso: (hr && hr.importeAtraso) || 0,
      origen: p.cobrador,
    });
  });
  // Préstamos que solo aparecen en la Hoja de Ruta (no deberían ser muchos,
  // pero por si la cartera no coincide 100% entre los dos archivos).
  hojaRutaFile2.forEach(h => {
    if (prestamosPorNro.has(h.nro)) return;
    prestamosPorNro.set(h.nro, {
      dni: h.dni, nro: h.nro,
      monto: h.montoTotal, cantCuotas: h.cantCuotasPlan, cuotaMonto: h.cuotaMontoPlan,
      fechaAlta: null, primerVencimiento: null, proximoVencimiento: null, fechaVencimientoFinal: null,
      cuotasPagas: h.cuotasPagas, cuotasVencidas: h.cuotasAtrasadas,
      ultimoPago: h.ultimoPago, saldoCapital: null, saldoTotal: null, saldoTotalPunitorios: null,
      diasAtraso: null, importeAtraso: h.importeAtraso, origen: null,
    });
  });

  const { data: { session } } = await window.sb.auth.getSession();
  if (!session) throw new Error('No autenticado');
  const uid = session.user.id;

  progreso('Buscando clientes existentes...');
  const { data: etapas } = await window.sb.from('etapas').select('id, clave').eq('user_id', uid);
  const etapaInicialId = (etapas || []).find(e => e.clave === 'a_contactar')?.id || null;
  const { data: existentes } = await window.sb.from('clientes').select('id, dni').eq('user_id', uid).not('dni', 'is', null);
  const idPorDni = new Map((existentes || []).map(c => [c.dni, c.id]));

  let nuevos = 0, actualizados = 0;
  const dnis = Array.from(clientesPorDni.keys());
  const filasNuevas = [];
  const filasActualizar = [];
  dnis.forEach(dni => {
    const c = clientesPorDni.get(dni);
    const base = {
      nombre: c.nombre || '(sin nombre)',
      dni,
      cuil: c.cuil || null,
      domicilio: c.domicilio || null,
      localidad: c.localidad || null,
      empleador: c.empleador || null,
      email: c.email || null,
      segmento: c.segmento || null,
      cobrador_nombre: c.cobrador || null,
    };
    if (idPorDni.has(dni)) {
      filasActualizar.push({ id: idPorDni.get(dni), ...base });
      actualizados++;
    } else {
      const telPrincipal = c.telefonos[0] ? c.telefonos[0].telefono : null;
      filasNuevas.push({ user_id: uid, etapa_id: etapaInicialId, telefono_principal: telPrincipal, ...base });
      nuevos++;
    }
  });

  progreso(`Guardando ${filasNuevas.length} clientes nuevos...`);
  let clientesInsertados = [];
  if (filasNuevas.length) {
    const { data, error } = await window.sb.from('clientes').insert(filasNuevas).select('id, dni');
    if (error) throw error;
    clientesInsertados = data;
  }
  progreso(`Actualizando ${filasActualizar.length} clientes existentes...`);
  for (const fila of filasActualizar) {
    const { id, ...resto } = fila;
    const { error } = await window.sb.from('clientes').update(resto).eq('id', id);
    if (error) console.error('actualizar cliente', fila.dni, error);
  }

  clientesInsertados.forEach(c => idPorDni.set(c.dni, c.id));

  // --- Teléfonos ---
  progreso('Guardando teléfonos...');
  const filasTelefonos = [];
  dnis.forEach(dni => {
    const clienteId = idPorDni.get(dni);
    if (!clienteId) return;
    const vistos = new Set();
    clientesPorDni.get(dni).telefonos.forEach((t, i) => {
      if (vistos.has(t.telefono)) return;
      vistos.add(t.telefono);
      filasTelefonos.push({ cliente_id: clienteId, telefono: t.telefono, etiqueta: t.etiqueta, principal: i === 0 });
    });
  });
  if (filasTelefonos.length) {
    const { error } = await window.sb.from('clientes_telefonos')
      .upsert(filasTelefonos, { onConflict: 'cliente_id,telefono' });
    if (error) console.error('clientes_telefonos', error);
  }

  // --- Préstamos ---
  progreso(`Guardando ${prestamosPorNro.size} préstamos...`);
  const filasPrestamos = [];
  prestamosPorNro.forEach(p => {
    const clienteId = idPorDni.get(p.dni);
    if (!clienteId) return; // no debería pasar: todo préstamo viene de un cliente ya armado arriba
    const cancelado = p.saldoTotal !== null && p.saldoTotal <= 0;
    filasPrestamos.push({
      user_id: uid, cliente_id: clienteId, nro: p.nro,
      monto: p.monto, cant_cuotas: p.cantCuotas, cuota_monto: p.cuotaMonto,
      fecha_alta: p.fechaAlta, primer_vencimiento: p.primerVencimiento,
      proximo_vencimiento: p.proximoVencimiento, fecha_vencimiento_final: p.fechaVencimientoFinal,
      cuotas_pagas: p.cuotasPagas, cuotas_vencidas: p.cuotasVencidas, ultimo_pago: p.ultimoPago,
      saldo_capital: p.saldoCapital, saldo_total: p.saldoTotal, saldo_total_punitorios: p.saldoTotalPunitorios,
      dias_atraso: p.diasAtraso || 0, importe_atraso: p.importeAtraso || 0,
      estado: cancelado ? 'cancelado' : 'activo', origen: p.origen,
    });
  });
  let prestamosGuardados = [];
  if (filasPrestamos.length) {
    const { data, error } = await window.sb.from('prestamos')
      .upsert(filasPrestamos, { onConflict: 'user_id,nro' }).select('id, nro, cant_cuotas, cuota_monto, primer_vencimiento, cuotas_pagas, cuotas_vencidas');
    if (error) throw error;
    prestamosGuardados = data;
  }

  // --- Cuotas: se reconstruyen desde cero por préstamo (evita que una
  //     reimportación duplique o deje cuotas viejas desalineadas) ---
  progreso('Armando el plan de cuotas...');
  for (const p of prestamosGuardados) {
    if (!p.cant_cuotas || !p.primer_vencimiento) continue;
    await window.sb.from('cuotas').delete().eq('prestamo_id', p.id);
    const filas = [];
    for (let n = 1; n <= p.cant_cuotas; n++) {
      let estado = 'pendiente';
      if (n <= p.cuotas_pagas) estado = 'pagada';
      else if (n <= p.cuotas_pagas + p.cuotas_vencidas) estado = 'vencida';
      filas.push({
        prestamo_id: p.id, numero: n,
        vencimiento: _addMonthsISO(p.primer_vencimiento, n - 1),
        monto: p.cuota_monto,
        estado,
        monto_pagado: estado === 'pagada' ? p.cuota_monto : null,
      });
    }
    if (filas.length) await window.sb.from('cuotas').insert(filas);
  }

  return { clientesNuevos: nuevos, clientesActualizados: actualizados, prestamosImportados: filasPrestamos.length };
}

if (typeof window !== 'undefined') {
  window.importarCarteraDualExcel = importarCarteraDualExcel;
}
