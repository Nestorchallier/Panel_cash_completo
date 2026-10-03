-- CRM Panel Unificado — CRM de Cobranzas con WhatsApp (esquema v3)
-- Reemplaza el modelo kv_store (blobs JSON por clave) por tablas relacionales,
-- según sección 4 de docs/CRM_WhatsApp_Cash_Market_Plan.pdf.
--
-- Decisión de alcance (confirmada con el usuario): el sistema sigue siendo
-- por-usuario, no de equipo compartido. Cada cobrador sube su propia cartera
-- y conecta su propio WhatsApp; solo ve sus clientes y sus chats, nunca los
-- de un compañero. Por eso cada tabla tiene user_id y las políticas RLS
-- (002_rls.sql) son "solo mis filas", igual que ya funcionaba con kv_store.
-- Si en el futuro se agregan compañeros, se suma su propio user_id: no hace
-- falta rediseñar nada de esto.
--
-- kv_store (schema.sql) se mantiene para configuración liviana que no es una
-- entidad del CRM: tema claro/oscuro, campos personalizados del Kanban,
-- ajustes de Sueldo & Cobros (objetivo, escalas, categorías). Lo que antes
-- vivía ahí como listas/objetos centrales (clientes del Kanban, columnas,
-- plantillas, pagos) pasa a las tablas de abajo.

create extension if not exists pgcrypto;

-- ───────────────────────── usuarios ─────────────────────────
-- Un reflejo liviano de auth.users con datos propios del panel (nombre para
-- mostrar, color de avatar). Reemplaza el viejo wa_ejecutivo_v1.
create table usuarios (
  id          uuid primary key references auth.users(id) on delete cascade,
  nombre      text not null default '',
  color       text not null default '#5b8def',
  rol         text not null default 'cobrador' check (rol in ('cobrador','admin')),
  creado_at   timestamptz not null default now()
);

-- ───────────────────────── etapas ─────────────────────────
-- Columnas del Kanban. 'clave' identifica a las protegidas (a_contactar,
-- cerrado) que el resto del sistema referencia por id fijo; las columnas
-- que agregue el usuario tienen clave null.
-- id es texto (no uuid) a propósito: el panel ya generaba sus propios ids
-- tipo "st_..." para las columnas antes de esta migración, y el cliente
-- JS sigue generándolos igual — así no hace falta tocar esa lógica.
create table etapas (
  id          text primary key default (gen_random_uuid()::text),
  user_id     uuid not null references auth.users(id) on delete cascade,
  clave       text,
  nombre      text not null,
  color       text not null default '#8996ab',
  orden       int not null default 0,
  protegida   boolean not null default false,
  creado_at   timestamptz not null default now()
);
create unique index etapas_user_clave_idx on etapas(user_id, clave) where clave is not null;

-- ───────────────────────── clientes ─────────────────────────
-- id también es texto por el mismo motivo que etapas.id: preserva los ids
-- "c_..." que ya existen en los clientes del Kanban migrados desde el blob.
create table clientes (
  id              text primary key default (gen_random_uuid()::text),
  user_id         uuid not null references auth.users(id) on delete cascade,
  nombre          text not null,
  dni             text,
  cuil            text,
  domicilio       text,
  localidad       text,
  empleador       text,
  email           text,
  categoria       text,
  segmento        text,
  cobrador_nombre text,
  -- Copia denormalizada del teléfono "principal" (el que usa WhatsApp), para
  -- que el Kanban lo edite como un campo simple de la tarjeta, igual que
  -- antes. La fuente de verdad para vincular chats sigue siendo
  -- clientes_telefonos (un cliente puede tener más de un número); cada
  -- escritura acá se refleja también ahí vía la capa de datos del panel.
  telefono_principal text,
  etapa_id        text references etapas(id) on delete set null,
  promesa_fecha   date,
  notas           text,
  etiquetas       text[] not null default '{}',
  campos_extra    jsonb not null default '{}',
  creado_at       timestamptz not null default now(),
  actualizado_at  timestamptz not null default now()
);
-- Un mismo cobrador no puede tener dos fichas con el mismo DNI (clave de
-- match al importar los dos Excel de cartera). Clientes cargados a mano sin
-- DNI quedan afuera de esta restricción.
create unique index clientes_user_dni_idx on clientes(user_id, dni) where dni is not null and dni <> '';
create index clientes_user_etapa_idx on clientes(user_id, etapa_id);

-- Nombre distinto a propósito: kv_store (schema.sql) ya tiene su propia
-- función set_updated_at() que pone new.updated_at — usar el mismo nombre
-- acá la pisaría (create or replace reemplaza la función sin importar qué
-- tabla la use) y rompería en silencio cada UPDATE sobre kv_store.
create or replace function set_actualizado_at()
returns trigger as $$
begin
  new.actualizado_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_clientes_actualizado_at
  before update on clientes
  for each row execute function set_actualizado_at();

-- ───────────────────────── clientes_telefonos ─────────────────────────
-- Uno o más teléfonos por cliente, ya normalizados a 549 + área + número
-- (ver js/telefonos.js). Es la clave para vincular un chat de WhatsApp
-- entrante con la ficha del cliente.
create table clientes_telefonos (
  id          uuid primary key default gen_random_uuid(),
  cliente_id  text not null references clientes(id) on delete cascade,
  telefono    text not null,
  etiqueta    text not null default 'Celular',
  es_whatsapp boolean not null default true,
  principal   boolean not null default false,
  creado_at   timestamptz not null default now()
);
create unique index clientes_telefonos_unicos_idx on clientes_telefonos(cliente_id, telefono);
create index clientes_telefonos_telefono_idx on clientes_telefonos(telefono);

-- ───────────────────────── prestamos ─────────────────────────
-- Un cliente puede tener más de un préstamo (histórico + activo). Trae
-- también los campos de saldo/atraso que da el Excel "Préstamos", para no
-- tener que recalcularlos en el panel.
create table prestamos (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  cliente_id              text not null references clientes(id) on delete cascade,
  nro                     text not null,
  monto                   numeric,
  cant_cuotas             int,
  cuota_monto             numeric,
  tna                     numeric,
  fecha_alta              date,
  primer_vencimiento      date,
  proximo_vencimiento     date,
  fecha_vencimiento_final date,
  cuotas_pagas            int not null default 0,
  cuotas_vencidas         int not null default 0,
  ultimo_pago             date,
  saldo_capital           numeric,
  saldo_total             numeric,
  saldo_total_punitorios  numeric,
  dias_atraso             int not null default 0,
  importe_atraso          numeric not null default 0,
  estado                  text not null default 'activo' check (estado in ('activo','cancelado','refinanciado')),
  origen                  text,
  creado_at               timestamptz not null default now(),
  actualizado_at          timestamptz not null default now()
);
create unique index prestamos_user_nro_idx on prestamos(user_id, nro);
create index prestamos_cliente_idx on prestamos(cliente_id);

create trigger trg_prestamos_actualizado_at
  before update on prestamos
  for each row execute function set_actualizado_at();

-- ───────────────────────── cuotas ─────────────────────────
-- El Excel de cartera no trae el plan cuota por cuota, solo totales (pagas,
-- vencidas, próx. vto). El importador arma esta tabla a partir de esos
-- totales (fecha_alta + cant_cuotas, una por mes); si más adelante llega un
-- Excel con el detalle real, se puede recargar sin tocar el resto.
create table cuotas (
  id            uuid primary key default gen_random_uuid(),
  prestamo_id   uuid not null references prestamos(id) on delete cascade,
  numero        int not null,
  vencimiento   date,
  monto         numeric,
  estado        text not null default 'pendiente' check (estado in ('pendiente','pagada','vencida')),
  monto_pagado  numeric,
  pagado_el     date
);
create unique index cuotas_prestamo_numero_idx on cuotas(prestamo_id, numero);

-- ───────────────────────── pagos ─────────────────────────
-- Reemplaza el array payments[] que vivía adentro del blob de Sueldo &
-- Cobros. Un pago puede no tener cliente_id (todavía) si vino de un Excel
-- de cobros que no matcheó por nombre — se deja para match manual.
create table pagos (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  cliente_id    text references clientes(id) on delete set null,
  prestamo_id   uuid references prestamos(id) on delete set null,
  nombre        text not null,
  fecha         date,
  monto         numeric not null default 0,
  estado        text not null default 'pendiente',
  origen        text not null default 'manual' check (origen in ('excel','kanban','whatsapp','manual')),
  comprobante_path text,
  creado_at     timestamptz not null default now()
);
create index pagos_user_idx on pagos(user_id);
create index pagos_cliente_idx on pagos(cliente_id);

-- ───────────────────────── plantillas ─────────────────────────
create table plantillas (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  atajo       text,
  nombre      text not null,
  texto       text not null default '',
  creado_at   timestamptz not null default now(),
  actualizado_at timestamptz not null default now()
);
create unique index plantillas_user_nombre_idx on plantillas(user_id, nombre);

create trigger trg_plantillas_actualizado_at
  before update on plantillas
  for each row execute function set_actualizado_at();

-- ───────────────────────── conversaciones ─────────────────────────
create table conversaciones (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  jid         text not null,            -- id de WhatsApp (ej. 5491145327781@s.whatsapp.net)
  telefono    text not null,            -- mismo número normalizado (549...)
  cliente_id  text references clientes(id) on delete set null,
  asignado_a  uuid references usuarios(id) on delete set null,
  no_leidos   int not null default 0,
  ultimo_texto text,
  ultimo_at   timestamptz,
  creado_at   timestamptz not null default now()
);
create unique index conversaciones_user_telefono_idx on conversaciones(user_id, telefono);
create index conversaciones_cliente_idx on conversaciones(cliente_id);

-- ───────────────────────── mensajes ─────────────────────────
create table mensajes (
  id              uuid primary key default gen_random_uuid(),
  conversacion_id uuid not null references conversaciones(id) on delete cascade,
  wa_id           text,                 -- id único de WhatsApp, para no duplicar si Baileys reentrega
  direccion       text not null check (direccion in ('entrante','saliente')),
  tipo            text not null default 'texto' check (tipo in ('texto','imagen','pdf','audio','otro')),
  texto           text,
  media_path      text,                 -- ruta en Supabase Storage (bucket comprobantes/)
  estado          text not null default 'enviado' check (estado in ('pendiente','enviado','entregado','leido','error')),
  enviado_por     uuid references usuarios(id) on delete set null,
  creado_at       timestamptz not null default now()
);
create unique index mensajes_wa_id_idx on mensajes(wa_id) where wa_id is not null;
create index mensajes_conversacion_idx on mensajes(conversacion_id, creado_at);

-- ───────────────────────── reglas ─────────────────────────
-- Clasificación automática por palabras clave (sección 6). 'accion' guarda
-- qué hace la regla: {"mover_a":"<clave de etapa>", "etiqueta":"...",
-- "avisa_admin":true, "detectar_fecha":true}.
create table reglas (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  prioridad     int not null default 100,
  nombre        text not null,
  palabras      text[] not null default '{}',
  tipo_adjunto  text,                   -- 'imagen' | 'pdf' | null (no filtra por adjunto)
  accion        jsonb not null default '{}',
  activa        boolean not null default true,
  creado_at     timestamptz not null default now()
);
create index reglas_user_prioridad_idx on reglas(user_id, prioridad);

-- ───────────────────────── eventos ─────────────────────────
-- Línea de tiempo de gestión de la ficha del cliente (5.3).
create table eventos (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  cliente_id  text not null references clientes(id) on delete cascade,
  tipo        text not null check (tipo in ('mensaje','etapa','promesa','nota','pago','regla')),
  detalle     jsonb not null default '{}',
  usuario_id  uuid references usuarios(id) on delete set null,
  creado_at   timestamptz not null default now()
);
create index eventos_cliente_idx on eventos(cliente_id, creado_at desc);

-- ───────────────────────── recordatorios ─────────────────────────
-- Lo que aparece en el Calendario (5.5): promesas, vencimientos, manuales.
create table recordatorios (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  cliente_id  text references clientes(id) on delete cascade,
  fecha       date not null,
  tipo        text not null check (tipo in ('promesa','vencimiento','manual','cobrado')),
  texto       text,
  hecho       boolean not null default false,
  creado_at   timestamptz not null default now()
);
create index recordatorios_user_fecha_idx on recordatorios(user_id, fecha);

-- ───────────────────────── wa_sesion ─────────────────────────
-- Una fila por usuario: estado de su conexión de WhatsApp (su propio
-- número, su propio worker). El worker la actualiza con la service key.
create table wa_sesion (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  estado          text not null default 'desconectado' check (estado in ('desconectado','conectando','conectado')),
  qr              text,
  numero          text,
  nombre_whatsapp text,
  conectado_desde timestamptz,
  ultimo_latido   timestamptz,
  enviados_hoy    int not null default 0,
  limite_diario   int not null default 250,
  intervalo_min   int not null default 25,
  intervalo_max   int not null default 60,
  horario_desde   time not null default '09:00',
  horario_hasta   time not null default '20:00',
  dias_habiles    int[] not null default '{1,2,3,4,5,6}',
  actualizado_at  timestamptz not null default now()
);

create trigger trg_wa_sesion_actualizado_at
  before update on wa_sesion
  for each row execute function set_actualizado_at();
