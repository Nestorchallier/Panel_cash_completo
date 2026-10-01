-- Políticas RLS: cada cobrador ve y edita solo sus propias filas. Nada de
-- esto es visible entre compañeros (ver nota de alcance en 001_tablas.sql).

alter table usuarios        enable row level security;
alter table etapas          enable row level security;
alter table clientes        enable row level security;
alter table clientes_telefonos enable row level security;
alter table prestamos       enable row level security;
alter table cuotas          enable row level security;
alter table pagos           enable row level security;
alter table plantillas      enable row level security;
alter table conversaciones  enable row level security;
alter table mensajes        enable row level security;
alter table reglas          enable row level security;
alter table eventos         enable row level security;
alter table recordatorios   enable row level security;
alter table wa_sesion       enable row level security;

-- Tablas con user_id propio: política directa.
create policy "own rows" on usuarios for all
  using (auth.uid() = id) with check (auth.uid() = id);

create policy "own rows" on etapas for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own rows" on clientes for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own rows" on prestamos for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own rows" on pagos for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own rows" on plantillas for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own rows" on conversaciones for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own rows" on reglas for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own rows" on eventos for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own rows" on recordatorios for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own rows" on wa_sesion for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Tablas hijas sin user_id propio: se valida contra el dueño de la fila padre.
create policy "own rows via cliente" on clientes_telefonos for all
  using (exists (select 1 from clientes c where c.id = cliente_id and c.user_id = auth.uid()))
  with check (exists (select 1 from clientes c where c.id = cliente_id and c.user_id = auth.uid()));

create policy "own rows via prestamo" on cuotas for all
  using (exists (select 1 from prestamos p where p.id = prestamo_id and p.user_id = auth.uid()))
  with check (exists (select 1 from prestamos p where p.id = prestamo_id and p.user_id = auth.uid()));

create policy "own rows via conversacion" on mensajes for all
  using (exists (select 1 from conversaciones cv where cv.id = conversacion_id and cv.user_id = auth.uid()))
  with check (exists (select 1 from conversaciones cv where cv.id = conversacion_id and cv.user_id = auth.uid()));

-- El worker de WhatsApp (Fase 2) corre con la service_role key, que
-- ignora RLS por diseño de Supabase — no necesita políticas propias, pero
-- por eso la service key NUNCA debe exponerse en el panel (solo vive en el
-- .env del worker, ver worker/.env.example).
