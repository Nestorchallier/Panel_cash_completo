-- Permiso para VER las fotos y PDF de los chats desde el panel.
--
-- El worker sube cada adjunto (comprobantes, fotos, PDF, audios) al bucket
-- privado "comprobantes", en una carpeta con el id del usuario
-- (<user_id>/<archivo>). El bucket es privado a propósito (los comprobantes
-- tienen datos personales), pero nunca se le había dado permiso de lectura
-- al usuario logueado en el panel: por eso los chats mostraban "Imagen" sin
-- poder abrirla. Con esto, cada usuario puede leer SOLO su propia carpeta
-- (el panel arma un link firmado que dura 1 hora).
--
-- Se corre una sola vez en Supabase → SQL Editor → New query → pegar → Run.
-- Se puede volver a correr sin problema.

drop policy if exists "comprobantes: leer propios" on storage.objects;
create policy "comprobantes: leer propios"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'comprobantes'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Nombre de quién escribió cada mensaje en los GRUPOS (para mostrarlo en la burbuja).
alter table mensajes add column if not exists autor text;
