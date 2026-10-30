-- Post-FIFA: si cada player se queda después de la Jornada.
-- Correr una sola vez en el SQL Editor de Supabase (primero pruebas, luego producción).
alter table public.jornada_rsvps alter column going drop not null;
alter table public.jornada_rsvps add column if not exists post boolean;

-- El post-FIFA se puede contestar hasta el mismo día de la Jornada (11:59:59 pm, hora del centro
-- de México), aunque ya cerró la asistencia o ya se generó el calendario.
create or replace function public.jornada_rsvps_guard()
 returns trigger language plpgsql security definer set search_path to '' as $$
declare jr record; going_changed boolean; post_changed boolean;
begin
  if not public.is_admin() then
    select j.play_date, exists (select 1 from public.matches m where m.jornada_id = j.id) as started
      into jr from public.jornadas j where j.id = new.jornada_id;
    if tg_op = 'INSERT' then
      going_changed := new.going is not null; post_changed := new.post is not null;
    else
      going_changed := new.going is distinct from old.going; post_changed := new.post is distinct from old.post;
    end if;
    if going_changed then
      if jr.started then raise exception 'Ya se genero el calendario de esta Jornada'; end if;
      if jr.play_date is not null and now() > public.rsvp_deadline(jr.play_date) then
        raise exception 'Ya cerro la confirmacion de asistencia';
      end if;
    end if;
    if post_changed and jr.play_date is not null
       and now() > (jr.play_date::timestamp + interval '23 hours 59 minutes 59 seconds') at time zone 'America/Mexico_City' then
      raise exception 'Ya cerro la confirmacion del post-FIFA';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke execute on function public.jornada_rsvps_guard() from public, anon, authenticated;
