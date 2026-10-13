/**
 * Shapes for the multi-org layer, apart from the actions so that client
 * components can import them (a `"use server"` module may only export async
 * functions).
 */

/** One organization the signed-in user may enter. */
export interface OrgOption {
  id: string;
  name: string;
  /** They own this org, rather than holding a membership in it. */
  isOwner: boolean;
}
