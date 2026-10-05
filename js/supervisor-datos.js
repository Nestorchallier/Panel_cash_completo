// Datos del rol supervisor, compartidos por index.html (pantalla "¿Qué
// querés ver?" y el selector "Cambiar agente") y supervisor.html (Panel de
// supervisor). Todo es lectura: el supervisor puede leer las filas de todos
// gracias a las políticas "supervisor lee" de 011_supervisor.sql.
//
// Cada consulta filtra por user_id explícito (uno o la lista de agentes):
// con el supervisor RLS deja ver todo, así que no alcanza con confiar en él.
(function () {
  const TZ = 'America/Argentina/Buenos_Aires';
  const LATIDO_VIEJO_MS = 3 * 60000; // sin latido hace más de esto: desconectado
  const INACTIVO_MS = 5 * 60000;      // sin tocar nada hace más de esto: inactivo
  const STATE_KEY = 'panelComisionesCobros_state_v1'; // Registro de pagos / Objetivos (index.html)

  const hoyAR = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const periodoAR = () => hoyAR().slice(0, 7); // 'AAAA-MM' del mes en curso
  const horaAR = (iso) => new Date(iso).toLocaleTimeString('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

  // ¿El usuario logueado es supervisor? Si todavía no se corrió
  // 011_supervisor.sql la función no existe: se lo trata como cobrador.
  async function supEsSupervisor() {
    try {
      const { data, error } = await window.sb.rpc('es_supervisor');
      if (error) return false;
      return data === true;
    } catch (e) { return false; }
  }

  // Agentes (cobradores): todos los que entraron alguna vez al panel
  // (usuarios) más los que estén en perfiles, sin los supervisores.
  async function supListarAgentes() {
    const [rU, rP] = await Promise.all([
      window.sb.from('usuarios').select('id, nombre'),
      window.sb.from('perfiles').select('user_id, nombre, rol'),
    ]);
    if (rU.error) console.error('supListarAgentes usuarios', rU.error);
    const perfiles = new Map(((rP && rP.data) || []).map(p => [p.user_id, p]));
    const porId = new Map();
    ((rU && rU.data) || []).forEach(u => porId.set(u.id, { id: u.id, nombre: u.nombre || '' }));
    perfiles.forEach((p, id) => {
      const a = porId.get(id) || { id, nombre: '' };
      if (p.nombre) a.nombre = p.nombre;
      porId.set(id, a);
    });
    return [...porId.values()]
      .filter(a => !(perfiles.get(a.id) && perfiles.get(a.id).rol === 'supervisor'))
      .map(a => ({ ...a, nombre: a.nombre || 'Sin nombre' }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }

  // { uid: { estado: 'conectado'|'inactivo'|'desconectado'|'sin_datos', texto, minutos, latidoAt } }
  async function supEstadosConexion(ids) {
    const out = {};
    ids.forEach(id => { out[id] = { estado: 'sin_datos', texto: 'Sin conexión hoy' }; });
    if (!ids.length) return out;
    const { data, error } = await window.sb.from('actividad_latido')
      .select('user_id, latido_at, ultimo_input_at, sesion_desde').in('user_id', ids);
    if (error) { console.warn('actividad_latido', error); return out; }
    const ahora = Date.now();
    const hoy = hoyAR();
    (data || []).forEach(l => {
      const lat = new Date(l.latido_at).getTime();
      const inp = l.ultimo_input_at ? new Date(l.ultimo_input_at).getTime() : lat;
      if (ahora - lat > LATIDO_VIEJO_MS) {
        const deHoy = new Date(l.latido_at).toLocaleDateString('en-CA', { timeZone: TZ }) === hoy;
        out[l.user_id] = { estado: 'desconectado', latidoAt: l.latido_at,
          texto: deHoy ? 'Desconectado desde ' + horaAR(l.latido_at) : 'Sin conexión hoy' };
      } else if (ahora - inp >= INACTIVO_MS) {
        const min = Math.floor((ahora - inp) / 60000);
        out[l.user_id] = { estado: 'inactivo', minutos: min, latidoAt: l.latido_at, texto: 'Inactivo ' + min + ' min' };
      } else {
        out[l.user_id] = { estado: 'conectado', latidoAt: l.latido_at, texto: 'Conectado' };
      }
    });
    return out;
  }

  // Tramos de actividad de hoy, por agente: { uid: [{inicio, fin}] } ordenados.
  async function supActividadHoy(ids) {
    const out = {};
    ids.forEach(id => { out[id] = []; });
    if (!ids.length) return out;
    const { data, error } = await window.sb.from('actividad')
      .select('user_id, inicio, fin').in('user_id', ids).eq('dia', hoyAR())
      .order('inicio', { ascending: true }).range(0, 4999);
    if (error) { console.warn('actividad', error); return out; }
    (data || []).forEach(t => { if (out[t.user_id]) out[t.user_id].push(t); });
    return out;
  }

  // Cobrado y objetivo de cada agente, de la misma fuente que Registro de
  // pagos / Objetivos (index.html): el estado guardado en kv_store, más los
  // pagos del CRM (tabla pagos) que todavía no se sumaron al registro
  // (index.html los integra al abrirse: integrarPagosCRM, con la misma regla
  // de duplicados: mismo nombre y monto que uno ya registrado queda aparte
  // y no suma). Además devuelve lo que usa la pantalla Objetivos del agente:
  // registrado (todos los pagos, cobrados o no), la escala de metas (con los
  // montos recalculados si el supervisor fijó el objetivo) y las facturas de
  // sus recorridos.
  async function supCobradoYObjetivo(ids) {
    const out = {};
    const vacio = () => ({ cobrado: 0, registrado: 0, objetivo: 0, objetivoPropio: 0, fijado: false, corte: '', escalas: [], factObjetivo: 0, factCobradas: 0, tieneEstado: false });
    ids.forEach(id => { out[id] = vacio(); });
    if (!ids.length) return out;
    const [rKv, rPagos, fijados] = await Promise.all([
      window.sb.from('kv_store').select('user_id, value').eq('key', STATE_KEY).in('user_id', ids),
      window.sb.from('pagos').select('id, user_id, nombre, monto, estado, origen').in('user_id', ids).neq('origen', 'excel').range(0, 9999),
      supObjetivosFijados(ids, periodoAR()),
    ]);
    if (rKv.error) console.warn('kv_store estado', rKv.error);
    const integrados = {}, registrados = {};
    ((rKv && rKv.data) || []).forEach(r => {
      const st = r.value || {};
      const pagos = Array.isArray(st.payments) ? st.payments : [];
      const rutas = Array.isArray(st.routes) ? st.routes : [];
      out[r.user_id] = Object.assign(vacio(), {
        cobrado: pagos.filter(p => p.estado === 'Cobrado').reduce((s, p) => s + (Number(p.monto) || 0), 0),
        registrado: pagos.reduce((s, p) => s + (Number(p.monto) || 0), 0),
        objetivo: Number(st.objetivoTotal) || 0,
        objetivoPropio: Number(st.objetivoTotal) || 0, // el del panel del agente
        corte: st.cutoffDate || '',
        escalas: (Array.isArray(st.scaleRows) ? st.scaleRows : []).map(s => ({ escala: Number(s.escala) || 0, meta: Number(s.meta) || 0 })),
        factObjetivo: rutas.reduce((s, x) => s + (Number(x.objetivo) || 0), 0),
        factCobradas: rutas.reduce((s, x) => s + (Number(x.cobradas) || 0), 0),
        tieneEstado: true,
      });
      integrados[r.user_id] = new Set(Array.isArray(st.pagosCRMIntegrados) ? st.pagosCRMIntegrados : []);
      registrados[r.user_id] = pagos.map(p => ({ name: String(p.name || '').trim().toLowerCase(), monto: Math.round(Number(p.monto) || 0) }));
    });
    // Mismo orden que integrarPagosCRM (del más viejo al más nuevo).
    ((rPagos && rPagos.data) || []).slice().reverse().forEach(p => {
      const o = out[p.user_id];
      if (!o) return;
      if (integrados[p.user_id] && integrados[p.user_id].has(p.id)) return;
      const lista = registrados[p.user_id] || (registrados[p.user_id] = []);
      const name = String(p.nombre || '(sin nombre)').trim().toLowerCase();
      const monto = Number(p.monto) || 0;
      if (lista.some(x => x.name === name && x.monto === Math.round(monto))) return; // duplicado: no suma
      lista.push({ name, monto: Math.round(monto) });
      o.registrado += monto;
      if (String(p.estado || '').toLowerCase() === 'cobrado') o.cobrado += monto;
    });
    // El objetivo que fijó el supervisor para este mes manda sobre el que
    // el agente tenga cargado en su panel (y los montos de su escala pasan
    // a ser ese % del objetivo fijado, como en aplicarObjetivoSupervisor).
    Object.keys(fijados).forEach(id => {
      const o = out[id];
      if (!o || !(fijados[id] > 0)) return;
      o.objetivo = fijados[id]; o.fijado = true;
      if (o.objetivo !== o.objetivoPropio) o.escalas = o.escalas.map(s => ({ escala: s.escala, meta: Math.round(s.escala * o.objetivo) }));
    });
    return out;
  }

  // Objetivos fijados por el supervisor (tabla objetivos_agente, ver
  // 012_supervisor_gestion.sql) para un mes: { uid: monto }. Sin la tabla
  // todavía (migración sin correr) devuelve {} y todo sigue como antes.
  async function supObjetivosFijados(ids, periodo) {
    const out = {};
    if (!ids.length) return out;
    const { data, error } = await window.sb.from('objetivos_agente')
      .select('user_id, monto').eq('periodo', periodo).in('user_id', ids);
    if (error) { console.warn('objetivos_agente', error); return out; }
    (data || []).forEach(r => { out[r.user_id] = Number(r.monto) || 0; });
    return out;
  }

  // Promesas de pago para hoy (clientes.promesa_fecha) y cuántas se
  // cumplieron (hay un pago de ese cliente con fecha de hoy).
  async function supPromesasHoy(ids) {
    const out = {};
    ids.forEach(id => { out[id] = { total: 0, cumplidas: 0 }; });
    if (!ids.length) return out;
    const hoy = hoyAR();
    const [rC, rP] = await Promise.all([
      window.sb.from('clientes').select('id, user_id').in('user_id', ids).eq('promesa_fecha', hoy).range(0, 9999),
      window.sb.from('pagos').select('cliente_id, user_id').in('user_id', ids).eq('fecha', hoy).range(0, 9999),
    ]);
    const pagaron = new Set(((rP && rP.data) || []).map(p => p.user_id + '|' + p.cliente_id));
    ((rC && rC.data) || []).forEach(c => {
      if (!out[c.user_id]) return;
      out[c.user_id].total++;
      if (pagaron.has(c.user_id + '|' + c.id)) out[c.user_id].cumplidas++;
    });
    return out;
  }

  // Chats con mensajes sin leer (lo mismo que el globito de "WhatsApp CRM"
  // en el menú) y total de chats, por agente.
  async function supChats(ids) {
    const out = {};
    await Promise.all(ids.map(async id => {
      const [rS, rT] = await Promise.all([
        window.sb.from('conversaciones').select('id', { count: 'exact', head: true }).eq('user_id', id).gt('no_leidos', 0),
        window.sb.from('conversaciones').select('id', { count: 'exact', head: true }).eq('user_id', id),
      ]);
      out[id] = { sinResponder: (rS && rS.count) || 0, total: (rT && rT.count) || 0 };
    }));
    return out;
  }

  // Mensajes enviados y recibidos hoy por todo el equipo.
  async function supMensajesHoy(ids) {
    if (!ids.length) return { enviados: 0, recibidos: 0 };
    const desde = new Date(hoyAR() + 'T00:00:00-03:00').toISOString();
    const contar = (dir) => window.sb.from('mensajes')
      .select('id, conversaciones!inner(user_id)', { count: 'exact', head: true })
      .in('conversaciones.user_id', ids).eq('direccion', dir).gte('creado_at', desde);
    const [rE, rR] = await Promise.all([contar('saliente'), contar('entrante')]);
    return { enviados: (rE && rE.count) || 0, recibidos: (rR && rR.count) || 0 };
  }

  const nombreCorto = (n) => {
    const p = String(n || '').trim().split(/\s+/).filter(Boolean);
    return p.length > 1 ? `${p[0]} ${p[1][0]}.` : (p[0] || '—');
  };

  Object.assign(window, {
    supEsSupervisor, supListarAgentes, supEstadosConexion, supActividadHoy,
    supCobradoYObjetivo, supObjetivosFijados, supPromesasHoy, supChats, supMensajesHoy,
    supHoyAR: hoyAR, supPeriodoAR: periodoAR, supHoraAR: horaAR, supNombreCorto: nombreCorto,
  });
})();
