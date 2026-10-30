"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { LoadingScreen } from "@/components/ui/loading-screen";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { Empty, ModalTabs, Panel, Row, Stat, TabPane, TableBox, THead, Th, type ModalTab } from "@/components/scout/modal-ui";
import { getVisitorDetail } from "@/lib/admin/gtm/actions";
import { placeLabel } from "@/lib/admin/gtm/derive";
import { count, demoName, fmtClock, fmtDateTime, fmtDuration, pageName } from "@/lib/admin/gtm/format";
import type { EventRow, VisitorDetail } from "@/lib/admin/gtm/types";

type TabKey = "summary" | "visits" | "activity" | "demos";

const EVENT_LABEL: Record<EventRow["type"], string> = {
  pageview: "Page view",
  scroll_milestone: "Scrolled",
  click: "Click",
  rage_click: "Rage click",
  dead_click: "Dead click",
  hover: "Hover",
};

function eventDetail(e: EventRow): string {
  if (e.type === "pageview") return pageName(e.path);
  if (e.type === "scroll_milestone") return `${e.scroll_pct}% of ${pageName(e.path)}`;
  const el = [e.el_text ? `"${e.el_text}"` : null, e.el_tag ? `<${e.el_tag}${e.el_id ? `#${e.el_id}` : ""}>` : null]
    .filter(Boolean)
    .join(" ");
  const hover = e.type === "hover" && e.hover_ms != null ? ` for ${fmtDuration(e.hover_ms)}` : "";
  return `${el || "the page"}${hover}`;
}

/**
 * Everything held on one landing visitor, in Recon's dossier layout: who they
 * are (Snitcher's company, when identified) and where, each visit, the chosen
 * visit's timeline, and the demos they watched. Opened from a Visitors row or
 * a map dot.
 */
export function VisitorPanel({ visitorId, onClose }: { visitorId: string | null; onClose: () => void }) {
  const [detail, setDetail] = useState<VisitorDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("summary");
  const [visit, setVisit] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      if (!visitorId) return;
      setLoading(true);
      setError(null);
      setDetail(null);
      setTab("summary");
      try {
        const d = await getVisitorDetail(visitorId);
        if (!active) return;
        if (!d) setError("This visitor is no longer in the data.");
        setDetail(d);
        setVisit(d?.sessions[0]?.id ?? null);
      } catch {
        if (active) setError("Could not load the visitor.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
    // Not cleared when `visitorId` goes null: the modal plays a close animation.
  }, [visitorId]);

  const totals = useMemo(() => {
    const sessions = detail?.sessions ?? [];
    return {
      engaged: sessions.reduce((a, s) => a + s.engaged_ms, 0),
      maxScroll: sessions.reduce((a, s) => Math.max(a, s.max_scroll_pct), 0),
    };
  }, [detail]);

  const demos = useMemo(() => {
    const groups = new Map<string, { path: string; demo: string; plays: number; furthest: number | null; completed: boolean; watched: number }>();
    for (const d of detail?.demoViews ?? []) {
      const key = `${d.path}|${d.demo}`;
      const g = groups.get(key) ?? { path: d.path, demo: d.demo, plays: 0, furthest: null, completed: false, watched: 0 };
      g.plays++;
      if (d.max_progress_pct != null) g.furthest = Math.max(g.furthest ?? 0, d.max_progress_pct);
      g.completed ||= d.completed;
      g.watched += d.watched_ms;
      groups.set(key, g);
    }
    return [...groups.values()].sort((a, b) => b.plays - a.plays);
  }, [detail]);

  const timeline = useMemo(() => (detail?.events ?? []).filter((e) => e.session_id === visit), [detail, visit]);

  const sessions = detail?.sessions ?? [];
  const first = sessions[sessions.length - 1];
  const latest = sessions[0];
  const company = detail?.company ?? null;

  const TABS: ModalTab<TabKey>[] = [
    { key: "summary", label: "Summary" },
    { key: "visits", label: "Visits", count: sessions.length },
    { key: "activity", label: "Activity", count: timeline.length },
    { key: "demos", label: "Demos", count: demos.length },
  ];

  return (
    <SwipeUpModal
      open={visitorId != null}
      onClose={onClose}
      title={company?.name ?? "Anonymous visitor"}
      description={latest ? (placeLabel(latest.city, latest.state, latest.country) ?? undefined) : undefined}
      headerAction={
        detail ? (
          <Badge variant={company ? "secondary" : "outline"} className="mr-1">
            {company ? "Identified" : "Anonymous"}
          </Badge>
        ) : null
      }
      className="h-[80vh] max-w-5xl"
    >
      <ModalTabs tabs={TABS} value={tab} onChange={setTab} showCounts={Boolean(detail)} />

      {loading && (
        <div className="flex flex-1 items-center justify-center">
          <LoadingScreen label="Loading visitor" />
        </div>
      )}
      {error && !loading && (
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {!loading && !error && detail && tab === "summary" && (
        <TabPane>
          <div className="grid shrink-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Visits" value={count.format(sessions.length)} />
            <Stat label="Engaged time" value={fmtDuration(totals.engaged)} />
            <Stat label="Max scroll" value={`${totals.maxScroll}%`} />
            <Stat label="Demos watched" value={count.format(demos.length)} />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <Panel title="Visitor">
              <div className="px-4 py-2">
                <Row label="First seen" value={fmtDateTime(detail.visitor.first_seen_at)} />
                <Row label="Last seen" value={fmtDateTime(detail.visitor.last_seen_at)} />
                <Row label="Latest location" value={latest ? placeLabel(latest.city, latest.state, latest.country) : null} />
                <Row label="Device" value={latest?.device ?? null} />
                <Row label="First came from" value={first ? (first.utm_source ?? first.source ?? first.referrer) : null} />
                <Row label="First page" value={first ? pageName(first.entry_path) : null} />
              </div>
            </Panel>
            <Panel title="Company">
              {company ? (
                <div className="px-4 py-2">
                  <Row label="Name" value={company.name} />
                  <Row label="Website" value={company.domain} />
                  <Row label="Industry" value={company.industry} />
                  <Row label="Employees" value={company.employee_range} />
                  <Row label="Headquarters" value={placeLabel(company.hq_city, company.hq_state, company.hq_country)} />
                </div>
              ) : (
                <p className="px-4 py-3 text-sm text-muted-foreground">Not identified.</p>
              )}
            </Panel>
          </div>
        </TabPane>
      )}

      {!loading && !error && detail && tab === "visits" && (
        <TabPane>
          <TableBox>
            <table className="w-full text-sm">
              <THead>
                <Th>Started</Th>
                <Th>First page</Th>
                <Th>Came from</Th>
                <Th>Location</Th>
                <Th right>Engaged</Th>
                <Th right>Scroll</Th>
              </THead>
              <tbody>
                {sessions.map((s) => (
                  <tr
                    key={s.id}
                    className="cursor-pointer border-b last:border-0 hover:bg-muted/50"
                    onClick={() => {
                      setVisit(s.id);
                      setTab("activity");
                    }}
                  >
                    <td className="px-3 py-2 tabular-nums">{fmtDateTime(s.started_at)}</td>
                    <td className="px-3 py-2">{pageName(s.entry_path)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{s.utm_source ?? s.source ?? "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground">{placeLabel(s.city, s.state, s.country) ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtDuration(s.engaged_ms)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.max_scroll_pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableBox>
        </TabPane>
      )}

      {!loading && !error && detail && tab === "activity" && (
        <TabPane>
          <div className="flex shrink-0 flex-wrap gap-1.5">
            {sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={visit === s.id}
                onClick={() => setVisit(s.id)}
                className={
                  visit === s.id
                    ? "rounded-sm bg-foreground px-2.5 py-1 text-xs font-medium text-background"
                    : "rounded-sm bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                }
              >
                {fmtDateTime(s.started_at)}
              </button>
            ))}
          </div>
          {timeline.length === 0 ? (
            <Empty>Nothing was recorded on this visit.</Empty>
          ) : (
            <TableBox>
              <table className="w-full text-sm">
                <THead>
                  <Th>Time</Th>
                  <Th>Event</Th>
                  <Th>Detail</Th>
                </THead>
                <tbody>
                  {timeline.map((e) => (
                    <tr key={e.id} className="border-b last:border-0">
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">{fmtClock(e.occurred_at)}</td>
                      <td className="px-3 py-2">
                        {e.type === "rage_click" || e.type === "dead_click" ? (
                          <Badge variant="outline" className="border-amber-400/30 bg-amber-400/15 text-amber-600 dark:text-amber-300">
                            {EVENT_LABEL[e.type]}
                          </Badge>
                        ) : (
                          EVENT_LABEL[e.type]
                        )}
                      </td>
                      <td className="max-w-md truncate px-3 py-2 text-muted-foreground">{eventDetail(e)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableBox>
          )}
        </TabPane>
      )}

      {!loading && !error && detail && tab === "demos" && (
        <TabPane>
          {demos.length === 0 ? (
            <Empty>No demos watched.</Empty>
          ) : (
            <TableBox>
              <table className="w-full text-sm">
                <THead>
                  <Th>Demo</Th>
                  <Th>Page</Th>
                  <Th right>Plays</Th>
                  <Th right>Furthest</Th>
                  <Th>Finished</Th>
                  <Th right>Watched</Th>
                </THead>
                <tbody>
                  {demos.map((d) => (
                    <tr key={`${d.path}|${d.demo}`} className="border-b last:border-0">
                      <td className="px-3 py-2 font-medium">{demoName(d.demo)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{pageName(d.path)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{count.format(d.plays)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{d.furthest == null ? "—" : `${d.furthest}%`}</td>
                      <td className="px-3 py-2">{d.furthest == null ? "—" : d.completed ? "Yes" : "No"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtDuration(d.watched)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableBox>
          )}
        </TabPane>
      )}
    </SwipeUpModal>
  );
}
