-- Bug encontrado en producción: 001_tablas.sql creó una función llamada
-- set_updated_at() para clientes/prestamos/plantillas/wa_sesion — pero ese
-- nombre ya lo usaba la función original de kv_store (de la migración
-- base, ver schema.sql), que pone new.updated_at. Como "create or replace
-- function" pisa la función existente sin importar qué tabla la use, desde
-- la Fase 1 cada UPDATE sobre kv_store tira "record 'new' has no field
-- 'actualizado_at'" porque kv_store no tiene esa columna (tiene
-- updated_at, en inglés) — rompía en silencio el tema claro/oscuro, el
-- estado de Sueldo & Cobros, la config del Kanban, etc. cada vez que se
-- volvía a guardar una clave ya existente.
--
-- Se separan en dos funciones con nombre distinto y cada trigger apunta a
-- la que corresponde.

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create or replace function set_actualizado_at()
returns trigger as $$
begin
  new.actualizado_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_clientes_actualizado_at on clientes;
create trigger trg_clientes_actualizado_at
  before update on clientes
  for each row execute function set_actualizado_at();

drop trigger if exists trg_prestamos_actualizado_at on prestamos;
create trigger trg_prestamos_actualizado_at
  before update on prestamos
  for each row execute function set_actualizado_at();

drop trigger if exists trg_plantillas_actualizado_at on plantillas;
create trigger trg_plantillas_actualizado_at
  before update on plantillas
  for each row execute function set_actualizado_at();

drop trigger if exists trg_wa_sesion_actualizado_at on wa_sesion;
create trigger trg_wa_sesion_actualizado_at
  before update on wa_sesion
  for each row execute function set_actualizado_at();
