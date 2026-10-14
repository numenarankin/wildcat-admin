# Prospecting Outreach: Enrich, Sequence, Send

Status: BUILT (2026-10-08), not yet run against the cloud. Typecheck, lint
and the unit suites are clean; the actions and readers ran end to end on the
local Supabase stack (queue → research → contacts → enroll → steps →
schedule → cancel, and an outsider refused). Needs, before it works for
real: migration `2026100800400_admin_outreach.sql` (and the renamed
`2026100800300_admin_targets.sql`) pushed from wildcat; `CRON_SECRET` on the
deployment (the cron is in `vercel.json`, every five minutes). `EXA_API_KEY`
and `HUNTER_API_KEY` are set in the local `.env` (2026-10-09); they still
need adding to the deployment's environment. Nothing has been seen in
a browser yet.

Where it lives: `src/lib/admin/outreach/` (types + pure rules, readers,
actions, draft, scheduled sending), `src/lib/admin/exa.ts`,
`src/lib/admin/hunter.ts`, `src/lib/ai/admin/enrich-tools.ts` +
`enrich-prompt.ts`, route `src/app/api/admin/enrich/chat`, cron
`src/app/api/cron/send-scheduled-emails`, UI under
`src/components/admin/prospecting/` (enrich-workspace, enrich-chat,
research-card, sequence-workspace, prospecting-settings-sheet).

Builds on the shipped Prospecting page (`/prospecting`: Recon, Targets, Map)
and the Email page's Gmail connection.

## Goal

Turn a target (an RRC operator on the Targets list) into a contacted prospect:
find the company's website and the people who matter, source their contact
details, enroll them in a cadence of emails and calls, and keep the user on
top of what is due today. Orion does the research and drafting; the user does
the verifying, calling and sending.

## What we already have

- **Targets** (`admin_targets`): the operator's identity, plus live figures
  from the RRC mirror (wells, production, revenue, counties, P-5 profile).
- **P-5 phone and mailing address** on every operator record. This is the
  office line; it is the starting point, not something to go find.
- **P-5 officers**: names, titles and cities from the filing.
- **Email page**: the user's Gmail is connected; the app can read threads,
  create drafts and send through the user's account.
- **Orion** on the admin side with its own tool catalog (`lib/ai/admin/tools.ts`).

## 1. Enrich page

One tab (or page) under Prospecting: an Orion chat with a **queue of companies
on the left in a file-tree style list**. Companies reach the queue through an
**Add to queue** button on a Targets row (and on the filtered list); nothing is
queued automatically. Picking a company starts or resumes its research
thread. Each company carries a status (queued, researching, reviewed,
enrolled).

**Enrichment happens only inside the chat.** There is no one-click enrich:
the user works each company with Orion so every step is seen and confirmed
before the next.

Orion works the company in steps, and each step's output is something the user
can check:

1. **Website.** Orion searches with **Exa** (the company name without its
   corporate suffix, city, state, oil and gas vocabulary) and proposes the
   site as a **clickable link**. Beside the link it reports what matched:
   P-5 phone on the site, mailing address, city, officer names. A phone or
   address match is the strong signal; a name-only match is flagged as a
   guess. The user confirms or rejects the site.
2. **Decision-makers.** From the site (about, team, leadership pages) and the
   P-5 officers, Orion lists the people for whom Wildcat is relevant: owner or
   president, operations or production manager, office or accounting lead.
   Each with name, title, where it came from.
3. **Contact details.** The P-5 phone is shown as is. For email, **Hunter**
   (one API key, `HUNTER_API_KEY`), in this order per verified domain:
   1. **Domain Search** (`/v2/domain-search`): every address Hunter has seen
      for the domain, with the domain's pattern (`{first}.{last}` and so on)
      and each address's name, position and confidence. Often this alone
      yields the people.
   2. **Email Finder** (`/v2/email-finder`, domain + first and last name) for
      each decision-maker not found above. Returns the most likely address
      with a score.
   3. **Email Verifier** (`/v2/email-verifier`) on every address we intend to
      use, whether found or guessed from the pattern. Keep `deliverable`;
      show `risky` (accept-all domains) as such; drop `undeliverable`.
   Any `mailto:` or `tel:` links found on the site are kept with their source
   page. Every contact row keeps its source (P-5, site page, Hunter found,
   pattern guess) and Hunter's score where it applies.
4. **Add to sequence.** Once the user is happy with the people and their
   details, one click enrolls the company (and chosen contacts) in a sequence.

Orion's tools here are read and propose only: search, fetch a page, verify an
email, write research notes and proposed contacts to the company's record.
Enrolling, sending and scheduling are the user's clicks.

## 2. Sequence page

A table of enrolled companies with the cadence state, sorted by what is due.
The page answers "what do I do today": the calls and emails due now, overdue
ones first.

**Default sequence** (editable later): a three-week cadence, repeated 3 times:

| Step | Day | Action |
|---|---|---|
| 1 | Tuesday | Email |
| 2 | Thursday | Call, then a follow-up email |

Per row: company, contact, step number, next action and its date, last
action and outcome, and buttons for the action: **Draft** for an email step,
**Done** / **No answer** for a call step. Calls are placed by the user on their
own phone; the row records the outcome and advances. A reply or a booked
meeting takes the company out of the sequence.

## 3. Email drafting and sending

- **Draft** opens the Email page's draft card. Orion writes the email from the
  page's **template** plus the company's context: P-5 info, website content,
  the contact's name and title, research notes.
- **Orion never sends.** The send button is the user's. The draft tool creates
  a Gmail draft at most; there is no send tool in Orion's catalog, and the
  route test pins that (same pattern as the admin chat route's tool test).
- **Send now** sends through the user's Gmail as the Email page does today.
- **Schedule** sets a send time, either a one-off time or one of the named
  schedules from settings. Gmail's API has no scheduled send (that is a web
  UI feature), so scheduled sends are rows in `admin_scheduled_emails` and a
  **Vercel cron** sends the due ones through the user's stored Google token.
  A sent row records the Gmail message id; a failed send stays due and shows
  on the sequence row.

## 4. Settings (on the Prospecting page)

- **Email template**: the body Orion drafts from, with placeholders the draft
  fills (company, contact first name, wells, county, the user's signature).
- **Send schedules**: named schedules (for example "Tuesday 8am") that the
  Schedule button offers. Stored in the user's time zone.
- Later: the default sequence cadence.

## 5. Data model (proposed)

All admin-side, policy `is_platform_admin()`, migrations in
`~/dev/wildcat/supabase/migrations`.

- `admin_target_research`: one per target. Website URL, match evidence
  (phone, address, city, names: booleans plus the text matched), status,
  Orion's notes, the chat's conversation id.
- `admin_target_contacts`: person rows. Name, title, email, phone, source
  (P-5, website page URL, guessed and verified), confidence, reviewed flag.
- `admin_sequences`: the cadence definition (steps, days, actions, repeats).
- `admin_sequence_enrollments`: target, contact, sequence, current step,
  next due date, state (active, replied, meeting, stopped).
- `admin_sequence_events`: each call or email with its outcome and time.
- `admin_scheduled_emails`: draft content, recipient, send at, schedule name,
  status, Gmail message id once sent.
- `admin_prospecting_settings`: the template and the named schedules.

## 6. Guardrails

- Orion has no send capability anywhere in this flow. Drafting is the ceiling.
- Every Orion write on this page (add target, queue, enrich, enroll) is an
  approval card the user clicks; the Enrich chat's own tools still cannot
  enroll.
- Every contact detail carries its source; nothing is shown as fact without
  one. Guessed emails are labelled guessed until verified.
- Scraping is polite: `robots.txt` respected, one request at a time per site,
  a real User-Agent, a page cap per site (about 10).
- The cron sends only rows the user scheduled, through the user's own Google
  account, so replies land in their inbox.

## Decisions made

- Search: **Exa** (not a separate search UI; Claude's own web search tool is an
  option alongside it).
- No dialer. The user calls from their cell and marks the outcome.
- Scheduled sending is our cron, since Gmail's API cannot schedule.
- Email finding and verification: **Hunter** (Domain Search, Email Finder,
  Email Verifier). Not optimizing for price; the universe is small.
- Generic addresses (info@, office@) are kept and shown as generic, and are
  never picked as a sequence contact by default.
- New targets are not queued automatically. The queue is fed from Targets
  rows, by the user's button or by the admin Orion's `queue_for_enrichment`
  tool after the user approves its card.
- Enrichment runs through the Enrich chat, or headless from the admin Orion's
  `enrich_target` tool (`lib/ai/admin/enrich-run.ts`: same persona, card and
  catalog, one `generateText` pass, one target per approved call).
- The admin Orion (`lib/ai/admin/prospecting-tools.ts`, 2026-10-14) reads
  every tab (targets with projected subscription figures, queue, cards,
  enrollments, scheduled emails, settings; RRC operator search and profile)
  and has four actions behind approval cards: `add_targets`,
  `queue_for_enrichment`, `enrich_target`, `add_to_sequence`. It still cannot
  draft, record a step, schedule or send; `prospecting-tools.test.ts` pins
  the catalog.

## Keys and infrastructure (needed to run, not to build)

- `EXA_API_KEY`, `HUNTER_API_KEY`: in the local `.env`; add to the deployment.
  The Exa client follows Exa's `build-with-exa` skill (installed under
  `.agents/skills/build-with-exa`): search = query + the agent's `objective`
  + `type: auto` + `contents: { highlights: true }`; contents = top-level
  `text` with a character budget, `statuses` checked.
- Cron: a `vercel.json` schedule and a `CRON_SECRET` on the deployment for
  the scheduled-send route.

## Open decisions


## Related

- Prospecting page: `src/components/admin/prospecting/`, `src/lib/admin/targets.ts`.
- Email page and Gmail: `src/lib/admin/google/`, `src/components/admin/email/`.
- Admin Orion tools: `src/lib/ai/admin/tools.ts` (and its safety test).
