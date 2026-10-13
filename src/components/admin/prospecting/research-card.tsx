"use client";

import { useState, useTransition } from "react";
import { CheckIcon, ExternalLinkIcon, Loader2Icon, MinusIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { deleteContact, setDecisionMaker } from "@/lib/admin/outreach/research-actions";
import { enrollTarget } from "@/lib/admin/outreach/sequence-actions";
import {
  ENRICH_STATUS_LABEL,
  type EnrichQueueItem,
  type TargetContact,
  type TargetResearch,
} from "@/lib/admin/outreach/types";

/**
 * The company's card beside its Enrich chat: what Orion has saved (the
 * website with what matched, the people and their details) and the one
 * button Orion cannot press, Add to sequence. Everything here is read back
 * from the database after each turn, so it shows exactly what was saved.
 */
export function ResearchCard({
  item,
  research,
  contacts,
  onChanged,
}: {
  item: EnrichQueueItem;
  research: TargetResearch | null;
  contacts: TargetContact[];
  /** A write landed: reload the card (and the queue's status). */
  onChanged: () => void;
}) {
  const [, startTransition] = useTransition();
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [enrolling, setEnrolling] = useState(false);
  const status = research?.status ?? item.status;
  const matches = research?.websiteMatches ?? {};
  const matchedPhone = matches.phone === true;
  const matchedAddress = matches.address === true;
  const strong = matchedPhone || matchedAddress;

  function toggle(id: string, on: boolean) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function handleEnroll() {
    setEnrolling(true);
    try {
      const { enrolled } = await enrollTarget(item.operatorNo, [...checked]);
      toast.success(enrolled === 0 ? "Already in the sequence." : `Enrolled ${enrolled === 1 ? "1 contact" : `${enrolled} contacts`}.`);
      setChecked(new Set());
      onChanged();
    } catch (error) {
      console.error("Failed to enroll", error);
      toast.error("Couldn't add to the sequence.");
    } finally {
      setEnrolling(false);
    }
  }

  const people = contacts.filter((c) => !c.generic);
  const generic = contacts.filter((c) => c.generic);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4 text-sm">
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-heading text-base font-semibold">{item.name}</div>
            <div className="text-xs text-muted-foreground">
              {[item.city, item.state].filter(Boolean).join(", ") || "—"} · {item.activeWells.toLocaleString()} active wells
            </div>
          </div>
          <Badge variant={status === "reviewed" || status === "enrolled" ? "secondary" : "outline"}>
            {ENRICH_STATUS_LABEL[status]}
          </Badge>
        </div>
      </div>

      <section className="flex flex-col gap-1.5">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Website</h3>
        {research?.website ? (
          <>
            <a
              href={research.website}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 truncate font-medium text-primary hover:underline"
            >
              {research.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
              <ExternalLinkIcon className="size-3.5 shrink-0" />
            </a>
            {/* What on the site agreed with the P-5 record, so the user can
                judge the link in one glance. */}
            <ul className="flex flex-wrap gap-1.5">
              <Match on={matchedPhone} label="Phone" />
              <Match on={matchedAddress} label="Address" />
              <Match on={matches.city === true} label="City" />
              <Match on={(matches.names?.length ?? 0) > 0} label={matches.names?.length ? `Names: ${matches.names.join(", ")}` : "Names"} />
            </ul>
            {!strong && <p className="text-xs text-amber-600 dark:text-amber-400">A guess: neither the phone nor the address was on the site.</p>}
          </>
        ) : (
          <p className="text-muted-foreground">Not found yet.</p>
        )}
      </section>

      <section className="flex flex-col gap-1.5">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">People</h3>
        {people.length === 0 ? (
          <p className="text-muted-foreground">None saved yet.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-[0.15rem] border">
            {people.map((c) => (
              <ContactRow key={c.id} contact={c} checked={checked.has(c.id)} onCheck={(on) => toggle(c.id, on)} onChanged={onChanged} />
            ))}
          </ul>
        )}
        {generic.length > 0 && (
          <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
            {generic.map((c) => (
              <li key={c.id} className="flex items-center gap-1.5">
                <span className="truncate">{c.email}</span>
                <span>· generic</span>
                {c.verification && <span>· {c.verification}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {research?.notes && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Notes</h3>
          <p className="whitespace-pre-line text-sm">{research.notes}</p>
        </section>
      )}

      <div className="mt-auto flex flex-col gap-1 pt-2">
        <Button onClick={() => startTransition(handleEnroll)} disabled={enrolling || status === "enrolled" && checked.size === 0}>
          {enrolling && <Loader2Icon className="animate-spin" />}
          Add to sequence{checked.size > 0 ? ` (${checked.size})` : ""}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          {checked.size === 0 ? "No one ticked: the calls go to the P-5 phone." : "One enrollment per ticked person."}
        </p>
      </div>
    </div>
  );
}

function Match({ on, label }: { on: boolean; label: string }) {
  return (
    <li
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
        on ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"
      )}
    >
      {on ? <CheckIcon className="size-3" /> : <MinusIcon className="size-3" />}
      {label}
    </li>
  );
}

function ContactRow({
  contact: c,
  checked,
  onCheck,
  onChanged,
}: {
  contact: TargetContact;
  checked: boolean;
  onCheck: (on: boolean) => void;
  onChanged: () => void;
}) {
  const [, startTransition] = useTransition();
  return (
    <li className="group flex items-start gap-2 px-2.5 py-2">
      <Checkbox
        className="mt-0.5"
        aria-label={`Enroll ${c.name ?? c.email ?? "contact"}`}
        checked={checked}
        onCheckedChange={(on) => onCheck(on === true)}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium">{c.name ?? "(no name)"}</span>
          {c.decisionMaker && <Badge variant="secondary" className="h-4 px-1 text-[10px]">Decision-maker</Badge>}
        </div>
        {c.title && <div className="truncate text-xs text-muted-foreground">{c.title}</div>}
        <div className="truncate text-xs">
          {c.email ?? <span className="text-muted-foreground">no email</span>}
          {c.phone && <span className="text-muted-foreground"> · {c.phone}</span>}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {c.source}
          {c.verification ? ` · ${c.verification}` : c.email ? " · unverified" : ""}
          {c.confidence != null ? ` · ${c.confidence}%` : ""}
          {c.sourceUrl && (
            <>
              {" · "}
              <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="hover:underline">
                source
              </a>
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          title={c.decisionMaker ? "Not a decision-maker" : "Mark decision-maker"}
          onClick={() => startTransition(async () => {
            await setDecisionMaker(c.id, !c.decisionMaker).catch(() => toast.error("Couldn't update the contact."));
            onChanged();
          })}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <CheckIcon className="size-3.5" />
        </button>
        <button
          type="button"
          title="Remove"
          onClick={() => startTransition(async () => {
            await deleteContact(c.id).catch(() => toast.error("Couldn't remove the contact."));
            onChanged();
          })}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
    </li>
  );
}
