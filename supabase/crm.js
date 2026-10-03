// Capa de datos del CRM sobre las tablas relacionales (001_tablas.sql),
// compartida por index.html, kanban_clientes.html y clientes.html.
// Reemplaza al modelo kv_store para todo lo que es una entidad real del
// negocio (clientes, préstamos, etapas, plantillas, pagos, chats).
//
// Las funciones de clientes devuelven/reciben objetos con la MISMA forma
// que ya usaba el Kanban cuando vivía en el blob cm_kanban_clientes_v1
// ({id, nombre, dni, monto, telefono, notas, stage, fechaPromesa,
// montoPagado, customFields, stageChangedAt}), para no tener que reescribir
// el render/drag-drop/filtros que ya funcionan. Lo que cambia es de dónde
// salen y adónde se guardan esos objetos.

async function _uid() {
  const { data: { session } } = await window.sb.auth.getSession();
  if (!session) throw new Error('No autenticado');
  return session.user.id;
}

// Se llama una vez por sesión (ver index.html), después del login. Crea la
// fila de usuarios, las columnas default del Kanban y las reglas de
// clasificación si todavía no existen — es un no-op si ya estaban.
async function crmBootstrap(nombre) {
  const { error } = await window.sb.rpc('bootstrap_usuario', { p_nombre: nombre || '' });
  if (error) console.error('bootstrap_usuario', error);
}

// ───────────────────────── etapas ─────────────────────────

async function crmListEtapas() {
  const uid = await _uid();
  const { data, error } = await window.sb
    .from('etapas').select('*').eq('user_id', uid).order('orden', { ascending: true });
  if (error) { console.error('crmListEtapas', error); return []; }
  return data.map(e => ({ id: e.clave || e.id, _rowId: e.id, name: e.nombre, color: e.color, protected: e.protegida, orden: e.orden }));
}

// Recibe el array STAGES tal como lo maneja el Kanban ({id,name,color,protected})
// y lo deja reflejado en la tabla. id puede ser la clave fija ('a_contactar')
// o un id local nuevo (recién creado en el panel, todavía no existe en la tabla).
async function crmSaveEtapas(stages) {
  const uid = await _uid();
  const { data: actuales, error: e1 } = await window.sb.from('etapas').select('id, clave').eq('user_id', uid);
  if (e1) { console.error('crmSaveEtapas (leer actuales)', e1); return; }
  const porClave = new Map(actuales.filter(r => r.clave).map(r => [r.clave, r.id]));
  const porId = new Set(actuales.map(r => r.id));

  const rows = stages.map((s, i) => {
    const esProtegida = !!s.protected;
    const rowId = esProtegida ? (porClave.get(s.id) || s.id) : (porId.has(s.id) || /^[0-9a-f-]{36}$/i.test(s.id) ? s.id : undefined);
    const row = {
      user_id: uid,
      clave: esProtegida ? s.id : null,
      nombre: s.name,
      color: s.color,
      orden: i,
      protegida: esProtegida,
    };
    if (rowId) row.id = rowId;
    return row;
  });

  const { error } = await window.sb.from('etapas').upsert(rows).select();
  if (error) { console.error('crmSaveEtapas', error); throw error; }

  // Borra las columnas que ya no están (el usuario eliminó una no protegida).
  const idsVivos = new Set(rows.map(r => r.id).filter(Boolean));
  const idsABorrar = actuales.map(r => r.id).filter(id => !idsVivos.has(id) && rows.every(r => r.id !== id));
  if (idsABorrar.length) {
    await window.sb.from('etapas').delete().in('id', idsABorrar);
  }
}

// ───────────────────────── clientes ─────────────────────────

function _filaAObjetoCliente(row, etapaIdPorRowId) {
  const extra = row.campos_extra || {};
  return {
    id: row.id,
    nombre: row.nombre,
    dni: row.dni || '',
    monto: extra.monto || '',
    telefono: row.telefono_principal || '',
    notas: row.notas || '',
    stage: etapaIdPorRowId.get(row.etapa_id) || row.etapa_id || '',
    fechaPromesa: row.promesa_fecha || '',
    montoPagado: extra.montoPagado || '',
    customFields: extra.customFields || {},
    stageChangedAt: extra.stageChangedAt || null,
    // Solo lectura en el Kanban (las ponen las reglas del worker); no se
    // manda de vuelta en crmSaveClientes, así que no se pisa.
    etiquetas: row.etiquetas || [],
    // Del Excel de Préstamos (filtro "Cobrador" del Kanban / Bandeja).
    cobrador: row.cobrador_nombre || '',
    segmento: row.segmento || '',
  };
}

// "nestor.challier" / "Nestor Challier" -> "Nestor C." (como en los renders
// del plan: avatar "NC" + "Nestor C.").
function crmNombreCorto(nombre) {
  const partes = String(nombre || '').trim().split(/[\s._-]+/).filter(Boolean)
    .map(p => p[0].toUpperCase() + p.slice(1).toLowerCase());
  if (!partes.length) return '';
  return partes.length > 1 ? `${partes[0]} ${partes[1][0]}.` : partes[0];
}
function crmIniciales(nombre) {
  const partes = String(nombre || '').trim().split(/[\s._-]+/).filter(Boolean);
  return (((partes[0] || '?')[0] || '?') + ((partes[1] || '')[0] || '')).toUpperCase();
}

async function crmListClientes() {
  const uid = await _uid();
  const [{ data: clientes, error }, etapas] = await Promise.all([
    window.sb.from('clientes').select('*').eq('user_id', uid),
    window.sb.from('etapas').select('id, clave').eq('user_id', uid),
  ]);
  if (error) { console.error('crmListClientes', error); return []; }
  const etapaIdPorRowId = new Map((etapas.data || []).map(e => [e.id, e.clave || e.id]));
  return (clientes || []).map(r => _filaAObjetoCliente(r, etapaIdPorRowId));
}

// Guarda los clientes que se le pasan (upsert). OJO: ya NO borra de la base
// los que no vengan en el array — antes lo hacía, y como el Kanban guardaba
// TODA su copia en memoria con cada movimiento, pisaba los cambios que el
// worker (reglas automáticas) o la Bandeja habían hecho mientras tanto
// (ej. devolvía a "Contactado" a alguien que el worker había pasado a
// "Verificar pago") y podía borrar clientes recién agendados. Para borrar
// hay que llamar a crmDeleteCliente(id) explícitamente, y conviene pasar
// solo los clientes que cambiaron.
async function crmSaveClientes(clients) {
  const uid = await _uid();
  const { data: etapas } = await window.sb.from('etapas').select('id, clave').eq('user_id', uid);
  const rowIdPorClave = new Map((etapas || []).filter(e => e.clave).map(e => [e.clave, e.id]));
  const idsEtapasValidos = new Set((etapas || []).map(e => e.id));

  const rows = clients.map(c => {
    const etapaRowId = rowIdPorClave.get(c.stage) || (idsEtapasValidos.has(c.stage) ? c.stage : null);
    return {
      id: c.id,
      user_id: uid,
      nombre: c.nombre || '(sin nombre)',
      dni: c.dni || null,
      telefono_principal: c.telefono || null,
      notas: c.notas || null,
      etapa_id: etapaRowId,
      promesa_fecha: c.fechaPromesa || null,
      campos_extra: {
        monto: c.monto || '',
        montoPagado: c.montoPagado || '',
        customFields: c.customFields || {},
        stageChangedAt: c.stageChangedAt || null,
      },
    };
  });

  if (rows.length) {
    const { error } = await window.sb.from('clientes').upsert(rows);
    if (error) { console.error('crmSaveClientes', error); throw error; }
  }

  // Sincroniza clientes_telefonos (tabla real para matchear WhatsApp) con el
  // teléfono principal de cada tarjeta.
  await Promise.all(clients.filter(c => c.telefono).map(async c => {
    const tel = window.normalizarTelefonoAR ? (window.normalizarTelefonoAR(c.telefono) || c.telefono) : c.telefono;
    await window.sb.from('clientes_telefonos')
      .upsert({ cliente_id: c.id, telefono: tel, etiqueta: 'Celular', principal: true }, { onConflict: 'cliente_id,telefono' });
  }));
}

async function crmDeleteCliente(id) {
  await window.sb.from('clientes').delete().eq('id', id);
}

// ───────────────────────── plantillas ─────────────────────────
// Compatibilidad con la forma vieja de misPlantillas: { "Nombre": "texto" }.

async function crmListPlantillas() {
  const uid = await _uid();
  const { data, error } = await window.sb.from('plantillas').select('*').eq('user_id', uid).order('nombre');
  if (error) { console.error('crmListPlantillas', error); return {}; }
  const out = {};
  (data || []).forEach(p => { out[p.nombre] = p.texto; });
  return out;
}

async function crmSavePlantillas(obj) {
  const uid = await _uid();
  const nombres = Object.keys(obj || {});
  if (nombres.length) {
    const rows = nombres.map(nombre => ({ user_id: uid, nombre, texto: obj[nombre] || '' }));
    const { error } = await window.sb.from('plantillas').upsert(rows, { onConflict: 'user_id,nombre' });
    if (error) console.error('crmSavePlantillas', error);
  }
  const { data: existentes } = await window.sb.from('plantillas').select('id, nombre').eq('user_id', uid);
  const vivos = new Set(nombres);
  const aBorrar = (existentes || []).filter(p => !vivos.has(p.nombre)).map(p => p.id);
  if (aBorrar.length) await window.sb.from('plantillas').delete().in('id', aBorrar);
}

// ───────────────────────── pagos ─────────────────────────

async function crmListPagos() {
  const uid = await _uid();
  const { data, error } = await window.sb.from('pagos').select('*').eq('user_id', uid).order('fecha', { ascending: false });
  if (error) { console.error('crmListPagos', error); return []; }
  return data || [];
}

async function crmAddPago(pago) {
  const uid = await _uid();
  const { error } = await window.sb.from('pagos').insert({ user_id: uid, ...pago });
  if (error) console.error('crmAddPago', error);
}

// ───────────────────────── conversaciones / mensajes (Bandeja WhatsApp) ─────────────────────────

async function crmListConversaciones() {
  const uid = await _uid();
  const { data, error } = await window.sb
    .from('conversaciones')
    .select('*, clientes(id, nombre, dni, etapa_id, promesa_fecha, etiquetas, cobrador_nombre)')
    .eq('user_id', uid)
    .order('ultimo_at', { ascending: false, nullsFirst: false });
  if (error) { console.error('crmListConversaciones', error); return []; }
  return data || [];
}

async function crmListMensajes(conversacionId) {
  const { data, error } = await window.sb
    .from('mensajes').select('*').eq('conversacion_id', conversacionId).order('creado_at', { ascending: true });
  if (error) { console.error('crmListMensajes', error); return []; }
  return data || [];
}

async function crmMarcarConversacionLeida(conversacionId) {
  await window.sb.from('conversaciones').update({ no_leidos: 0 }).eq('id', conversacionId);
}

// Deja el mensaje en 'pendiente': lo manda de verdad el worker (cola.js),
// respetando los límites anti-bloqueo. Acá solo se deja la fila lista y se
// refleja el "último mensaje" en la lista de chats al toque.
async function crmEnviarMensaje(conversacionId, texto) {
  const uid = await _uid();
  const { error } = await window.sb.from('mensajes').insert({
    conversacion_id: conversacionId, direccion: 'saliente', tipo: 'texto', texto, estado: 'pendiente', enviado_por: uid,
  });
  if (error) { console.error('crmEnviarMensaje', error); throw error; }
  // "Vos: ..." en la lista de chats (como el render 5.1), y contestar deja
  // el chat como leído.
  await window.sb.from('conversaciones').update({ ultimo_texto: 'Vos: ' + texto, ultimo_at: new Date().toISOString(), no_leidos: 0 }).eq('id', conversacionId);
}

// Para "+ Nuevo chat": arranca una conversación a mano con un teléfono que
// todavía no escribió. Si el teléfono matchea un cliente existente, queda vinculada.
async function crmCrearConversacion(telefonoCrudo) {
  const uid = await _uid();
  const tel = (window.normalizarTelefonoAR && window.normalizarTelefonoAR(telefonoCrudo)) || null;
  if (!tel) throw new Error('Teléfono inválido');
  const { data: existente } = await window.sb.from('conversaciones').select('*').eq('user_id', uid).eq('telefono', tel).maybeSingle();
  if (existente) return existente;

  const { data: telCliente } = await window.sb.from('clientes_telefonos').select('cliente_id').eq('telefono', tel).maybeSingle();
  const { data: nueva, error } = await window.sb.from('conversaciones').insert({
    user_id: uid, jid: tel + '@s.whatsapp.net', telefono: tel, cliente_id: telCliente ? telCliente.cliente_id : null,
  }).select('*').single();
  if (error) throw error;
  return nueva;
}

// Eventos de regla de un cliente, para intercalarlos con los mensajes del
// chat (los avisos "Regla automática: ..." del render 5.1).
async function crmListEventosConversacion(clienteId) {
  const { data, error } = await window.sb
    .from('eventos').select('*').eq('cliente_id', clienteId).eq('tipo', 'regla').order('creado_at', { ascending: true });
  if (error) { console.error('crmListEventosConversacion', error); return []; }
  return data || [];
}

// Ficha lateral del chat (5.1) y ficha completa de Clientes (5.3): cliente +
// su préstamo activo con el plan de cuotas + historial de préstamos previos.
async function crmGetFichaCliente(clienteId) {
  const [{ data: cliente }, { data: prestamos }, { data: eventos }] = await Promise.all([
    window.sb.from('clientes').select('*, etapas(id, clave, nombre, color)').eq('id', clienteId).maybeSingle(),
    window.sb.from('prestamos').select('*').eq('cliente_id', clienteId).order('fecha_alta', { ascending: false, nullsFirst: false }),
    window.sb.from('eventos').select('*').eq('cliente_id', clienteId).order('creado_at', { ascending: false }).limit(50),
  ]);
  if (!cliente) return null;
  // Entre los préstamos "activos", puede haber alguno cargado solo desde la
  // Hoja de Ruta (sin fecha de alta ni saldo, porque esa planilla no trae
  // esos datos) — se prioriza el que sí tiene saldo real cargado, para no
  // mostrar la ficha con $0 en todo cuando en realidad hay otro préstamo
  // con el saldo completo.
  const activo = _prestamoPrincipal(prestamos || []);
  let cuotas = [];
  if (activo) {
    const { data } = await window.sb.from('cuotas').select('*').eq('prestamo_id', activo.id).order('numero', { ascending: true });
    cuotas = data || [];
  }
  // Atraso calculado al día de HOY desde las cuotas (js/mora.js), así la
  // ficha nunca muestra números viejos aunque el worker todavía no haya
  // corrido el recálculo diario. Si no hay plan de cuotas, mora = null y se
  // usan los campos del préstamo tal cual vinieron del Excel.
  const mora = (window.CMMora && cuotas.length) ? window.CMMora.calcularMora(cuotas) : null;
  if (mora) cuotas = mora.cuotas;
  return { cliente, prestamos: prestamos || [], prestamoActivo: activo, cuotas, mora, eventos: eventos || [] };
}

// Préstamo "principal" de un cliente: el activo con saldo real cargado
// (puede haber alguno cargado solo desde la Hoja de Ruta, sin saldo); si no
// hay activos, el más reciente (ej. uno ya cancelado).
function _prestamoPrincipal(prestamos) {
  const activos = prestamos.filter(p => p.estado === 'activo');
  const conSaldo = activos.filter(p => p.saldo_total !== null).sort((a, b) => (b.saldo_total || 0) - (a.saldo_total || 0));
  return conSaldo[0] || activos[0] || prestamos[0] || null;
}

async function crmActualizarCliente(clienteId, cambios) {
  const { error } = await window.sb.from('clientes').update(cambios).eq('id', clienteId);
  if (error) { console.error('crmActualizarCliente', error); throw error; }
}

async function crmListTelefonosCliente(clienteId) {
  const { data, error } = await window.sb.from('clientes_telefonos').select('*').eq('cliente_id', clienteId).order('principal', { ascending: false });
  if (error) { console.error('crmListTelefonosCliente', error); return []; }
  return data || [];
}

async function crmAgregarNotaCliente(clienteId, texto) {
  const uid = await _uid();
  const autor = crmNombreCorto(await crmGetNombreUsuario());
  await window.sb.from('eventos').insert({ user_id: uid, cliente_id: clienteId, tipo: 'nota', detalle: { texto, autor } });
}

async function _registrarEvento(clienteId, tipo, detalle) {
  const uid = await _uid();
  const { error } = await window.sb.from('eventos').insert({ user_id: uid, cliente_id: clienteId, tipo, detalle: detalle || {} });
  if (error) console.error('_registrarEvento', tipo, error);
}

// Cambio de etapa hecho a mano (Bandeja, Ficha): queda en el historial de
// gestión. etapaRowId = id de fila de `etapas`.
async function crmMoverEtapa(clienteId, etapaRowId) {
  const { data: antes } = await window.sb.from('clientes').select('etapa_id, etapas(clave, nombre)').eq('id', clienteId).maybeSingle();
  if (antes && antes.etapa_id === etapaRowId) return;
  await crmActualizarCliente(clienteId, { etapa_id: etapaRowId });
  const { data: destino } = await window.sb.from('etapas').select('clave, nombre').eq('id', etapaRowId).maybeSingle();
  await _registrarEvento(clienteId, 'etapa', {
    de: antes && antes.etapas ? antes.etapas.clave : null,
    a: destino ? destino.clave : null,
    a_nombre: destino ? destino.nombre : null,
    manual: true,
  });
}

// Promesa de pago cargada a mano: también queda en el historial.
async function crmGuardarPromesa(clienteId, fechaISO) {
  await crmActualizarCliente(clienteId, { promesa_fecha: fechaISO || null });
  if (fechaISO) await _registrarEvento(clienteId, 'promesa', { fecha: fechaISO, manual: true });
}

// "✅ Confirmar pago" (Bandeja, Kanban al pasar a Cerrado, Ficha).
//   opciones = { clienteId, monto, cancelaTotal, origen: 'whatsapp'|'kanban'|'manual' }
// - imputa el pago a las cuotas impagas más viejas del préstamo principal
//   (o salda todas si cancelaTotal) y recalcula el préstamo con js/mora.js;
// - si quedó todo pago, el préstamo pasa a 'cancelado' y el cliente lleva la
//   etiqueta "Cancelado";
// - registra el pago en `pagos` (Sueldo & Cobros lo suma solo) y los
//   eventos "pago" y "etapa" en el historial de gestión;
// - mueve al cliente a "Cerrado (Cobrado)" y saca la etiqueta "Comprobante"
//   (ya se verificó).
// Devuelve { prestamo, mora, cancelado }.
async function crmConfirmarPago(opciones) {
  const { clienteId, cancelaTotal, origen } = opciones;
  let monto = Math.max(0, Number(opciones.monto) || 0);
  const uid = await _uid();
  const hoy = window.CMMora ? window.CMMora.hoyISO() : new Date().toISOString().slice(0, 10);
  const [{ data: cliente }, { data: prestamos }, { data: etapas }] = await Promise.all([
    window.sb.from('clientes').select('id, nombre, etapa_id, etiquetas, etapas(clave)').eq('id', clienteId).maybeSingle(),
    window.sb.from('prestamos').select('*').eq('cliente_id', clienteId),
    window.sb.from('etapas').select('id, clave, nombre').eq('user_id', uid),
  ]);
  if (!cliente) throw new Error('Cliente no encontrado');
  const prestamo = _prestamoPrincipal((prestamos || []).filter(p => p.estado === 'activo'));

  let mora = null;
  if (prestamo && window.CMMora) {
    const { data: cuotas } = await window.sb.from('cuotas').select('*').eq('prestamo_id', prestamo.id).order('numero');
    if (cuotas && cuotas.length) {
      const saldo = cuotas.reduce((s, c) => s + Math.max(0, (Number(c.monto) || 0) - (Number(c.monto_pagado) || 0)), 0);
      const aImputar = cancelaTotal ? saldo : monto;
      if (cancelaTotal && !monto) monto = saldo;
      const { cuotas: nuevas } = window.CMMora.aplicarPago(cuotas, aImputar, hoy, hoy);
      mora = window.CMMora.calcularMora(nuevas, hoy);
      await Promise.all(mora.cuotas.map(c => window.sb.from('cuotas')
        .update({ monto_pagado: c.monto_pagado, estado: c.estado, pagado_el: c.pagado_el || null }).eq('id', c.id)));
      await window.sb.from('prestamos').update({
        cuotas_pagas: mora.cuotas_pagas, cuotas_vencidas: mora.cuotas_vencidas,
        dias_atraso: mora.dias_atraso, importe_atraso: mora.importe_atraso,
        proximo_vencimiento: mora.proximo_vencimiento, saldo_total: mora.saldo_total,
        ultimo_pago: hoy, estado: mora.cancelado ? 'cancelado' : 'activo',
        actualizado_at: new Date().toISOString(),
      }).eq('id', prestamo.id);
    }
  }
  const cancelado = mora ? mora.cancelado : !!cancelaTotal;
  if (!mora && prestamo && cancelaTotal) {
    await window.sb.from('prestamos').update({ estado: 'cancelado', importe_atraso: 0, dias_atraso: 0, ultimo_pago: hoy }).eq('id', prestamo.id);
  }

  await window.sb.from('pagos').insert({
    user_id: uid, cliente_id: clienteId, prestamo_id: prestamo ? prestamo.id : null,
    nombre: cliente.nombre, monto, fecha: hoy, estado: 'Cobrado', origen: origen || 'manual',
  });

  const etapaCerrado = (etapas || []).find(e => e.clave === 'cerrado');
  let etiquetas = (cliente.etiquetas || []).filter(e => String(e).toLowerCase() !== 'comprobante');
  if (cancelado && !etiquetas.some(e => String(e).toLowerCase() === 'cancelado')) etiquetas = [...etiquetas, 'Cancelado'];
  const cambios = { etiquetas };
  if (etapaCerrado) cambios.etapa_id = etapaCerrado.id;
  await crmActualizarCliente(clienteId, cambios);

  await _registrarEvento(clienteId, 'pago', {
    monto, origen: origen || 'manual', prestamo: prestamo ? prestamo.nro : null,
    cancelado, cuotas_pagas: mora ? mora.cuotas_pagas_decimal : null, cant_cuotas: prestamo ? prestamo.cant_cuotas : null,
  });
  if (etapaCerrado && cliente.etapa_id !== etapaCerrado.id) {
    await _registrarEvento(clienteId, 'etapa', { de: cliente.etapas ? cliente.etapas.clave : null, a: 'cerrado', a_nombre: etapaCerrado.nombre, manual: true });
  }
  return { prestamo, mora, cancelado };
}

// Buscador para "Agendar" (vincular un chat a un cliente existente).
async function crmBuscarClientes(texto) {
  const uid = await _uid();
  const q = String(texto || '').trim();
  if (!q) return [];
  const soloDigitos = q.replace(/\D/g, '');
  let consulta = window.sb.from('clientes').select('id, nombre, dni, telefono_principal').eq('user_id', uid).limit(20);
  consulta = soloDigitos.length >= 4 ? consulta.ilike('dni', `%${soloDigitos}%`) : consulta.ilike('nombre', `%${q}%`);
  const { data, error } = await consulta.order('nombre');
  if (error) { console.error('crmBuscarClientes', error); return []; }
  return data || [];
}

// "👤 Agendar" un chat que no está vinculado a ningún cliente:
//   { conversacionId, clienteId }               -> lo vincula a uno existente
//   { conversacionId, nuevo: { nombre, dni } }  -> crea el cliente (en "A contactar")
// Si el chat tiene teléfono, queda cargado en la ficha del cliente, así los
// mensajes que lleguen después de ese número se vinculan solos.
async function crmAgendarConversacion(opciones) {
  const uid = await _uid();
  const { data: conv } = await window.sb.from('conversaciones').select('*').eq('id', opciones.conversacionId).maybeSingle();
  if (!conv) throw new Error('Chat no encontrado');
  let clienteId = opciones.clienteId;
  if (!clienteId) {
    const nuevo = opciones.nuevo || {};
    const nombre = String(nuevo.nombre || '').trim();
    if (!nombre) throw new Error('Falta el nombre');
    const { data: etapa } = await window.sb.from('etapas').select('id').eq('user_id', uid).eq('clave', 'a_contactar').maybeSingle();
    const { data: creado, error } = await window.sb.from('clientes').insert({
      user_id: uid, nombre, dni: String(nuevo.dni || '').replace(/\D/g, '') || null,
      telefono_principal: conv.telefono || null, etapa_id: etapa ? etapa.id : null,
      campos_extra: { monto: '', montoPagado: '', customFields: {}, stageChangedAt: Date.now() },
    }).select('id').single();
    if (error) throw error;
    clienteId = creado.id;
  }
  if (conv.telefono) {
    const { data: tels } = await window.sb.from('clientes_telefonos').select('telefono, principal').eq('cliente_id', clienteId);
    const yaEsta = (tels || []).some(t => t.telefono === conv.telefono);
    if (!yaEsta) {
      await window.sb.from('clientes_telefonos').insert({ cliente_id: clienteId, telefono: conv.telefono, etiqueta: 'Celular', principal: !(tels || []).some(t => t.principal) });
    }
  }
  const { error: errConv } = await window.sb.from('conversaciones').update({ cliente_id: clienteId }).eq('id', conv.id);
  if (errConv) throw errConv;
  return clienteId;
}

// ───────────────────────── recordatorios (Calendario, 5.5) ─────────────────────────

async function crmListRecordatorios(desdeISO, hastaISO) {
  const uid = await _uid();
  let q = window.sb.from('recordatorios').select('*, clientes(id, nombre)').eq('user_id', uid);
  if (desdeISO) q = q.gte('fecha', desdeISO);
  if (hastaISO) q = q.lte('fecha', hastaISO);
  const { data, error } = await q.order('fecha');
  if (error) { console.error('crmListRecordatorios', error); return []; }
  return data || [];
}

async function crmCrearRecordatorio({ fecha, texto, clienteId }) {
  const uid = await _uid();
  const { error } = await window.sb.from('recordatorios').insert({ user_id: uid, cliente_id: clienteId || null, fecha, tipo: 'manual', texto: texto || null });
  if (error) { console.error('crmCrearRecordatorio', error); throw error; }
}

async function crmMarcarRecordatorio(id, hecho) {
  await window.sb.from('recordatorios').update({ hecho: !!hecho }).eq('id', id);
}

async function crmEliminarRecordatorio(id) {
  await window.sb.from('recordatorios').delete().eq('id', id);
}

// Historial de gestión completo de un cliente (render 5.3): eventos (reglas,
// etapas, promesas, notas, pagos) + los mensajes de sus chats + los pagos
// registrados, en una sola línea de tiempo, del más nuevo al más viejo.
//   [{ tipo: 'regla'|'etapa'|'promesa'|'nota'|'pago'|'mensaje', fecha, detalle }]
async function crmGetTimelineCliente(clienteId, limiteMensajes) {
  const [{ data: eventos }, { data: convs }, { data: pagos }] = await Promise.all([
    window.sb.from('eventos').select('*').eq('cliente_id', clienteId).order('creado_at', { ascending: false }).limit(200),
    window.sb.from('conversaciones').select('id').eq('cliente_id', clienteId),
    window.sb.from('pagos').select('*').eq('cliente_id', clienteId).order('creado_at', { ascending: false }),
  ]);
  let mensajes = [];
  const ids = (convs || []).map(c => c.id);
  if (ids.length) {
    const { data } = await window.sb.from('mensajes').select('id, direccion, tipo, texto, media_path, estado, creado_at, enviado_por')
      .in('conversacion_id', ids).order('creado_at', { ascending: false }).limit(limiteMensajes || 40);
    mensajes = data || [];
  }
  const items = [];
  (eventos || []).forEach(e => items.push({ tipo: e.tipo, fecha: e.creado_at, detalle: e.detalle || {}, id: 'e' + e.id }));
  mensajes.forEach(m => items.push({ tipo: 'mensaje', fecha: m.creado_at, detalle: m, id: 'm' + m.id }));
  // Los pagos que ya tienen su evento "pago" no se repiten.
  const pagosConEvento = (eventos || []).filter(e => e.tipo === 'pago').length;
  (pagos || []).slice(pagosConEvento).forEach(p => items.push({ tipo: 'pago', fecha: p.creado_at, detalle: { monto: p.monto, origen: p.origen, fecha: p.fecha }, id: 'p' + p.id }));
  return items.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
}

// ───────────────────────── agenda (no clientes) ─────────────────────────
// Equipo, gerencia y otros contactos que no son clientes (009_agenda_contactos.sql).
// Si todavía no se corrió esa migración, crmListContactos devuelve [] y
// marca crmListContactos.faltaTabla = true para que la pantalla lo avise.

function _esFaltaTabla(error) {
  return error && (error.code === '42P01' || error.code === 'PGRST205' || /contactos/.test(error.message || '') && /does not exist|schema cache/.test(error.message || ''));
}

async function crmListContactos() {
  const uid = await _uid();
  const { data, error } = await window.sb.from('contactos').select('*').eq('user_id', uid).order('nombre');
  crmListContactos.faltaTabla = _esFaltaTabla(error);
  if (error) { if (!crmListContactos.faltaTabla) console.error('crmListContactos', error); return []; }
  return data || [];
}

// Crea o actualiza (si trae id). El teléfono se guarda normalizado para
// poder cruzarlo con los chats.
async function crmGuardarContacto(c) {
  const uid = await _uid();
  const telefono = c.telefono ? ((window.normalizarTelefonoAR && window.normalizarTelefonoAR(c.telefono)) || null) : null;
  if (c.telefono && !telefono) throw new Error('Teléfono inválido');
  const fila = {
    user_id: uid, nombre: String(c.nombre || '').trim(), telefono,
    grupo: c.grupo || 'equipo', cargo: c.cargo || null, notas: c.notas || null,
    actualizado_at: new Date().toISOString(),
  };
  if (!fila.nombre) throw new Error('Falta el nombre');
  const q = c.id ? window.sb.from('contactos').update(fila).eq('id', c.id) : window.sb.from('contactos').insert(fila);
  const { data, error } = await q.select().single();
  if (error) {
    if (error.code === '23505') throw new Error('Ya hay un contacto con ese teléfono');
    console.error('crmGuardarContacto', error); throw error;
  }
  return data;
}

async function crmEliminarContacto(id) {
  const { error } = await window.sb.from('contactos').delete().eq('id', id);
  if (error) { console.error('crmEliminarContacto', error); throw error; }
}

// Canales de Realtime: avisan cambios en vivo sin tener que hacer polling.
function crmSuscribirConversaciones(userId, onChange) {
  return window.sb.channel('conversaciones-' + userId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'conversaciones', filter: `user_id=eq.${userId}` }, onChange)
    .subscribe();
}
// INSERT (mensajes nuevos) y UPDATE (tildes: enviado -> entregado -> leído).
function crmSuscribirMensajes(conversacionId, onChange) {
  return window.sb.channel('mensajes-' + conversacionId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'mensajes', filter: `conversacion_id=eq.${conversacionId}` }, onChange)
    .subscribe();
}

// Resumen liviano del préstamo principal por cliente, para Kanban, Bandeja
// y Calendario (sección 5.2: "DNI · Nº de préstamo" y el pill de atraso).
// Trae activos y cancelados: si el cliente ya no tiene ninguno activo, el
// resumen es el cancelado (estado: 'cancelado') y se muestra "Cancelado".
async function crmListResumenPrestamos() {
  const uid = await _uid();
  const { data, error } = await window.sb
    .from('prestamos').select('cliente_id, nro, estado, dias_atraso, importe_atraso, saldo_total, proximo_vencimiento, cuota_monto, cuotas_pagas, cuotas_vencidas, cant_cuotas')
    .eq('user_id', uid).in('estado', ['activo', 'cancelado']);
  if (error) { console.error('crmListResumenPrestamos', error); return {}; }
  const porCliente = {};
  (data || []).forEach(p => { (porCliente[p.cliente_id] = porCliente[p.cliente_id] || []).push(p); });
  const out = {};
  Object.keys(porCliente).forEach(id => { out[id] = _prestamoPrincipal(porCliente[id]); });
  return out;
}

// Resumen liviano de chats por cliente, para la insignia de WhatsApp en
// las tarjetas del Kanban (sección 5.2: "último mensaje, un globo verde
// con los no leídos"). {cliente_id: {ultimoTexto, noLeidos, ultimoAt}}
async function crmListResumenChats() {
  const uid = await _uid();
  const { data, error } = await window.sb
    .from('conversaciones').select('cliente_id, ultimo_texto, no_leidos, ultimo_at')
    .eq('user_id', uid).not('cliente_id', 'is', null);
  if (error) { console.error('crmListResumenChats', error); return {}; }
  const out = {};
  (data || []).forEach(c => { out[c.cliente_id] = { ultimoTexto: c.ultimo_texto, noLeidos: c.no_leidos, ultimoAt: c.ultimo_at }; });
  return out;
}

// ───────────────────────── wa_sesion / reglas (Conexión WhatsApp, 5.4) ─────────────────────────

async function crmGetWaSesion() {
  const uid = await _uid();
  const { data, error } = await window.sb.from('wa_sesion').select('*').eq('user_id', uid).maybeSingle();
  if (error) { console.error('crmGetWaSesion', error); return null; }
  return data;
}

async function crmPedirComandoWa(comando) {
  const uid = await _uid();
  const { error } = await window.sb.from('wa_sesion').upsert({ user_id: uid, comando });
  if (error) { console.error('crmPedirComandoWa', error); throw error; }
}

async function crmActualizarLimitesWa(cambios) {
  const uid = await _uid();
  const { error } = await window.sb.from('wa_sesion').upsert({ user_id: uid, ...cambios });
  if (error) { console.error('crmActualizarLimitesWa', error); throw error; }
}

async function crmListReglas() {
  const uid = await _uid();
  const { data, error } = await window.sb.from('reglas').select('*').eq('user_id', uid).order('prioridad', { ascending: true });
  if (error) { console.error('crmListReglas', error); return []; }
  return data || [];
}

async function crmGuardarRegla(regla) {
  const uid = await _uid();
  const fila = { ...regla, user_id: uid };
  const { error } = await window.sb.from('reglas').upsert(fila);
  if (error) { console.error('crmGuardarRegla', error); throw error; }
}

async function crmEliminarRegla(id) {
  await window.sb.from('reglas').delete().eq('id', id);
}

async function crmReordenarReglas(idsEnOrden) {
  await Promise.all(idsEnOrden.map((id, i) => window.sb.from('reglas').update({ prioridad: i + 1 }).eq('id', id)));
}

// ───────────────────────── usuarios ─────────────────────────

async function crmGetNombreUsuario() {
  const uid = await _uid();
  const { data, error } = await window.sb.from('usuarios').select('nombre').eq('id', uid).maybeSingle();
  if (error) { console.error('crmGetNombreUsuario', error); return ''; }
  return (data && data.nombre) || '';
}

async function crmSetNombreUsuario(nombre) {
  const uid = await _uid();
  const { error } = await window.sb.from('usuarios').upsert({ id: uid, nombre: nombre || '' });
  if (error) console.error('crmSetNombreUsuario', error);
}

if (typeof window !== 'undefined') {
  Object.assign(window, {
    crmBootstrap, crmListEtapas, crmSaveEtapas,
    crmListClientes, crmSaveClientes, crmDeleteCliente,
    crmListPlantillas, crmSavePlantillas,
    crmListPagos, crmAddPago,
    crmGetNombreUsuario, crmSetNombreUsuario,
    crmListContactos, crmGuardarContacto, crmEliminarContacto,
    crmListConversaciones, crmListMensajes, crmMarcarConversacionLeida, crmListResumenChats, crmListResumenPrestamos,
    crmEnviarMensaje, crmCrearConversacion,
    crmGetFichaCliente, crmActualizarCliente, crmAgregarNotaCliente, crmListTelefonosCliente,
    crmListEventosConversacion,
    crmNombreCorto, crmIniciales, crmMoverEtapa, crmGuardarPromesa, crmConfirmarPago,
    crmBuscarClientes, crmAgendarConversacion, crmGetTimelineCliente,
    crmListRecordatorios, crmCrearRecordatorio, crmMarcarRecordatorio, crmEliminarRecordatorio,
    crmGetWaSesion, crmPedirComandoWa, crmActualizarLimitesWa,
    crmListReglas, crmGuardarRegla, crmEliminarRegla, crmReordenarReglas,
    crmSuscribirConversaciones, crmSuscribirMensajes,
  });
}
