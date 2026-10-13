import "server-only";
import Stripe from "stripe";

/**
 * Lazily-constructed, server-only Stripe client.
 *
 * Uses the secret key — must never be imported into a client bundle (the
 * `server-only` guard enforces this at build time). Throws if billing isn't
 * configured; call `hasStripe()` (src/lib/env) before reaching for this.
 */
let cached: Stripe | null = null;

export function getStripe(): Stripe {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    throw new Error("Stripe is not configured: set STRIPE_SECRET_KEY in .env");
  }
  // Pin the API version to the SDK's bundled default by omitting it; Stripe then
  // uses the version set on the account, which keeps webhook/event shapes stable.
  cached ??= new Stripe(secret);
  return cached;
}

/** The signing secret for verifying incoming webhook events. */
export function getWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error(
      "Stripe webhooks not configured: set STRIPE_WEBHOOK_SECRET in .env"
    );
  }
  return secret;
}
