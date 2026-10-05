-- Contador de actividad: registra los tramos en que cada usuario estuvo
-- usando el panel (mouse, teclado, scroll). Si pasan 5 minutos sin tocar
-- nada, el tramo se cierra en el último movimiento; el hueco hasta el
-- siguiente tramo es una pausa. Lo carga js/actividad.js y lo muestra el
-- Panel de supervisor (supervisor.html).
--
-- actividad_latido es una fila por usuario con el último "latido" de la
-- pestaña abierta (cada 30 s, aunque no toque nada) y el último movimiento:
-- con eso el supervisor distingue Conectado / Inactivo N min /
-- Desconectado desde HH:MM.
--
-- Se corre una sola vez en Supabase → SQL Editor → New query → pegar → Run.
-- Se puede volver a correr sin problema.

create table if not exists actividad (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  dia         date not null,             -- día en horario de Argentina
  inicio      timestamptz not null,
  fin         timestamptz not null,
  creado_at   timestamptz not null default now(),
  check (fin >= inicio)
);

create index if not exists actividad_user_dia on actividad (user_id, dia);
create index if not exists actividad_dia on actividad (dia);

alter table actividad enable row level security;
drop policy if exists "own rows" on actividad;
create policy "own rows" on actividad for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists actividad_latido (
  user_id          uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  latido_at        timestamptz not null default now(),  -- pestaña abierta (cada 30 s)
  ultimo_input_at  timestamptz,                         -- último mouse / teclado / scroll
  sesion_desde     timestamptz                          -- cuándo abrió el panel esta vez
);

alter table actividad_latido enable row level security;
drop policy if exists "own rows" on actividad_latido;
create policy "own rows" on actividad_latido for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
