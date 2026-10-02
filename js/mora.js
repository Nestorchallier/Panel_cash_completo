// Cálculo de cuotas, vencimientos y atraso de un préstamo — un solo lugar
// para el panel (importador, confirmar pago) y el worker (recálculo diario).
// Mismo patrón que telefonos.js: funciona como <script> en el navegador y
// con require() en Node.
//
// Fuente de verdad: las filas de `cuotas` de cada préstamo, con cuánto se
// pagó de cada una (monto_pagado). Todo lo demás (cuotas pagas/vencidas,
// días de atraso, importe en atraso, próximo vencimiento, saldo) se deriva
// de ahí + la fecha de HOY, así que se mantiene al día solo aunque los
// Excel se suban una vez por mes.
//
// Plan de vencimientos (validado con los 333 préstamos reales con fechas):
//   - cuota 1 vence el "Primer vto." del Excel;
//   - las cuotas 2..N vencen el mismo día que el vencimiento final, mes a
//     mes hacia atrás desde ese final (casi siempre el día 5). Cuando el
//     primer vto. cae a fin de mes (ej. 28/07) la cuota 2 no es el 5 de
//     agosto sino el de septiembre — anclar en el final lo resuelve solo.
//   - si no hay vencimiento final, todas el mismo día que el primer vto.
// Regla de mora: una cuota está VENCIDA si su fecha ya pasó (así sea por un
// día) y no está pagada completa. Los días de atraso se cuentan desde la
// cuota impaga más vieja.

(function (raiz) {
  const MS_DIA = 86400000;

  // 'YYYY-MM-DD' en hora local (el panel y el worker corren en Argentina).
  function hoyISO(ahora) {
    const d = ahora ? new Date(ahora) : new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function _partes(iso) {
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return { y, m, d };
  }

  // Fecha del día `dia` del mes (y, m + delta), recortando a fin de mes
  // (ej. día 31 en febrero -> 28/29).
  function _fechaMes(y, m, delta, dia) {
    const base = new Date(Date.UTC(y, m - 1 + delta, 1));
    const ultimo = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
    return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(dia, ultimo)).padStart(2, '0')}`;
  }

  function diasEntre(desdeISO, hastaISO) {
    const a = _partes(desdeISO), b = _partes(hastaISO);
    return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / MS_DIA);
  }

  // Fechas de vencimiento de las cuotas 1..cant_cuotas. [] si no hay datos.
  function planVencimientos(p) {
    const cant = Number(p && p.cant_cuotas) || 0;
    if (!cant || !p.primer_vencimiento) return [];
    const primero = String(p.primer_vencimiento).slice(0, 10);
    const pri = _partes(primero);
    const fin = p.fecha_vencimiento_final ? _partes(p.fecha_vencimiento_final) : null;
    const fechas = [primero];
    for (let n = 2; n <= cant; n++) {
      let f = fin ? _fechaMes(fin.y, fin.m, -(cant - n), fin.d) : _fechaMes(pri.y, pri.m, n - 1, pri.d);
      // Por si el Excel trae un final inconsistente: nunca antes que la anterior.
      if (f <= fechas[n - 2]) f = _fechaMes(pri.y, pri.m, n - 1, pri.d);
      fechas.push(f);
    }
    return fechas;
  }

  // "3.39" / "3,39" / 3.39 -> 3.39 (cuotas pagas con fracción, como vienen
  // en las columnas Pagas / Vencidas del Excel). Distinto de un monto en
  // pesos ("460.200"): acá el punto SIEMPRE es decimal.
  function numeroDecimal(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    const n = parseFloat(String(v).trim().replace(',', '.').replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  function estadoCuota(c, hoy) {
    const monto = Number(c.monto) || 0;
    const pagado = Number(c.monto_pagado) || 0;
    if (monto > 0 && pagado >= monto - 1) return 'pagada';
    if (c.vencimiento && String(c.vencimiento).slice(0, 10) < hoy) return 'vencida';
    return 'pendiente';
  }

  // Arma las filas de `cuotas` desde cero (importación): las primeras
  // floor(pagas) cuotas pagas completas, la siguiente con la fracción paga.
  function construirCuotas(p, pagasDecimal, hoy) {
    const fechas = planVencimientos(p);
    const monto = Number(p.cuota_monto) || 0;
    const pagas = Math.max(0, Math.min(fechas.length, Number(pagasDecimal) || 0));
    const completas = Math.floor(pagas + 1e-9);
    const fraccion = pagas - completas;
    const h = hoy || hoyISO();
    return fechas.map((vencimiento, i) => {
      const numero = i + 1;
      let monto_pagado = 0;
      if (numero <= completas) monto_pagado = monto;
      else if (numero === completas + 1 && fraccion > 0.005) monto_pagado = Math.round(monto * fraccion);
      const fila = { numero, vencimiento, monto, monto_pagado, pagado_el: null };
      fila.estado = estadoCuota(fila, h);
      return fila;
    });
  }

  // Imputa un pago a las cuotas impagas más viejas. Devuelve
  // { cuotas, sobrante } con copias (no modifica el array recibido).
  function aplicarPago(cuotas, monto, fechaISO, hoy) {
    let resto = Math.max(0, Number(monto) || 0);
    const h = hoy || hoyISO();
    const fecha = fechaISO || h;
    const out = (cuotas || []).map(c => ({ ...c }))
      .sort((a, b) => a.numero - b.numero);
    for (const c of out) {
      if (resto <= 0) break;
      const falta = Math.max(0, (Number(c.monto) || 0) - (Number(c.monto_pagado) || 0));
      if (falta <= 0) continue;
      const imputo = Math.min(falta, resto);
      c.monto_pagado = (Number(c.monto_pagado) || 0) + imputo;
      resto -= imputo;
      if (c.monto_pagado >= (Number(c.monto) || 0) - 1) c.pagado_el = fecha;
    }
    out.forEach(c => { c.estado = estadoCuota(c, h); });
    return { cuotas: out, sobrante: resto };
  }

  // Resumen del préstamo a partir de sus cuotas y la fecha de hoy. Es lo
  // que se guarda en `prestamos` (y lo que muestran Kanban, Bandeja, Ficha).
  function calcularMora(cuotas, hoy) {
    const h = hoy || hoyISO();
    const filas = (cuotas || []).map(c => ({ ...c, estado: estadoCuota(c, h) }))
      .sort((a, b) => a.numero - b.numero);
    if (!filas.length) return null;
    const totalCuotas = filas.reduce((s, c) => s + (Number(c.monto) || 0), 0);
    const totalPagado = filas.reduce((s, c) => s + Math.min(Number(c.monto) || 0, Number(c.monto_pagado) || 0), 0);
    const vencidas = filas.filter(c => c.estado === 'vencida');
    const impagas = filas.filter(c => c.estado !== 'pagada');
    const montoCuota = Number(filas[0].monto) || 0;
    return {
      cuotas: filas,
      cuotas_pagas: filas.filter(c => c.estado === 'pagada').length,
      // Cuotas pagas con fracción (ej. 3.39), para "3,4 de 5" y el % cancelado.
      cuotas_pagas_decimal: montoCuota ? Math.round((totalPagado / montoCuota) * 100) / 100 : 0,
      cuotas_vencidas: vencidas.length,
      importe_atraso: Math.round(vencidas.reduce((s, c) => s + Math.max(0, (Number(c.monto) || 0) - (Number(c.monto_pagado) || 0)), 0)),
      dias_atraso: vencidas.length ? Math.max(0, diasEntre(vencidas[0].vencimiento, h)) : 0,
      proximo_vencimiento: impagas.length ? impagas[0].vencimiento : null,
      saldo_total: Math.round(Math.max(0, totalCuotas - totalPagado)),
      porcentaje_cancelado: totalCuotas ? Math.min(100, Math.round((totalPagado / totalCuotas) * 100)) : 0,
      cancelado: impagas.length === 0,
    };
  }

  // Tramo de mora para el filtro del Kanban (render 5.2: "Tramo mora").
  function tramoMora(dias) {
    const d = Number(dias) || 0;
    if (d <= 0) return 'al_dia';
    if (d <= 30) return '1_30';
    if (d <= 60) return '31_60';
    if (d <= 90) return '61_90';
    return 'mas_90';
  }
  const TRAMOS_MORA = [
    { id: 'al_dia', nombre: 'Al día' },
    { id: '1_30', nombre: 'Temprana (1–30 d)' },
    { id: '31_60', nombre: '31–60 d' },
    { id: '61_90', nombre: '61–90 d' },
    { id: 'mas_90', nombre: 'Más de 90 d' },
  ];

  const api = { hoyISO, diasEntre, planVencimientos, numeroDecimal, estadoCuota, construirCuotas, aplicarPago, calcularMora, tramoMora, TRAMOS_MORA };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.CMMora = api;
})(this);
