"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SearchIcon, SettingsIcon, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScoutMap } from "@/components/scout/scout-map";
import { TargetModal } from "@/components/admin/prospecting/target-modal";
import { BarField, CountyPicker, MultiSelect, Range } from "@/components/scout/map-filters";
import {
  ProspectingToolbar,
  type ProspectingTab,
} from "@/components/admin/prospecting/prospecting-toolbar";
import { TargetsTable } from "@/components/admin/prospecting/targets-table";
import { TargetsMap } from "@/components/admin/prospecting/targets-map";
import { EnrichWorkspace } from "@/components/admin/prospecting/enrich-workspace";
import { SequenceWorkspace } from "@/components/admin/prospecting/sequence-workspace";
import { ProspectingSettingsModal } from "@/components/admin/prospecting/prospecting-settings-modal";
import { queueTarget } from "@/lib/admin/outreach/research-actions";
import { clearEnrollments } from "@/lib/admin/outreach/sequence-actions";
import type { ScheduledEmail } from "@/lib/admin/outreach/settings";
import { todayInAdminZone, type EnrichQueueItem, type Enrollment, type ProspectingSettings } from "@/lib/admin/outreach/types";
import type { EmailIndex } from "@/lib/admin/google/gmail/suggest";
import type { EmailSettings } from "@/lib/admin/google/gmail/email-style";
import { useServerState } from "@/hooks/use-server-state";
import { addTargets, removeTarget } from "@/lib/admin/target-actions";
import {
  EMPTY_TARGET_FILTERS,
  filterTargets,
  hasTargetFilters,
  targetTotals,
  type TargetFilters,
  type TargetInput,
  type TargetRow,
} from "@/lib/admin/target-types";
import { TIERS, type TierKey } from "@/lib/billing/tiers";
import type { CommodityPrices } from "@/lib/analytics/types";
import type { ReconLink } from "@/lib/recon-alerts/types";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const count = new Intl.NumberFormat("en-US");

const TIER_OPTIONS: { value: TierKey; label: string }[] = TIERS.map((t) => ({
  value: t.key,
  label: `${t.label} (${t.maxWells === null ? `${t.minWells}+` : `${t.minWells}–${t.maxWells}`} wells)`,
}));

/**
 * /prospecting: the sales desk's shape (tab switch · the tab's controls) over
 * three surfaces. Recon is the customer app's Recon map, Operators only;
 * Targets is the table of operators added from it; Map plots those targets at
 * their P-5 mailing addresses. Targets and Map show ONE list, filtered by the
 * toolbar's search and filters, so the dots are the rows.
 */
export function ProspectingWorkspace({
  prices,
  tileVersion,
  link,
  targets: initialTargets,
  queue,
  enrollments,
  scheduled,
  settings: initialSettings,
  emailIndex,
  emailSettings,
  firstName,
}: {
  prices: CommodityPrices;
  tileVersion: string;
  link: ReconLink;
  targets: TargetRow[];
  /** The Enrich queue and the Sequence tab's rows, read by the page. */
  queue: EnrichQueueItem[];
  enrollments: Enrollment[];
  scheduled: ScheduledEmail[];
  settings: ProspectingSettings;
  /** For the compose card the Sequence tab opens: autofill and signature. */
  emailIndex: EmailIndex;
  emailSettings: EmailSettings;
  firstName: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [tab, setTab] = useState<ProspectingTab>("recon");
  /** The toolbar's right side; Recon portals its filter bar into it. */
  const [filtersHost, setFiltersHost] = useState<HTMLDivElement | null>(null);
  // Removed rows leave at once; the refresh after each write hands the list
  // back to the server, which is also how a Recon add reaches the table.
  const [targets, setTargets] = useServerState<TargetRow[]>(initialTargets);
  const targetNumbers = useMemo(() => new Set(targets.map((t) => t.operatorNo)), [targets]);
  const [filters, setFilters] = useState<TargetFilters>(EMPTY_TARGET_FILTERS);
  const set = (patch: Partial<TargetFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const [settings, setSettings] = useServerState<ProspectingSettings>(initialSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const refresh = useCallback(() => router.refresh(), [router]);
  const dueToday = enrollments.filter((e) => e.state === "active" && e.nextDueOn != null && e.nextDueOn <= todayInAdminZone()).length;

  const handleQueue = useCallback(
    (target: TargetRow) => {
      startTransition(async () => {
        try {
          await queueTarget(target.operatorNo);
          toast.success(`${target.name} is on the enrich queue.`);
        } catch (error) {
          console.error("Failed to queue", error);
          toast.error("Couldn't add it to the queue.");
        }
        router.refresh();
      });
    },
    [router]
  );

  const queuedStatus = useMemo(() => new Map(queue.map((q) => [q.operatorNo, q.status])), [queue]);

  /** The target whose dossier is open (`TargetModal`), from a row, a dot or a cluster list. */
  const [openOperator, setOpenOperator] = useState<number | null>(null);
  const openTarget = useMemo(
    () => (openOperator == null ? null : targets.find((t) => t.operatorNo === openOperator) ?? null),
    [openOperator, targets]
  );

  // What Targets and Map show (`filterTargets`). The totals beside the search
  // are over these rows, so they answer "how much is in the list I am looking at".
  const shown = useMemo(() => filterTargets(targets, filters), [targets, filters]);
  const totals = targetTotals(shown);

  const handleAddTargets = useCallback(
    (inputs: TargetInput[]) => {
      const fresh = inputs.filter((t) => !targets.some((x) => x.operatorNo === t.operatorNo));
      startTransition(async () => {
        try {
          await addTargets(inputs);
          toast.success(
            fresh.length === 0
              ? "Already on the targets list."
              : `Added ${fresh.length} ${fresh.length === 1 ? "target" : "targets"}.`
          );
        } catch (error) {
          console.error("Failed to add targets", error);
          toast.error("Couldn't add the targets.");
        }
        router.refresh();
      });
    },
    [router, targets]
  );

  const handleRemove = useCallback(
    (target: TargetRow) => {
      setTargets((prev) => prev.filter((t) => t.operatorNo !== target.operatorNo));
      startTransition(async () => {
        try {
          await removeTarget(target.operatorNo);
        } catch (error) {
          console.error("Failed to remove target", error);
          toast.error("Couldn't remove the target.");
        }
        router.refresh();
      });
    },
    [router, setTargets]
  );

  // The Targets/Map controls, in the toolbar: the list's size and what it
  // would pay (the Sub /mo and Sub /yr columns summed over the rows shown),
  // the search, then the filters as the Recon bar draws its own.
  const targetActions = (
    <>
      <div className="flex items-center gap-3 whitespace-nowrap text-sm tabular-nums text-muted-foreground">
        <span>
          <span className="font-medium text-foreground">{count.format(totals.count)}</span>{" "}
          {totals.count === 1 ? "target" : "targets"}
        </span>
        <span>
          <span className="font-medium text-foreground">{usd.format(totals.monthUsd)}</span>/mo
        </span>
        <span>
          <span className="font-medium text-foreground">{usd.format(totals.yearUsd)}</span>/yr
        </span>
      </div>
      <div className="flex h-8 w-64 items-center gap-2 rounded-sm border border-input px-2">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          type="search"
          value={filters.query}
          onChange={(e) => set({ query: e.target.value })}
          placeholder="Search targets…"
          aria-label="Search targets"
          className="h-7 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <BarField label="Tier">
        <MultiSelect
          options={TIER_OPTIONS}
          selected={filters.tiers}
          onChange={(tiers) => set({ tiers })}
          allLabel="Any tier"
          noun="tiers"
          ariaLabel="Filter by tier"
          width="w-32"
        />
      </BarField>
      <BarField label="County">
        <CountyPicker codes={filters.counties} onChange={(counties) => set({ counties })} />
      </BarField>
      <BarField label="Revenue /mo">
        <Range
          label="Revenue per month"
          min={filters.minRevenue}
          max={filters.maxRevenue}
          onMin={(v) => set({ minRevenue: v })}
          onMax={(v) => set({ maxRevenue: v })}
          width="w-24"
        />
      </BarField>
      <BarField label="Wells">
        <Range
          label="Active wells"
          min={filters.minWells}
          max={filters.maxWells}
          onMin={(v) => set({ minWells: v })}
          onMax={(v) => set({ maxWells: v })}
          width="w-20"
        />
      </BarField>
      {hasTargetFilters(filters) && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setFilters({ ...EMPTY_TARGET_FILTERS, query: filters.query })}
        >
          <X className="size-3.5" />
          Clear
        </Button>
      )}
    </>
  );

  const handleClearSequence = useCallback(() => {
    startTransition(async () => {
      try {
        await clearEnrollments();
      } catch (error) {
        console.error("Failed to clear the sequence", error);
        toast.error("Couldn't clear the sequence.");
      }
      router.refresh();
    });
  }, [router]);

  const sequenceActions = (
    <>
      <span className="text-sm tabular-nums text-muted-foreground">
        <span className="font-medium text-foreground">{dueToday}</span> due today
      </span>
      {enrollments.length > 0 && (
        <Button size="sm" variant="outline" className="h-9 text-muted-foreground hover:text-destructive" onClick={handleClearSequence}>
          Clear
        </Button>
      )}
      <Button size="sm" variant="outline" className="h-9" onClick={() => setSettingsOpen(true)}>
        <SettingsIcon />
        Settings
      </Button>
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ProspectingToolbar
        tab={tab}
        onTab={setTab}
        actionsRef={setFiltersHost}
        actions={
          tab === "recon" || tab === "enrich" ? null : tab === "sequence" ? sequenceActions : targetActions
        }
      />
      {/* Every tab stays mounted and the inactive ones are hidden, so Recon
          keeps its view, filters and open panels across a visit to Targets
          (and the table its sort). Each map's own ResizeObserver calls
          `map.resize()` when its container comes back from 0×0. */}
      <div className={cn("relative min-h-0 flex-1", tab !== "recon" && "hidden")} inert={tab !== "recon"}>
        <ScoutMap
          prices={prices}
          tileVersion={tileVersion}
          link={link}
          onAddTargets={handleAddTargets}
          targetNumbers={targetNumbers}
          // Only while Recon is open: the same slot holds the Targets controls
          // on the other tabs.
          filtersHost={tab === "recon" ? filtersHost : null}
        />
      </div>
      {/* The table fills the area under the toolbar and pads its own outer
          cells to the toolbar's px-4 (the accounting app's table look). */}
      <div
        className={cn("min-h-0 flex-1 overflow-y-auto", tab !== "targets" && "hidden")}
        inert={tab !== "targets"}
      >
        <TargetsTable targets={shown} onOpen={(t) => setOpenOperator(t.operatorNo)} onRemove={handleRemove} onQueue={handleQueue} queued={queuedStatus} />
      </div>
      <div className={cn("relative min-h-0 flex-1", tab !== "map" && "hidden")} inert={tab !== "map"}>
        <TargetsMap targets={shown} onSelect={setOpenOperator} />
      </div>
      {/* Enrich and Sequence mount only while open: their chat and compose
          card hold nothing a visit elsewhere should keep, and the Enrich
          chat should not keep streaming unseen. */}
      {tab === "enrich" && <EnrichWorkspace queue={queue} firstName={firstName} onQueueChanged={refresh} />}
      {tab === "sequence" && (
        <SequenceWorkspace
          enrollments={enrollments}
          scheduled={scheduled}
          settings={settings}
          emailIndex={emailIndex}
          emailSettings={emailSettings}
          onChanged={refresh}
        />
      )}
      <ProspectingSettingsModal
        key={settingsOpen ? "open" : "closed"}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        emailSettings={emailSettings}
        onSaved={setSettings}
      />
      {/* Outside the hidden/inert panes, so it can show over any of them. */}
      <TargetModal target={openTarget} prices={prices} onClose={() => setOpenOperator(null)} />
    </div>
  );
}
