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
function jidATelefono(jid, jidAlt) {
  if (jid && jid.endsWith('@g.us')) return null;
  if (jid && !jid.endsWith('@lid')) {
    const tel = normalizarTelefonoAR(jid.split('@')[0]);
    if (tel) return tel;
  }
  if (jidAlt && !jidAlt.endsWith('@g.us')) {
    return normalizarTelefonoAR(jidAlt.split('@')[0]);
  }
  return null;
}

function tipoDeMensaje(msg) {
  if (msg.message?.imageMessage) return 'imagen';
  if (msg.message?.documentMessage) return 'pdf';
  if (msg.message?.audioMessage || msg.message?.pttMessage) return 'audio';
  if (msg.message?.conversation || msg.message?.extendedTextMessage) return 'texto';
  return 'otro';
}

function textoDeMensaje(msg) {
  return msg.message?.conversation
    || msg.message?.extendedTextMessage?.text
    || msg.message?.imageMessage?.caption
    || msg.message?.documentMessage?.caption
    || '';
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

async function aplicarReglas(supabase, userId, conversacion, mensajeTexto, tipo) {
  if (!conversacion.cliente_id) return; // sin cliente vinculado no hay tarjeta que mover

  const { data: cliente } = await supabase.from('clientes').select('*').eq('id', conversacion.cliente_id).single();
  const { data: etapaActual } = cliente?.etapa_id
    ? await supabase.from('etapas').select('clave').eq('id', cliente.etapa_id).maybeSingle()
    : { data: null };

  const { data: reglas } = await supabase
    .from('reglas').select('*').eq('user_id', userId).order('prioridad', { ascending: true });

  const resultado = clasificarMensaje(reglas || [], {
    texto: mensajeTexto,
    tieneAdjunto: tipo === 'imagen' || tipo === 'pdf',
    tipoAdjunto: tipo === 'imagen' || tipo === 'pdf' ? tipo : null,
    etapaActualClave: etapaActual?.clave || null,
  });
  if (!resultado) return;

  const { regla, fechaDetectada } = resultado;
  const accion = regla.accion || {};
  const cambios = {};

  if (accion.mueve_a) {
    const { data: etapaDestino } = await supabase
      .from('etapas').select('id').eq('user_id', userId).eq('clave', accion.mueve_a).maybeSingle();
    if (etapaDestino) cambios.etapa_id = etapaDestino.id;
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
  const esGrupo = !!jid && jid.endsWith('@g.us');

  let telefono = null;
  let nombreContactoResuelto = null;
  if (esGrupo) {
    // Los grupos no tienen teléfono propio — se identifican solo por jid.
  } else {
    // Esta versión de Baileys manda el número "de toda la vida" de un
    // contacto @lid en key.senderPn (remoteJidAlt es el nombre que usan
    // versiones más nuevas); jidAlt viene de la importación del historial.
    telefono = jidATelefono(jid, msg.key.remoteJidAlt || msg.key.senderPn || jidAlt || pnPorLidGlobal[jid]);
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
  const { error: errorInsert } = await supabase.from('mensajes').insert({
    conversacion_id: conversacion.id,
    wa_id: waId,
    direccion,
    tipo,
    texto: texto || null,
    media_path: mediaPath,
    estado: direccion === 'entrante' ? 'entregado' : 'enviado',
    creado_at: creadoAt,
  });
  if (errorInsert) { logger.error({ err: errorInsert }, 'No se pudo guardar el mensaje'); return; }

  const esMasNuevo = !conversacion.ultimo_at || creadoAt >= conversacion.ultimo_at;
  const { error: errorUpdate } = await supabase.from('conversaciones').update({
    ...(esMasNuevo ? { ultimo_texto: previewTexto(texto, tipo), ultimo_at: creadoAt } : {}),
    ...(direccion === 'entrante' && !opciones.noContarNoLeido ? { no_leidos: (conversacion.no_leidos || 0) + 1 } : {}),
  }).eq('id', conversacion.id);
  if (errorUpdate) logger.error({ err: errorUpdate }, 'No se pudo actualizar la conversación');

  if (aplicarAutomatizacion && direccion === 'entrante') {
    await aplicarReglas(supabase, userId, conversacion, texto, tipo).catch(e => logger.error({ err: e }, 'Error aplicando reglas'));
  }
}

// Esta versión de Baileys no tiene forma de preguntarle a WhatsApp el
// número de un contacto @lid, pero sí avisa cuando se entera: contactos
// agendados (contacts.upsert, con lid + jid), nombres de perfil
// (contacts.update / notify) y cuando alguien comparte su número
// (chats.phoneNumberShare). Se guarda en memoria para los mensajes que
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

// Primera vinculación (o reconexión): WhatsApp manda de a tandas todo el
// historial de chats que había antes de conectar el panel. Se guarda todo
// (sin bajar adjuntos viejos ni mover tarjetas del Kanban por mensajes
// pasados, ver guardarMensaje) y al final se corrige no_leidos de cada
// chat con el contador real que manda WhatsApp.
async function sincronizarHistorial(sock, supabase, userId, config, { chats, contacts, messages }) {
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
  (contacts || []).forEach(c => {
    if (c.lid && c.jid) pnPorLid[c.lid] = c.jid;
    const nombre = c.name || c.notify || c.verifiedName;
    if (c.id && nombre && !nombresContacto[c.id]) nombresContacto[c.id] = nombre;
  });

  let guardados = 0;
  for (const msg of messages || []) {
    if (!msg.message) continue;
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
    const jid = c.jid || (c.id && !c.id.endsWith('@lid') ? c.id : null);
    if ((lid && jid) || (nombre && lid)) {
      await actualizarContacto(supabase, userId, { lid, jid, nombre })
        .catch(e => logger.error({ err: e }, 'Error actualizando contacto del historial'));
    }
  }
  for (const lid of Object.keys(pnPorLid)) pnPorLidGlobal[lid] = pnPorLid[lid];
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
    printQRInTerminal: false,
    browser: ['Cash Market CRM', 'Chrome', '1.0'],
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
      const jid = c.jid || (c.id && !c.id.endsWith('@lid') ? c.id : null);
      if (!(lid && jid) && !(nombre && lid)) continue;
      await actualizarContacto(supabase, userId, { lid, jid, nombre })
        .catch(e => logger.error({ err: e }, 'Error actualizando contacto'));
    }
  };
  sock.ev.on('contacts.upsert', alActualizarContactos);
  sock.ev.on('contacts.update', alActualizarContactos);
  sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => alActualizarContactos([{ lid, jid }]));

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message) continue;
      try {
        await guardarMensaje(sock, supabase, userId, config, msg);
      } catch (e) {
        logger.error({ err: e }, 'Error procesando mensaje entrante');
      }
    }
  });

  return sock;
}

module.exports = { iniciarWhatsApp, jidATelefono };
