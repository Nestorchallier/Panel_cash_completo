-- Agenda de contactos que NO son clientes (equipo, gerencia, otros).
--
-- Sirve para que los chats con compañeros o la gerencia muestren el nombre
-- y no queden como "Sin cliente vinculado". Se cargan desde la pantalla
-- "Agenda" del panel o con "📇 Guardar en agenda" en un chat sin agendar.
--
-- Se corre una sola vez en Supabase → SQL Editor → New query → pegar → Run.
-- Se puede volver a correr sin problema.

create table if not exists contactos (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade default auth.uid(),
  nombre      text not null,
  telefono    text,                      -- normalizado como en clientes_telefonos (549...)
  grupo       text not null default 'equipo' check (grupo in ('equipo', 'gerencia', 'otro')),
  cargo       text,                      -- ej: "Supervisor", "Cobrador calle"
  notas       text,
  creado_at   timestamptz not null default now(),
  actualizado_at timestamptz not null default now()
);

create unique index if not exists contactos_user_telefono on contactos (user_id, telefono) where telefono is not null;

alter table contactos enable row level security;
drop policy if exists "own rows" on contactos;
create policy "own rows" on contactos for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
