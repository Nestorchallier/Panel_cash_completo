-- Rol SUPERVISOR (solo lectura sobre todo el equipo).
--
-- Hasta ahora cada cobrador veía solo sus filas (002_rls.sql: user_id =
-- auth.uid()). Esto agrega:
--   1) la tabla perfiles: quién es cobrador y quién supervisor;
--   2) la función es_supervisor(), que las políticas usan para saber si el
--      usuario logueado es supervisor;
--   3) políticas EXTRA de solo lectura (SELECT) en todas las tablas de datos
--      y en el bucket de comprobantes, para que un supervisor pueda LEER las
--      filas de todos los cobradores.
--
-- Al supervisor NUNCA se le da insert / update / delete sobre lo ajeno: las
-- políticas nuevas son "for select". Las políticas "own rows" de siempre
-- siguen igual (cada uno escribe solo lo suyo).
--
-- OJO: como el supervisor ve todo, el panel ya no confía en RLS para
-- quedarse con "lo mío": cada consulta filtra por el usuario que se está
-- viendo (ver cmUidVista en supabase/kv.js).
--
-- Requiere haber corrido antes 010_actividad.sql (tablas del contador de
-- actividad), porque también les da lectura a los supervisores.
--
-- Se corre una sola vez en Supabase → SQL Editor → New query → pegar → Run.
-- Se puede volver a correr sin problema.

-- ───────────────────────── perfiles ─────────────────────────
create table if not exists perfiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  nombre      text not null default '',
  rol         text not null default 'cobrador' check (rol in ('cobrador', 'supervisor')),
  creado_at   timestamptz not null default now()
);

-- Un perfil por cada usuario que ya entró al panel (con el nombre que puso).
insert into perfiles (user_id, nombre)
select u.id, coalesce(u.nombre, '') from usuarios u
on conflict (user_id) do nothing;

-- ¿El usuario logueado es supervisor? security definer: lee perfiles sin
-- pasar por RLS (si no, la política de perfiles se llamaría a sí misma).
create or replace function es_supervisor()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.perfiles
    where user_id = auth.uid() and rol = 'supervisor'
  );
$$;

revoke all on function es_supervisor() from public;
grant execute on function es_supervisor() to authenticated;

alter table perfiles enable row level security;
-- Cada uno ve su propio perfil; el supervisor ve todos. Nadie lo escribe
-- desde el panel: el rol se cambia a mano acá en el SQL Editor (abajo).
drop policy if exists "perfiles: ver propio" on perfiles;
create policy "perfiles: ver propio" on perfiles for select
  to authenticated using (user_id = auth.uid());
drop policy if exists "perfiles: supervisor lee" on perfiles;
create policy "perfiles: supervisor lee" on perfiles for select
  to authenticated using (es_supervisor());

-- ───────────── lectura de todo el equipo para supervisores ─────────────
-- Una política "for select" más por tabla. Las políticas de Postgres se
-- suman (OR): el cobrador sigue viendo lo suyo por "own rows" y el
-- supervisor además ve lo de todos por esta.
do $$
declare
  t text;
begin
  foreach t in array array[
    'usuarios', 'etapas', 'clientes', 'clientes_telefonos', 'prestamos',
    'cuotas', 'pagos', 'plantillas', 'conversaciones', 'mensajes', 'reglas',
    'eventos', 'recordatorios', 'wa_sesion', 'kv_store', 'contactos',
    'actividad', 'actividad_latido'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists "supervisor lee" on public.%I', t);
      execute format(
        'create policy "supervisor lee" on public.%I for select to authenticated using (public.es_supervisor())', t);
    else
      raise notice 'Tabla % no existe todavía: se saltea (¿falta correr una migración anterior?)', t;
    end if;
  end loop;
end $$;

-- Fotos y PDF de los chats (bucket privado "comprobantes", ver
-- 008_storage_comprobantes.sql): el supervisor puede abrir los de todos.
drop policy if exists "comprobantes: supervisor lee" on storage.objects;
create policy "comprobantes: supervisor lee"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'comprobantes' and public.es_supervisor());

-- ───────────────────────── marcar un supervisor ─────────────────────────
-- El supervisor es un usuario más (se crea en Authentication → Users como
-- los cobradores). Después de crearlo, se lo marca así (cambiá el email):
--
--   insert into perfiles (user_id, nombre, rol)
--   select id, 'Supervisor', 'supervisor' from auth.users where email = 'supervisor@ejemplo.com'
--   on conflict (user_id) do update set rol = 'supervisor', nombre = excluded.nombre;
--
-- Para sacarle el rol (vuelve a ser cobrador):
--
--   update perfiles set rol = 'cobrador'
--   where user_id = (select id from auth.users where email = 'supervisor@ejemplo.com');
--
-- Para ver quién es qué:
--
--   select u.email, p.nombre, p.rol from perfiles p join auth.users u on u.id = p.user_id order by p.rol, u.email;
