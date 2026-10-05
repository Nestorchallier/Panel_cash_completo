// Pruebas de los pedidos de 👥 Usuarios (src/usuarios.js) con un supabase
// de mentira: tablas en memoria + auth.admin simulado. Correr: npm test
const test = require('node:test');
const assert = require('node:assert');
const { procesarComandoUsuario, revisarComandosUsuarios } = require('../src/usuarios');

const SUP = '11111111-1111-4111-8111-111111111111';
const SUP2 = '22222222-2222-4222-8222-222222222222';
const COB = '33333333-3333-4333-8333-333333333333';

function mock({ perfiles, users }) {
  const db = { perfiles: perfiles.map(p => ({ ...p })), usuarios: [], comandos_usuarios: [] };
  const authUsers = new Map(users.map(u => [u.id, { ...u }]));
  const llamadas = [];
  let n = 0;
  function from(tabla) {
    const st = { filtros: [], op: 'select', payload: null, single: false, devolver: false, lim: Infinity };
    const filas = () => db[tabla].filter(r => st.filtros.every(f => f(r)));
    const run = () => {
      if (st.op === 'update') {
        const fs = filas();
        llamadas.push({ tabla, op: 'update', payload: st.payload, n: fs.length });
        fs.forEach(r => Object.assign(r, st.payload));
        return { data: st.devolver ? fs.map(r => ({ ...r })) : null, error: null };
      }
      if (st.op === 'upsert') {
        const clave = tabla === 'usuarios' ? 'id' : 'user_id';
        const ex = db[tabla].find(r => r[clave] === st.payload[clave]);
        if (ex) Object.assign(ex, st.payload); else db[tabla].push({ ...st.payload });
        llamadas.push({ tabla, op: 'upsert', payload: st.payload });
        return { data: null, error: null };
      }
      const fs = filas().slice(0, st.lim);
      return { data: st.single ? (fs[0] || null) : fs, error: null };
    };
    const b = {
      select() { if (st.op !== 'select') st.devolver = true; return b; },
      eq(k, v) { st.filtros.push(r => r[k] === v); return b; },
      order() { return b; }, limit(x) { st.lim = x; return b; },
      maybeSingle() { st.single = true; return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; },
      upsert(p) { st.op = 'upsert'; st.payload = p; return b; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  }
  const admin = {
    async createUser(o) {
      llamadas.push({ admin: 'createUser', o });
      if ([...authUsers.values()].some(u => u.email === o.email)) return { data: null, error: { message: 'A user with this email address has already been registered' } };
      const id = '44444444-4444-4444-8444-44444444444' + (n++);
      authUsers.set(id, { id, email: o.email });
      return { data: { user: { id, email: o.email } }, error: null };
    },
    async getUserById(id) {
      const u = authUsers.get(id);
      return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: 'User not found' } };
    },
    async updateUserById(id, attrs) {
      llamadas.push({ admin: 'updateUserById', id, attrs });
      const u = authUsers.get(id);
      if (attrs.ban_duration === 'none') u.banned_until = null;
      else if (attrs.ban_duration) u.banned_until = new Date(Date.now() + 1e12).toISOString();
      return { data: { user: u }, error: null };
    },
  };
  const supabase = { from, auth: { admin } };
  const pedido = (f) => { const fila = { id: 'c' + (n++), estado: 'pendiente', creado_at: new Date().toISOString(), creador: SUP, ...f }; db.comandos_usuarios.push(fila); return fila; };
  return { supabase, db, authUsers, llamadas, pedido };
}

const base = () => mock({
  perfiles: [{ user_id: SUP, rol: 'supervisor', nombre: 'Laura' }, { user_id: COB, rol: 'cobrador', nombre: 'Magalí' }],
  users: [{ id: SUP, email: 'laura@x.com' }, { id: COB, email: 'magali@x.com' }],
});

test('crear: createUser con email confirmado, perfil + usuarios, contraseña borrada', async () => {
  const m = base();
  const fila = m.pedido({ accion: 'crear', email: ' Nuevo@X.com ', nombre: 'Diego Gonzalez', rol: 'cobrador', password: 'secreta123' });
  const r = await procesarComandoUsuario(m.supabase, { ...fila });
  assert.equal(r.estado, 'ok', r.mensaje);
  const c = m.llamadas.find(l => l.admin === 'createUser');
  assert.deepEqual({ email: c.o.email, email_confirm: c.o.email_confirm, password: c.o.password }, { email: 'nuevo@x.com', email_confirm: true, password: 'secreta123' });
  const fin = m.db.comandos_usuarios.find(x => x.id === fila.id);
  assert.equal(fin.password, null);
  assert.equal(fin.estado, 'ok');
  assert.ok(fin.user_id);
  assert.ok(m.db.perfiles.some(p => p.user_id === fin.user_id && p.rol === 'cobrador' && p.nombre === 'Diego Gonzalez'));
  assert.ok(m.db.usuarios.some(u => u.id === fin.user_id && u.nombre === 'Diego Gonzalez'));
  // La contraseña se borró en el PRIMER update (al tomar el pedido), antes de actuar.
  const primero = m.llamadas.findIndex(l => l.tabla === 'comandos_usuarios');
  assert.equal(m.llamadas[primero].payload.password, null);
  assert.ok(primero < m.llamadas.findIndex(l => l.admin === 'createUser'));
});

test('crear: validaciones (email, contraseña corta, rol, email repetido)', async () => {
  const m = base();
  const casos = [
    [{ email: 'no-es-email', nombre: 'X', rol: 'cobrador', password: 'secreta123' }, /Email/],
    [{ email: 'a@b.com', nombre: 'X', rol: 'cobrador', password: '123' }, /8 caracteres/],
    [{ email: 'a@b.com', nombre: 'X', rol: 'admin', password: 'secreta123' }, /Rol/],
    [{ email: 'a@b.com', nombre: '  ', rol: 'cobrador', password: 'secreta123' }, /nombre/],
    [{ email: 'magali@x.com', nombre: 'X', rol: 'cobrador', password: 'secreta123' }, /Ya existe/],
  ];
  for (const [f, re] of casos) {
    const fila = m.pedido({ accion: 'crear', ...f });
    const r = await procesarComandoUsuario(m.supabase, { ...fila });
    assert.equal(r.estado, 'error');
    assert.match(r.mensaje, re);
    assert.equal(m.db.comandos_usuarios.find(x => x.id === fila.id).password, null);
  }
  assert.equal(m.llamadas.filter(l => l.admin === 'createUser').length, 1); // solo el repetido llegó a auth
});

test('solo actúa si el creador es supervisor (según perfiles, en el servidor)', async () => {
  const m = base();
  const fila = m.pedido({ creador: COB, accion: 'reset_password', user_id: SUP, password: 'hackeado123' });
  const r = await procesarComandoUsuario(m.supabase, { ...fila });
  assert.equal(r.estado, 'error');
  assert.match(r.mensaje, /Solo un supervisor/);
  assert.ok(!m.llamadas.some(l => l.admin));
  assert.equal(m.db.comandos_usuarios.find(x => x.id === fila.id).password, null);
});

test('reset_password y editar', async () => {
  const m = base();
  let r = await procesarComandoUsuario(m.supabase, { ...m.pedido({ accion: 'reset_password', user_id: COB, password: 'nueva12345' }) });
  assert.equal(r.estado, 'ok');
  assert.deepEqual(m.llamadas.find(l => l.admin === 'updateUserById').attrs, { password: 'nueva12345' });
  r = await procesarComandoUsuario(m.supabase, { ...m.pedido({ accion: 'editar', user_id: COB, nombre: 'Magalí Medina', rol: 'supervisor' }) });
  assert.equal(r.estado, 'ok');
  assert.equal(m.db.perfiles.find(p => p.user_id === COB).rol, 'supervisor');
  assert.equal(m.db.usuarios.find(u => u.id === COB).nombre, 'Magalí Medina');
});

test('deshabilitar / habilitar con ban', async () => {
  const m = base();
  let r = await procesarComandoUsuario(m.supabase, { ...m.pedido({ accion: 'deshabilitar', user_id: COB }) });
  assert.equal(r.estado, 'ok');
  assert.ok(m.authUsers.get(COB).banned_until);
  r = await procesarComandoUsuario(m.supabase, { ...m.pedido({ accion: 'habilitar', user_id: COB }) });
  assert.equal(r.estado, 'ok');
  assert.equal(m.authUsers.get(COB).banned_until, null);
});

test('nunca deshabilitarse a sí mismo ni dejar sin supervisores', async () => {
  const m = base();
  let r = await procesarComandoUsuario(m.supabase, { ...m.pedido({ accion: 'deshabilitar', user_id: SUP }) });
  assert.match(r.mensaje, /a vos mismo/);
  r = await procesarComandoUsuario(m.supabase, { ...m.pedido({ accion: 'editar', user_id: SUP, nombre: 'Laura', rol: 'cobrador' }) });
  assert.match(r.mensaje, /vos mismo/);
  assert.ok(!m.llamadas.some(l => l.admin === 'updateUserById'));

  // Con dos supervisores se puede sacar a uno; pero si el que pide quedó
  // deshabilitado (pedido viejo), no cuenta: SUP sería el último.
  const m2 = mock({
    perfiles: [{ user_id: SUP, rol: 'supervisor' }, { user_id: SUP2, rol: 'supervisor' }],
    users: [{ id: SUP, email: 'a@x.com' }, { id: SUP2, email: 'b@x.com', banned_until: new Date(Date.now() + 1e9).toISOString() }],
  });
  r = await procesarComandoUsuario(m2.supabase, { ...m2.pedido({ creador: SUP2, accion: 'deshabilitar', user_id: SUP }) });
  assert.match(r.mensaje, /último supervisor/);
  r = await procesarComandoUsuario(m2.supabase, { ...m2.pedido({ creador: SUP2, accion: 'editar', user_id: SUP, nombre: 'A', rol: 'cobrador' }) });
  assert.match(r.mensaje, /último supervisor/);
  assert.ok(!m2.llamadas.some(l => l.admin === 'updateUserById'));
  m2.authUsers.get(SUP2).banned_until = null;
  r = await procesarComandoUsuario(m2.supabase, { ...m2.pedido({ creador: SUP2, accion: 'deshabilitar', user_id: SUP }) });
  assert.equal(r.estado, 'ok');
});

test('id inválido y acción desconocida', async () => {
  const m = base();
  let r = await procesarComandoUsuario(m.supabase, { ...m.pedido({ accion: 'deshabilitar', user_id: "x' or 1=1" }) });
  assert.match(r.mensaje, /id inválido/);
  r = await procesarComandoUsuario(m.supabase, { ...m.pedido({ accion: 'borrar_todo', user_id: COB }) });
  assert.match(r.mensaje, /desconocida/);
});

test('un pedido ya tomado no se procesa dos veces; revisar procesa los pendientes', async () => {
  const m = base();
  const fila = m.pedido({ accion: 'habilitar', user_id: COB });
  m.pedido({ accion: 'deshabilitar', user_id: COB });
  await revisarComandosUsuarios(m.supabase);
  assert.ok(m.db.comandos_usuarios.every(c => c.estado === 'ok'));
  const otra = await procesarComandoUsuario(m.supabase, { ...fila, estado: 'pendiente' });
  assert.equal(otra, null);
});
