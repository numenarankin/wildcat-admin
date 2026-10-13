/**
 * Server-side feature flags derived from environment variables.
 *
 * `MOCK_MODE` and its `isMockMode()` reader are GONE. Every data surface reads
 * the database now; the last consumer was the invoices list, which served five
 * fabricated rows. A sample row and a broken query look identical on screen, so
 * the flag mostly bought a way to not notice. `MOCK_MODE` can be deleted from
 * `.env`.
 */

/**
 * Master billing switch. When false (the default), the AI-credit gate, usage
 * metering, and the subscription well cap are ALL bypassed — users can do
 * anything without paying. Set `PAID_MODE=true` to turn on paid enforcement.
 */
export function isPaidMode(): boolean {
  return process.env.PAID_MODE === "true";
}

/**
 * The Supabase project URL. Derived from `SUPABASE_PROJECT_ID`
 * (`https://<id>.supabase.co`), or taken verbatim from `SUPABASE_URL` if set
 * (e.g. a custom domain). Returns null when unconfigured.
 */
export function getSupabaseUrl(): string | null {
  if (process.env.SUPABASE_URL) return process.env.SUPABASE_URL;
  const projectId = process.env.SUPABASE_PROJECT_ID;
  return projectId ? `https://${projectId}.supabase.co` : null;
}

/**
 * Whether a Supabase backend is configured. When false, data surfaces return
 * empty rather than inventing rows, so an unconfigured environment reads as
 * "nothing here" instead of as real data.
 */
export function hasSupabase(): boolean {
  return Boolean(getSupabaseUrl() && process.env.SUPABASE_SECRET_KEY);
}

/**
 * Whether ElevenLabs text-to-speech is configured. When false, the read-aloud
 * controls stay hidden and `/api/voice` returns 503.
 */
export function hasElevenLabs(): boolean {
  return Boolean(process.env.ELEVEN_LABS_KEY);
}

/**
 * Whether OpenAI is configured, for the experimental Realtime voice loop only.
 *
 * Orion's thinking is Anthropic everywhere else, per the project convention.
 * Realtime is the one exception, and only because it is a different shape of
 * product: a single speech-to-speech model instead of the transcribe → model →
 * speak cascade `use-voice-conversation.ts` runs. It is off unless this key is
 * set AND `NEXT_PUBLIC_REALTIME_VOICE=true`, so the Anthropic loop stays the
 * default path.
 *
 * Note the variable name: `OPEN_AI_KEY`, not `OPENAI_API_KEY`.
 */
export function hasOpenAI(): boolean {
  return Boolean(process.env.OPEN_AI_KEY);
}

/**
 * Whether Stripe billing is configured. When false, checkout/portal/top-up and
 * the webhook are disabled, and the AI-credit gate fails open (so the app keeps
 * working in dev before billing is wired). See src/lib/billing.
 */
export function hasStripe(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/**
 * The tiered Stripe Price ID subscriptions bill on (well count is the quantity),
 * one per billing interval. Replaces the old per-tier `STRIPE_PRICE_TIER_n`
 * vars. Null when unset — subscription creation throws a clear error in that
 * case.
 *
 * The two prices are the SAME product at two intervals
 * (`docs/plans/annual-pricing.md`); the annual one carries the two-months-free
 * pricing in its own tier amounts (ten monthly payments), so nothing in the app
 * applies a discount at runtime.
 */
export function getWellsPriceId(
  interval: "month" | "year" = "month"
): string | null {
  const id =
    interval === "year"
      ? process.env.STRIPE_PRICE_WELLS_YEARLY
      : process.env.STRIPE_PRICE_WELLS;
  return id ?? null;
}

/**
 * The Stripe Price for AI credits — one unit is one credit at $0.01
 * (`DOLLARS_PER_CREDIT`), so a top-up bills `quantity = credits`.
 *
 * Optional. Unset, `chargeTopUp` charges a bare PaymentIntent for the same
 * money, which is what it did before this price existed; set, the charge goes
 * through an invoice so the sale lands on the product's revenue line and carries
 * the product's tax code. Either way the customer pays the same amount and gets
 * the same credits.
 */
export function getAiCreditsPriceId(): string | null {
  return process.env.STRIPE_PRICE_AI_CREDITS ?? null;
}

/**
 * The Stripe Product the AI-credits price belongs to. Read only for tax: a
 * calculation that names the product is taxed by the product's tax code, which
 * is what the invoice will use, so the quote and the charge agree.
 */
export function getAiCreditsProductId(): string | null {
  return process.env.STRIPE_PRODUCT_AI_CREDITS ?? null;
}

/**
 * The Stripe publishable key, exposed to the browser so Stripe Elements can load
 * (`NEXT_PUBLIC_` prefix is required for client access). Returns null when unset.
 */
export function getStripePublishableKey(): string | null {
  return process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? null;
}

/** Whether the browser-side Stripe SDK (Elements) can be initialized. */
export function hasStripeClient(): boolean {
  return Boolean(getStripePublishableKey());
}

/** The public base URL used for Stripe redirect (success/cancel/return) URLs. */
export function getAppUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.APP_URL ??
    "http://localhost:3000"
  );
}

/**
 * Google OAuth client for the admin side's Gmail / Calendar / Tasks
 * connections. Server only: the secret signs the token exchange.
 */
export function getGoogleApp(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Whether Google connections can be made: the OAuth client and the token key. */
export function hasGoogle(): boolean {
  return Boolean(getGoogleApp() && process.env.CLOUD_TOKEN_KEY);
}

/**
 * Slack app for the admin side's /admin/slack connections (OAuth v2, user
 * token). Server only: the secret signs the token exchange.
 */
export function getSlackApp(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Whether Slack connections can be made: the app's credentials and the token key. */
export function hasSlack(): boolean {
  return Boolean(getSlackApp() && process.env.CLOUD_TOKEN_KEY);
}
