-- Post-FIFA: si cada player se queda después de la Jornada.
-- Correr una sola vez en el SQL Editor de Supabase (primero pruebas, luego producción).
alter table public.jornada_rsvps alter column going drop not null;
alter table public.jornada_rsvps add column if not exists post boolean;
