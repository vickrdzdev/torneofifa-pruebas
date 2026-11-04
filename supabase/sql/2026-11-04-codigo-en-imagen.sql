-- Desde la J2, el código de la alineación se sube como imagen (code_path) en lugar de texto.
-- Correr una sola vez en el SQL Editor de Supabase (primero pruebas, luego producción).
alter table public.lineups add column if not exists code_path text;

create or replace function public.lineups_guard()
 returns trigger language plpgsql security definer set search_path to '' as $function$
declare
  jr record;
  deadline timestamptz;
  past boolean;
  admin boolean := public.is_admin();
  complete boolean;
  was_complete boolean := (tg_op = 'UPDATE' and old.submitted_at is not null);
begin
  select season_id, jornada_number, play_date into jr from public.jornadas where id = new.jornada_id;
  if jr is null then raise exception 'Jornada inexistente'; end if;
  if jr.jornada_number < 1 then raise exception 'La J0 no lleva alineación'; end if;
  new.season_id := jr.season_id;
  if tg_op = 'UPDATE' then
    new.jornada_id := old.jornada_id;
    new.player_id := old.player_id;
  end if;
  new.updated_at := now();
  deadline := public.lineup_deadline(jr.play_date);
  past := deadline is not null and now() >= deadline;

  if not admin and past and was_complete then
    raise exception 'El plazo para cambiar la alineación ya cerró';
  end if;

  -- J1: código en texto. Desde la J2: código en imagen.
  complete := (case when jr.jornada_number >= 2 then new.code_path is not null
                    else coalesce(btrim(new.code), '') <> '' end)
              and new.starters_path is not null and new.bench_path is not null;

  if admin and tg_op = 'UPDATE' and new.late is distinct from old.late then
    -- el admin puede corregir la marca de "tarde" a mano
    return new;
  end if;

  if not complete then
    new.submitted_at := null;
    new.late := false;
  elsif was_complete then
    new.submitted_at := old.submitted_at;
    new.late := old.late;
  else
    new.submitted_at := now();
    new.late := past;
  end if;
  return new;
end $function$;

-- Desde la J2 ya no se usa el código en texto: se borra, y quien no tenga imagen del código
-- queda con la alineación incompleta (tiene que subir la imagen).
alter table public.lineups disable trigger lineups_guard;
update public.lineups l set code = null,
       submitted_at = case when l.code_path is null then null else l.submitted_at end,
       late = case when l.code_path is null then false else l.late end
  from public.jornadas j
 where j.id = l.jornada_id and j.jornada_number >= 2;
alter table public.lineups enable trigger lineups_guard;
