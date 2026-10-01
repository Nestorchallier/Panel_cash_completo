-- Fase 3 (ampliación): soporte para chats grupales en la Bandeja. Un grupo
-- no tiene cliente ni teléfono propio (lo identifica WhatsApp solo por su
-- jid), así que telefono pasa a ser opcional y el jid se vuelve la clave
-- real para no duplicar conversaciones.
alter table conversaciones alter column telefono drop not null;
alter table conversaciones add column if not exists nombre text;
alter table conversaciones add column if not exists es_grupo boolean not null default false;

drop index if exists conversaciones_user_telefono_idx;
create unique index conversaciones_user_telefono_idx on conversaciones(user_id, telefono) where telefono is not null;
create unique index if not exists conversaciones_user_jid_idx on conversaciones(user_id, jid);
