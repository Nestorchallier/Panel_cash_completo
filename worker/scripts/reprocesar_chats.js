// Relee los chats de los últimos días y aplica las reglas automáticas como
// si los mensajes hubieran llegado recién.
//
// Por qué hace falta: los mensajes que entraron con la sincronización del
// historial (o mientras el worker estaba caído) se guardaron SIN pasar por
// las reglas — a propósito, para no mover tarjetas por chats viejos. Pero
// así quedaron clientes que avisaron una promesa de pago por WhatsApp y no
// figuran con promesa, y clientes que mandaron el comprobante y no están en
// "Verificar pago". Además, algunos chats quedaron con "no leídos" aunque lo
// último lo escribimos nosotros.
//
// Qué hace, por cada conversación vinculada a un cliente:
//   - recorre los mensajes ENTRANTES de los últimos N días en orden y los
//     clasifica con las reglas activas (mismo motor que el worker:
//     src/reglas.js), con las mismas reglas de convivencia que
//     aplicarReglas de src/wa.js: las tarjetas solo avanzan según el orden
//     de las columnas, nunca salen de "Cerrado" ni de "Refinanciado", las
//     etiquetas se suman y la promesa queda con la última fecha detectada;
//   - deja el evento "Regla automática" en el historial con la fecha del
//     mensaje (si ya estaba —mismo cliente y regla a ±2 minutos— no lo repite);
// y en TODAS las conversaciones corrige la vista previa: si lo último es
// nuestro, "Vos: ..." y 0 no leídos.
//
// Además, para no deshacer trabajo hecho a mano:
//   - si el cobrador movió la tarjeta o cargó la promesa DESPUÉS del mensaje,
//     manda lo que hizo el cobrador (ese mensaje no mueve ni pisa la promesa);
//   - un comprobante mandado ANTES del último pago registrado (Excel o
//     "Confirmar pago") se considera ya acreditado: no lo vuelve a mandar a
//     "Verificar pago" (el mensaje se clasifica como si esa regla no existiera).
//
// Uso (desde la carpeta worker):
//   node scripts/reprocesar_chats.js [--dias=30]            -> SOLO simula
//   node scripts/reprocesar_chats.js [--dias=30] --aplicar  -> escribe

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const { clasificarMensaje } = require('../src/reglas.js');
const { fechaParaReglas } = require('../src/aplicar-reglas.js');

const APLICAR = process.argv.includes('--aplicar');
const argDias = process.argv.find(a => a.startsWith('--dias='));
const DIAS = argDias ? Math.max(1, parseInt(argDias.split('=')[1], 10) || 30) : 30;
const VENTANA_DUPLICADO_MS = 2 * 60 * 1000;
// --cliente=TEXTO: muestra el detalle de los clientes cuyo nombre lo contiene
// (en vez de los 15 ejemplos).
const argCliente = process.argv.find(a => a.startsWith('--cliente='));
// --solo-futuras: solo toma promesas con fecha de hoy en adelante (las
// vencidas dejarían al cliente en "Promesa" con una fecha pasada).
const SOLO_FUTURAS = process.argv.includes('--solo-futuras');
const FILTRO_CLIENTE = argCliente ? argCliente.split('=').slice(1).join('=').toLowerCase() : null;

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
async function traerPorLotes(ids, armarConsulta) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) out.push(...await traerTodo(() => armarConsulta(ids.slice(i, i + 100))));
  return out;
}
function agrupar(filas, clave) {
  const m = new Map();
  filas.forEach(f => { const k = f[clave]; if (!m.has(k)) m.set(k, []); m.get(k).push(f); });
  return m;
}

// Igual que previewTexto de src/wa.js (no se exporta de ahí).
function previewTexto(texto, tipo) {
  return texto || (tipo === 'imagen' ? '📷 Imagen' : tipo === 'pdf' ? '📄 PDF' : tipo === 'audio' ? '🎙️ Audio' : '...');
}
// Fecha local de Argentina (UTC-3, sin horario de verano) de un timestamp.
const fechaAR = ts => new Date(new Date(ts).getTime() - 3 * 3600000).toISOString().slice(0, 10);
const fecha = iso => iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '-';
const corto = (t, n = 60) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

(async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY || !uid) {
    console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY / WORKER_USER_ID en worker/.env');
    process.exit(1);
  }
  const ahora = new Date();
  const desde = new Date(ahora.getTime() - DIAS * 86400000).toISOString();
  const hoy = fechaAR(ahora.toISOString());
  console.log(`${APLICAR ? 'APLICANDO' : 'SIMULACIÓN (no se escribe nada; para aplicar: --aplicar)'} — mensajes entrantes desde ${fecha(fechaAR(desde))} (${DIAS} días)\n`);

  const { data: etapas, error: eEt } = await sb.from('etapas').select('id, clave, nombre, orden').eq('user_id', uid);
  if (eEt) throw eEt;
  const etapaPorId = new Map(etapas.map(e => [e.id, e]));
  const etapaPorClave = new Map(etapas.map(e => [e.clave, e]));
  const { data: reglas, error: eRg } = await sb.from('reglas').select('*').eq('user_id', uid).order('prioridad', { ascending: true });
  if (eRg) throw eRg;
  const reglasSinComprobante = reglas.filter(r => !(r.accion && r.accion.mueve_a === 'verificar_pago'));

  const conversaciones = await traerTodo(() => sb.from('conversaciones').select('id, cliente_id, nombre, no_leidos, ultimo_texto, ultimo_at').eq('user_id', uid));
  const mensajes = await traerPorLotes(conversaciones.map(c => c.id),
    lote => sb.from('mensajes').select('id, conversacion_id, direccion, tipo, texto, creado_at').in('conversacion_id', lote).order('creado_at', { ascending: true }));
  const mensajesPorConv = agrupar(mensajes, 'conversacion_id');

  const clienteIds = Array.from(new Set(conversaciones.map(c => c.cliente_id).filter(Boolean)));
  const clientes = await traerPorLotes(clienteIds, lote => sb.from('clientes').select('id, nombre, etapa_id, etiquetas, promesa_fecha').in('id', lote));
  const clientePorId = new Map(clientes.map(c => [c.id, c]));
  const eventos = await traerTodo(() => sb.from('eventos').select('cliente_id, tipo, detalle, creado_at').eq('user_id', uid).in('tipo', ['regla', 'etapa', 'promesa']));
  const eventosPorCliente = agrupar(eventos, 'cliente_id');
  const prestamos = await traerPorLotes(clienteIds, lote => sb.from('prestamos').select('cliente_id, ultimo_pago').in('cliente_id', lote));
  const pagos = await traerTodo(() => sb.from('pagos').select('cliente_id, fecha, creado_at').eq('user_id', uid));
  const recordatorios = await traerTodo(() => sb.from('recordatorios').select('cliente_id, fecha, tipo').eq('user_id', uid).eq('tipo', 'promesa'));
  const recordatorioYa = new Set(recordatorios.map(r => `${r.cliente_id}|${r.fecha}`));

  // Último pago conocido por cliente: fecha del Excel (ultimo_pago, solo
  // día) y momento exacto de los pagos confirmados desde el panel.
  const ultimoPagoDia = new Map();
  const ultimoPagoTs = new Map();
  prestamos.forEach(p => { if (p.ultimo_pago && (!ultimoPagoDia.has(p.cliente_id) || p.ultimo_pago > ultimoPagoDia.get(p.cliente_id))) ultimoPagoDia.set(p.cliente_id, p.ultimo_pago); });
  pagos.forEach(p => {
    if (!p.cliente_id) return;
    const ts = new Date(p.creado_at).getTime();
    if (!ultimoPagoTs.has(p.cliente_id) || ts > ultimoPagoTs.get(p.cliente_id)) ultimoPagoTs.set(p.cliente_id, ts);
  });
  function comprobanteYaAcreditado(clienteId, msg) {
    const ts = new Date(msg.creado_at).getTime();
    if (ultimoPagoTs.has(clienteId) && ts < ultimoPagoTs.get(clienteId)) return true;
    // El Excel trae solo el día del pago, que suele ser el mismo o uno
    // después del comprobante: un comprobante de ese día o anterior ya entró.
    const dia = ultimoPagoDia.get(clienteId);
    return !!dia && fechaAR(msg.creado_at) <= dia;
  }

  // --- Simulación por cliente ---
  // Un cliente puede tener más de un chat (dos teléfonos): se juntan sus
  // mensajes en un solo recorrido cronológico.
  const convsPorCliente = agrupar(conversaciones.filter(c => c.cliente_id), 'cliente_id');
  const resultados = [];
  let mensajesEvaluados = 0, comprobantesAcreditados = 0;
  for (const [clienteId, convs] of convsPorCliente) {
    const cliente = clientePorId.get(clienteId);
    if (!cliente) continue;
    const entrantes = convs.flatMap(c => mensajesPorConv.get(c.id) || [])
      .filter(m => m.direccion === 'entrante' && m.creado_at >= desde)
      .sort((a, b) => new Date(a.creado_at) - new Date(b.creado_at));
    if (!entrantes.length) continue;
    const evs = eventosPorCliente.get(clienteId) || [];
    const ultimoManual = tipo => evs.filter(e => e.tipo === tipo && (tipo !== 'etapa' || !e.detalle || e.detalle.manual !== false))
      .reduce((max, e) => Math.max(max, new Date(e.creado_at).getTime()), 0);
    const ultimoMovimientoManual = ultimoManual('etapa');
    const ultimaPromesaManual = ultimoManual('promesa');
    const reglasPrevias = evs.filter(e => e.tipo === 'regla');

    let etapa = cliente.etapa_id ? etapaPorId.get(cliente.etapa_id) || null : null;
    const etapaInicial = etapa;
    let promesa = cliente.promesa_fecha || null;
    let promesaTexto = null, promesaRegla = null;
    const etiquetas = new Set(cliente.etiquetas || []);
    const etiquetasNuevas = [];
    const eventosNuevos = [];
    const disparos = [];

    for (const m of entrantes) {
      mensajesEvaluados++;
      const esAdjunto = m.tipo === 'imagen' || m.tipo === 'pdf';
      const contexto = {
        texto: m.texto || '', tieneAdjunto: esAdjunto, tipoAdjunto: esAdjunto ? m.tipo : null,
        etapaActualClave: etapa ? etapa.clave : null, fecha: fechaParaReglas(m.creado_at), hora: m.creado_at,
      };
      let res = clasificarMensaje(reglas, contexto);
      if (res && res.regla.accion && res.regla.accion.mueve_a === 'verificar_pago' && comprobanteYaAcreditado(clienteId, m)) {
        comprobantesAcreditados++;
        res = clasificarMensaje(reglasSinComprobante, contexto);
      }
      if (!res) continue;
      // Una promesa escrita antes de un pago ya registrado está cumplida: no
      // vuelve a poner al cliente en "Promesa" con una fecha vieja.
      if (res.regla.accion && res.regla.accion.detecta_fecha && comprobanteYaAcreditado(clienteId, m)) continue;
      if (SOLO_FUTURAS && res.regla.accion && res.regla.accion.detecta_fecha && (!res.fechaDetectada || res.fechaDetectada < fechaAR(Date.now()))) continue;
      const { regla, fechaDetectada } = res;
      const accion = regla.accion || {};
      const ts = new Date(m.creado_at).getTime();

      const bloqueada = etapa && ['cerrado', 'refinanciado'].includes(etapa.clave);
      if (accion.mueve_a && !bloqueada && ts > ultimoMovimientoManual) {
        const destino = etapaPorClave.get(accion.mueve_a);
        const avanza = !etapa || etapa.orden == null || !destino || destino.orden == null || destino.orden > etapa.orden;
        if (destino && avanza) etapa = destino;
      }
      if (fechaDetectada && ts > ultimaPromesaManual) {
        promesa = fechaDetectada;
        promesaTexto = m.texto;
        promesaRegla = regla;
      }
      if (accion.etiqueta && !etiquetas.has(accion.etiqueta)) { etiquetas.add(accion.etiqueta); etiquetasNuevas.push(accion.etiqueta); }

      const repetido = reglasPrevias.some(e => e.detalle && e.detalle.regla === regla.nombre
        && Math.abs(new Date(e.creado_at).getTime() - ts) <= VENTANA_DUPLICADO_MS);
      disparos.push({ regla: regla.nombre, texto: m.texto || previewTexto(null, m.tipo), fecha: m.creado_at, fechaDetectada, repetido });
      if (!repetido) {
        eventosNuevos.push({
          user_id: uid, cliente_id: clienteId, tipo: 'regla', creado_at: m.creado_at,
          detalle: { regla: regla.nombre, accion, fecha_detectada: fechaDetectada, reproceso: true },
        });
      }
    }

    const cambios = {};
    if (etapa && etapa !== etapaInicial) cambios.etapa_id = etapa.id;
    if (promesa !== (cliente.promesa_fecha || null)) cambios.promesa_fecha = promesa;
    if (etiquetasNuevas.length) cambios.etiquetas = Array.from(etiquetas);
    const recordatorio = cambios.promesa_fecha && promesaRegla && promesaRegla.accion && promesaRegla.accion.crea_recordatorio
      && !recordatorioYa.has(`${clienteId}|${cambios.promesa_fecha}`)
      // Una promesa que ya venció no necesita recordatorio a futuro.
      && cambios.promesa_fecha >= fechaAR(Date.now())
      ? { user_id: uid, cliente_id: clienteId, fecha: cambios.promesa_fecha, tipo: 'promesa', texto: `Promesa detectada por WhatsApp: "${promesaTexto}"` }
      : null;
    if (Object.keys(cambios).length || eventosNuevos.length) {
      resultados.push({ cliente, etapaInicial, etapa, promesaAntes: cliente.promesa_fecha || null, cambios, etiquetasNuevas, eventosNuevos, recordatorio, disparos, entrantes: entrantes.length });
    }
  }

  // --- Vista previa / no leídos de cada conversación ---
  const arreglosConv = [];
  for (const c of conversaciones) {
    const msgs = mensajesPorConv.get(c.id);
    if (!msgs || !msgs.length) continue;
    const ultimo = msgs.reduce((a, b) => (new Date(b.creado_at) >= new Date(a.creado_at) ? b : a));
    const saliente = ultimo.direccion === 'saliente';
    const texto = (saliente ? 'Vos: ' : '') + previewTexto(ultimo.texto, ultimo.tipo);
    const cambios = {};
    if (c.ultimo_texto !== texto) cambios.ultimo_texto = texto;
    if (!c.ultimo_at || new Date(c.ultimo_at).getTime() !== new Date(ultimo.creado_at).getTime()) cambios.ultimo_at = ultimo.creado_at;
    if (saliente && c.no_leidos) cambios.no_leidos = 0;
    if (Object.keys(cambios).length) arreglosConv.push({ c, cambios });
  }

  // --- Informe ---
  const conCambioEtapa = resultados.filter(r => r.cambios.etapa_id);
  const porDestino = {};
  conCambioEtapa.forEach(r => {
    const k = `${r.etapaInicial ? r.etapaInicial.nombre : '(sin etapa)'} -> ${r.etapa.nombre}`;
    porDestino[k] = (porDestino[k] || 0) + 1;
  });
  const promesasNuevas = resultados.filter(r => r.cambios.promesa_fecha);
  const aVerificar = conCambioEtapa.filter(r => r.etapa.clave === 'verificar_pago');
  const eventosTotales = resultados.reduce((s, r) => s + r.eventosNuevos.length, 0);
  const porRegla = {};
  resultados.forEach(r => r.eventosNuevos.forEach(e => { porRegla[e.detalle.regla] = (porRegla[e.detalle.regla] || 0) + 1; }));
  const etiquetasCuenta = {};
  resultados.forEach(r => r.etiquetasNuevas.forEach(t => { etiquetasCuenta[t] = (etiquetasCuenta[t] || 0) + 1; }));

  console.log(`Conversaciones: ${conversaciones.length} (${conversaciones.filter(c => c.cliente_id).length} vinculadas a cliente) | mensajes: ${mensajes.length}`);
  console.log(`Mensajes entrantes evaluados (clientes, últimos ${DIAS} días): ${mensajesEvaluados}`);
  console.log(`Reglas activas: ${reglas.filter(r => r.activa).map(r => r.nombre).join(', ')}`);
  console.log(`\nClientes con algún cambio: ${resultados.length}`);
  console.log(`Cambian de etapa: ${conCambioEtapa.length}`);
  Object.entries(porDestino).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`   ${k}: ${n}`));
  console.log(`Promesas de pago nuevas o actualizadas: ${promesasNuevas.length} (vencidas antes de hoy: ${promesasNuevas.filter(r => r.cambios.promesa_fecha < hoy).length}, hoy o después: ${promesasNuevas.filter(r => r.cambios.promesa_fecha >= hoy).length}) | recordatorios a crear: ${resultados.filter(r => r.recordatorio).length}`);
  console.log(`Comprobantes -> Verificar pago: ${aVerificar.length} (comprobantes ignorados por ser anteriores al último pago registrado: ${comprobantesAcreditados})`);
  console.log(`Etiquetas a sumar: ${Object.entries(etiquetasCuenta).map(([k, n]) => `${k}: ${n}`).join(' | ') || 'ninguna'}`);
  console.log(`Eventos "Regla automática" a insertar: ${eventosTotales} (${Object.entries(porRegla).map(([k, n]) => `${k}: ${n}`).join(' | ')})`);
  console.log(`Chats con vista previa corregida: ${arreglosConv.length} (no leídos puestos en 0 porque lo último es nuestro: ${arreglosConv.filter(a => a.cambios.no_leidos === 0).length}, texto "Vos: ...": ${arreglosConv.filter(a => (a.cambios.ultimo_texto || '').startsWith('Vos: ')).length})`);

  // Ejemplos: primero los que cambian de etapa o promesa (lo que el
  // usuario va a notar en el Kanban), después el resto.
  const ejemplos = [...resultados].sort((a, b) => {
    const peso = r => (r.cambios.etapa_id && r.etapa.clave === 'verificar_pago' ? 4 : 0) + (r.cambios.promesa_fecha ? 3 : 0) + (r.cambios.etapa_id ? 1 : 0);
    return peso(b) - peso(a);
  }).filter(r => !FILTRO_CLIENTE || String(r.cliente.nombre || '').toLowerCase().includes(FILTRO_CLIENTE))
    .slice(0, FILTRO_CLIENTE ? 1000 : 15);
  if (FILTRO_CLIENTE) {
    const sinCambios = clientes.filter(c => String(c.nombre || '').toLowerCase().includes(FILTRO_CLIENTE) && !resultados.some(r => r.cliente.id === c.id));
    sinCambios.forEach(c => console.log(`${c.nombre}: sin cambios (promesa actual ${fecha(c.promesa_fecha)})`));
  }
  console.log(FILTRO_CLIENTE ? `\nClientes con "${FILTRO_CLIENTE}":` : '\n15 ejemplos:');
  ejemplos.forEach((r, i) => {
    const partes = [];
    if (r.cambios.etapa_id) partes.push(`etapa ${r.etapaInicial ? r.etapaInicial.nombre : '(sin etapa)'} -> ${r.etapa.nombre}`);
    else partes.push(`etapa ${r.etapa ? r.etapa.nombre : '(sin etapa)'} (sin cambio)`);
    if (r.cambios.promesa_fecha) partes.push(`promesa ${fecha(r.promesaAntes)} -> ${fecha(r.cambios.promesa_fecha)}`);
    if (r.etiquetasNuevas.length) partes.push(`+ etiquetas ${r.etiquetasNuevas.join(', ')}`);
    partes.push(`${r.eventosNuevos.length} evento(s)`);
    console.log(`${String(i + 1).padStart(2)}. ${r.cliente.nombre}: ${partes.join(' | ')}`);
    r.disparos.filter(d => !d.repetido).slice(-3).forEach(d => console.log(`      ${fecha(fechaAR(d.fecha))} [${d.regla}] "${corto(d.texto)}"${d.fechaDetectada ? ` -> ${fecha(d.fechaDetectada)}` : ''}`));
  });

  if (!APLICAR) { console.log('\nSimulación terminada: no se escribió nada.'); return; }

  // --- Escritura ---
  let errores = 0;
  for (const r of resultados) {
    if (Object.keys(r.cambios).length) {
      const { error } = await sb.from('clientes').update(r.cambios).eq('id', r.cliente.id);
      if (error) { errores++; console.error('cliente', r.cliente.nombre, error.message); }
    }
    if (r.eventosNuevos.length) {
      const { error } = await sb.from('eventos').insert(r.eventosNuevos);
      if (error) { errores++; console.error('eventos', r.cliente.nombre, error.message); }
    }
    if (r.recordatorio) {
      const { error } = await sb.from('recordatorios').insert(r.recordatorio);
      if (error) { errores++; console.error('recordatorio', r.cliente.nombre, error.message); }
    }
  }
  for (const { c, cambios } of arreglosConv) {
    const { error } = await sb.from('conversaciones').update(cambios).eq('id', c.id);
    if (error) { errores++; console.error('conversación', c.nombre || c.id, error.message); }
  }
  console.log(`\nListo: ${resultados.length} clientes y ${arreglosConv.length} chats actualizados, ${errores} errores.`);
})().catch(e => { console.error('Error:', e.message || e); process.exit(1); });
