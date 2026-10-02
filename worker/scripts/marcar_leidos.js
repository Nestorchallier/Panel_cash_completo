// Una sola vez: en cada chat 1 a 1, los mensajes nuestros anteriores a la
// última respuesta del cliente pasan a "leído" (tilde azul). Mismo criterio
// que aplica el worker con cada mensaje nuevo (ver guardarMensaje en wa.js).
// Uso (desde la carpeta worker): node scripts/marcar_leidos.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const uid = process.env.WORKER_USER_ID;

(async () => {
  const convs = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await sb.from('conversaciones').select('id').eq('user_id', uid).eq('es_grupo', false).range(desde, desde + 999);
    if (error) throw error;
    convs.push(...data);
    if (data.length < 1000) break;
  }
  let chats = 0;
  for (const c of convs) {
    const { data: ult } = await sb.from('mensajes').select('creado_at').eq('conversacion_id', c.id)
      .eq('direccion', 'entrante').order('creado_at', { ascending: false }).limit(1);
    if (!ult || !ult.length) continue;
    const { error, count } = await sb.from('mensajes').update({ estado: 'leido' }, { count: 'exact' })
      .eq('conversacion_id', c.id).eq('direccion', 'saliente').in('estado', ['enviado', 'entregado'])
      .lte('creado_at', ult[0].creado_at);
    if (error) console.error(c.id, error.message);
    else if (count) chats++;
  }
  console.log(`Listo: ${chats} chats con mensajes pasados a leído (de ${convs.length}).`);
})();
