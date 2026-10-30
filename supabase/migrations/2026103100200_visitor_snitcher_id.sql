-- Snitcher's own id for a browser, on our visitor row. Snitcher's script runs
-- on the same pages as our tracker and keeps its visitor id in the browser
-- (`radar_device_id`); the tracker reads it and sends it with each batch. It is
-- the `visitor_uuid` on every Snitcher session, so a company Snitcher
-- identifies links to our visitor, and their visits, clicks and demo plays, by
-- equality rather than by guessing.
alter table public.visitors add column if not exists snitcher_visitor_id text;
create index if not exists visitors_snitcher_visitor on public.visitors (snitcher_visitor_id)
  where snitcher_visitor_id is not null;

-- The ingest function, unchanged but for filling the column.
create or replace function public.gtm_ingest(p jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  s jsonb := p -> 'session';
  g jsonb := coalesce(p -> 'geo', '{}'::jsonb);
  v_id uuid := (p ->> 'visitor_id')::uuid;
  s_id uuid := (s ->> 'id')::uuid;
  seen timestamptz := coalesce((s ->> 'last_event_at')::timestamptz, now());
  is_new boolean;
begin
  insert into visitors (id, first_seen_at, last_seen_at, visit_count, snitcher_visitor_id)
  values (v_id, coalesce((s ->> 'started_at')::timestamptz, seen), seen, 0, nullif(p ->> 'snitcher_visitor_id', ''))
  on conflict (id) do update set
    last_seen_at = greatest(visitors.last_seen_at, excluded.last_seen_at),
    -- Snitcher's script may set its id after our first batch; fill it when it arrives.
    snitcher_visitor_id = coalesce(excluded.snitcher_visitor_id, visitors.snitcher_visitor_id);

  insert into sessions (
    id, visitor_id, started_at, last_event_at, ended_at, entry_path, referrer, source,
    utm_source, utm_medium, utm_campaign, utm_term, utm_content,
    device, user_agent, viewport_w, viewport_h,
    country, state, city, latitude, longitude,
    engaged_ms, max_scroll_pct
  ) values (
    s_id, v_id, coalesce((s ->> 'started_at')::timestamptz, seen), seen, (s ->> 'ended_at')::timestamptz,
    coalesce(s ->> 'entry_path', '/'), s ->> 'referrer', s ->> 'source',
    s ->> 'utm_source', s ->> 'utm_medium', s ->> 'utm_campaign', s ->> 'utm_term', s ->> 'utm_content',
    s ->> 'device', s ->> 'user_agent', (s ->> 'viewport_w')::integer, (s ->> 'viewport_h')::integer,
    g ->> 'country', g ->> 'state', g ->> 'city', (g ->> 'latitude')::double precision, (g ->> 'longitude')::double precision,
    coalesce((s ->> 'engaged_ms')::bigint, 0), coalesce((s ->> 'max_scroll_pct')::smallint, 0)
  )
  on conflict (id) do nothing
  returning true into is_new;

  if is_new then
    update visitors set visit_count = visit_count + 1 where id = v_id;
  else
    update sessions set
      last_event_at = greatest(last_event_at, seen),
      ended_at = coalesce((s ->> 'ended_at')::timestamptz, ended_at),
      engaged_ms = greatest(engaged_ms, coalesce((s ->> 'engaged_ms')::bigint, 0)),
      max_scroll_pct = greatest(max_scroll_pct, coalesce((s ->> 'max_scroll_pct')::smallint, 0)),
      -- A later batch can carry the location the first one lacked.
      country = coalesce(country, g ->> 'country'),
      state = coalesce(state, g ->> 'state'),
      city = coalesce(city, g ->> 'city'),
      latitude = coalesce(latitude, (g ->> 'latitude')::double precision),
      longitude = coalesce(longitude, (g ->> 'longitude')::double precision)
    where id = s_id and visitor_id = v_id;
  end if;

  insert into events (id, session_id, occurred_at, type, path, scroll_pct, x_pct, y_pct, el_tag, el_id, el_class, el_text, hover_ms, data)
  select e.id, s_id, e.occurred_at, e.type, e.path, e.scroll_pct, e.x_pct, e.y_pct, e.el_tag, e.el_id, e.el_class, e.el_text, e.hover_ms, e.data
  from jsonb_to_recordset(coalesce(p -> 'events', '[]'::jsonb)) as e(
    id uuid, occurred_at timestamptz, type text, path text, scroll_pct smallint,
    x_pct numeric, y_pct numeric, el_tag text, el_id text, el_class text, el_text text, hover_ms integer, data jsonb
  )
  on conflict do nothing;

  insert into demo_views (session_id, path, demo, view_number, started_at, max_progress_pct, completed, watched_ms)
  select s_id, coalesce(d.path, '/'), d.demo, d.view_number, d.started_at, d.max_progress_pct, coalesce(d.completed, false), coalesce(d.watched_ms, 0)
  from jsonb_to_recordset(coalesce(p -> 'demo_views', '[]'::jsonb)) as d(
    path text, demo text, view_number integer, started_at timestamptz, max_progress_pct smallint, completed boolean, watched_ms bigint
  )
  on conflict (session_id, path, demo, view_number) do update set
    max_progress_pct = greatest(demo_views.max_progress_pct, excluded.max_progress_pct),
    completed = demo_views.completed or excluded.completed,
    watched_ms = greatest(demo_views.watched_ms, excluded.watched_ms);
end;
$$;

revoke all on function public.gtm_ingest(jsonb) from public, anon, authenticated;
grant execute on function public.gtm_ingest(jsonb) to service_role;
