/**
 * Secure admin invite tokens. The customer app's `lib/auth/invite.ts`, as is.
 *
 * An invite link carries a high-entropy random token. We never store the raw
 * token: only its SHA-256 hash goes in `platform_admin_invites.invite_token_hash`.
 * To validate a link we hash the presented token and look up the matching row,
 * so a leaked DB row can't be reversed into a working link. Tokens are
 * single-use (the row is deleted on accept) and expire after `INVITE_TTL_MS`.
 *
 * Server-only (Node crypto).
 */

import { randomBytes, createHash } from "node:crypto";

/** Invite links are valid for 7 days. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A new opaque invite token for the URL (raw, never persisted). */
export function generateInviteToken(): string {
  return randomBytes(32).toString("hex");
}

/** Hash a token for storage / lookup. Same input always yields the same hash. */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex");
}

/** Expiry timestamp for a freshly issued invite, given a base time in ms. */
export function inviteExpiry(nowMs: number): string {
  return new Date(nowMs + INVITE_TTL_MS).toISOString();
}
