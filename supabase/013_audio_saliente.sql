-- Notas de voz desde el panel (🎤 en el chat de WhatsApp).
--
-- El panel graba el audio, lo sube al bucket privado "comprobantes" en la
-- carpeta del usuario (<user_id>/<archivo>.webm u .ogg) y deja en la cola un
-- mensaje saliente tipo 'audio' con su media_path; el worker lo baja, lo
-- pasa a OGG/Opus y lo manda como nota de voz.
--
-- Hasta ahora el panel solo podía LEER su carpeta (008): falta el permiso
-- para SUBIR archivos, siempre dentro de la carpeta propia. La tabla
-- mensajes no cambia: el tipo 'audio' y la columna media_path ya existen
-- (001).
--
-- Se corre una sola vez en Supabase → SQL Editor → New query → pegar → Run.
-- Se puede volver a correr sin problema.

drop policy if exists "comprobantes: subir propios" on storage.objects;
create policy "comprobantes: subir propios"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'comprobantes'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
