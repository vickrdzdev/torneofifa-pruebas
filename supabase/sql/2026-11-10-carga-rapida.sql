-- Carga rápida: todo lo que la app necesita al abrir, en un solo viaje al servidor.
-- Corre con los permisos de quien la llama (security invoker), así que aplican las mismas
-- reglas de lectura que en las consultas sueltas (p. ej. push_subscriptions solo para admins).
-- Correr una sola vez en el SQL Editor de Supabase (primero pruebas, luego producción).
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
    'draft_states', coalesce((select jsonb_agg(t) from public.draft_states t where t.season_id = (select id from s)), '[]'::jsonb),
    'penalties', coalesce((select jsonb_agg(t order by t.created_at) from public.penalties t where t.season_id = (select id from s)), '[]'::jsonb),
    'push_subs', coalesce((select jsonb_agg(jsonb_build_object('email', t.email, 'created_at', t.created_at)) from public.push_subscriptions t), '[]'::jsonb),
    'attendance', coalesce((select jsonb_agg(t) from public.jornada_attendance t where t.jornada_id in (select id from j)), '[]'::jsonb),
    'matches', coalesce((select jsonb_agg(t) from public.matches t where t.jornada_id in (select id from j)), '[]'::jsonb),
    'rsvps', coalesce((select jsonb_agg(t) from public.jornada_rsvps t where t.jornada_id in (select id from j)), '[]'::jsonb)
  );
$$;
revoke execute on function public.season_bundle() from public, anon;
grant execute on function public.season_bundle() to authenticated;
