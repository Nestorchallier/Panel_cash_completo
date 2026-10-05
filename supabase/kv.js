// Cliente Supabase + helpers de kv_store compartidos entre index.html y
// kanban_clientes.html (mismo origen en GitHub Pages, así que comparten
// la misma sesión de auth vía localStorage, tal como antes compartían
// localStorage directamente).

window.sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Se resuelve la primera vez que hay una sesión confirmada (login inicial
// o sesión ya guardada). El resto del código espera esta promesa antes de
// cargar datos, para no pegarle a Supabase sin estar autenticado.
let _resolveAppReady;
window.appReady = new Promise((resolve) => { _resolveAppReady = resolve; });
window._markAppReady = () => { _resolveAppReady(); };

// ───────────────────────── Modo supervisor ─────────────────────────
// Un supervisor (ver supabase/011_supervisor.sql) puede LEER las filas de
// todos los cobradores. Por eso ninguna consulta puede confiar solo en RLS
// para quedarse con "lo mío": todas filtran por cmUidVista(), que es el
// propio usuario siempre, salvo cuando un supervisor eligió "ver el panel
// de" un agente: ahí es el id de ese agente.
//
// El agente elegido se anota en sessionStorage, que el panel comparte con
// sus pantallas internas (iframes, mismo origen), así todas ven al mismo.
// Lo ponen y lo sacan solo index.html / supervisor.html, después de
// confirmar que el usuario es supervisor (con un cobrador logueado se borra
// siempre, antes de cargar nada).
const CM_VISTA_KEY = 'cm_ver_agente_v1';

function cmVistaGuardada() {
  try { return JSON.parse(sessionStorage.getItem(CM_VISTA_KEY) || 'null'); } catch (e) { return null; }
}
// { sup, agente, nombre } o null.
window.cmVista = cmVistaGuardada;
// true mientras un supervisor mira el panel de otro: todo es solo lectura.
window.cmSoloLectura = function () {
  const v = cmVistaGuardada();
  return !!(v && v.agente);
};
window.cmVerAgente = function (supUid, agenteUid, nombre) {
  try { sessionStorage.setItem(CM_VISTA_KEY, JSON.stringify({ sup: supUid, agente: agenteUid, nombre: nombre || '' })); } catch (e) { }
};
window.cmDejarDeVer = function () {
  try { sessionStorage.removeItem(CM_VISTA_KEY); } catch (e) { }
};
// El usuario logueado (para lo que es de él aunque esté mirando a otro:
// su rol, su contador de actividad).
window.cmUidPropio = async function () {
  const { data: { session } } = await window.sb.auth.getSession();
  if (!session) throw new Error('No autenticado');
  return session.user.id;
};
// El usuario cuyos datos se muestran: el propio, o el agente que eligió el
// supervisor.
window.cmUidVista = async function () {
  const propio = await window.cmUidPropio();
  const v = cmVistaGuardada();
  return (v && v.agente && v.sup === propio) ? v.agente : propio;
};

// Mirando a otro, el panel no puede escribir NADA: se tapan insert /
// update / upsert / delete, los rpc y las subidas de archivos del cliente
// Supabase. Devuelven un error (como haría RLS) en vez de tirar una
// excepción, así las pantallas siguen andando. RLS igual lo rechazaría (el
// supervisor solo tiene permisos de lectura sobre lo ajeno): esto es para
// que ni se intente y el supervisor vea el aviso.
(function () {
  const ERROR = { code: 'SOLO_LECTURA', message: 'Modo supervisor: solo lectura' };
  let ultimoAviso = 0;
  function avisar() {
    if (Date.now() - ultimoAviso < 2500) return;
    ultimoAviso = Date.now();
    try {
      const d = document.createElement('div');
      d.className = 'cm-aviso-solo-lectura';
      d.textContent = '🔒 Modo supervisor: solo lectura. No se guardó ningún cambio.';
      d.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:99999;background:#92400e;color:#fff;font:600 13px system-ui,sans-serif;padding:10px 16px;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.25)';
      document.body.appendChild(d);
      setTimeout(() => d.remove(), 2600);
    } catch (e) { }
  }
  // Un "builder" que acepta cualquier encadenado (.eq().select().single()...)
  // y termina en { data: null, error }.
  function rechazo() {
    avisar();
    const res = Promise.resolve({ data: null, error: ERROR, count: null });
    const p = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'then') return res.then.bind(res);
        if (prop === 'catch') return res.catch.bind(res);
        if (prop === 'finally') return res.finally.bind(res);
        return () => p;
      },
      apply() { return p; },
    });
    return p;
  }
  const cliente = window.sb;
  const fromOriginal = cliente.from.bind(cliente);
  cliente.from = function (tabla) {
    const b = fromOriginal(tabla);
    if (!window.cmSoloLectura()) return b;
    ['insert', 'update', 'upsert', 'delete'].forEach((m) => { b[m] = rechazo; });
    return b;
  };
  const rpcOriginal = cliente.rpc.bind(cliente);
  cliente.rpc = function (fn, ...resto) {
    if (window.cmSoloLectura() && fn !== 'es_supervisor') return rechazo();
    return rpcOriginal(fn, ...resto);
  };
  // supabase-js arma un StorageClient nuevo cada vez que se lee sb.storage.
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(cliente), 'storage');
  let leerStorage;
  if (desc && desc.get) leerStorage = () => desc.get.call(cliente);
  else { const s = cliente.storage; leerStorage = () => s; }
  Object.defineProperty(cliente, 'storage', {
    configurable: true,
    get() {
      const st = leerStorage();
      if (!st || !window.cmSoloLectura()) return st;
      return {
        from(bucket) {
          const b = st.from(bucket);
          ['upload', 'update', 'remove', 'move', 'copy', 'uploadToSignedUrl'].forEach((m) => { b[m] = rechazo; });
          return b;
        },
      };
    },
  });

  if (window.cmSoloLectura()) {
    document.documentElement.classList.add('cm-solo-lectura');
    // Se esconden los botones que escriben de cada pantalla (los ids son
    // de cada .html; en las demás no matchean nada).
    const css = document.createElement('style');
    css.textContent = `
      /* WhatsApp CRM: sin caja para escribir */
      .cm-solo-lectura .wa-compose > *, .cm-solo-lectura #btnAgendarHead, .cm-solo-lectura #btnAgendaHead,
      .cm-solo-lectura #btnFijar, .cm-solo-lectura #btnNuevoChat, .cm-solo-lectura #fichaConfirmarPago,
      .cm-solo-lectura #fichaNota, .cm-solo-lectura .quitar-etiqueta { display: none !important; }
      .cm-solo-lectura #fichaEtapa, .cm-solo-lectura #cajaPromesa { pointer-events: none; opacity: .7; }
      .cm-solo-lectura .wa-compose::after { content: '🔒 Modo supervisor: solo lectura'; display: block; margin: 4px 0;
        padding: 11px 16px; border-radius: 22px; background: #fff; color: #64748b; font-size: 13.5px; border: 1px solid #e2e8f0; }
      /* Kanban / Calendario */
      .cm-solo-lectura #btnConfigTarjeta, .cm-solo-lectura #btnConfigColumnas, .cm-solo-lectura #btnMas,
      .cm-solo-lectura #btnImportCartera, .cm-solo-lectura #btnNuevoRecordatorio, .cm-solo-lectura #btnSaveClient,
      .cm-solo-lectura #btnAddStage, .cm-solo-lectura #btnConfirmCobrado, .cm-solo-lectura #btnGuardarRec,
      .cm-solo-lectura #btnConfirmMover, .cm-solo-lectura #btnConfirmOk, .cm-solo-lectura #btnConfirmImport,
      .cm-solo-lectura #btnConfirmImportPagos, .cm-solo-lectura #btnConfirmImportCartera,
      /* Clientes */
      .cm-solo-lectura #btnEditar, .cm-solo-lectura #btnAgregarTel, .cm-solo-lectura #btnGuardarNota,
      /* Agenda */
      .cm-solo-lectura #btnNuevo,
      /* Conexión WhatsApp */
      .cm-solo-lectura #btnNuevaRegla, .cm-solo-lectura #btnGuardarLimites, .cm-solo-lectura #btnGuardarRegla,
      .cm-solo-lectura #btnReiniciar, .cm-solo-lectura #btnDesvincular { display: none !important; }
      .cm-solo-lectura .card[draggable] { cursor: default; }
    `;
    document.head.appendChild(css);
    // Ni arrastrar tarjetas (Kanban) ni soltar archivos.
    ['dragstart', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); avisar(); }, true));
  }
  window.cmAvisarSoloLectura = avisar;
})();

// ───────────────────────── kv_store ─────────────────────────

async function kvGet(key) {
  const { data: { session } } = await window.sb.auth.getSession();
  if (!session) return null;
  const uid = await window.cmUidVista();
  const { data, error } = await window.sb
    .from('kv_store')
    .select('value')
    .eq('user_id', uid)
    .eq('key', key)
    .maybeSingle();
  if (error) { console.error('kvGet', key, error); return null; }
  return data ? data.value : null;
}

async function kvSet(key, value) {
  const { data: { session } } = await window.sb.auth.getSession();
  if (!session) throw new Error('No autenticado');
  if (window.cmSoloLectura()) { window.cmAvisarSoloLectura(); throw new Error('Modo supervisor: solo lectura'); }
  const { error } = await window.sb
    .from('kv_store')
    .upsert({ user_id: session.user.id, key, value });
  if (error) throw error;
}

async function kvRemove(key) {
  const { data: { session } } = await window.sb.auth.getSession();
  if (!session) return;
  if (window.cmSoloLectura()) return;
  await window.sb.from('kv_store').delete().eq('user_id', session.user.id).eq('key', key);
}
