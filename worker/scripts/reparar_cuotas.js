// Reparación de una sola vez de las cuotas de los préstamos importados.
//
// Qué pasó: en el Excel de Préstamos las columnas "Pagas" y "Vencidas"
// vienen con PUNTO DECIMAL ("3.39" = 3 cuotas y el 39% de la cuarta) y el
// importador viejo tomaba ese punto como separador de miles: guardó 339.
// Resultado: cuotas_pagas / cuotas_vencidas quedaron multiplicadas por 100
// en todos los préstamos y el plan de cuotas se armó entero como "pagado"
// (ej. #85037 con 339 pagas de 5, Elsa #88142 con 100 de 100).
//
// Qué hace este script, préstamo por préstamo:
//   - con plan de cuotas (primer vto. + cantidad): reconstruye las cuotas
//     con js/mora.js usando pagas = cuotas_pagas / 100, les vuelve a
//     imputar los pagos que se confirmaron desde el panel DESPUÉS de la
//     importación (Bandeja / Kanban / Ficha; ej. el de Elsa del 01/10) y
//     recalcula atraso, saldo, próximo vencimiento y estado al día de hoy;
//   - sin plan: solo divide por 100 (redondeando para abajo) pagas y vencidas.
//
// Uso (desde la carpeta worker):
//   node scripts/reparar_cuotas.js            -> SOLO simula e imprime
//   node scripts/reparar_cuotas.js --aplicar  -> escribe en la base
//
// Se puede correr una sola vez: al aplicar deja la marca
// 'reparacion_cuotas_v1' en kv_store y, si la encuentra, no hace nada (una
// segunda pasada volvería a dividir por 100 números que ya están bien).

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const M = require('../../js/mora.js');

const APLICAR = process.argv.includes('--aplicar');
const CLAVE_KV = 'reparacion_cuotas_v1';
const NROS_EJEMPLO = ['85037', '88142', '89200', '85213', '88089'];

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const uid = process.env.WORKER_USER_ID;

async function traerTodo(armarConsulta) {
  const out = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await armarConsulta().range(desde, desde + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

// Mismo criterio que _prestamoPrincipal de supabase/crm.js: el pago que se
// confirmó desde el panel se imputó al préstamo activo con más saldo.
function prestamoPrincipal(prestamos) {
  const activos = prestamos.filter(p => p.estado === 'activo');
  const conSaldo = activos.filter(p => p.saldo_total !== null).sort((a, b) => (b.saldo_total || 0) - (a.saldo_total || 0));
  return conSaldo[0] || activos[0] || prestamos[0] || null;
}

const pesos = n => (n === null || n === undefined) ? '-' : '$' + Math.round(Number(n)).toLocaleString('es-AR');
const fecha = iso => iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '-';

function resumen(r) {
  return `pagas ${r.pagas} | vencidas ${r.vencidas} | ${r.dias} días | atraso ${pesos(r.importe)} | próx. vto ${fecha(r.prox)} | ${r.pct === null ? '-' : r.pct + '%'} cancelado | ${r.estado}`;
}

(async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY || !uid) {
    console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY / WORKER_USER_ID en worker/.env');
    process.exit(1);
  }
  const { data: marca } = await sb.from('kv_store').select('value').eq('user_id', uid).eq('key', CLAVE_KV).maybeSingle();
  if (marca) {
    console.log(`Ya reparado (${marca.value && marca.value.fecha}): no se hace nada.`);
    return;
  }

  const hoy = M.hoyISO();
  console.log(`${APLICAR ? 'APLICANDO' : 'SIMULACIÓN (no se escribe nada; para aplicar: --aplicar)'} — hoy ${fecha(hoy)}\n`);

  const prestamos = await traerTodo(() => sb.from('prestamos').select('*').eq('user_id', uid).order('nro'));
  const clientes = await traerTodo(() => sb.from('clientes').select('id, nombre, etiquetas').eq('user_id', uid));
  const clientePorId = new Map(clientes.map(c => [c.id, c]));
  const pagos = await traerTodo(() => sb.from('pagos').select('*').eq('user_id', uid).neq('origen', 'excel').order('creado_at'));
  const eventosPago = await traerTodo(() => sb.from('eventos').select('cliente_id').eq('user_id', uid).eq('tipo', 'pago'));
  const clientesConEventoPago = new Set(eventosPago.map(e => e.cliente_id));
  const idsPrestamos = prestamos.map(p => p.id);
  const cuotasViejas = [];
  for (let i = 0; i < idsPrestamos.length; i += 100) {
    const lote = idsPrestamos.slice(i, i + 100);
    cuotasViejas.push(...await traerTodo(() => sb.from('cuotas').select('*').in('prestamo_id', lote).order('numero')));
  }
  const cuotasPorPrestamo = new Map();
  cuotasViejas.forEach(c => { if (!cuotasPorPrestamo.has(c.prestamo_id)) cuotasPorPrestamo.set(c.prestamo_id, []); cuotasPorPrestamo.get(c.prestamo_id).push(c); });

  // --- 1) Reconstrucción de cuotas con las pagas reales (x / 100) ---
  const resultados = new Map(); // prestamo.id -> { p, cuotas, cambios, antes, ... }
  let conPlan = 0, sinPlan = 0, raros = 0;
  for (const p of prestamos) {
    const viejas = cuotasPorPrestamo.get(p.id) || [];
    const moraVieja = viejas.length ? M.calcularMora(viejas, hoy) : null;
    const antes = {
      pagas: p.cuotas_pagas, vencidas: p.cuotas_vencidas, dias: p.dias_atraso, importe: p.importe_atraso,
      prox: p.proximo_vencimiento, pct: moraVieja ? moraVieja.porcentaje_cancelado : null, estado: p.estado,
    };
    // Valor que no puede venir de "x100" (ej. 3 pagas en un préstamo de 5
    // cuando lo esperable es 300): se avisa, por si alguien ya lo corrigió
    // a mano. Igual se divide, porque la marca de kv_store no estaba.
    if (p.cuotas_pagas && p.cuotas_pagas % 1 === 0 && p.cuotas_pagas <= (p.cant_cuotas || 0) && p.cuotas_pagas < 100) raros++;
    const plan = M.planVencimientos(p);
    if (plan.length) {
      conPlan++;
      const pagasReal = (Number(p.cuotas_pagas) || 0) / 100;
      resultados.set(p.id, { p, antes, pagasReal, cuotas: M.construirCuotas(p, pagasReal, hoy), pagos: [], ultimoPago: p.ultimo_pago });
    } else {
      sinPlan++;
      resultados.set(p.id, {
        p, antes, sinPlan: true,
        cambios: { cuotas_pagas: Math.floor((Number(p.cuotas_pagas) || 0) / 100), cuotas_vencidas: Math.floor((Number(p.cuotas_vencidas) || 0) / 100) },
      });
    }
  }

  // --- 2) Pagos confirmados desde el panel después de la importación ---
  // Se imputan sobre las cuotas YA reconstruidas, en el orden en que se
  // cargaron, al préstamo que tengan anotado o, si no tienen, al principal
  // del cliente (como lo haría hoy "Confirmar pago").
  const pagosAplicados = [];
  const prestamosPorCliente = new Map();
  prestamos.forEach(p => { if (!prestamosPorCliente.has(p.cliente_id)) prestamosPorCliente.set(p.cliente_id, []); prestamosPorCliente.get(p.cliente_id).push(p); });
  for (const pago of pagos) {
    let destino = pago.prestamo_id ? prestamos.find(p => p.id === pago.prestamo_id) : null;
    if (!destino && pago.cliente_id) {
      // El principal se elige con los saldos ya corregidos (con el bug,
      // todos los préstamos figuraban casi saldados).
      const candidatos = (prestamosPorCliente.get(pago.cliente_id) || []).map(p => {
        const r = resultados.get(p.id);
        if (r && r.cuotas) { const m = M.calcularMora(r.cuotas, hoy); return { ...p, saldo_total: m.saldo_total, estado: p.estado === 'refinanciado' ? p.estado : (m.cancelado ? 'cancelado' : 'activo') }; }
        return p;
      });
      destino = prestamoPrincipal(candidatos);
    }
    if (!destino) continue;
    // Solo los pagos posteriores a la importación del Excel: los anteriores
    // ya vienen sumados en la columna "Pagas".
    // Los que ya tienen el préstamo anotado los cargó "Confirmar pago", que
    // además mueve actualizado_at: por eso cuentan aunque la fecha no dé.
    const posterior = new Date(pago.creado_at) > new Date(destino.actualizado_at || destino.creado_at);
    if (!posterior && pago.prestamo_id !== destino.id) continue;
    const r = resultados.get(destino.id);
    if (!r || !r.cuotas) { pagosAplicados.push({ pago, destino, r, sinPlan: true }); continue; }
    const { cuotas, sobrante } = M.aplicarPago(r.cuotas, pago.monto, pago.fecha || String(pago.creado_at).slice(0, 10), hoy);
    r.cuotas = cuotas;
    r.pagos.push(pago);
    if (pago.fecha && (!r.ultimoPago || pago.fecha > r.ultimoPago)) r.ultimoPago = pago.fecha;
    pagosAplicados.push({ pago, destino, r, sobrante });
  }

  // --- 3) Totales recalculados al día de hoy ---
  for (const r of resultados.values()) {
    if (r.sinPlan) { r.despues = { ...r.antes, pagas: r.cambios.cuotas_pagas, vencidas: r.cambios.cuotas_vencidas }; continue; }
    const m = M.calcularMora(r.cuotas, hoy);
    r.mora = m;
    r.cambios = {
      cuotas_pagas: m.cuotas_pagas, cuotas_vencidas: m.cuotas_vencidas,
      dias_atraso: m.dias_atraso, importe_atraso: m.importe_atraso,
      proximo_vencimiento: m.proximo_vencimiento, saldo_total: m.saldo_total,
      // "Refinanciado" lo decide el cobrador: no se toca.
      estado: r.p.estado === 'refinanciado' ? 'refinanciado' : (m.cancelado ? 'cancelado' : 'activo'),
      ultimo_pago: r.ultimoPago || null,
      actualizado_at: new Date().toISOString(),
    };
    r.despues = {
      pagas: `${m.cuotas_pagas} (${String(m.cuotas_pagas_decimal).replace('.', ',')} de ${r.p.cant_cuotas})`,
      vencidas: m.cuotas_vencidas, dias: m.dias_atraso, importe: m.importe_atraso,
      prox: m.proximo_vencimiento, pct: m.porcentaje_cancelado, estado: r.cambios.estado,
    };
  }

  // --- Informe ---
  const todos = Array.from(resultados.values());
  const conAtraso = todos.filter(r => (r.cambios.dias_atraso !== undefined ? r.cambios.dias_atraso : r.p.dias_atraso) > 0 && (r.cambios.estado || r.p.estado) === 'activo');
  const cancelados = todos.filter(r => (r.cambios.estado || r.p.estado) === 'cancelado');
  const canceladosAntes = prestamos.filter(p => p.estado === 'cancelado').length;
  const tramos = {};
  todos.filter(r => r.mora && r.cambios.estado === 'activo').forEach(r => { const t = M.tramoMora(r.mora.dias_atraso); tramos[t] = (tramos[t] || 0) + 1; });

  console.log(`Préstamos: ${prestamos.length} (con plan de cuotas: ${conPlan}, sin plan: ${sinPlan})`);
  console.log(`Cuotas a reconstruir: ${todos.filter(r => r.cuotas).reduce((s, r) => s + r.cuotas.length, 0)} (hoy hay ${cuotasViejas.length} guardadas, ${cuotasViejas.filter(c => c.estado === 'pagada').length} marcadas como pagadas)`);
  if (raros) console.log(`OJO: ${raros} préstamos tienen "pagas" chicas que no parecen x100 (igual se dividen).`);
  console.log(`\nPagos del panel a reimputar: ${pagosAplicados.length}`);
  pagosAplicados.forEach(({ pago, destino, r, sobrante, sinPlan: sp }) => {
    const cli = clientePorId.get(pago.cliente_id);
    console.log(`  - ${cli ? cli.nombre : pago.nombre}: ${pesos(pago.monto)} del ${fecha(pago.fecha)} (${pago.origen}) -> préstamo #${destino.nro}` +
      (sp ? ' (sin plan de cuotas: solo se le anota el préstamo)' : `, queda ${r.mora.porcentaje_cancelado}% cancelado${r.mora.cancelado ? ' (CANCELADO)' : ''}${sobrante > 1 ? `, sobran ${pesos(sobrante)}` : ''}`) +
      (clientesConEventoPago.has(pago.cliente_id) ? '' : ' + evento "pago" en el historial'));
  });

  console.log('\nEjemplos (antes -> después):');
  NROS_EJEMPLO.forEach(nro => {
    const r = todos.find(x => x.p.nro === nro);
    if (!r) { console.log(`  #${nro}: no está en la base`); return; }
    const cli = clientePorId.get(r.p.cliente_id);
    console.log(`  #${nro} ${cli ? cli.nombre : ''} (${r.p.cant_cuotas || '?'} cuotas de ${pesos(r.p.cuota_monto)}${r.sinPlan ? ', SIN plan' : ''})`);
    console.log(`     antes:   ${resumen(r.antes)}`);
    console.log(`     después: ${resumen(r.despues)}`);
  });

  console.log(`\nActivos con atraso hoy: ${conAtraso.length} | al día: ${todos.filter(r => (r.cambios.estado || r.p.estado) === 'activo').length - conAtraso.length}`);
  console.log(`Por tramo (activos con plan): ${M.TRAMOS_MORA.map(t => `${t.nombre}: ${tramos[t.id] || 0}`).join(' | ')}`);
  console.log(`Cancelados: ${cancelados.length} (antes ${canceladosAntes})`);

  if (!APLICAR) { console.log('\nSimulación terminada: no se escribió nada.'); return; }

  // --- Escritura ---
  let errores = 0;
  for (const r of todos) {
    if (r.cuotas) {
      const { error: e1 } = await sb.from('cuotas').delete().eq('prestamo_id', r.p.id);
      if (e1) { errores++; console.error('borrar cuotas', r.p.nro, e1.message); continue; }
      const filas = r.cuotas.map(c => ({
        prestamo_id: r.p.id, numero: c.numero, vencimiento: c.vencimiento, monto: c.monto,
        estado: c.estado, monto_pagado: c.monto_pagado || 0, pagado_el: c.pagado_el || null,
      }));
      const { error: e2 } = await sb.from('cuotas').insert(filas);
      if (e2) { errores++; console.error('insertar cuotas', r.p.nro, e2.message); continue; }
    }
    const { error: e3 } = await sb.from('prestamos').update(r.cambios).eq('id', r.p.id);
    if (e3) { errores++; console.error('actualizar préstamo', r.p.nro, e3.message); }
  }
  for (const { pago, destino, r } of pagosAplicados) {
    if (!pago.prestamo_id) await sb.from('pagos').update({ prestamo_id: destino.id }).eq('id', pago.id);
    if (!pago.cliente_id) continue;
    const cancelado = !!(r && r.mora && r.mora.cancelado);
    if (!clientesConEventoPago.has(pago.cliente_id)) {
      clientesConEventoPago.add(pago.cliente_id);
      await sb.from('eventos').insert({
        user_id: uid, cliente_id: pago.cliente_id, tipo: 'pago', creado_at: pago.creado_at,
        detalle: {
          monto: Number(pago.monto), origen: pago.origen, prestamo: destino.nro, cancelado,
          cuotas_pagas: r && r.mora ? r.mora.cuotas_pagas_decimal : null, cant_cuotas: destino.cant_cuotas,
        },
      });
    }
    if (cancelado) {
      const cli = clientePorId.get(pago.cliente_id);
      const etiquetas = (cli && cli.etiquetas) || [];
      if (!etiquetas.some(e => String(e).toLowerCase() === 'cancelado')) {
        cli.etiquetas = [...etiquetas, 'Cancelado'];
        await sb.from('clientes').update({ etiquetas: cli.etiquetas }).eq('id', cli.id);
      }
    }
  }
  const { error: e4 } = await sb.from('kv_store').upsert({
    user_id: uid, key: CLAVE_KV, value: { fecha: new Date().toISOString(), prestamos: prestamos.length }, updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,key' });
  if (e4) console.error('No se pudo guardar la marca en kv_store:', e4.message, '— NO volver a correr el script sin revisar.');
  console.log(`\nListo: ${prestamos.length} préstamos procesados, ${errores} errores.`);
})().catch(e => { console.error('Error:', e.message || e); process.exit(1); });
