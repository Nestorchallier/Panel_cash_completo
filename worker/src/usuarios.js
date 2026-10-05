// Usuarios del panel (pantalla 👥 Usuarios del Panel de supervisor).
//
// Crear un agente, cambiarle la contraseña o deshabilitarlo necesita la
// clave SERVICE de Supabase (auth.admin), que solo tiene este worker: el
// panel es público y no puede llevarla. Entonces el supervisor deja un
// pedido en la tabla comandos_usuarios (ver supabase/012_supervisor_gestion.sql)
// y acá se revisa cada pocos segundos, igual que wa_sesion.comando.
//
// Por cada pedido pendiente:
//   1) se lo toma (estado 'procesando') y en el MISMO update se borra la
//      contraseña de la fila — queda solo en memoria lo que dura el pedido;
//   2) se verifica que quien lo pidió sea supervisor (en perfiles, acá del
//      lado del servidor: no se confía en lo que diga el panel);
//   3) se validan los datos y se ejecuta;
//   4) se guarda estado 'ok' / 'error' y un mensaje para el panel.

const ACCIONES = ['crear', 'editar', 'deshabilitar', 'habilitar', 'reset_password'];
const ROLES = ['cobrador', 'supervisor'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BAN_PARA_SIEMPRE = '876000h'; // ~100 años: "deshabilitado" hasta que lo habiliten
const INTERVALO_MS = 5000;

class ErrorPedido extends Error { }
const falla = (msg) => { throw new ErrorPedido(msg); };

function validarPassword(p) {
  if (typeof p !== 'string' || p.length < 8) falla('La contraseña tiene que tener al menos 8 caracteres.');
  if (p.length > 72) falla('La contraseña es demasiado larga (máximo 72 caracteres).');
}
function validarNombre(n) {
  const s = String(n == null ? '' : n).trim();
  if (!s) falla('Falta el nombre.');
  if (s.length > 80) falla('El nombre es demasiado largo (máximo 80 caracteres).');
  return s;
}
function validarRol(r) {
  if (!ROLES.includes(r)) falla('Rol inválido: tiene que ser cobrador o supervisor.');
  return r;
}
function validarUserId(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) falla('Falta el usuario (id inválido).');
  return id;
}

async function esSupervisor(supabase, uid) {
  if (!uid) return false;
  const { data, error } = await supabase.from('perfiles').select('rol').eq('user_id', uid).maybeSingle();
  if (error) throw error;
  return !!(data && data.rol === 'supervisor');
}

// Supervisores habilitados que quedarían si a "sacar" se lo deshabilita o
// pasa a cobrador.
async function otrosSupervisoresActivos(supabase, sacar) {
  const { data, error } = await supabase.from('perfiles').select('user_id').eq('rol', 'supervisor');
  if (error) throw error;
  let n = 0;
  for (const p of data || []) {
    if (p.user_id === sacar) continue;
    const { data: u, error: e } = await supabase.auth.admin.getUserById(p.user_id);
    if (e || !u || !u.user) continue;
    const ban = u.user.banned_until ? new Date(u.user.banned_until).getTime() : 0;
    if (ban > Date.now()) continue;
    n++;
  }
  return n;
}

async function guardarPerfil(supabase, userId, { nombre, rol }) {
  const perfil = { user_id: userId };
  if (nombre != null) perfil.nombre = nombre;
  if (rol != null) perfil.rol = rol;
  const { error } = await supabase.from('perfiles').upsert(perfil, { onConflict: 'user_id' });
  if (error) throw error;
  if (nombre != null) {
    const { error: e2 } = await supabase.from('usuarios').upsert({ id: userId, nombre }, { onConflict: 'id' });
    if (e2) throw e2;
  }
}

// Ejecuta un pedido ya tomado. Devuelve { mensaje, user_id? } o tira
// ErrorPedido con el motivo para mostrarle al supervisor.
async function ejecutar(supabase, fila, password) {
  if (!ACCIONES.includes(fila.accion)) falla('Acción desconocida.');
  if (!(await esSupervisor(supabase, fila.creador))) falla('Solo un supervisor puede gestionar usuarios.');

  if (fila.accion === 'crear') {
    const email = String(fila.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 200) falla('Email inválido.');
    const nombre = validarNombre(fila.nombre);
    const rol = validarRol(fila.rol || 'cobrador');
    validarPassword(password);
    const { data, error } = await supabase.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { nombre },
    });
    if (error) {
      if (/already|registered|exists/i.test(error.message || '')) falla('Ya existe un usuario con ese email.');
      throw error;
    }
    const id = data.user.id;
    await guardarPerfil(supabase, id, { nombre, rol });
    return { mensaje: `Usuario ${email} creado como ${rol}.`, user_id: id };
  }

  const userId = validarUserId(fila.user_id);
  const { data: u, error: eU } = await supabase.auth.admin.getUserById(userId);
  if (eU || !u || !u.user) falla('No existe ese usuario.');
  const { data: perfilActual } = await supabase.from('perfiles').select('rol').eq('user_id', userId).maybeSingle();
  const eraSupervisor = !!(perfilActual && perfilActual.rol === 'supervisor');

  if (fila.accion === 'editar') {
    const nombre = validarNombre(fila.nombre);
    const rol = validarRol(fila.rol);
    if (eraSupervisor && rol !== 'supervisor') {
      if (userId === fila.creador) falla('No podés sacarte el rol de supervisor a vos mismo.');
      if ((await otrosSupervisoresActivos(supabase, userId)) === 0) falla('Es el último supervisor: no se le puede sacar el rol.');
    }
    await guardarPerfil(supabase, userId, { nombre, rol });
    return { mensaje: `Datos de ${u.user.email} guardados.` };
  }

  if (fila.accion === 'deshabilitar') {
    if (userId === fila.creador) falla('No podés deshabilitarte a vos mismo.');
    if (eraSupervisor && (await otrosSupervisoresActivos(supabase, userId)) === 0) falla('Es el último supervisor habilitado: no se lo puede deshabilitar.');
    const { error } = await supabase.auth.admin.updateUserById(userId, { ban_duration: BAN_PARA_SIEMPRE });
    if (error) throw error;
    return { mensaje: `${u.user.email} deshabilitado: ya no puede entrar.` };
  }

  if (fila.accion === 'habilitar') {
    const { error } = await supabase.auth.admin.updateUserById(userId, { ban_duration: 'none' });
    if (error) throw error;
    return { mensaje: `${u.user.email} habilitado de nuevo.` };
  }

  // reset_password
  validarPassword(password);
  const { error } = await supabase.auth.admin.updateUserById(userId, { password });
  if (error) throw error;
  return { mensaje: `Contraseña de ${u.user.email} cambiada.` };
}

// Procesa UN pedido (la fila tal como vino de la tabla, con la contraseña).
async function procesarComandoUsuario(supabase, fila, logger) {
  const password = fila.password;
  // Tomarlo y borrar la contraseña en el mismo paso. Si otro proceso ya lo
  // tomó, no vuelve ninguna fila y se deja.
  const { data: tomado, error: eTomar } = await supabase.from('comandos_usuarios')
    .update({ estado: 'procesando', password: null })
    .eq('id', fila.id).eq('estado', 'pendiente')
    .select('id');
  if (eTomar) throw eTomar;
  if (!tomado || !tomado.length) return null;

  let res;
  try {
    const r = await ejecutar(supabase, fila, password);
    res = { estado: 'ok', mensaje: r.mensaje };
    if (r.user_id) res.user_id = r.user_id;
  } catch (e) {
    const msg = e instanceof ErrorPedido ? e.message : 'Error del servidor: ' + ((e && e.message) || e);
    if (logger) logger[e instanceof ErrorPedido ? 'warn' : 'error']({ err: e, id: fila.id, accion: fila.accion }, 'Pedido de usuarios rechazado');
    res = { estado: 'error', mensaje: msg };
  }
  res.procesado_at = new Date().toISOString();
  res.password = null;
  const { error: eFin } = await supabase.from('comandos_usuarios').update(res).eq('id', fila.id);
  if (eFin && logger) logger.error({ err: eFin, id: fila.id }, 'No se pudo guardar el resultado del pedido de usuarios');
  if (logger) logger.info({ id: fila.id, accion: fila.accion, estado: res.estado }, 'Pedido de usuarios procesado');
  return res;
}

async function revisarComandosUsuarios(supabase, logger) {
  const { data, error } = await supabase.from('comandos_usuarios')
    .select('*').eq('estado', 'pendiente').order('creado_at', { ascending: true }).limit(20);
  if (error) {
    // Sin 012_supervisor_gestion.sql corrida todavía: no hay nada que hacer.
    if (error.code === '42P01' || error.code === 'PGRST205') return;
    throw error;
  }
  for (const fila of data || []) await procesarComandoUsuario(supabase, fila, logger);
}

function iniciarComandosUsuarios({ supabase, logger }) {
  let corriendo = false;
  const tick = async () => {
    if (corriendo) return;
    corriendo = true;
    try { await revisarComandosUsuarios(supabase, logger); }
    catch (e) { logger.error({ err: e }, 'Error revisando pedidos de usuarios'); }
    finally { corriendo = false; }
  };
  tick();
  return setInterval(tick, INTERVALO_MS);
}

module.exports = { iniciarComandosUsuarios, revisarComandosUsuarios, procesarComandoUsuario };
