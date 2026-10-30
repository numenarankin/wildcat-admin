# Demo booking

Status: BUILT (2026-10-30), not yet live. Verified offline: the slot rules,
Mapbox batching, busy list, confirm path and admin routes by hand-oracle vitest
(`src/lib/admin/booking/*.test.ts`, `src/app/api/gtm/booking/routes.test.ts`);
the migration and `book_demo` on a throwaway Postgres (overlap, stale check,
Central day, six concurrent bookings for one slot land one); the landing relay
by a script with admin stubbed. Not seen in a browser; no real Google or
Mapbox call has run.

Needs, before it works for real:
- migration `supabase/migrations/2026103000200_demo_bookings.sql` pushed to the
  GTM project (the user pushes);
- admin: `BOOKING_API_SECRET`, `BOOKING_CALENDAR_USER_ID` (the owner's admin
  user id, with Calendar connected under Settings), `NEXT_PUBLIC_MAPBOX_TOKEN` (already set; the secret token is
  scoped to downloads and Mapbox refuses it for geocoding and the matrix);
- landing: `BOOKING_ADMIN_URL` (admin's origin), `BOOKING_API_SECRET` (same
  value), `NEXT_PUBLIC_MAPBOX_TOKEN` (already set) allowed to use Search Box;
- one real booking, as in "Before it goes live" below.

Built as written with these choices on the open questions: the widget shows
2h and the end time two hours on; an event with no location counts as home;
no limit on the first drive; the drive home is ignored. Busy reads the
owner's primary calendar only (not other calendars on their list). The
end-to-end test through both apps' running servers was not done (no dev
servers started); the relay and admin routes were each tested against stubs.

## Goal

A visitor books an on-site demo at their office. Only times the owner can
actually reach are offered: the owner drives between demos, so a slot is open
only if the meeting before it, a buffer and the drive all fit, and the same
holds for the meeting after it. This is why we run our own booking instead of
Cal.com.

## Rules

All times are Central (`America/Chicago`, DST-aware).

| Rule | Value |
|---|---|
| Days | Monday, Wednesday from 1:30pm, Thursday, Friday |
| Slot starts | Every 30 minutes, first 9:00am, last 4:00pm (Wednesday 1:30pm to 4:00pm) |
| Meeting length | 2 hours, blocked on the calendar |
| Buffer | 30 minutes after every meeting, before driving |
| Day start | The owner leaves from 805 Secretariat Trail, Keller, TX |
| Busy | Every Google Calendar event that is not marked Free, plus every confirmed booking |
| Booking window | Tomorrow through 45 days out (as the widget does now) |

## The availability check

For a visitor at office V and a candidate slot S (start `s`, end `s + 2h`) on day D:

- `prev` = the latest busy event on D that ends at or before `s`; if none, the owner starts at home.
- `next` = the earliest busy event on D that starts at or after `s + 2h`; if none, no constraint after.
- S is open when:
  - no busy event overlaps `[s, s + 2h + 30m)`, and
  - `prev.end + 30m + drive(prev.location → V) ≤ s`, and
  - `s + 2h + 30m + drive(V → next.location) ≤ next.start`.
- An all-day event that is not Free blocks the whole day.

`drive` is Mapbox driving time (Matrix API, one call per request: V plus every
distinct event location in the window, 25 coordinates max), rounded up to the
next 5 minutes. Addresses are geocoded once with Mapbox Geocoding (US only).

Event locations:
- a booking: its stored coordinates;
- a Google event with a `location`: geocoded;
- a Google event with no location, or one that does not geocode: treated as at
  home (open question 2).

The rule is a pure function, `openSlots(day, busy, driveMinutes)`, tested
against hand-computed cases. For example, a Monday with one event 9:00 to 11:00
at home and a visitor 40 minutes away: 11:00 + 30m + 40m = 12:10, so the first
open slot is 12:30.

## Where it runs

Google tokens and the Mapbox secret live in admin, so admin does the work and
the landing only relays.

```
landing /book ──> landing /api/book/{availability,confirm}
                    │  server to server, shared secret BOOKING_API_SECRET
                    v
admin /api/gtm/booking/{availability,confirm}
   ├── GTM db: demo_bookings
   ├── Google Calendar (owner's connection, BOOKING_CALENDAR_USER_ID)
   └── Mapbox geocoding + matrix (NEXT_PUBLIC_MAPBOX_TOKEN)
```

- **availability** `{ address, lat?, lng? }` → `{ place, days: { date, slots[] }[] }`,
  or `{ error: "address" }` when the address does not geocode. Coordinates from
  a picked suggestion are used as given; a typed address is geocoded. Google free/busy
  (`events.list` on primary, `singleEvents=true`) is read once per request for
  the whole window.
- **confirm** `{ name, email, company, address, start, notes }` → re-checks
  the slot under a lock, inserts the booking, then creates the Google event.

## Database (GTM project)

Migration `admin/supabase/migrations/<ts>_demo_bookings.sql`, pushed by the user:

```sql
create table public.demo_bookings (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  company text not null,
  office_address text not null,      -- as typed
  office_place text not null,        -- Mapbox's resolved place name
  office_lat double precision not null,
  office_lng double precision not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,      -- starts_at + 2h
  notes text,
  status text not null default 'confirmed'
    check (status in ('confirmed', 'cancelled')),
  google_event_id text,              -- null until the calendar write lands
  visitor_id uuid references public.visitors(id) on delete set null,
  created_at timestamptz not null default now()
);
create index on public.demo_bookings (starts_at) where status = 'confirmed';
alter table public.demo_bookings enable row level security;  -- no policies: secret key only
```

Double booking: `confirm` runs as one RPC (`book_demo`) that takes
`pg_advisory_xact_lock` on a fixed key, re-reads the confirmed bookings for the
day, and inserts. The travel re-check runs in admin before the RPC, and the RPC
refuses an overlap, so two visitors racing for nearby slots cannot both land.

## Google Calendar

On confirm, admin inserts an event on the owner's primary calendar through the
existing `insertEvent` (`src/lib/admin/google/calendar/client.ts`):

- summary `WildcatIQ demo: <company>`, location = the office address, 2 hours;
- description: name, email, company, notes;
- the visitor is an attendee with `sendUpdates=all`, so Google sends the
  confirmation email the success screen promises.

If the calendar write fails, the booking stays `confirmed` with
`google_event_id` null, and the GTM page lists it as needing attention. It
still blocks availability, because bookings are read from the table as well as
the calendar.

## Landing changes

- The office address field suggests addresses as the visitor types, through
  Mapbox's Search Box API (`/suggest`, then `/retrieve` on pick) with the
  landing's public `NEXT_PUBLIC_MAPBOX_TOKEN`, limited to the US and biased
  toward Texas, one session token per visit. Picking a suggestion fills the
  full address and keeps its coordinates for availability. A visitor who types
  an address without picking is still accepted and geocoded by admin.
- Step 1 Continue calls availability. An address that does not geocode shows a
  field error. The calendar and times come from the response.
- Confirm calls confirm. A slot taken in the meantime returns to the calendar
  with a short note and fresh availability.
- Same gates as `/api/track`: rate limit per IP, honeypot field, the Origin
  check in production.

## Admin changes

- GTM page: a Bookings list (upcoming first) with each booking's calendar state.
- Env: `BOOKING_API_SECRET` (both apps), `BOOKING_CALENDAR_USER_ID` (admin);
  `MAPBOX_SECRET_TOKEN` and the GTM keys already exist.

## Order

1. Migration and `book_demo` RPC.
2. `openSlots` with oracle tests.
3. Mapbox geocode and matrix helpers.
4. Admin availability and confirm routes, then the Google event.
5. Landing relay routes and widget wiring.
6. GTM Bookings list.

## Testing

Every expected value is worked out by hand from the rules above, never by
running the code. Tests are scoped vitest runs next to the code they cover.

**`openSlots` (pure, injected drive times).** One case per rule:
- weekday rules: Tuesday, Saturday and Sunday return nothing; Wednesday starts
  at 1:30pm; Monday, Thursday and Friday run 9:00am to 4:00pm, 15 slots;
- empty day, visitor 40 minutes from home: all 15 slots (the first drive is
  unconstrained, open question 3);
- prev event 9:00 to 11:00 at home, visitor 40 minutes away: first slot 12:30
  (11:00 + 30m + 40m = 12:10, rounded up to the next slot);
- next event at 3:00pm 25 minutes from the visitor: last slot 12:00
  (12:00 + 2h + 30m + 25m = 2:55 ≤ 3:00; 12:30 gives 3:25);
- event between two candidates: both sides checked in the same day;
- an overlapping event blocks every slot it touches, including the 30-minute
  buffer after it;
- an all-day busy event blocks the day; an event marked Free blocks nothing;
- DST: the Sunday 2026-11-01 change does not shift Monday's 9:00am slot.

**Drive times.** Rounding up to 5 minutes; matrix requests stay at 25
coordinates or fewer; an event location that does not geocode is treated as
home. Mapbox is answered by a local stub, so tests make no real calls.

**Database.** The migration is applied to a throwaway local database (never
the remote one). `book_demo` refuses an overlapping booking, and two concurrent
calls for overlapping slots result in one booking. RLS is on and the anon key
reads nothing.

**Address suggestions.** With Mapbox stubbed: typing past three characters
asks for suggestions (debounced), arrow keys and Enter pick one, picking
calls retrieve once and stores its coordinates, and editing the field after a
pick drops them. Availability uses the stored coordinates without geocoding.

**Routes.** Admin routes refuse a missing or wrong `BOOKING_API_SECRET`.
Availability returns `{ error: "address" }` for an address that does not
geocode. Confirm refuses a slot that is no longer open, and creates the
Google event with the visitor as an attendee (Google stubbed). If the calendar
write fails, the booking is kept with `google_event_id` null. Landing relays
enforce the rate limit, honeypot and Origin check.

**End to end.** The landing widget against the admin routes, the local
database and stubbed Google and Mapbox: one booking from address to success
screen, with the booking row and the calendar event payload checked against
hand-written expectations.

**Before it goes live (needs the user).** One real booking against the real
calendar: the event lands with the right time, location and attendee, Google's
invite email arrives, and a second visitor no longer sees that slot or the
slots its drive rules out.

## Open questions

1. The widget says "30m" and the success copy says the meeting lasts 30
   minutes. The calendar blocks 2 hours. What should the visitor see?
2. A Google event with no location: assume home, or assume no travel needed?
3. Is there a farthest drive you will take? As written, a visitor four hours
   away still gets a 9:00am slot, because nothing limits the first drive of the
   day. Option: the first drive must leave home no earlier than a set time.
4. Should the drive home after the last meeting matter?
