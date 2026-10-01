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
    const rowId = esProtegida ? (porClave.get(s.id) || s.id) : (porId.has(s.id) ? s.id : undefined);
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
  };
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

// Guarda el array completo de clientes del Kanban (igual que antes hacía
// kvSet con todo state.clients). Hace upsert de todos: con pocos cientos de
// filas es más simple y seguro que diffear fila por fila, y evita que un
// borrado manual en otra pestaña quede "zombie" sin sincronizar.
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

  // Borra de la base los que ya no están en memoria (eliminados en el Kanban).
  const { data: existentes } = await window.sb.from('clientes').select('id').eq('user_id', uid);
  const idsVivos = new Set(clients.map(c => c.id));
  const idsABorrar = (existentes || []).map(r => r.id).filter(id => !idsVivos.has(id));
  if (idsABorrar.length) {
    await window.sb.from('clientes').delete().in('id', idsABorrar);
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
    .select('*, clientes(id, nombre, dni, etapa_id, promesa_fecha, etiquetas)')
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
  await window.sb.from('conversaciones').update({ ultimo_texto: texto, ultimo_at: new Date().toISOString() }).eq('id', conversacionId);
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
  const activos = (prestamos || []).filter(p => p.estado === 'activo');
  const conSaldo = activos.filter(p => p.saldo_total !== null).sort((a, b) => (b.saldo_total || 0) - (a.saldo_total || 0));
  const activo = conSaldo[0] || activos[0] || (prestamos || [])[0] || null;
  let cuotas = [];
  if (activo) {
    const { data } = await window.sb.from('cuotas').select('*').eq('prestamo_id', activo.id).order('numero', { ascending: true });
    cuotas = data || [];
  }
  return { cliente, prestamos: prestamos || [], prestamoActivo: activo, cuotas, eventos: eventos || [] };
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
  await window.sb.from('eventos').insert({ user_id: uid, cliente_id: clienteId, tipo: 'nota', detalle: { texto } });
}

// Canales de Realtime: avisan cambios en vivo sin tener que hacer polling.
function crmSuscribirConversaciones(userId, onChange) {
  return window.sb.channel('conversaciones-' + userId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'conversaciones', filter: `user_id=eq.${userId}` }, onChange)
    .subscribe();
}
function crmSuscribirMensajes(conversacionId, onChange) {
  return window.sb.channel('mensajes-' + conversacionId)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mensajes', filter: `conversacion_id=eq.${conversacionId}` }, onChange)
    .subscribe();
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
    crmListConversaciones, crmListMensajes, crmMarcarConversacionLeida, crmListResumenChats,
    crmEnviarMensaje, crmCrearConversacion,
    crmGetFichaCliente, crmActualizarCliente, crmAgregarNotaCliente, crmListTelefonosCliente,
    crmGetWaSesion, crmPedirComandoWa, crmActualizarLimitesWa,
    crmListReglas, crmGuardarRegla, crmEliminarRegla, crmReordenarReglas,
    crmSuscribirConversaciones, crmSuscribirMensajes,
  });
}
