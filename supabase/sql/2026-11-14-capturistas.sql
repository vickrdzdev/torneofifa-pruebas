-- Capturistas de marcadores: cuentas que NO son admin (ven la app como un player normal) pero sí
-- pueden capturar los marcadores y penales de la Jornada y generar su Liguilla.
-- Correr una sola vez en el SQL Editor de Supabase (primero pruebas, luego producción).
create table if not exists public.score_keepers (email text primary key);
alter table public.score_keepers enable row level security;
drop policy if exists "score keepers admin" on public.score_keepers;
create policy "score keepers admin" on public.score_keepers for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create or replace function public.can_edit_scores()
 returns boolean language sql stable security definer set search_path to '' as $$
  select public.is_admin() or exists (select 1 from public.score_keepers k where lower(k.email) = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;
revoke execute on function public.can_edit_scores() from public, anon;
grant execute on function public.can_edit_scores() to authenticated;

drop policy if exists "admin write matches" on public.matches;
drop policy if exists "score write matches" on public.matches;
create policy "score write matches" on public.matches for all to authenticated
  using ((select public.can_edit_scores())) with check ((select public.can_edit_scores()));

-- La carga de la app (season_bundle) también dice si la sesión puede capturar marcadores.
create or replace function public.season_bundle()
 returns jsonb language sql stable security invoker set search_path to '' as $$
  with s as (select * from public.seasons where is_active order by created_at desc limit 1),
       j as (select * from public.jornadas where season_id = (select id from s))
  select jsonb_build_object(
    'is_admin', public.is_admin(),
    'can_score', public.can_edit_scores(),
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
