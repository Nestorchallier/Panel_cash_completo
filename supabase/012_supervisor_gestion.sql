-- Gestión del supervisor: Objetivos por agente y Usuarios.
--
--   1) objetivos_agente: el objetivo mensual de cada agente lo fija el
--      supervisor. Solo un supervisor lo escribe; lo leen el propio agente
--      (su pantalla Objetivos lo muestra fijo, sin poder cambiarlo) y los
--      supervisores. Si para el mes no hay fila, sigue valiendo el objetivo
--      que el agente tenga cargado en su panel, como hasta ahora.
--
--   2) comandos_usuarios: crear agentes, editar nombre / rol, deshabilitar,
--      habilitar y cambiar la contraseña necesitan la clave SERVICE de
--      Supabase, que NUNCA va en el panel (es público). El supervisor deja
--      un pedido en esta tabla y el worker (que sí tiene la clave, en el
--      servidor) lo ejecuta, guarda el resultado (estado 'ok' / 'error' +
--      mensaje) y borra la contraseña de la fila apenas la toma. Mismo
--      patrón que wa_sesion.comando (004_comando_sesion.sql).
--
--   3) usuarios_equipo(): la lista de usuarios con su email y si están
--      deshabilitados (eso vive en auth.users, que el panel no puede leer).
--      Solo devuelve filas a un supervisor.
--
-- Requiere 011_supervisor.sql (perfiles y es_supervisor()).
-- Se corre en Supabase → SQL Editor → New query → pegar → Run.
-- Se puede volver a correr sin problema.

-- ───────────────────────── objetivos_agente ─────────────────────────
create table if not exists objetivos_agente (
  user_id         uuid not null references auth.users(id) on delete cascade,
  periodo         text not null check (periodo ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),  -- 'AAAA-MM'
  monto           numeric(16, 2) not null check (monto > 0),
  fijado_por      uuid references auth.users(id) on delete set null default auth.uid(),
  actualizado_at  timestamptz not null default now(),
  primary key (user_id, periodo)
);

alter table objetivos_agente enable row level security;

drop policy if exists "objetivos: ver propio o supervisor" on objetivos_agente;
create policy "objetivos: ver propio o supervisor" on objetivos_agente for select
  to authenticated using (user_id = auth.uid() or public.es_supervisor());

drop policy if exists "objetivos: supervisor crea" on objetivos_agente;
create policy "objetivos: supervisor crea" on objetivos_agente for insert
  to authenticated with check (public.es_supervisor());

drop policy if exists "objetivos: supervisor cambia" on objetivos_agente;
create policy "objetivos: supervisor cambia" on objetivos_agente for update
  to authenticated using (public.es_supervisor()) with check (public.es_supervisor());

drop policy if exists "objetivos: supervisor borra" on objetivos_agente;
create policy "objetivos: supervisor borra" on objetivos_agente for delete
  to authenticated using (public.es_supervisor());

-- actualizado_at / fijado_por al día en cada cambio (aunque el panel no los mande).
create or replace function objetivos_agente_tocar()
returns trigger language plpgsql as $$
begin
  new.actualizado_at := now();
  if auth.uid() is not null then new.fijado_por := auth.uid(); end if;
  return new;
end $$;
drop trigger if exists objetivos_agente_tocar on objetivos_agente;
create trigger objetivos_agente_tocar before insert or update on objetivos_agente
  for each row execute function objetivos_agente_tocar();

-- ───────────────────────── comandos_usuarios ─────────────────────────
create table if not exists comandos_usuarios (
  id            uuid primary key default gen_random_uuid(),
  creador       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  accion        text not null check (accion in ('crear', 'editar', 'deshabilitar', 'habilitar', 'reset_password')),
  user_id       uuid,          -- usuario sobre el que se actúa (en 'crear' lo completa el worker)
  email         text,
  nombre        text,
  rol           text check (rol in ('cobrador', 'supervisor')),
  password      text,          -- solo hasta que el worker toma el pedido: lo borra enseguida
  estado        text not null default 'pendiente' check (estado in ('pendiente', 'procesando', 'ok', 'error')),
  mensaje       text,
  creado_at     timestamptz not null default now(),
  procesado_at  timestamptz
);
create index if not exists comandos_usuarios_pendientes on comandos_usuarios (creado_at) where estado = 'pendiente';

alter table comandos_usuarios enable row level security;

-- El supervisor solo puede DEJAR pedidos nuevos, a su nombre y pendientes.
-- Cambiarlos (estado, mensaje, borrar la contraseña) lo hace solo el worker
-- con la clave service, que no pasa por RLS.
drop policy if exists "comandos_usuarios: supervisor pide" on comandos_usuarios;
create policy "comandos_usuarios: supervisor pide" on comandos_usuarios for insert
  to authenticated with check (
    public.es_supervisor() and creador = auth.uid() and estado = 'pendiente'
    and mensaje is null and procesado_at is null
  );
drop policy if exists "comandos_usuarios: supervisor ve" on comandos_usuarios;
create policy "comandos_usuarios: supervisor ve" on comandos_usuarios for select
  to authenticated using (public.es_supervisor());

-- La contraseña no se puede leer desde el panel ni un instante: lectura
-- solo de las otras columnas.
revoke all on comandos_usuarios from anon, authenticated;
grant insert on comandos_usuarios to authenticated;
grant select (id, creador, accion, user_id, email, nombre, rol, estado, mensaje, creado_at, procesado_at)
  on comandos_usuarios to authenticated;

-- ───────────────────────── usuarios_equipo() ─────────────────────────
create or replace function usuarios_equipo()
returns table (
  user_id uuid, email text, nombre text, rol text,
  deshabilitado boolean, ultimo_ingreso timestamptz, creado_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select u.id,
         u.email::text,
         coalesce(nullif(p.nombre, ''), nullif(us.nombre, ''), split_part(u.email, '@', 1)),
         coalesce(p.rol, 'cobrador'),
         (u.banned_until is not null and u.banned_until > now()),
         u.last_sign_in_at,
         u.created_at
  from auth.users u
  left join public.perfiles p on p.user_id = u.id
  left join public.usuarios us on us.id = u.id
  where public.es_supervisor()
  order by 3;
$$;

revoke all on function usuarios_equipo() from public;
grant execute on function usuarios_equipo() to authenticated;
