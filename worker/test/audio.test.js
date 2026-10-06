// Pruebas de las notas de voz salientes (🎤 del panel): la cola baja el
// audio de Storage, lo pasa a OGG/Opus y lo manda con ptt: true. Con un
// sock, un supabase y un ffmpeg de mentira; si en la máquina hay ffmpeg de
// verdad, también se prueba la conversión real. Correr: npm test
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const { enviarUno } = require('../src/cola');
const { esOgg, convertirAOggOpus, audioParaNotaDeVoz, MIMETYPE_NOTA_DE_VOZ } = require('../src/audio');

const USER = '11111111-1111-4111-8111-111111111111';
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.from([0, 2, 0, 0])]);

// supabase de mentira: lo justo para enviarUno (tablas en memoria, filtros
// .eq, .update/.select) + storage.download.
function mock({ mensaje, archivos = {} }) {
  const db = {
    mensajes: [{ ...mensaje, conversaciones: { id: 'c1', jid: '5491100000000@s.whatsapp.net', user_id: USER, cliente_id: null } }],
    wa_sesion: [{ user_id: USER, enviados_hoy: 0 }],
  };
  const descargas = [];
  function from(tabla) {
    const st = { filtros: [], op: 'select', payload: null, single: false, devolver: false };
    const filas = () => db[tabla].filter(r => st.filtros.every(([k, v]) => k.includes('.') || r[k] === v));
    const run = () => {
      if (st.op === 'update') {
        const fs = filas();
        fs.forEach(r => Object.assign(r, st.payload));
        return { data: st.devolver ? fs.map(r => ({ id: r.id })) : null, error: null };
      }
      // esRespuesta pregunta por entrantes: no hay.
      if (st.filtros.some(([k, v]) => k === 'direccion' && v === 'entrante')) return { data: [], error: null };
      const fs = filas();
      return { data: st.single ? (fs[0] || null) : fs, error: null };
    };
    const b = {
      select() { if (st.op === 'update') st.devolver = true; return b; },
      eq(k, v) { st.filtros.push([k, v]); return b; },
      gte() { return b; }, order() { return b; }, limit() { return b; },
      maybeSingle() { st.single = true; return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  }
  const storage = {
    from(bucket) {
      return {
        async download(path) {
          descargas.push(bucket + '/' + path);
          const buf = archivos[path];
          if (!buf) return { data: null, error: { message: 'Object not found' } };
          // supabase-js devuelve un Blob.
          return { data: new Blob([buf]), error: null };
        },
      };
    },
  };
  return { db, descargas, supabase: { from, storage } };
}

function sockFalso() {
  const enviados = [];
  return {
    enviados,
    user: { id: '5491199999999:1@s.whatsapp.net' },
    async sendMessage(jid, contenido, opciones) { enviados.push({ jid, contenido, opciones }); return { key: { id: opciones.messageId } }; },
  };
}

const base = { id: 'm1', conversacion_id: 'c1', direccion: 'saliente', estado: 'pendiente', creado_at: '2026-10-05T12:00:00Z' };

test('nota de voz en WebM: se baja, se convierte y sale como ptt OGG/Opus', async () => {
  const path = `${USER}/1700000000000_abc123_voz.webm`;
  const { db, descargas, supabase } = mock({ mensaje: { ...base, tipo: 'audio', texto: null, media_path: path }, archivos: { [path]: WEBM } });
  const sock = sockFalso();
  const convertidos = [];
  const convertirAudio = async (buf) => { convertidos.push(buf); return OGG; };
  const r = await enviarUno(sock, supabase, USER, { enviados_hoy: 0 }, { bucket: 'comprobantes', convertirAudio });
  assert.deepStrictEqual(r, { respuesta: false });
  assert.deepStrictEqual(descargas, ['comprobantes/' + path]);
  assert.strictEqual(convertidos.length, 1);
  assert.ok(convertidos[0].equals(WEBM));
  assert.strictEqual(sock.enviados.length, 1);
  const { contenido, opciones } = sock.enviados[0];
  assert.strictEqual(contenido.ptt, true);
  assert.strictEqual(contenido.mimetype, 'audio/ogg; codecs=opus');
  assert.ok(contenido.audio.equals(OGG));
  assert.strictEqual(contenido.text, undefined);
  assert.strictEqual(db.mensajes[0].estado, 'enviado');
  assert.strictEqual(db.mensajes[0].wa_id, opciones.messageId);
  assert.strictEqual(db.wa_sesion[0].enviados_hoy, 1);
});

test('nota de voz que ya es OGG (Firefox): se manda tal cual, sin ffmpeg', async () => {
  const path = `${USER}/1700000000000_abc123_voz.ogg`;
  const { db, supabase } = mock({ mensaje: { ...base, tipo: 'audio', media_path: path }, archivos: { [path]: OGG } });
  const sock = sockFalso();
  const convertirAudio = async () => { throw new Error('no se tenía que convertir'); };
  await enviarUno(sock, supabase, USER, { enviados_hoy: 0 }, { convertirAudio });
  assert.ok(sock.enviados[0].contenido.audio.equals(OGG));
  assert.strictEqual(sock.enviados[0].contenido.ptt, true);
  assert.strictEqual(db.mensajes[0].estado, 'enviado');
});

test('sin ffmpeg (o falla la conversión): no se manda y queda en error para reintentar', async () => {
  const path = `${USER}/1700000000000_abc123_voz.webm`;
  const { db, supabase } = mock({ mensaje: { ...base, tipo: 'audio', media_path: path }, archivos: { [path]: WEBM } });
  const sock = sockFalso();
  const convertirAudio = () => convertirAOggOpus(WEBM, { ffmpeg: '/no/existe/ffmpeg' });
  await enviarUno(sock, supabase, USER, { enviados_hoy: 0 }, { convertirAudio });
  assert.strictEqual(sock.enviados.length, 0);
  assert.strictEqual(db.mensajes[0].estado, 'error');
  assert.strictEqual(db.wa_sesion[0].enviados_hoy, 0);
});

test('el audio no está en Storage: queda en error', async () => {
  const { db, supabase } = mock({ mensaje: { ...base, tipo: 'audio', media_path: `${USER}/no.webm` } });
  const sock = sockFalso();
  await enviarUno(sock, supabase, USER, { enviados_hoy: 0 }, { convertirAudio: async () => OGG });
  assert.strictEqual(sock.enviados.length, 0);
  assert.strictEqual(db.mensajes[0].estado, 'error');
});

test('los textos siguen saliendo igual', async () => {
  const { db, descargas, supabase } = mock({ mensaje: { ...base, tipo: 'texto', texto: 'Hola!' } });
  const sock = sockFalso();
  await enviarUno(sock, supabase, USER, { enviados_hoy: 0 });
  assert.deepStrictEqual(sock.enviados[0].contenido, { text: 'Hola!' });
  assert.deepStrictEqual(descargas, []);
  assert.strictEqual(db.mensajes[0].estado, 'enviado');
});

test('esOgg / audioParaNotaDeVoz', async () => {
  assert.strictEqual(esOgg(OGG), true);
  assert.strictEqual(esOgg(WEBM), false);
  assert.strictEqual(esOgg(Buffer.alloc(0)), false);
  assert.strictEqual(MIMETYPE_NOTA_DE_VOZ, 'audio/ogg; codecs=opus');
  assert.ok((await audioParaNotaDeVoz(OGG, { convertir: () => { throw new Error('no'); } })).equals(OGG));
});

const hayFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('conversión real con ffmpeg: WebM/Opus → OGG/Opus', { skip: !hayFfmpeg && 'no hay ffmpeg en esta máquina' }, async () => {
  // Un segundo de tono en WebM/Opus, como lo graba Chrome.
  const gen = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:a', 'libopus', '-f', 'webm', 'pipe:1'], { maxBuffer: 10 * 1024 * 1024 });
  assert.strictEqual(gen.status, 0, String(gen.stderr));
  const webm = gen.stdout;
  assert.strictEqual(esOgg(webm), false);
  const ogg = await audioParaNotaDeVoz(webm);
  assert.strictEqual(esOgg(ogg), true);
  // Que sea Opus mono de verdad.
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,channels', '-of', 'csv=p=0', '-i', 'pipe:0'], { input: ogg });
  if (probe.status === 0) assert.strictEqual(String(probe.stdout).trim(), 'opus,1');
  // Un archivo roto tira error claro (no cuelga).
  await assert.rejects(convertirAOggOpus(Buffer.from('esto no es audio')), /ffmpeg no pudo convertir/);
});
