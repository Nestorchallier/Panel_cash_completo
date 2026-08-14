-- Panel Cash Market — esquema Supabase (v2)
-- Migración desde localStorage (ver RESUMEN_MIGRACION_GITPAGES_SUPABASE.md)
--
-- v2 reemplaza el esquema normalizado original (11 tablas) por un modelo
-- clave/valor. Motivo: revisando Panel_Cash_Market_Unificado_8_7.html, cada
-- sección (Sueldo & Cobros, Envío de Mensajes, Kanban) mantiene UN objeto en
-- memoria que se guarda completo con JSON.stringify en un puñado de puntos
-- del código (saveState(), etc.) — nunca hace operaciones fila por fila.
-- Normalizar en tablas separadas hubiera obligado a reescribir cada punto
-- donde el código muta ese objeto (docenas de lugares), con alto riesgo de
-- romper algo en una herramienta que se usa a diario con datos reales.
--
-- Con kv_store, cada una de las 8 claves de localStorage pasa a ser una fila
-- (mismo nombre de clave, mismo JSON adentro). Solo hay que tocar los
-- puntos exactos donde hoy se llama localStorage.getItem/setItem.
--
-- Si corriste el schema v1 antes, este script lo borra primero.

drop table if exists commission_tiers;
drop table if exists commission_categories;
drop table if exists payment_routes;
drop table if exists scale_rows;
drop table if exists payments;
drop table if exists mensajes_clientes;
drop table if exists plantillas;
drop table if exists kanban_clientes;
drop table if exists kanban_stages;
drop table if exists kanban_config;
drop table if exists cobros_settings;
drop table if exists profiles;

create table kv_store (
  user_id    uuid not null references auth.users(id) on delete cascade,
  key        text not null,   -- mismo nombre que la clave de localStorage, ej. 'misClientes'
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_kv_store_updated_at
  before update on kv_store
  for each row execute function set_updated_at();

alter table kv_store enable row level security;

create policy "own rows" on kv_store for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
