-- Sin esto, los chats nuevos y los mensajes nuevos no llegan en vivo al
-- panel (solo se ven al recargar la página a mano) — Supabase no manda
-- eventos de Realtime de una tabla a menos que esté sumada a la
-- publicación supabase_realtime, y ninguna migración anterior lo hizo.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversaciones'
  ) then
    alter publication supabase_realtime add table conversaciones;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'mensajes'
  ) then
    alter publication supabase_realtime add table mensajes;
  end if;
end $$;
