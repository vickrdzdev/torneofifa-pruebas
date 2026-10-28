-- Confirmación de asistencia por Jornada y ubicación del host.
-- Correr una sola vez en el SQL Editor de Supabase (primero pruebas, luego producción).

alter table public.jornadas add column if not exists location_url text;

-- Fecha límite para confirmar: miércoles previo a la Jornada, 11:59:59 pm (hora del centro de México).
-- Si la Jornada cae en miércoles, es el miércoles anterior.
create or replace function public.rsvp_deadline(d date)
 returns timestamptz language sql stable set search_path to '' as $$
  select ((d - (case when extract(dow from d)::int = 3 then 7 else ((extract(dow from d)::int - 3 + 7) % 7) end))::timestamp
          + interval '23 hours 59 minutes 59 seconds') at time zone 'America/Mexico_City'
$$;

create table if not exists public.jornada_rsvps (
  jornada_id uuid not null references public.jornadas(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  going boolean not null,
  updated_at timestamptz not null default now(),
  primary key (jornada_id, player_id)
);
alter table public.jornada_rsvps enable row level security;
create policy "rsvp read" on public.jornada_rsvps for select to authenticated using (true);
create policy "rsvp insert" on public.jornada_rsvps for insert to authenticated with check ((select public.is_admin()) or public.owns_player(player_id));
create policy "rsvp update" on public.jornada_rsvps for update to authenticated using ((select public.is_admin()) or public.owns_player(player_id)) with check ((select public.is_admin()) or public.owns_player(player_id));

-- Un player solo puede responder antes de la fecha límite y antes de que se genere el calendario.
create or replace function public.jornada_rsvps_guard()
 returns trigger language plpgsql security definer set search_path to '' as $$
declare jr record;
begin
  if not public.is_admin() then
    select j.play_date, exists (select 1 from public.matches m where m.jornada_id = j.id) as started
      into jr from public.jornadas j where j.id = new.jornada_id;
    if jr.started then raise exception 'Ya se genero el calendario de esta Jornada'; end if;
    if jr.play_date is not null and now() > public.rsvp_deadline(jr.play_date) then
      raise exception 'Ya cerro la confirmacion de asistencia';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists jornada_rsvps_guard on public.jornada_rsvps;
create trigger jornada_rsvps_guard before insert or update on public.jornada_rsvps
  for each row execute function public.jornada_rsvps_guard();
revoke execute on function public.jornada_rsvps_guard() from public, anon, authenticated;

-- El host (Consola 1) o un admin guarda la ubicación.
create or replace function public.set_jornada_location(p_jornada uuid, p_url text)
 returns void language plpgsql security definer set search_path to '' as $$
declare host uuid;
begin
  select console1_id into host from public.jornadas where id = p_jornada;
  if not (public.is_admin() or (host is not null and public.owns_player(host))) then
    raise exception 'Solo el host o un admin pueden cambiar la ubicacion';
  end if;
  if p_url is not null and p_url !~ '^https://' then raise exception 'La liga debe empezar con https://'; end if;
  update public.jornadas set location_url = nullif(trim(p_url), '') where id = p_jornada;
end $$;
revoke execute on function public.set_jornada_location(uuid, text) from public, anon;
grant execute on function public.set_jornada_location(uuid, text) to authenticated;

alter publication supabase_realtime add table public.jornada_rsvps;
