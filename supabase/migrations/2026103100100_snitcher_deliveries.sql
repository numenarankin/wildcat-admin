-- Every request that reaches the Snitcher webhook, kept raw before anything
-- is read from it, so a delivery whose shape or signature we do not yet
-- handle is still here to look at. `signature_valid` says whether it carried
-- our secret's signature; only those are ever turned into companies and
-- sessions. Same access as the rest of the GTM tables: none but the secret key.
create table if not exists public.snitcher_deliveries (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  signature_valid boolean not null,
  event text,
  -- The body as JSON when it parses, else as text.
  payload jsonb,
  body_text text,
  -- What we made of it: stored (a session written), no_session, bad_json, bad_signature, store_failed.
  outcome text
);

create index if not exists snitcher_deliveries_received on public.snitcher_deliveries (received_at desc);

alter table public.snitcher_deliveries enable row level security;
revoke all on public.snitcher_deliveries from anon, authenticated;
