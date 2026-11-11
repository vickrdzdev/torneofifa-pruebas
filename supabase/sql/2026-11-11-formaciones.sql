-- Alineación con formación: cada player acomoda sus 11 titulares y 3 de banca (de su propio
-- equipo) en una formación, y sube la imagen del código. Reemplaza a las capturas de titulares y
-- banca. Todos la ven; solo su dueño la puede editar (ni los admins). Se bloquea al vencer el
-- plazo de la alineación (lineup_deadline). En el Torneo FC27 aplica desde la J3; en torneos
-- nuevos, desde la J1. Además, cada player sube la foto de su DT.
-- Correr una sola vez en el SQL Editor de Supabase (primero pruebas, luego producción).
alter table public.lineups add column if not exists formation text;
alter table public.lineups add column if not exists slots jsonb;  -- 11 card_id (o null) en el orden de la formación
alter table public.lineups add column if not exists bench jsonb;  -- 3 card_id (o null)
alter table public.players add column if not exists coach_path text;

-- ¿La Jornada usa alineación con formación?
create or replace function public.lineup_uses_formation(p_season uuid, p_number int)
 returns boolean language sql immutable set search_path to '' as $$
  select p_number >= 1 and not (p_number <= 2 and p_season in ('46f41d3f-0a28-4716-90bd-08948def700a', 'f96f2078-5c80-43ea-a0b4-e91750df4fe9'));
$$;

create or replace function public.lineups_guard()
 returns trigger language plpgsql security definer set search_path to '' as $function$
declare
  jr record;
  deadline timestamptz;
  past boolean;
  admin boolean := public.is_admin();
  complete boolean;
  was_complete boolean := (tg_op = 'UPDATE' and old.submitted_at is not null);
  fmode boolean;
  internal boolean := coalesce(current_setting('tf.lineup_internal', true), '') = '1';
  changed boolean;
  ids int[];
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
  fmode := public.lineup_uses_formation(jr.season_id, jr.jornada_number);

  if fmode then
    changed := tg_op = 'INSERT' or new.formation is distinct from old.formation or new.slots is distinct from old.slots
      or new.bench is distinct from old.bench or new.code_path is distinct from old.code_path;
    if changed and not internal then
      if not public.owns_player(new.player_id) then raise exception 'Solo su dueño puede editar esta alineación'; end if;
      if past and was_complete then raise exception 'El plazo para cambiar la alineación ya cerró'; end if;
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
    complete := new.code_path is not null and new.formation is not null
      and new.slots is not null and (select count(*) from jsonb_array_elements(new.slots) e where jsonb_typeof(e) = 'number') = 11
      and new.bench is not null and (select count(*) from jsonb_array_elements(new.bench) e where jsonb_typeof(e) = 'number') = 3;
  else
    if not admin and past and was_complete then
      raise exception 'El plazo para cambiar la alineación ya cerró';
    end if;
    -- Código en imagen, salvo la J1 del Torneo FC27 (código en texto).
    complete := (case when jr.jornada_number = 1 and jr.season_id in ('46f41d3f-0a28-4716-90bd-08948def700a', 'f96f2078-5c80-43ea-a0b4-e91750df4fe9')
                      then coalesce(btrim(new.code), '') <> ''
                      else new.code_path is not null end)
                and new.starters_path is not null and new.bench_path is not null;
  end if;

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

-- Si un jugador se vende (o se deshace su compra), sale de las alineaciones abiertas de su
-- antiguo dueño: su lugar queda vacío y la alineación vuelve a quedar incompleta.
create or replace function public.lineups_drop_sold()
 returns trigger language plpgsql security definer set search_path to '' as $function$
declare
  card int := old.card_id;
  pid uuid := old.player_id;
begin
  if tg_op = 'UPDATE' and not (old.sold_at is null and new.sold_at is not null) then return new; end if;
  perform set_config('tf.lineup_internal', '1', true);
  update public.lineups l set
    slots = (select jsonb_agg(case when e = to_jsonb(card) then 'null'::jsonb else e end order by o) from jsonb_array_elements(l.slots) with ordinality t(e, o)),
    bench = (select jsonb_agg(case when e = to_jsonb(card) then 'null'::jsonb else e end order by o) from jsonb_array_elements(l.bench) with ordinality t(e, o))
   where l.player_id = pid
     and (coalesce(l.slots, '[]'::jsonb) @> jsonb_build_array(card) or coalesce(l.bench, '[]'::jsonb) @> jsonb_build_array(card))
     and exists (select 1 from public.jornadas j where j.id = l.jornada_id
                 and (public.lineup_deadline(j.play_date) is null or now() < public.lineup_deadline(j.play_date)));
  perform set_config('tf.lineup_internal', '', true);
  return coalesce(new, old);
end $function$;
drop trigger if exists lineups_drop_sold on public.team_purchases;
create trigger lineups_drop_sold after update or delete on public.team_purchases
  for each row execute function public.lineups_drop_sold();
revoke execute on function public.lineups_drop_sold() from public, anon, authenticated;

-- Foto del DT: bucket privado "coaches"; cada player sube la suya (carpeta temporada/player).
insert into storage.buckets (id, name, public) values ('coaches', 'coaches', false) on conflict (id) do nothing;
drop policy if exists "coaches read" on storage.objects;
create policy "coaches read" on storage.objects for select to authenticated using (bucket_id = 'coaches');
drop policy if exists "coaches insert" on storage.objects;
create policy "coaches insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'coaches' and public.owns_player(((storage.foldername(name))[2])::uuid));
create or replace function public.set_coach_photo(p_player uuid, p_path text)
 returns void language plpgsql security definer set search_path to '' as $$
begin
  if not public.owns_player(p_player) then raise exception 'Solo su dueño puede cambiar la foto del DT'; end if;
  if p_path is not null and split_part(p_path, '/', 2) <> p_player::text then raise exception 'Ruta inválida'; end if;
  update public.players set coach_path = p_path where id = p_player;
end $$;
revoke execute on function public.set_coach_photo(uuid, text) from public, anon;
grant execute on function public.set_coach_photo(uuid, text) to authenticated;
