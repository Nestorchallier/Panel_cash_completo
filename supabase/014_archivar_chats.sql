-- Archivar chats, y leer en el celular lo que se lee en el CRM.
--
-- 1) Archivar (como en WhatsApp Web): el chat sale de "Todos" / "Sin leer"
--    y pasa al filtro "Archivados". Si llega un mensaje nuevo SIGUE
--    archivado (igual que WhatsApp con "Mantener chats archivados"): el
--    worker nunca toca estas columnas, solo las cambia el panel.
--    Eliminar un chat no necesita nada nuevo: es un delete de la
--    conversación (la política "own rows" de 002 ya lo permite) y los
--    mensajes se borran solos (on delete cascade, 001). Los clientes no se
--    tocan.
--
-- 2) Leído en el celular: al abrir en el CRM un chat con mensajes sin leer,
--    el panel deja la marca leer_en_celular_hasta = ahora. El worker la ve
--    (revisa cada pocos segundos), le manda a WhatsApp el "leído" de los
--    entrantes sin leer hasta ese momento (el contacto ve los tildes
--    azules) y borra la marca. El supervisor mirando un chat NO deja la
--    marca (además su política es solo de lectura, ver 011).
--    Para los grupos WhatsApp pide quién escribió cada mensaje: se guarda
--    en mensajes.wa_participante (los mensajes viejos no lo tienen y en
--    grupos se saltean). wa_remote_jid es el jid con el que llegó el
--    mensaje (puede ser el @lid aunque el chat esté guardado con el número).
--
-- Se corre una sola vez en Supabase → SQL Editor → New query → pegar → Run.
-- Se puede volver a correr sin problema.

alter table conversaciones add column if not exists archivada boolean not null default false;
alter table conversaciones add column if not exists archivada_at timestamptz;
alter table conversaciones add column if not exists leer_en_celular_hasta timestamptz;

alter table mensajes add column if not exists wa_remote_jid text;
alter table mensajes add column if not exists wa_participante text;

-- El worker busca solo los chats con la marca puesta: índice chico, parcial.
create index if not exists conversaciones_leer_en_celular_idx
  on conversaciones(user_id) where leer_en_celular_hasta is not null;
