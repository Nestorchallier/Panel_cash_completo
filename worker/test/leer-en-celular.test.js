// Pruebas de src/leer-en-celular.js (chat leído en el CRM -> leído en el
// celular) con un supabase y un sock de mentira. Correr: npm test
const test = require('node:test');
const assert = require('node:assert');
const { revisarLeidosPendientes, claveDeMensaje } = require('../src/leer-en-celular');

const U = 'user-1';
const HASTA = '2026-10-06T12:00:00.000Z';

function mock(db) {
  const llamadas = [];
  function from(tabla) {
    const st = { filtros: [], op: 'select', payload: null, orden: null, lim: Infinity };
    const filas = () => db[tabla].filter(r => st.filtros.every(f => f(r)));
    const run = () => {
      if (st.op === 'update') {
        const fs = filas();
        llamadas.push({ tabla, op: 'update', payload: st.payload, ids: fs.map(r => r.id) });
        fs.forEach(r => Object.assign(r, st.payload));
        return { data: null, error: null };
      }
      let out = filas().map(r => ({ ...r }));
      if (st.orden) out.sort((a, b) => (a[st.orden.col] < b[st.orden.col] ? -1 : 1) * (st.orden.asc ? 1 : -1));
      return { data: out.slice(0, st.lim), error: null };
    };
    const q = {
      select() { return q; },
      update(p) { st.op = 'update'; st.payload = p; return q; },
      eq(c, v) { st.filtros.push(r => r[c] === v); return q; },
      lte(c, v) { st.filtros.push(r => r[c] <= v); return q; },
      in(c, vs) { st.filtros.push(r => vs.includes(r[c])); return q; },
      not(c, op, v) { st.filtros.push(r => r[c] !== null && r[c] !== undefined); return q; },
      order(col, o) { st.orden = { col, asc: !o || o.ascending !== false }; return q; },
      limit(n) { st.lim = n; return q; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return q;
  }
  return { supabase: { from }, llamadas };
}

function sockFalso({ falla = false } = {}) {
  const leidos = [];
  return { leidos, readMessages: async (claves) => { if (falla) throw new Error('sin conexión'); leidos.push(...claves); } };
}

function base() {
  return {
    conversaciones: [
      { id: 'c1', user_id: U, jid: '5491111111111@s.whatsapp.net', leer_en_celular_hasta: HASTA },
      { id: 'g1', user_id: U, jid: '12345@g.us', leer_en_celular_hasta: HASTA },
      { id: 'c2', user_id: U, jid: '5492222222222@s.whatsapp.net', leer_en_celular_hasta: null },
      { id: 'otro', user_id: 'user-2', jid: '5493333333333@s.whatsapp.net', leer_en_celular_hasta: HASTA },
    ],
    mensajes: [
      // chat 1 a 1: dos sin leer antes de la marca, uno después, uno ya leído, un saliente
      { id: 'm1', conversacion_id: 'c1', wa_id: 'A1', direccion: 'entrante', estado: 'entregado', creado_at: '2026-10-06T11:00:00.000Z', wa_remote_jid: '999@lid' },
      { id: 'm2', conversacion_id: 'c1', wa_id: 'A2', direccion: 'entrante', estado: 'entregado', creado_at: '2026-10-06T11:30:00.000Z' },
      { id: 'm3', conversacion_id: 'c1', wa_id: 'A3', direccion: 'entrante', estado: 'entregado', creado_at: '2026-10-06T12:30:00.000Z' },
      { id: 'm4', conversacion_id: 'c1', wa_id: 'A4', direccion: 'entrante', estado: 'leido', creado_at: '2026-10-06T10:00:00.000Z' },
      { id: 'm5', conversacion_id: 'c1', wa_id: 'A5', direccion: 'saliente', estado: 'entregado', creado_at: '2026-10-06T11:40:00.000Z' },
      // grupo: uno con participante, uno viejo sin participante (se saltea)
      { id: 'g-a', conversacion_id: 'g1', wa_id: 'G1', direccion: 'entrante', estado: 'entregado', creado_at: '2026-10-06T11:10:00.000Z', wa_participante: '777@lid' },
      { id: 'g-b', conversacion_id: 'g1', wa_id: 'G2', direccion: 'entrante', estado: 'entregado', creado_at: '2026-10-06T11:20:00.000Z' },
      // chat sin marca
      { id: 'n1', conversacion_id: 'c2', wa_id: 'B1', direccion: 'entrante', estado: 'entregado', creado_at: '2026-10-06T11:00:00.000Z' },
    ],
  };
}

test('claveDeMensaje: 1 a 1 usa el jid con que llegó; grupo pide participante', () => {
  const conv = { jid: '549@s.whatsapp.net' };
  assert.deepStrictEqual(claveDeMensaje({ wa_id: 'X' }, conv), { remoteJid: '549@s.whatsapp.net', id: 'X', fromMe: false });
  assert.deepStrictEqual(claveDeMensaje({ wa_id: 'X', wa_remote_jid: '1@lid' }, conv), { remoteJid: '1@lid', id: 'X', fromMe: false });
  assert.strictEqual(claveDeMensaje({ wa_id: 'X' }, { jid: '1@g.us' }), null);
  assert.deepStrictEqual(claveDeMensaje({ wa_id: 'X', wa_participante: 'p@lid' }, { jid: '1@g.us' }),
    { remoteJid: '1@g.us', id: 'X', fromMe: false, participant: 'p@lid' });
  assert.strictEqual(claveDeMensaje({ wa_id: null }, conv), null);
});

test('marca como leídos en WhatsApp solo los entrantes sin leer hasta la marca, y borra la marca', async () => {
  const db = base();
  const { supabase } = mock(db);
  const sock = sockFalso();
  const r = await revisarLeidosPendientes(sock, supabase, U);
  assert.strictEqual(r.marcados, 3);
  const ids = sock.leidos.map(k => k.id).sort();
  assert.deepStrictEqual(ids, ['A1', 'A2', 'G1']);
  assert.deepStrictEqual(sock.leidos.find(k => k.id === 'A1'), { remoteJid: '999@lid', id: 'A1', fromMe: false });
  assert.deepStrictEqual(sock.leidos.find(k => k.id === 'G1'), { remoteJid: '12345@g.us', id: 'G1', fromMe: false, participant: '777@lid' });
  const m = id => db.mensajes.find(x => x.id === id);
  assert.strictEqual(m('m1').estado, 'leido');
  assert.strictEqual(m('m2').estado, 'leido');
  assert.strictEqual(m('m3').estado, 'entregado', 'el que llegó después de abrir el chat sigue sin leer');
  assert.strictEqual(m('m5').estado, 'entregado', 'los salientes no se tocan');
  assert.strictEqual(m('g-b').estado, 'entregado', 'grupo sin participante: se saltea');
  assert.strictEqual(m('n1').estado, 'entregado', 'chat sin marca: no se toca');
  const c = id => db.conversaciones.find(x => x.id === id);
  assert.strictEqual(c('c1').leer_en_celular_hasta, null);
  assert.strictEqual(c('g1').leer_en_celular_hasta, null);
  assert.strictEqual(c('otro').leer_en_celular_hasta, HASTA, 'chats de otro usuario no se tocan');
});

test('una segunda vuelta no vuelve a mandar nada', async () => {
  const db = base();
  const { supabase } = mock(db);
  const sock = sockFalso();
  await revisarLeidosPendientes(sock, supabase, U);
  sock.leidos.length = 0;
  const r = await revisarLeidosPendientes(sock, supabase, U);
  assert.strictEqual(r.marcados, 0);
  assert.strictEqual(sock.leidos.length, 0);
});

test('si WhatsApp falla, la marca queda para reintentar y se abandona a los 3 intentos', async () => {
  const db = base();
  const { supabase } = mock(db);
  const sock = sockFalso({ falla: true });
  const intentos = new Map();
  await revisarLeidosPendientes(sock, supabase, U, intentos);
  assert.strictEqual(db.conversaciones.find(x => x.id === 'c1').leer_en_celular_hasta, HASTA);
  assert.strictEqual(db.mensajes.find(x => x.id === 'm1').estado, 'entregado');
  await revisarLeidosPendientes(sock, supabase, U, intentos);
  await revisarLeidosPendientes(sock, supabase, U, intentos);
  assert.strictEqual(db.conversaciones.find(x => x.id === 'c1').leer_en_celular_hasta, null);
  assert.strictEqual(db.mensajes.find(x => x.id === 'm1').estado, 'entregado');
});

test('si el chat se volvió a abrir mientras tanto, la marca nueva no se borra', async () => {
  const db = base();
  const { supabase } = mock(db);
  const NUEVA = '2026-10-06T13:00:00.000Z';
  const sock = { readMessages: async () => { db.conversaciones.find(x => x.id === 'c1').leer_en_celular_hasta = NUEVA; } };
  await revisarLeidosPendientes(sock, supabase, U);
  assert.strictEqual(db.conversaciones.find(x => x.id === 'c1').leer_en_celular_hasta, NUEVA);
});
