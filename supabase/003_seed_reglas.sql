-- Carga inicial para un cobrador nuevo: fila en usuarios, columnas del
-- Kanban y las 7 reglas de clasificación de la sección 6. No se puede
-- insertar esto "a ciegas" en una migración porque no hay forma de saber de
-- antemano el user_id de cada cobrador — en cambio se expone como función
-- que el panel llama una sola vez, la primera vez que alguien entra
-- (auth.uid() = el que está logueado). Es idempotente: si ya tiene datos,
-- no duplica nada.
create or replace function bootstrap_usuario(p_nombre text default '')
returns void
language plpgsql
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'bootstrap_usuario: no hay sesión';
  end if;

  insert into usuarios (id, nombre)
  values (v_uid, coalesce(nullif(p_nombre, ''), split_part(auth.email(), '@', 1)))
  on conflict (id) do nothing;

  if not exists (select 1 from etapas where user_id = v_uid) then
    insert into etapas (user_id, clave, nombre, color, orden, protegida) values
      (v_uid, 'a_contactar',    'A contactar',          '#8996ab', 0, true),
      (v_uid, 'contactado',     'Contactado',           '#5b8def', 1, false),
      (v_uid, 'promesa',        'Promesa de pago',      '#f0b866', 2, false),
      (v_uid, 'verificar_pago', 'Verificar pago',       '#8b6fd1', 3, false),
      (v_uid, 'refinanciado',   'Refinanciado',         '#3fd0c9', 4, false),
      (v_uid, 'cerrado',        'Cerrado (Cobrado)',    '#63d29a', 5, true);
  end if;

  if not exists (select 1 from reglas where user_id = v_uid) then
    insert into reglas (user_id, prioridad, nombre, palabras, tipo_adjunto, accion, activa) values
      (v_uid, 1, 'Reclamo / riesgo',
        array['denuncia','abogado','defensa del consumidor','no me escriban','acoso'],
        null,
        jsonb_build_object('etiqueta', 'Reclamo', 'avisa_admin', true, 'mueve', false),
        true),
      (v_uid, 2, 'Comprobante',
        array['transferi','comprobante','ya pague','ya deposite'],
        'imagen_o_pdf',
        jsonb_build_object('mueve_a', 'verificar_pago', 'etiqueta', 'Comprobante', 'guarda_adjunto', true),
        true),
      (v_uid, 3, 'Promesa de pago',
        array['te pago','manana','el viernes','cuando cobro','a fin de mes','el 10'],
        null,
        jsonb_build_object('mueve_a', 'promesa', 'detecta_fecha', true, 'crea_recordatorio', true),
        true),
      (v_uid, 4, 'Pide refinanciar',
        array['refinanciar','en cuotas','no llego','plan de pago','no puedo pagar todo'],
        null,
        jsonb_build_object('etiqueta', 'Pide refinanciar'),
        true),
      (v_uid, 5, 'Consulta de saldo',
        array['cuanto debo','saldo','cuanto es','cuanto me falta'],
        null,
        jsonb_build_object('etiqueta', 'Consulta', 'sugiere_plantilla', '/saldo'),
        true),
      (v_uid, 6, 'Respondió',
        array[]::text[],
        null,
        jsonb_build_object('mueve_de', 'a_contactar', 'mueve_a', 'contactado'),
        true),
      (v_uid, 7, 'Fuera de horario',
        array[]::text[],
        null,
        jsonb_build_object('respuesta_automatica', true, 'horario_desde', '09:00', 'horario_hasta', '18:00'),
        false);
  end if;
end;
$$;
