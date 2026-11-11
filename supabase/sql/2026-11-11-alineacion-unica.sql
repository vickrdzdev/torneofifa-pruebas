-- Alineación única por player (se actualiza al comprar o vender), en lugar de una por Jornada.
-- · season_lineups: la alineación vigente de cada player (formación, 11 titulares, 3 de banca, código).
-- · Solo su dueño la edita (ni los admins). Se cierra desde el plazo de alineación de una Jornada
--   (lineup_deadline) hasta que termina el día de esa Jornada.
-- · Al vencer el plazo, snapshot_lineups() copia la de cada quien a lineups (una fila por Jornada):
--   con eso siguen funcionando las faltas automáticas, que se revisan por Jornada.
-- Requiere 2026-11-11-formaciones.sql. Correr una sola vez (primero pruebas, luego producción).
create table if not exists public.season_lineups (
  season_id uuid not null references public.seasons(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  formation text,
  slots jsonb,
  bench jsonb,
  code_path text,
  complete boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (season_id, player_id)
);
alter table public.season_lineups enable row level security;
drop policy if exists "season lineups read" on public.season_lineups;
create policy "season lineups read" on public.season_lineups for select to authenticated using (true);
drop policy if exists "season lineups insert" on public.season_lineups;
create policy "season lineups insert" on public.season_lineups for insert to authenticated with check (public.owns_player(player_id));
drop policy if exists "season lineups update" on public.season_lineups;
create policy "season lineups update" on public.season_lineups for update to authenticated using (public.owns_player(player_id)) with check (public.owns_player(player_id));
alter publication supabase_realtime add table public.season_lineups;

alter table public.jornadas add column if not exists lineup_snapshot_at timestamptz;

-- ¿Está cerrada la alineación? (venció el plazo de una Jornada y todavía no termina su día)
create or replace function public.lineup_locked(p_season uuid)
 returns boolean language sql stable set search_path to '' as $$
  select exists (select 1 from public.jornadas j
    where j.season_id = p_season and j.play_date is not null
      and public.lineup_uses_formation(j.season_id, j.jornada_number)
      and now() >= public.lineup_deadline(j.play_date)
      and now() < ((j.play_date + 1)::timestamp at time zone 'America/Mexico_City'));
$$;

create or replace function public.season_lineups_guard()
 returns trigger language plpgsql security definer set search_path to '' as $function$
declare
  internal boolean := coalesce(current_setting('tf.lineup_internal', true), '') = '1';
  ids int[];
begin
  if tg_op = 'UPDATE' then new.season_id := old.season_id; new.player_id := old.player_id; end if;
  if not internal then
    if not public.owns_player(new.player_id) then raise exception 'Solo su dueño puede editar esta alineación'; end if;
    if public.lineup_locked(new.season_id) then raise exception 'La alineación está cerrada hasta que se juegue la Jornada'; end if;
    if new.slots is not null and (jsonb_typeof(new.slots) <> 'array' or jsonb_array_length(new.slots) <> 11) then raise exception 'Formación inválida'; end if;
    if new.bench is not null and (jsonb_typeof(new.bench) <> 'array' or jsonb_array_length(new.bench) <> 3) then raise exception 'Banca inválida'; end if;
    select array_agg((e)::text::int) into ids
      from jsonb_array_elements(coalesce(new.slots, '[]'::jsonb) || coalesce(new.bench, '[]'::jsonb)) e where jsonb_typeof(e) = 'number';
    if ids is not null then
      if cardinality(ids) <> (select count(distinct x) from unnest(ids) x) then raise exception 'Hay un jugador repetido'; end if;
      if exists (select 1 from unnest(ids) x where not exists (
           select 1 from public.team_purchases t where t.player_id = new.player_id and t.card_id = x and t.sold_at is null)) then
        raise exception 'Ese jugador no está en tu equipo';
      end if;
    end if;
  end if;
  new.complete := new.code_path is not null and new.formation is not null
    and new.slots is not null and (select count(*) from jsonb_array_elements(new.slots) e where jsonb_typeof(e) = 'number') = 11
    and new.bench is not null and (select count(*) from jsonb_array_elements(new.bench) e where jsonb_typeof(e) = 'number') = 3;
  new.updated_at := now();
  return new;
end $function$;
drop trigger if exists season_lineups_guard on public.season_lineups;
create trigger season_lineups_guard before insert or update on public.season_lineups
  for each row execute function public.season_lineups_guard();
revoke execute on function public.season_lineups_guard() from public, anon, authenticated;

-- lineups (filas por Jornada): las de formación solo las escribe snapshot_lineups.
create or replace function public.lineups_guard()
 returns trigger language plpgsql security definer set search_path to '' as $function$
declare
  jr record;
  deadline timestamptz;
  past boolean;
  admin boolean := public.is_admin();
  complete boolean;
  was_complete boolean := (tg_op = 'UPDATE' and old.submitted_at is not null);
  internal boolean := coalesce(current_setting('tf.lineup_internal', true), '') = '1';
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
  if internal then return new; end if; -- copia al vencer el plazo (snapshot_lineups)
  if public.lineup_uses_formation(jr.season_id, jr.jornada_number) then
    -- Con formación, la alineación vive en season_lineups; aquí solo se corrige la marca de "tarde".
    if admin and tg_op = 'UPDATE' and new.late is distinct from old.late
       and new.formation is not distinct from old.formation and new.slots is not distinct from old.slots
       and new.bench is not distinct from old.bench and new.code_path is not distinct from old.code_path then
      return new;
    end if;
    raise exception 'La alineación se edita en tu alineación vigente';
  end if;
  deadline := public.lineup_deadline(jr.play_date);
  past := deadline is not null and now() >= deadline;
  if not admin and past and was_complete then
    raise exception 'El plazo para cambiar la alineación ya cerró';
  end if;
  complete := (case when jr.jornada_number = 1 and jr.season_id in ('46f41d3f-0a28-4716-90bd-08948def700a', 'f96f2078-5c80-43ea-a0b4-e91750df4fe9')
                    then coalesce(btrim(new.code), '') <> ''
                    else new.code_path is not null end)
              and new.starters_path is not null and new.bench_path is not null;
  if admin and tg_op = 'UPDATE' and new.late is distinct from old.late then
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

-- Al vencer el plazo de una Jornada: copia la alineación vigente de cada player a lineups.
-- Entregada = estaba completa en ese momento (después ya no se puede editar).
create or replace function public.snapshot_lineups()
 returns int language plpgsql security definer set search_path to '' as $function$
declare j record; n int := 0;
begin
  for j in select * from public.jornadas
    where lineup_snapshot_at is null and play_date is not null
      and public.lineup_uses_formation(season_id, jornada_number)
      and now() >= public.lineup_deadline(play_date)
  loop
    perform set_config('tf.lineup_internal', '1', true);
    insert into public.lineups (season_id, jornada_id, player_id, formation, slots, bench, code_path, submitted_at, late)
      select s.season_id, j.id, s.player_id, s.formation, s.slots, s.bench, s.code_path,
             case when s.complete then s.updated_at end, false
        from public.season_lineups s where s.season_id = j.season_id
    on conflict (jornada_id, player_id) do update set formation = excluded.formation, slots = excluded.slots, bench = excluded.bench,
      code_path = excluded.code_path, submitted_at = excluded.submitted_at, late = false;
    perform set_config('tf.lineup_internal', '', true);
    update public.jornadas set lineup_snapshot_at = now() where id = j.id;
    n := n + 1;
  end loop;
  return n;
end $function$;
revoke execute on function public.snapshot_lineups() from public, anon, authenticated;
select cron.unschedule('lineup-snapshot') where exists (select 1 from cron.job where jobname = 'lineup-snapshot');
select cron.schedule('lineup-snapshot', '* * * * *', 'select public.snapshot_lineups()');

-- Si un jugador se vende (o se deshace su compra), sale de la alineación vigente de su antiguo dueño.
create or replace function public.lineups_drop_sold()
 returns trigger language plpgsql security definer set search_path to '' as $function$
declare
  card int := old.card_id;
begin
  if tg_op = 'UPDATE' and not (old.sold_at is null and new.sold_at is not null) then return new; end if;
  perform set_config('tf.lineup_internal', '1', true);
  update public.season_lineups l set
    slots = (select jsonb_agg(case when e = to_jsonb(card) then 'null'::jsonb else e end order by o) from jsonb_array_elements(l.slots) with ordinality t(e, o)),
    bench = (select jsonb_agg(case when e = to_jsonb(card) then 'null'::jsonb else e end order by o) from jsonb_array_elements(l.bench) with ordinality t(e, o))
   where l.player_id = old.player_id and l.season_id = old.season_id
     and (coalesce(l.slots, '[]'::jsonb) @> jsonb_build_array(card) or coalesce(l.bench, '[]'::jsonb) @> jsonb_build_array(card));
  perform set_config('tf.lineup_internal', '', true);
  return coalesce(new, old);
end $function$;

-- La carga de la app (season_bundle) también trae las alineaciones vigentes.
create or replace function public.season_bundle()
 returns jsonb language sql stable security invoker set search_path to '' as $$
  with s as (select * from public.seasons where is_active order by created_at desc limit 1),
       j as (select * from public.jornadas where season_id = (select id from s))
  select jsonb_build_object(
    'is_admin', public.is_admin(),
    'accounts', coalesce((select jsonb_agg(a) from public.player_accounts a), '[]'::jsonb),
    'season', (select to_jsonb(s) from s),
    'players', coalesce((select jsonb_agg(p order by p.sort_order) from public.players p where p.season_id = (select id from s)), '[]'::jsonb),
    'jornadas', coalesce((select jsonb_agg(x order by x.jornada_number) from j x), '[]'::jsonb),
    'purchases', coalesce((select jsonb_agg(t order by t.created_at) from public.team_purchases t where t.season_id = (select id from s)), '[]'::jsonb),
    'passes', coalesce((select jsonb_agg(t order by t.created_at) from public.draft_passes t where t.season_id = (select id from s)), '[]'::jsonb),
    'lineups', coalesce((select jsonb_agg(t) from public.lineups t where t.season_id = (select id from s)), '[]'::jsonb),
    'season_lineups', coalesce((select jsonb_agg(t) from public.season_lineups t where t.season_id = (select id from s)), '[]'::jsonb),
    'draft_states', coalesce((select jsonb_agg(t) from public.draft_states t where t.season_id = (select id from s)), '[]'::jsonb),
    'penalties', coalesce((select jsonb_agg(t order by t.created_at) from public.penalties t where t.season_id = (select id from s)), '[]'::jsonb),
    'push_subs', coalesce((select jsonb_agg(jsonb_build_object('email', t.email, 'created_at', t.created_at)) from public.push_subscriptions t), '[]'::jsonb),
    'attendance', coalesce((select jsonb_agg(t) from public.jornada_attendance t where t.jornada_id in (select id from j)), '[]'::jsonb),
    'matches', coalesce((select jsonb_agg(t) from public.matches t where t.jornada_id in (select id from j)), '[]'::jsonb),
    'rsvps', coalesce((select jsonb_agg(t) from public.jornada_rsvps t where t.jornada_id in (select id from j)), '[]'::jsonb)
  );
$$;
