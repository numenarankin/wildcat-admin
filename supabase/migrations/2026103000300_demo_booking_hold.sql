-- A demo is 30 minutes on paper but holds the owner for longer, so it can run
-- long (docs/plans/demo-booking.md). `ends_at` is the end the visitor is told;
-- `hold_ends_at` is when the owner is free again, and it is what overlap and
-- travel are checked against.

alter table public.demo_bookings add column hold_ends_at timestamptz;
-- Bookings made before this were stored with the hold as their end.
update public.demo_bookings set hold_ends_at = ends_at where hold_ends_at is null;
alter table public.demo_bookings alter column hold_ends_at set not null;
alter table public.demo_bookings add constraint demo_bookings_hold_covers_meeting check (hold_ends_at >= ends_at);

drop function if exists public.book_demo(text, text, text, text, double precision, double precision, timestamptz, timestamptz, text, timestamptz);

-- As before, with the hold: refused when another booking's hold overlaps this
-- one's, or when a booking on the same Central day landed after the caller
-- checked availability. Returns the new id, or null when refused.
create or replace function public.book_demo(
  p_name text,
  p_email text,
  p_company text,
  p_office_address text,
  p_office_lat double precision,
  p_office_lng double precision,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_hold_ends_at timestamptz,
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
        (b.starts_at < p_hold_ends_at and b.hold_ends_at > p_starts_at)
        or (
          b.created_at > p_checked_at
          and (b.starts_at at time zone 'America/Chicago')::date = (p_starts_at at time zone 'America/Chicago')::date
        )
      )
  ) then
    return null;
  end if;

  insert into demo_bookings (name, email, company, office_address, office_lat, office_lng, starts_at, ends_at, hold_ends_at, notes)
  values (p_name, p_email, p_company, p_office_address, p_office_lat, p_office_lng, p_starts_at, p_ends_at, p_hold_ends_at, nullif(p_notes, ''))
  returning id into new_id;
  return new_id;
end;
$$;

revoke all on function public.book_demo from public, anon, authenticated;
