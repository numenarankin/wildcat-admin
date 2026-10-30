-- On-site demo bookings from the landing's /book (docs/plans/demo-booking.md).
-- Written only by admin's booking routes through this project's secret key, so
-- RLS is on with no policies, like the rest of the GTM database.

create table public.demo_bookings (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  company text not null,
  -- As the visitor typed or picked it.
  office_address text not null,
  office_lat double precision not null,
  office_lng double precision not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  notes text,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  -- Null until the Google Calendar event is created; the GTM page lists those.
  google_event_id text,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index demo_bookings_starts_at on public.demo_bookings (starts_at) where status = 'confirmed';

alter table public.demo_bookings enable row level security;

-- Inserts a booking unless one overlaps it, or unless another booking on the
-- same Central day landed after the caller checked availability (its travel
-- may now rule this one out). Returns the new id, or null when refused: the
-- caller re-checks availability and tries once more. One booking at a time,
-- under a transaction lock.
create or replace function public.book_demo(
  p_name text,
  p_email text,
  p_company text,
  p_office_address text,
  p_office_lat double precision,
  p_office_lng double precision,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_notes text,
  p_checked_at timestamptz
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  new_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('public.book_demo'));

  if exists (
    select 1 from demo_bookings b
    where b.status = 'confirmed'
      and (
        (b.starts_at < p_ends_at and b.ends_at > p_starts_at)
        or (
          b.created_at > p_checked_at
          and (b.starts_at at time zone 'America/Chicago')::date = (p_starts_at at time zone 'America/Chicago')::date
        )
      )
  ) then
    return null;
  end if;

  insert into demo_bookings (name, email, company, office_address, office_lat, office_lng, starts_at, ends_at, notes)
  values (p_name, p_email, p_company, p_office_address, p_office_lat, p_office_lng, p_starts_at, p_ends_at, nullif(p_notes, ''))
  returning id into new_id;
  return new_id;
end;
$$;

revoke all on function public.book_demo from public, anon, authenticated;
