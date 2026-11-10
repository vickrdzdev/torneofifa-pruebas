-- Compras y ventas también se publican en un grupo de WhatsApp (Green-API) desde la función notify.
-- Correr una sola vez en el SQL Editor de Supabase (primero pruebas, luego producción).
alter table public.notifications add column if not exists whatsapp boolean default false;
-- Acepta vacío: en un lote de varios avisos, a las filas sin esta columna la app les manda null.
alter table public.notifications alter column whatsapp drop not null;
alter table public.notifications add column if not exists wa_photo text;
-- Bucket privado donde la función guarda la tarjeta con la foto (Green-API la toma de una liga temporal).
insert into storage.buckets (id, name, public) values ('whatsapp', 'whatsapp', false) on conflict (id) do nothing;
-- Datos de Green-API (los captura el admin en el SQL Editor; nunca van en el repositorio):
--   greenapi_url, greenapi_instance, greenapi_token
-- Grupo donde se publica (identificador de WhatsApp "...@g.us"; distinto en pruebas y en producción):
-- insert into public.app_secrets (name, value) values ('whatsapp_group', '<id del grupo>@g.us')
-- on conflict (name) do update set value = excluded.value;
