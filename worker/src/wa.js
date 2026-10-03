// Conexión a WhatsApp con Baileys (librería no oficial, igual que usa
// Whaticket — ver sección 8 del plan sobre el riesgo de esto). Expone
// iniciarWhatsApp(), que:
//   - mantiene la sesión en worker/auth/ (NO se sube al repo, ver .gitignore)
//   - publica el QR y el estado de conexión en wa_sesion
//   - por cada mensaje entrante: normaliza el teléfono, busca/crea el
//     cliente y la conversación, guarda el mensaje (con el adjunto en
//     Storage si trae uno) y corre las reglas de clasificación
//   - deja la cola de salida (cola.js) mandar lo que esté 'pendiente' en
//     la tabla mensajes, respetando los límites de wa_sesion.

const path = require('node:path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const pino = require('pino');
const { normalizarTelefonoAR } = require('./telefonos');
const { clasificarMensaje } = require('./reglas');

const AUTH_DIR = path.join(__dirname, '..', 'auth');
// En 'warn' se perdían nuestros propios logger.info (el progreso de la
// importación del historial, "Historial de WhatsApp importado.", etc.) —
// quedaba todo en silencio aunque la sincronización terminara bien. Ahora
// en 'info' (el mismo nivel que usa index.js) para verlos siempre; el
// ruido propio de Baileys se filtra aparte, con loggerBaileys más abajo.
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// "5491145327781@s.whatsapp.net" -> "5491145327781". Los jid de grupo
// (@g.us) se descartan: este worker es 1 a 1 con clientes, no atiende
// grupos.
//
// WhatsApp viene migrando las cuentas a un identificador nuevo que no trae
// el número de teléfono ("Linked ID", jid terminado en "@lid") — ahí el
// propio jid no sirve para nada, pero Baileys manda el jid "de toda la
// vida" (el que sí tiene el número) en un campo aparte cuando lo conoce.
// jidAlt es ese campo (remoteJidAlt del mensaje, o lid/id del chat según
// de dónde venga).
// "5491145327781:0@s.whatsapp.net" -> "5491145327781" (Baileys 7 a veces
// devuelve el jid con el número de dispositivo pegado).
function usuarioDeJid(jid) {
  return jid.split('@')[0].split(':')[0];
}

function jidATelefono(jid, jidAlt) {
  if (jid && jid.endsWith('@g.us')) return null;
  if (jid && !jid.endsWith('@lid')) {
    const tel = normalizarTelefonoAR(usuarioDeJid(jid));
    if (tel) return tel;
  }
  if (jidAlt && !jidAlt.endsWith('@g.us') && !jidAlt.endsWith('@lid')) {
    return normalizarTelefonoAR(usuarioDeJid(jidAlt));
  }
  return null;
}

// Baileys 7 guarda la equivalencia lid -> número cada vez que WhatsApp la
// manda (tabla que viene con el historial, mensajes nuevos, contactos) y
// permite consultarla. Devuelve el jid de toda la vida, o null.
async function pnDeLid(sock, lid) {
  if (!lid || !lid.endsWith('@lid')) return null;
  try {
    return (await sock.signalRepository?.lidMapping?.getPNForLID(lid)) || null;
  } catch (e) {
    return null;
  }
}

// WhatsApp envuelve muchos mensajes (temporales, "ver una vez", documento
// con texto, editados): se saca el contenido de adentro.
function contenido(msg) {
  let m = msg.message || {};
  for (let i = 0; i < 4; i++) {
    const adentro = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message
      || m.viewOnceMessageV2Extension?.message || m.documentWithCaptionMessage?.message
      || m.editedMessage?.message;
    if (!adentro) break;
    m = adentro;
  }
  return m;
}

function tipoDeMensaje(msg) {
  const m = contenido(msg);
  if (m.imageMessage) return 'imagen';
  if (m.documentMessage) return 'pdf';
  if (m.audioMessage || m.pttMessage) return 'audio';
  if (m.conversation || m.extendedTextMessage) return 'texto';
  return 'otro';
}

function textoDeMensaje(msg) {
  const m = contenido(msg);
  return m.conversation
    || m.extendedTextMessage?.text
    || m.imageMessage?.caption
    || m.documentMessage?.caption
    || (m.videoMessage && ('🎥 Video' + (m.videoMessage.caption ? ': ' + m.videoMessage.caption : '')))
    || (m.stickerMessage && '🏷️ Sticker')
    || (m.locationMessage && '📍 Ubicación')
    || ((m.contactMessage || m.contactsArrayMessage) && '👤 Contacto')
    || (m.pollCreationMessage && ('📊 Encuesta: ' + (m.pollCreationMessage.name || '')))
    || '';
}

// Avisos sin nada para mostrar: reacciones, claves de cifrado de grupo,
// votos de encuestas, etc. Se descartan.
function esMensajeVacio(msg) {
  const m = contenido(msg);
  if (m.reactionMessage || m.pollUpdateMessage || m.keepInChatMessage || m.pinInChatMessage) return true;
  return tipoDeMensaje(msg) === 'otro' && !textoDeMensaje(msg);
}

// jid es la clave real (sirve tanto para 1 a 1 como para grupos, que no
// tienen teléfono). telefono va null para grupos. nombreGrupo solo se usa
// la primera vez que se crea la conversación de un grupo.
async function buscarClientePorTelefono(supabase, userId, telefono) {
  if (!telefono) return null;
  const { data: tel } = await supabase
    .from('clientes_telefonos').select('cliente_id, clientes!inner(user_id)').eq('telefono', telefono).maybeSingle();
  return (tel && tel.clientes && tel.clientes.user_id === userId) ? tel.cliente_id : null;
}

async function obtenerOCrearConversacion(supabase, userId, telefono, jid, nombre) {
  let { data: existente } = await supabase
    .from('conversaciones').select('*').eq('user_id', userId).eq('jid', jid).maybeSingle();
  // El mismo contacto puede llegar a veces con su jid @lid y a veces con el
  // de toda la vida (@s.whatsapp.net) — si ya hay una conversación con ese
  // teléfono se reusa, en vez de chocar contra el índice único de
  // (user_id, telefono) y perder el mensaje.
  if (!existente && telefono) {
    ({ data: existente } = await supabase
      .from('conversaciones').select('*').eq('user_id', userId).eq('telefono', telefono).maybeSingle());
  }
  if (existente) {
    // Chats sin teléfono (ver guardarMensaje): si ahora llega un nombre y
    // antes no lo tenía, se completa para que la Bandeja no muestre
    // "(sin nombre)".
    if (!existente.nombre && nombre && !existente.es_grupo) {
      await supabase.from('conversaciones').update({ nombre }).eq('id', existente.id);
      existente.nombre = nombre;
    }
    // Esta conversación puede haber quedado sin cliente vinculado por el
    // bug de los jid @lid de hoy (el teléfono no se podía resolver
    // todavía cuando se creó). Si ahora sí hay teléfono y matchea con
    // algún cliente, se re-vincula sola en vez de quedar huérfana para
    // siempre — así las reglas automáticas (section 6) vuelven a andar
    // para esos chats sin tener que tocar nada a mano.
    if (!existente.cliente_id && telefono) {
      const clienteId = await buscarClientePorTelefono(supabase, userId, telefono);
      if (clienteId) {
        const { data: actualizada } = await supabase.from('conversaciones')
          .update({ cliente_id: clienteId, telefono }).eq('id', existente.id).select('*').single();
        if (actualizada) return actualizada;
      } else if (!existente.telefono) {
        // Tampoco tenía teléfono guardado (se creó cuando @lid no se
        // resolvía) — al menos lo completa para la próxima.
        await supabase.from('conversaciones').update({ telefono }).eq('id', existente.id);
        existente.telefono = telefono;
      }
    }
    return existente;
  }

  const clienteId = await buscarClientePorTelefono(supabase, userId, telefono);

  const { data: nueva, error } = await supabase
    .from('conversaciones')
    .insert({
      user_id: userId, jid, telefono, cliente_id: clienteId, no_leidos: 0,
      es_grupo: jid.endsWith('@g.us'), nombre: nombre || null,
    })
    .select('*').single();
  if (error) throw error;
  return nueva;
}

async function subirAdjunto(supabase, bucket, userId, buffer, extension) {
  const nombre = `${userId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${extension}`;
  const { error } = await supabase.storage.from(bucket).upload(nombre, buffer, { upsert: false });
  if (error) { logger.error({ err: error }, 'No se pudo subir el adjunto a Storage'); return null; }
  return nombre;
}

// reglas.js (detectarFecha) toma el DÍA en UTC de la fecha que recibe. Un
// mensaje de las 22:00 de Argentina ya es el día siguiente en UTC, y
// "mañana" quedaba dos días después. Se le pasa el mediodía UTC del día
// LOCAL del mensaje: así su día en UTC es siempre el día de acá.
function fechaParaReglas(fechaISO) {
  const d = fechaISO ? new Date(fechaISO) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  const dia = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${dia}T12:00:00.000Z`;
}

async function aplicarReglas(supabase, userId, conversacion, mensajeTexto, tipo, fechaMensaje) {
  if (!conversacion.cliente_id) return; // sin cliente vinculado no hay tarjeta que mover

  const { data: cliente } = await supabase.from('clientes').select('*').eq('id', conversacion.cliente_id).single();
  const { data: etapaActual } = cliente?.etapa_id
    ? await supabase.from('etapas').select('clave, orden').eq('id', cliente.etapa_id).maybeSingle()
    : { data: null };

  const { data: reglas } = await supabase
    .from('reglas').select('*').eq('user_id', userId).order('prioridad', { ascending: true });

  const resultado = clasificarMensaje(reglas || [], {
    texto: mensajeTexto,
    tieneAdjunto: tipo === 'imagen' || tipo === 'pdf',
    tipoAdjunto: tipo === 'imagen' || tipo === 'pdf' ? tipo : null,
    etapaActualClave: etapaActual?.clave || null,
    // "mañana" / "el viernes" se cuentan desde el día en que se escribió el
    // mensaje, no desde que el worker lo procesa (si estuvo caído un rato
    // y lo recibe tarde, la promesa no se corre un día).
    fecha: fechaParaReglas(fechaMensaje),
  });
  if (!resultado) return;

  const { regla, fechaDetectada } = resultado;
  const accion = regla.accion || {};
  const cambios = {};

  // Reglas de convivencia con el trabajo manual (sección 6 del plan): las
  // reglas solo AVANZAN tarjetas según el orden de las columnas, nunca las
  // devuelven hacia atrás, y nada saca a un cliente de "Cerrado (Cobrado)"
  // ni de "Refinanciado" (ahí solo se agregan etiquetas).
  const etapaBloqueada = etapaActual && ['cerrado', 'refinanciado'].includes(etapaActual.clave);
  if (accion.mueve_a && !etapaBloqueada) {
    const { data: etapaDestino } = await supabase
      .from('etapas').select('id, orden').eq('user_id', userId).eq('clave', accion.mueve_a).maybeSingle();
    const avanza = !etapaActual || etapaActual.orden == null || etapaDestino?.orden == null || etapaDestino.orden > etapaActual.orden;
    if (etapaDestino && avanza) cambios.etapa_id = etapaDestino.id;
  }
  if (fechaDetectada) cambios.promesa_fecha = fechaDetectada;
  if (accion.etiqueta) cambios.etiquetas = Array.from(new Set([...(cliente.etiquetas || []), accion.etiqueta]));

  if (Object.keys(cambios).length) {
    await supabase.from('clientes').update(cambios).eq('id', cliente.id);
  }
  if (fechaDetectada && accion.crea_recordatorio) {
    await supabase.from('recordatorios').insert({
      user_id: userId, cliente_id: cliente.id, fecha: fechaDetectada, tipo: 'promesa',
      texto: `Promesa detectada por WhatsApp: "${mensajeTexto}"`,
    });
  }
  await supabase.from('eventos').insert({
    user_id: userId, cliente_id: cliente.id, tipo: 'regla',
    detalle: { regla: regla.nombre, accion, fecha_detectada: fechaDetectada },
  });
}

function previewTexto(texto, tipo) {
  return texto || (tipo === 'imagen' ? '📷 Imagen' : tipo === 'pdf' ? '📄 PDF' : tipo === 'audio' ? '🎙️ Audio' : '...');
}

// Vista previa de la lista de chats: los salientes van con "Vos: " adelante
// (como en el render 5.1 y como lo guarda el panel al contestar), para que
// de un vistazo se vea quién habló último.
function textoUltimoMensaje(direccion, texto, tipo) {
  const vista = previewTexto(texto, tipo);
  return direccion === 'saliente' ? 'Vos: ' + vista : vista;
}

// ─── Tildes (✓ enviado, ✓✓ entregado, ✓✓ azul leído) ───
// Baileys 7 informa el estado con proto.WebMessageInfo.Status (verificado
// en node_modules): ERROR=0, PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3,
// READ=4, PLAYED=5 (audio escuchado: para el panel es lo mismo que leído).
// ERROR y PENDING no se traducen: no hay que "bajar" un mensaje que ya
// figuraba enviado por un aviso suelto.
const RANGO_ESTADO = { error: 0, pendiente: 0, enviado: 1, entregado: 2, leido: 3 };

function estadoDesdeStatus(status) {
  const s = Number(status);
  if (s === 2) return 'enviado';
  if (s === 3) return 'entregado';
  if (s === 4 || s === 5) return 'leido';
  return null;
}

// Estado con el que se guarda un mensaje nuevo (en vivo o del historial).
// Los del historial traen su status real: un saliente de hace días que el
// cliente ya leyó entra directo con el tilde azul.
function estadoInicial(direccion, status) {
  const desdeStatus = estadoDesdeStatus(status);
  if (direccion === 'entrante') return desdeStatus === 'leido' ? 'leido' : 'entregado';
  return desdeStatus || 'enviado';
}

// Estados que se pueden "subir" a `destino` (nunca se baja: leído > entregado > enviado > pendiente).
function estadosInferiores(destino) {
  return Object.keys(RANGO_ESTADO).filter(e => RANGO_ESTADO[e] < RANGO_ESTADO[destino]);
}

// actualizaciones: [{ waId, estado }]. Busca las filas por wa_id (solo de
// conversaciones de este usuario), sube el estado donde corresponde y
// devuelve los wa_id que todavía no están en la base (para reintentar).
async function aplicarEstados(supabase, userId, actualizaciones) {
  // Si para el mismo mensaje llegan varios avisos juntos, vale el más alto.
  const mejor = new Map();
  for (const { waId, estado } of actualizaciones) {
    if (!waId || !estado) continue;
    const previo = mejor.get(waId);
    if (!previo || RANGO_ESTADO[estado] > RANGO_ESTADO[previo]) mejor.set(waId, estado);
  }
  if (!mejor.size) return [];

  const ids = [...mejor.keys()];
  const filas = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase.from('mensajes')
      .select('id, wa_id, estado, direccion, conversacion_id, creado_at, conversaciones!inner(user_id)')
      .in('wa_id', ids.slice(i, i + 200)).eq('conversaciones.user_id', userId);
    if (error) { logger.error({ err: error }, 'No se pudieron buscar los mensajes para actualizar los tildes'); return []; }
    filas.push(...(data || []));
  }

  const encontrados = new Set(filas.map(f => f.wa_id));
  const porDestino = {};
  // conversacion_id -> creado_at del entrante leído más nuevo.
  const leidoHasta = new Map();
  for (const f of filas) {
    const destino = mejor.get(f.wa_id);
    if (RANGO_ESTADO[destino] <= (RANGO_ESTADO[f.estado] ?? 0)) continue;
    (porDestino[destino] = porDestino[destino] || []).push(f.id);
    // Un ENTRANTE pasa a leído cuando lo abrí en el celular (aviso
    // "read-self" de WhatsApp).
    if (destino === 'leido' && f.direccion === 'entrante') {
      const previo = leidoHasta.get(f.conversacion_id);
      if (!previo || f.creado_at > previo) leidoHasta.set(f.conversacion_id, f.creado_at);
    }
  }
  for (const [destino, idsFila] of Object.entries(porDestino)) {
    // El filtro por estado repite la regla de "nunca bajar" en la propia
    // base, por si entre la lectura y esto el mensaje ya subió por otro lado.
    const { error } = await supabase.from('mensajes').update({ estado: destino })
      .in('id', idsFila).in('estado', estadosInferiores(destino));
    if (error) logger.error({ err: error, destino }, 'No se pudo actualizar el tilde de los mensajes');
  }
  // Lo que queda sin leer en ese chat son los entrantes POSTERIORES al
  // último que leí (si justo entró otro mensaje después, no se borra su
  // globo). Nunca se sube el contador desde acá, solo se baja.
  for (const [conversacionId, hasta] of leidoHasta) {
    try {
      const { count, error } = await supabase.from('mensajes').select('id', { count: 'exact', head: true })
        .eq('conversacion_id', conversacionId).eq('direccion', 'entrante').gt('creado_at', hasta);
      if (error) throw error;
      const { data: conv } = await supabase.from('conversaciones').select('no_leidos')
        .eq('id', conversacionId).eq('user_id', userId).maybeSingle();
      if (conv && (count || 0) < (conv.no_leidos || 0)) {
        await supabase.from('conversaciones').update({ no_leidos: count || 0 }).eq('id', conversacionId);
      }
    } catch (e) {
      logger.error({ err: e }, 'No se pudo actualizar los no leídos tras leer en el celular');
    }
  }
  return ids.filter(id => !encontrados.has(id));
}

// Algunos avisos llegan antes de que el mensaje esté guardado (el
// "enviado" de WhatsApp puede ganarle a la escritura en la base, o el
// mensaje del celular todavía se está procesando en messages.upsert). Los
// que no se encuentran se reintentan una sola vez, unos segundos después.
async function actualizarTildes(supabase, userId, actualizaciones) {
  const faltan = await aplicarEstados(supabase, userId, actualizaciones);
  if (!faltan.length) return;
  const pendientes = actualizaciones.filter(a => faltan.includes(a.waId));
  setTimeout(() => {
    aplicarEstados(supabase, userId, pendientes)
      .catch(e => logger.error({ err: e }, 'Error reintentando los tildes'));
  }, 5000);
}

// chats.update de Baileys NO trae el total de no leídos sino avisos: +N por
// cada mensaje entrante (eso ya lo cuenta guardarMensaje, sumarlo de nuevo
// lo duplicaría), 0 = el chat se leyó en el celular, -1 = se marcó como
// no leído a mano, null = sin cambio. Solo se usan el 0 y el -1.
async function buscarConversacionPorJid(sock, supabase, userId, jid) {
  const { data: porJid } = await supabase.from('conversaciones').select('id, no_leidos')
    .eq('user_id', userId).eq('jid', jid).maybeSingle();
  if (porJid) return porJid;
  if (jid.endsWith('@g.us')) return null;
  // El chat puede estar guardado con el otro jid (@lid vs. el de toda la
  // vida): se prueba por teléfono.
  const telefono = jidATelefono(jid, pnPorLidGlobal[jid] || await pnDeLid(sock, jid));
  if (!telefono) return null;
  const { data: porTelefono } = await supabase.from('conversaciones').select('id, no_leidos')
    .eq('user_id', userId).eq('telefono', telefono).maybeSingle();
  return porTelefono || null;
}

async function actualizarNoLeidos(sock, supabase, userId, cambios) {
  for (const c of cambios || []) {
    if (!c.id || c.id === 'status@broadcast') continue;
    if (c.unreadCount !== 0 && c.unreadCount !== -1) continue;
    try {
      const conv = await buscarConversacionPorJid(sock, supabase, userId, c.id);
      if (!conv) continue;
      // Marcado como no leído en el celular: que aparezca al menos el
      // globo "1" (si ya tenía más, se respeta).
      const nuevo = c.unreadCount === 0 ? 0 : Math.max(1, conv.no_leidos || 0);
      if (nuevo === (conv.no_leidos || 0)) continue;
      await supabase.from('conversaciones').update({ no_leidos: nuevo }).eq('id', conv.id);
    } catch (e) {
      logger.error({ err: e, jid: c.id }, 'Error actualizando no leídos de un chat');
    }
  }
}

// Guarda un mensaje (en vivo o del historial) en conversaciones/mensajes.
// opciones.descargarAdjuntos: false durante la sincronización inicial del
// historial (puede traer cientos de mensajes viejos de una — bajar y subir
// a Storage cada foto vieja sería lento y llenaría el bucket de golpe; los
// mensajes nuevos que lleguen de ahí en adelante sí bajan el adjunto).
// opciones.aplicarAutomatizacion: false para el historial — no tiene
// sentido que las reglas muevan tarjetas del Kanban por mensajes de hace
// semanas que ya se gestionaron a mano.
async function guardarMensaje(sock, supabase, userId, config, msg, opciones = {}) {
  const { descargarAdjuntos = true, tiposAdjuntoADescargar = ['imagen', 'pdf', 'audio'], aplicarAutomatizacion = true, silencioso = false, nombreGrupo = null, resolverNombreGrupo = true, jidAlt = null, nombreContacto = null } = opciones;
  const direccion = msg.key.fromMe ? 'saliente' : 'entrante';
  const jid = msg.key.remoteJid;
  // Los "Estados" (historias) de WhatsApp llegan con remoteJid
  // status@broadcast — no son una conversación 1 a 1 ni de grupo, así que
  // se descartan derecho, sin intentar sacarles teléfono ni loguear nada
  // (si no, generan un warning por cada vista de estado de cada contacto).
  if (jid === 'status@broadcast') return;
  // Mensajes internos de WhatsApp (borrados, ediciones, sincronización
  // entre dispositivos) — no son algo que se escribió en el chat.
  if (msg.message?.protocolMessage) return;
  if (esMensajeVacio(msg)) return;
  const esGrupo = !!jid && jid.endsWith('@g.us');

  let telefono = null;
  let nombreContactoResuelto = null;
  if (esGrupo) {
    // Los grupos no tienen teléfono propio — se identifican solo por jid.
  } else {
    // Baileys 7 manda el número "de toda la vida" de un contacto @lid en
    // key.remoteJidAlt (senderPn era el nombre en la versión 6); jidAlt
    // viene de la importación del historial. Si no vino en ningún lado, se
    // le pregunta a la tabla de equivalencias de Baileys.
    telefono = jidATelefono(jid, msg.key.remoteJidAlt || msg.key.senderPn || jidAlt || pnPorLidGlobal[jid])
      || jidATelefono(jid, await pnDeLid(sock, jid));
    if (!telefono) {
      // Antes estos chats se descartaban — ahora se guardan igual (como
      // los grupos, identificados solo por jid; se puede contestar porque
      // la cola manda al jid). Quedan sin cliente vinculado hasta que
      // WhatsApp revele el número, y ahí obtenerOCrearConversacion los
      // vincula solos. Para que se reconozcan en la Bandeja se les guarda
      // el nombre que tenga el contacto, o el número tal cual si no es
      // argentino.
      const digitos = jid && !jid.endsWith('@lid') ? jid.split('@')[0] : null;
      nombreContactoResuelto = nombreContacto || nombrePorJidGlobal[jid] || (!msg.key.fromMe && msg.pushName) || (digitos ? '+' + digitos : null);
      if (!silencioso) logger.info({ jid, nombre: nombreContactoResuelto }, 'Remitente sin teléfono argentino reconocible — se guarda igual, sin vincular a cliente');
    }
  }

  const waId = msg.key.id;
  const { data: yaExiste, error: errorExiste } = await supabase.from('mensajes').select('id').eq('wa_id', waId).maybeSingle();
  if (errorExiste) logger.error({ err: errorExiste }, 'Error chequeando duplicado de mensaje');
  if (yaExiste) return;

  let nombreGrupoResuelto = nombreGrupo;
  // Solo se le pregunta el nombre a WhatsApp para mensajes en vivo (un
  // grupo nuevo por vez, es raro). Durante la importación masiva del
  // historial NUNCA se llama acá — si no vino en el array de chats, pasa
  // null y listo (el panel muestra "Grupo" como respaldo); pedirlo mensaje
  // por mensaje del mismo grupo dispara el límite de pedidos de WhatsApp
  // ("rate-overlimit") y frena toda la sincronización.
  if (esGrupo && !nombreGrupoResuelto && resolverNombreGrupo) {
    try {
      const meta = await sock.groupMetadata(jid);
      nombreGrupoResuelto = meta?.subject || null;
    } catch (e) {
      logger.warn({ err: e, jid }, 'No se pudo obtener el nombre del grupo');
    }
  }

  const conversacion = await obtenerOCrearConversacion(supabase, userId, telefono, jid, esGrupo ? nombreGrupoResuelto : nombreContactoResuelto);
  const tipo = tipoDeMensaje(msg);
  const texto = textoDeMensaje(msg);
  if (!silencioso) logger.info({ telefono, esGrupo, grupo: nombreGrupoResuelto, direccion, conversacionId: conversacion.id, tipo, texto }, 'Guardando mensaje');

  let mediaPath = null;
  if (descargarAdjuntos && tiposAdjuntoADescargar.includes(tipo)) {
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: loggerBaileys, reuploadRequest: sock.updateMediaMessage });
      const ext = tipo === 'imagen' ? 'jpg' : tipo === 'pdf' ? 'pdf' : 'ogg';
      mediaPath = await subirAdjunto(supabase, config.bucket, userId, buffer, ext);
    } catch (e) {
      logger.error({ err: e }, 'No se pudo descargar el adjunto');
    }
  }

  const creadoAt = msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000).toISOString() : new Date().toISOString();
  const fila = {
    conversacion_id: conversacion.id,
    wa_id: waId,
    direccion,
    tipo,
    texto: texto || null,
    media_path: mediaPath,
    estado: estadoInicial(direccion, msg.status),
    creado_at: creadoAt,
  };
  // En los grupos se guarda quién escribió (nombre de perfil de WhatsApp).
  // Si no vino el nombre de perfil (pasa mucho con participantes @lid y en
  // el historial), se busca el número real del participante para mostrar
  // el nombre agendado o, como último recurso, el número.
  if (esGrupo && direccion === 'entrante') {
    const participante = msg.key.participant;
    let pn = msg.key.participantAlt || msg.key.participantPn || pnPorLidGlobal[participante] || null;
    if (!pn && participante && !participante.endsWith('@lid')) pn = participante;
    if (!pn) pn = await pnDeLid(sock, participante);
    if (pn && pn.endsWith('@lid')) pn = null;
    fila.autor = msg.pushName || nombrePorJidGlobal[participante] || (pn && nombrePorJidGlobal[pn])
      || (pn ? '+' + pn.split('@')[0].split(':')[0] : null);
    if (msg.pushName && participante) {
      nombrePorJidGlobal[participante] = nombrePorJidGlobal[participante] || msg.pushName;
      if (pn) nombrePorJidGlobal[pn] = nombrePorJidGlobal[pn] || msg.pushName;
    }
  }
  let { error: errorInsert } = await supabase.from('mensajes').insert(fila);
  // Si todavía no se creó la columna "autor" en la base, se guarda sin ella.
  if (errorInsert && fila.autor !== undefined && /autor/.test(errorInsert.message || '')) {
    delete fila.autor;
    ({ error: errorInsert } = await supabase.from('mensajes').insert(fila));
  }
  if (errorInsert) { logger.error({ err: errorInsert }, 'No se pudo guardar el mensaje'); return; }

  // WhatsApp solo avisa "entregado / leído" al aparato que mandó el mensaje:
  // lo que se escribe desde el celular casi nunca trae el aviso acá. Si el
  // cliente contesta, es seguro que vio lo anterior: se marca como leído.
  if (direccion === 'entrante' && !esGrupo) {
    const { error: eLeido } = await supabase.from('mensajes').update({ estado: 'leido' })
      .eq('conversacion_id', conversacion.id).eq('direccion', 'saliente')
      .in('estado', ['enviado', 'entregado']).lte('creado_at', creadoAt);
    if (eLeido) logger.error({ err: eLeido }, 'No se pudieron marcar como leídos los mensajes anteriores');
  }

  // Solo los ENTRANTES suman no leídos. Un saliente en vivo (contesté desde
  // el celular) significa que el chat ya se atendió: el globo vuelve a 0,
  // igual que cuando se contesta desde la Bandeja (crmEnviarMensaje). En el
  // historial no se toca: ahí el contador real lo pone sincronizarHistorial.
  const esMasNuevo = !conversacion.ultimo_at || creadoAt >= conversacion.ultimo_at;
  let noLeidos = {};
  if (!opciones.noContarNoLeido) {
    noLeidos = direccion === 'entrante' ? { no_leidos: (conversacion.no_leidos || 0) + 1 } : { no_leidos: 0 };
  }
  const { error: errorUpdate } = await supabase.from('conversaciones').update({
    ...(esMasNuevo ? { ultimo_texto: textoUltimoMensaje(direccion, texto, tipo), ultimo_at: creadoAt } : {}),
    ...noLeidos,
  }).eq('id', conversacion.id);
  if (errorUpdate) logger.error({ err: errorUpdate }, 'No se pudo actualizar la conversación');

  if (aplicarAutomatizacion && direccion === 'entrante') {
    await aplicarReglas(supabase, userId, conversacion, texto, tipo, creadoAt).catch(e => logger.error({ err: e }, 'Error aplicando reglas'));
  }
}

// Además de la tabla de equivalencias de Baileys (pnDeLid), se escuchan los
// avisos de contactos: agendados (contacts.upsert, con lid + número),
// nombres de perfil (contacts.update / notify) y cada equivalencia nueva
// que aprende Baileys (lid-mapping.update). Se guarda en memoria para los mensajes que
// lleguen después, y se completan las conversaciones que ya se crearon sin
// teléfono o sin nombre.
const pnPorLidGlobal = {};
let contactosResincronizados = false;
const nombrePorJidGlobal = {};

async function actualizarContacto(supabase, userId, { lid, jid, nombre }) {
  if (lid && jid && lid.endsWith('@lid') && !jid.endsWith('@lid')) {
    pnPorLidGlobal[lid] = jid;
    const telefono = jidATelefono(jid);
    const { data: convLid } = await supabase.from('conversaciones').select('*')
      .eq('user_id', userId).eq('jid', lid).is('telefono', null).maybeSingle();
    if (convLid && telefono) {
      const { data: convTel } = await supabase.from('conversaciones').select('*')
        .eq('user_id', userId).eq('telefono', telefono).maybeSingle();
      if (convTel) {
        // Ya había un chat con ese número (bajo el jid de toda la vida):
        // se pasan los mensajes del chat @lid ahí y se borra el duplicado.
        await supabase.from('mensajes').update({ conversacion_id: convTel.id }).eq('conversacion_id', convLid.id);
        const cambios = { no_leidos: (convTel.no_leidos || 0) + (convLid.no_leidos || 0) };
        if (convLid.ultimo_at && (!convTel.ultimo_at || convLid.ultimo_at > convTel.ultimo_at)) {
          cambios.ultimo_at = convLid.ultimo_at;
          cambios.ultimo_texto = convLid.ultimo_texto;
        }
        await supabase.from('conversaciones').update(cambios).eq('id', convTel.id);
        await supabase.from('conversaciones').delete().eq('id', convLid.id);
      } else {
        const clienteId = await buscarClientePorTelefono(supabase, userId, telefono);
        await supabase.from('conversaciones').update({ telefono, cliente_id: clienteId }).eq('id', convLid.id);
      }
    }
  }
  if (nombre) {
    for (const id of [jid, lid]) {
      if (!id || id.endsWith('@g.us')) continue;
      nombrePorJidGlobal[id] = nombre;
      await supabase.from('conversaciones').update({ nombre })
        .eq('user_id', userId).eq('jid', id).eq('es_grupo', false).is('nombre', null);
    }
  }
}

// Recorre los chats @lid que quedaron sin teléfono y les busca el número en
// lo que ya se sabe (memoria + tabla de equivalencias de Baileys). Se corre
// al final de cada tanda del historial y una vez por arranque.
async function resolverLidsPendientes(sock, supabase, userId) {
  const { data: pendientes } = await supabase.from('conversaciones').select('jid')
    .eq('user_id', userId).eq('es_grupo', false).is('telefono', null).like('jid', '%@lid');
  let resueltos = 0;
  for (const { jid: lid } of pendientes || []) {
    const pn = pnPorLidGlobal[lid] || await pnDeLid(sock, lid);
    if (!pn || !jidATelefono(pn)) continue;
    await actualizarContacto(supabase, userId, { lid, jid: pn })
      .then(() => { resueltos++; })
      .catch(e => logger.error({ err: e }, 'Error completando el número de un chat @lid'));
  }
  if (resueltos) logger.info({ resueltos, pendientes: (pendientes || []).length }, 'Chats @lid vinculados a su número');
}

// Primera vinculación (o reconexión): WhatsApp manda de a tandas todo el
// historial de chats que había antes de conectar el panel. Se guarda todo
// (sin bajar adjuntos viejos ni mover tarjetas del Kanban por mensajes
// pasados, ver guardarMensaje) y al final se corrige no_leidos de cada
// chat con el contador real que manda WhatsApp.
async function sincronizarHistorial(sock, supabase, userId, config, { chats, contacts, messages, lidPnMappings }) {
  logger.info({ chats: chats?.length || 0, mensajes: messages?.length || 0 }, 'Sincronizando historial de WhatsApp...');
  // El nombre de los grupos viene en el array de chats (chat.name) — se
  // arma un mapa para no tener que pedirle a WhatsApp el nombre de cada
  // grupo mensaje por mensaje durante la importación masiva.
  const nombresGrupo = {};
  (chats || []).forEach(c => { if (c.id && c.id.endsWith('@g.us') && c.name) nombresGrupo[c.id] = c.name; });
  // Los mensajes del historial de chats @lid no traen el número, pero el
  // array de chats (pnJid) y el de contactos (lid + jid) sí suelen traer la
  // equivalencia — y el nombre del contacto, para los que no se resuelvan.
  const pnPorLid = {};
  const nombresContacto = {};
  (chats || []).forEach(c => {
    if (!c.id) return;
    if (c.id.endsWith('@lid') && c.pnJid) pnPorLid[c.id] = c.pnJid;
    if (c.lidJid && !c.id.endsWith('@lid')) pnPorLid[c.lidJid] = c.id;
    if (!c.id.endsWith('@g.us') && c.name) nombresContacto[c.id] = c.name;
  });
  // Tabla de equivalencias que WhatsApp manda con cada tanda (Baileys 7).
  (lidPnMappings || []).forEach(m => { if (m.lid && m.pn) pnPorLid[m.lid] = m.pn; });
  (contacts || []).forEach(c => {
    const pn = c.phoneNumber || c.jid;
    if (c.lid && pn) pnPorLid[c.lid] = pn;
    const nombre = c.name || c.notify || c.verifiedName;
    if (c.id && nombre && !nombresContacto[c.id]) nombresContacto[c.id] = nombre;
  });

  // Cada vez que se vincula, WhatsApp vuelve a mandar TODO el historial. En
  // vez de preguntar mensaje por mensaje si ya está guardado (decenas de
  // miles de consultas), se pregunta de a 500 y los que ya están se
  // saltean de entrada — una re-vinculación pasa de horas a minutos.
  const yaGuardados = new Set();
  const ids = (messages || []).map(m => m.key?.id).filter(Boolean);
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await supabase.from('mensajes').select('wa_id').in('wa_id', ids.slice(i, i + 500));
    if (error) { logger.warn({ err: error }, 'No se pudo chequear qué mensajes ya estaban guardados'); continue; }
    (data || []).forEach(r => yaGuardados.add(r.wa_id));
  }
  if (yaGuardados.size) logger.info({ yaGuardados: yaGuardados.size, nuevos: ids.length - yaGuardados.size }, 'Mensajes del historial que ya estaban guardados — se saltean');

  let guardados = 0;
  for (const msg of messages || []) {
    if (!msg.message || yaGuardados.has(msg.key?.id)) continue;
    try {
      await guardarMensaje(sock, supabase, userId, config, msg, {
        // Fotos y PDFs sí se bajan durante la importación (comprobantes de
        // pago, principalmente — es justo lo que más importa ver) aunque
        // tarde más; los audios no, para no llenar el Storage de golpe con
        // notas de voz viejas. Solo se puede bajar un adjunto en el
        // momento en que WhatsApp lo entrega — después ya no hay forma.
        descargarAdjuntos: true, tiposAdjuntoADescargar: ['imagen', 'pdf'],
        aplicarAutomatizacion: false, noContarNoLeido: true, silencioso: true,
        nombreGrupo: nombresGrupo[msg.key.remoteJid] || null, resolverNombreGrupo: false,
        jidAlt: pnPorLid[msg.key.remoteJid] || null, nombreContacto: nombresContacto[msg.key.remoteJid] || null,
      });
      guardados++;
      if (guardados % 50 === 0) logger.info({ guardados, de: messages.length }, 'Importando historial...');
    } catch (e) {
      logger.error({ err: e }, 'Error importando un mensaje del historial');
    }
  }
  // Se matchea por jid (tal cual lo manda WhatsApp, @lid o @g.us incluido)
  // y no por teléfono: así no depende de poder resolver el número para
  // este paso, que solo corrige el contador de no leídos.
  // Equivalencias lid -> número y nombres de esta tanda: completan los chats
  // @lid que se crearon sin teléfono o sin nombre en tandas anteriores (hay
  // tandas, las de "nombres de perfil", que traen solo esto, sin mensajes).
  for (const c of contacts || []) {
    const nombre = c.name || c.notify || c.verifiedName || null;
    const lid = c.lid || (c.id && c.id.endsWith('@lid') ? c.id : null);
    const jid = c.phoneNumber || c.jid || (c.id && !c.id.endsWith('@lid') ? c.id : null);
    if ((lid && jid) || (nombre && lid)) {
      await actualizarContacto(supabase, userId, { lid, jid, nombre })
        .catch(e => logger.error({ err: e }, 'Error actualizando contacto del historial'));
    }
  }
  for (const lid of Object.keys(pnPorLid)) pnPorLidGlobal[lid] = pnPorLid[lid];
  await resolverLidsPendientes(sock, supabase, userId);
  for (const chat of chats || []) {
    if (!chat.id || !chat.unreadCount) continue;
    await supabase.from('conversaciones').update({ no_leidos: chat.unreadCount })
      .eq('user_id', userId).eq('jid', chat.id);
  }
  logger.info({ guardados }, 'Historial de WhatsApp importado.');
}

// Logger "hijo" que le pasamos a Baileys: queda en 'warn' aunque el
// nuestro esté en 'info', porque Baileys por su cuenta loguea en info
// cada query interna (son decenas, no aportan nada acá) — así no tapan
// nuestros propios logger.info de progreso. Además baja a debug (no se
// ve, salvo con LOG_LEVEL=debug) el "failed to decrypt message" que tira
// cuando le llega un mensaje cifrado con una sesión vieja (típico tras
// reescanear el QR varias veces, o con Estados de contactos) — es
// esperable y se autocorrige con el próximo mensaje de esa conversación.
// El resto de logger.error (nuestros, y cualquier otro error real de
// Baileys) no se toca.
const loggerBaileys = logger.child({}, { level: 'warn' });
const errorBaileysOriginal = loggerBaileys.error.bind(loggerBaileys);
loggerBaileys.error = (...args) => {
  const ultimo = args[args.length - 1];
  if (ultimo === 'failed to decrypt message') { loggerBaileys.debug(...args); return; }
  errorBaileysOriginal(...args);
};

async function iniciarWhatsApp({ supabase, userId, config, onReady }) {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({
    auth: state,
    logger: loggerBaileys,
    browser: ['CRM Panel Unificado', 'Chrome', '1.0'],
    syncFullHistory: true, // trae todos los chats/mensajes previos, no solo los recientes
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Se manda ya dibujado como imagen (data URL) en vez del texto crudo
      // del QR: así el panel solo tiene que mostrar un <img>, sin depender
      // de ninguna librería externa en el navegador (algunas redes de
      // oficina bloquean los CDN de JS y el QR quedaba sin poder dibujarse).
      const qrImagen = await QRCode.toDataURL(qr, { width: 300, margin: 1 });
      await supabase.from('wa_sesion').upsert({ user_id: userId, estado: 'conectando', qr: qrImagen });
      logger.info('QR nuevo generado — escanealo desde el panel (Conexión WhatsApp) o la terminal.');
    }

    if (connection === 'open') {
      await supabase.from('wa_sesion').upsert({
        user_id: userId, estado: 'conectado', qr: null,
        numero: sock.user?.id?.split(':')[0] || null,
        nombre_whatsapp: sock.user?.name || null,
        conectado_desde: new Date().toISOString(),
      });
      logger.info('WhatsApp conectado.');
      if (onReady) onReady(sock);
      // WhatsApp manda la lista completa de contactos agendados (con la
      // equivalencia lid -> número) una sola vez, al vincular. Para no
      // depender de eso, una vez por arranque del worker se pide de nuevo
      // desde cero (versión en null = snapshot completo; es lo mismo que
      // hace Baileys cuando una sincronización falla) — dispara
      // contacts.upsert y completa los chats @lid. Se espera un rato para
      // no pisarse con la importación del historial recién conectado.
      if (!contactosResincronizados) {
        contactosResincronizados = true;
        setTimeout(async () => {
          try {
            await state.keys.set({ 'app-state-sync-version': { critical_unblock_low: null } });
            await sock.resyncAppState(['critical_unblock_low'], true);
            logger.info('Lista de contactos de WhatsApp actualizada.');
            await resolverLidsPendientes(sock, supabase, userId);
          } catch (e) {
            logger.warn({ err: e }, 'No se pudo re-sincronizar la lista de contactos');
            contactosResincronizados = false; // se reintenta en la próxima conexión
          }
        }, 60000);
      }
    }

    if (connection === 'close') {
      try {
        await supabase.from('wa_sesion').upsert({ user_id: userId, estado: 'desconectado' });
      } catch (e) {
        logger.error({ err: e }, 'No se pudo marcar la sesión como desconectada');
      }
      const statusCode = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : null;
      const deslogueado = statusCode === DisconnectReason.loggedOut;
      logger.warn({ statusCode, deslogueado }, 'Conexión cerrada.');
      if (!deslogueado) {
        setTimeout(() => iniciarWhatsApp({ supabase, userId, config, onReady }), 5000);
      } else {
        logger.error('Sesión cerrada desde el celular — hay que volver a escanear el QR (borrar worker/auth/ y reiniciar).');
      }
    }
  });

  sock.ev.on('messaging-history.set', async (payload) => {
    try {
      await sincronizarHistorial(sock, supabase, userId, config, payload);
    } catch (e) {
      logger.error({ err: e }, 'Error sincronizando el historial de WhatsApp');
    }
  });

  const alActualizarContactos = async (contactos) => {
    for (const c of contactos || []) {
      const nombre = c.name || c.notify || c.verifiedName || null;
      const lid = c.lid || (c.id && c.id.endsWith('@lid') ? c.id : null);
      const jid = c.phoneNumber || c.jid || (c.id && !c.id.endsWith('@lid') ? c.id : null);
      if (!(lid && jid) && !(nombre && lid)) continue;
      await actualizarContacto(supabase, userId, { lid, jid, nombre })
        .catch(e => logger.error({ err: e }, 'Error actualizando contacto'));
    }
  };
  sock.ev.on('contacts.upsert', alActualizarContactos);
  sock.ev.on('contacts.update', alActualizarContactos);
  // Baileys 7: cada vez que aprende una equivalencia lid -> número.
  sock.ev.on('lid-mapping.update', ({ lid, pn }) => alActualizarContactos([{ lid, jid: pn }]));

  // 'notify' son los mensajes en vivo. 'append' trae, entre otros, los que
  // llegaron mientras el worker estaba desconectado (reinicio, corte de
  // internet): antes se descartaban y quedaban mensajes en el celular que
  // nunca aparecían en el CRM. guardarMensaje ya deduplica por wa_id, así
  // que los que ya estaban (por ejemplo los que mandó la cola) no se repiten.
  // A los atrasados no se les aplican las reglas automáticas si tienen más
  // de 30 minutos, igual que con el historial.
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages) {
      if (!msg.message) {
        // WhatsApp no lo pudo descifrar todavía (lo reintenta solo y, si
        // sale, vuelve a llegar por acá). Se deja constancia en el log.
        if (msg.messageStubType && msg.key?.remoteJid !== 'status@broadcast') {
          logger.warn({ jid: msg.key?.remoteJid, id: msg.key?.id, stub: msg.messageStubType, type }, 'Mensaje sin contenido (no se pudo descifrar todavía)');
        }
        continue;
      }
      try {
        const ts = Number(msg.messageTimestamp || 0) * 1000;
        const atrasado = type === 'append' && ts && (Date.now() - ts) > 30 * 60000;
        await guardarMensaje(sock, supabase, userId, config, msg, atrasado ? { aplicarAutomatizacion: false } : {});
      } catch (e) {
        logger.error({ err: e }, 'Error procesando mensaje entrante');
      }
    }
  });

  // Tildes de chats 1 a 1: WhatsApp avisa cada cambio de estado de un
  // mensaje (enviado al servidor, entregado al celular, leído).
  sock.ev.on('messages.update', async (cambios) => {
    const actualizaciones = (cambios || [])
      .filter(c => c.key?.id && c.key.remoteJid !== 'status@broadcast' && c.update && c.update.status != null)
      .map(c => ({ waId: c.key.id, estado: estadoDesdeStatus(c.update.status) }))
      .filter(a => a.estado);
    if (!actualizaciones.length) return;
    await actualizarTildes(supabase, userId, actualizaciones)
      .catch(e => logger.error({ err: e }, 'Error actualizando los tildes'));
  });

  // En grupos el aviso llega por participante (Baileys no lo manda por
  // messages.update): alcanza con que uno lo reciba / lo lea para mostrar
  // el tilde, como hace WhatsApp con "entregado".
  sock.ev.on('message-receipt.update', async (recibos) => {
    const actualizaciones = (recibos || [])
      .filter(r => r.key?.id && r.key.fromMe && r.key.remoteJid !== 'status@broadcast' && r.receipt)
      .map(r => ({
        waId: r.key.id,
        estado: (r.receipt.readTimestamp || r.receipt.playedTimestamp) ? 'leido' : r.receipt.receiptTimestamp ? 'entregado' : null,
      }))
      .filter(a => a.estado);
    if (!actualizaciones.length) return;
    await actualizarTildes(supabase, userId, actualizaciones)
      .catch(e => logger.error({ err: e }, 'Error actualizando los tildes de grupo'));
  });

  // Chat leído (o marcado como no leído) desde el celular.
  sock.ev.on('chats.update', (cambios) => actualizarNoLeidos(sock, supabase, userId, cambios)
    .catch(e => logger.error({ err: e }, 'Error actualizando no leídos')));

  return sock;
}

module.exports = { iniciarWhatsApp, jidATelefono };
