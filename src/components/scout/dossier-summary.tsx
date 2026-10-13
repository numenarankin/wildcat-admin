"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Panel } from "./modal-ui";
import type { ScoutSummary } from "@/lib/ai/scout-summary";

/**
 * The generated summary block on a Scout dossier's Summary tab.
 *
 * ON DEMAND, NOT ON OPEN. Every modal open would otherwise bill a model call
 * for a dossier nobody reads, and Scout's modals open on a map click. So this is
 * a header row with a button until it is asked, and the pane costs nothing until
 * then.
 *
 * Subject-agnostic on purpose: it takes the action already bound to its subject,
 * so the well, lease and (later) operator dossiers each add two lines rather
 * than a copy of this. The action is what enforces that the prose only ever
 * restates the figures rendered beside it; nothing here inspects the payload.
 */
export function DossierSummary({
  run,
}: {
  /** The bound server action, e.g. `() => summariseWell(api)`. */
  run: () => Promise<ScoutSummary>;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const result = await run();
      setText(result.text);
      setError(result.error ?? null);
    } catch {
      // A thrown action (signed out, network) must not leave the button spinning
      // with nothing said.
      setError("The summary could not be generated.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="AI summary"
      action={
        <Button size="sm" variant="outline" disabled={busy} onClick={generate}>
          {busy ? "Summarizing" : text ? "Regenerate" : "Summarize"}
        </Button>
      }
    >
      {busy ? (
        <div className="flex flex-col gap-2 px-4 py-3" aria-hidden>
          <div className="h-3.5 w-full animate-pulse rounded bg-muted" />
          <div className="h-3.5 w-11/12 animate-pulse rounded bg-muted" />
          <div className="h-3.5 w-2/3 animate-pulse rounded bg-muted" />
        </div>
      ) : error ? (
        <p className="px-4 py-3 text-sm text-destructive">{error}</p>
      ) : text ? (
        <p className="px-4 py-3 text-sm leading-relaxed text-secondary-text">
          {text}
        </p>
      ) : null}
    </Panel>
  );
}
