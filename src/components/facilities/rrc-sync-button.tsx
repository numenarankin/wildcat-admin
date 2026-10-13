"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Spokes } from "@/components/ui/spokes";
import type { RrcChoice, RrcSyncResult } from "@/lib/rrc/facility-sync";

/**
 * Sync with RRC, on a facility's settings form.
 *
 * Fills the form and NOTHING ELSE — no write happens until the user saves, the
 * same as if they had typed it. The button therefore lives beside Cancel rather
 * than looking like a second commit action, and it is gray for the same reason.
 *
 * The result line names the record that was taken (`API 12345678 · Dollar 1`).
 * A name search can land on the wrong hole of a two-well lease, and the only
 * moment that is correctable is before Save, so the match is stated rather than
 * left for the user to infer from the values that appeared.
 */
export function RrcSyncButton<T>({
  sync,
  onFilled,
  disabled,
}: {
  /**
   * Run the lookup. `apiNumber` is set only when the user picked one of the
   * choices below, which is how a shortlist resolves: the same action, pinned
   * to the record they chose.
   */
  sync: (apiNumber?: string) => Promise<RrcSyncResult<T>>;
  onFilled: (values: T) => void;
  disabled?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [choices, setChoices] = useState<RrcChoice[]>([]);

  async function handleClick(apiNumber?: string) {
    setPending(true);
    setNote(null);
    setChoices([]);
    try {
      const result = await sync(apiNumber);
      if (result.ok) {
        onFilled(result.values);
        setNote({ ok: true, text: result.match });
      } else {
        setNote({ ok: false, text: result.reason });
        setChoices(result.choices ?? []);
      }
    } catch (error) {
      console.error("RRC sync failed", error);
      setNote({
        ok: false,
        text: "Could not reach the Railroad Commission. Try again.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    // `mr-auto` inside the footer's `justify-end` row: this sits at the far
    // left, away from Cancel and Save, because it fills the form rather than
    // committing it.
    <div className="mr-auto flex min-w-0 flex-col items-start gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="lg"
          disabled={pending || disabled}
          onClick={() => void handleClick()}
        >
          {pending ? <Spokes data-icon="inline-start" /> : null}
          Sync with RRC
        </Button>
        {note ? (
          <span
            className={`min-w-0 text-xs leading-snug ${
              note.ok ? "text-muted-foreground" : "text-destructive"
            }`}
          >
            {note.text}
          </span>
        ) : null}
      </div>
      {/* Two wells of one name is ordinary, and the person who typed it is the
          only one who knows which they meant. */}
      {choices.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {choices.map((choice) => (
            <Button
              key={choice.apiNumber}
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => void handleClick(choice.apiNumber)}
            >
              {choice.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
