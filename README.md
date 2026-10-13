# WildcatIQ Admin

The Wildcat insiders' console, split out of the customer app (`wildcat`) where it
lived at `/admin/*`. Same pages, same Orion, same database: it uses the customer
app's Supabase project, so every read and write lands in the same tables.

- Pages that were `/admin/<x>` are now `/<x>` (e.g. `/admin/sales` is `/sales`).
- API routes keep their paths (`/api/admin/*`), so the Google and Slack OAuth
  callbacks are `<this app's origin>/api/admin/{google,slack}/callback`.
- Only accounts on `platform_admins` get in. Anyone else signed in sees a 404.

## Env

`.env` is the customer app's, plus:

| Var | Meaning |
|---|---|
| `NEXT_PUBLIC_APP_URL` | This app's origin. OAuth redirect URIs and the connect popup use it. |
| `NEXT_PUBLIC_WILDCAT_APP_URL` | The customer app. Used by "Back to app", notification links, and customer password resets. |

## Commands

```bash
npm run dev
npm test        # vitest
npm run lint
npx tsc --noEmit
```
