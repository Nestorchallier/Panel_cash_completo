-- Fase 5: la pantalla de Conexión (5.4) necesita poder pedirle algo al
-- worker ("Reiniciar sesión", "Desvincular") sin tener acceso directo al
-- proceso — el worker corre en otra máquina. Se hace con un campo de
-- "comando pendiente" que el worker revisa en su latido (cada ~10s) y
-- limpia apenas lo ejecuta.
alter table wa_sesion add column if not exists comando text check (comando in ('reiniciar', 'desvincular'));
