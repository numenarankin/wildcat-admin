"use client";

import { useState, type Dispatch, type SetStateAction } from "react";

/**
 * Local state seeded from a server prop that RE-SEEDS when the server sends a
 * new one.
 *
 * ## The bug this exists to kill
 *
 * A workspace holds its rows in client state so an edit can show up instantly:
 *
 * ```ts
 * const [rows, setRows] = useState(initialRows); // <- seeds ONCE, ever
 * ```
 *
 * `useState` ignores its argument on every render after the first. So when a
 * mutation finishes and calls `router.refresh()`, the server component really
 * does re-render and really does hand down fresh rows, and the client throws
 * them away. Nothing on screen moves. A full page reload remounts the component,
 * which re-seeds the state, which is why reloading looks like the fix and why
 * the reports always say "I had to refresh the page to see it."
 *
 * The compensation was manual: every mutation had to mirror its own write into
 * local state by hand, and the day someone adds a mutation and forgets that
 * line, the bug is back on that one action.
 *
 * This hook does what a handful of components already did inline (the org
 * member list, the notification table, the P-5 list): compare the prop against
 * the last one we seeded from and, when it differs, adopt it. That is React's
 * documented way to adjust state when a prop changes — the assignment happens
 * during render, so React re-runs this component before touching the DOM and
 * nothing flashes.
 *
 * Optimistic updates still work exactly as before. `setValue` shows the change
 * immediately; the refresh that follows the write replaces it with what the
 * database actually stored, so the server stays the authority and a wrong guess
 * can't survive on screen.
 *
 * ## Two things to know before reaching for it
 *
 * **The prop must come from a server component.** The trigger is identity, not
 * deep equality, and an RSC payload deserializes to fresh objects on every
 * refresh — which is what makes this work. If a CLIENT parent computes the prop
 * inline (`rows={all.filter(...)}`), it is a new array on every render of that
 * parent and this would wipe local state each time. Pass a memoized value, or
 * don't use the hook there.
 *
 * **Don't hold a text draft in it.** A refresh landing mid-keystroke would
 * replace what the user is typing. Editors keep their own draft state and
 * re-seed only while unfocused — see `InfoValueCell` in `well-info-panel.tsx`.
 *
 * @param server the value rendered by the server (the RSC prop)
 * @returns the usual `[value, setValue]`, where `value` follows the server
 */
export function useServerState<T>(
  server: T
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState(server);
  // What the server last sent. Kept separately from `value` because `value`
  // moves on its own (optimistic edits), and comparing against it would re-seed
  // on every local change instead of on every server change.
  const [synced, setSynced] = useState(server);

  if (synced !== server) {
    setSynced(server);
    setValue(server);
  }

  return [value, setValue];
}
