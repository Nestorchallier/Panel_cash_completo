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

async function kvGet(key) {
  const { data: { session } } = await window.sb.auth.getSession();
  if (!session) return null;
  const { data, error } = await window.sb
    .from('kv_store')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error) { console.error('kvGet', key, error); return null; }
  return data ? data.value : null;
}

async function kvSet(key, value) {
  const { data: { session } } = await window.sb.auth.getSession();
  if (!session) throw new Error('No autenticado');
  const { error } = await window.sb
    .from('kv_store')
    .upsert({ user_id: session.user.id, key, value });
  if (error) throw error;
}

async function kvRemove(key) {
  const { data: { session } } = await window.sb.auth.getSession();
  if (!session) return;
  await window.sb.from('kv_store').delete().eq('key', key);
}
