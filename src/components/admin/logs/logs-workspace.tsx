"use client";

import { Fragment, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ADMIN_TIME_ZONE } from "@/lib/admin/time-zone";
import { LOG_LEVELS, LOG_SOURCES, STATUS_CLASSES, type LogLine } from "@/lib/admin/log-rows";
import { LOG_RANGES, logParamsHref, type LogParams } from "@/lib/admin/log-params";
import { loadRequestLines } from "@/lib/admin/log-actions";
import { usePageContextSlice } from "@/lib/ai/use-ai-context";
import { logLineSlice, logsSlice } from "@/lib/ai/admin/page-slices";

/**
 * /admin/logs: the filter bar and the line table. The filters live in the URL, so the server
 * page does the reading and a filtered view can be linked. A row expands to its full message
 * and every other line of the same request. The table looks like the Clients table.
 */

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  day: "2-digit",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZone: ADMIN_TIME_ZONE,
});
const formatTime = (iso: string) => timeFormatter.format(new Date(iso));

const LEVEL_BADGE: Record<string, string> = {
  error: "border-red-500/30 bg-red-500/15 text-red-600 dark:text-red-400",
  fatal: "border-red-500/30 bg-red-500/15 text-red-600 dark:text-red-400",
  warning: "border-amber-400/30 bg-amber-400/15 text-amber-600 dark:text-amber-300",
  info: "border-blue-500/30 bg-blue-500/15 text-blue-600 dark:text-blue-400",
};
const statusTint = (code: number | null) =>
  code === null ? "" : code >= 500 ? "text-red-600 dark:text-red-400" : code >= 400 ? "text-amber-600 dark:text-amber-300" : "";

const COLUMNS = ["", "Time", "Level", "Status", "Method", "Path", "User", "Message"];
const ALL = "all";

export function LogsWorkspace({
  params,
  lines,
  hasMore,
  missingTable = false,
}: {
  params: LogParams;
  lines: LogLine[];
  hasMore: boolean;
  missingTable?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  usePageContextSlice("admin-logs", logsSlice(params, lines));
  const go = (next: Partial<LogParams>) =>
    startTransition(() => router.push(logParamsHref({ ...params, before: undefined, ...next })));

  const last = lines[lines.length - 1];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">Logs</h1>

      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Select time range" className="inline-flex items-center gap-0.5 rounded-sm bg-muted p-0.5">
          {LOG_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={params.range === r}
              onClick={() => go({ range: r })}
              className={cn(
                "rounded-sm px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
                params.range === r && "bg-background text-foreground shadow-sm hover:text-foreground"
              )}
            >
              {r}
            </button>
          ))}
        </div>
        <FilterSelect label="Level" value={params.level} options={LOG_LEVELS} onChange={(level) => go({ level })} />
        <FilterSelect label="Source" value={params.source} options={LOG_SOURCES} onChange={(source) => go({ source })} />
        <FilterSelect
          label="Status"
          value={params.status}
          options={STATUS_CLASSES}
          onChange={(status) => go({ status: status as LogParams["status"] })}
        />
        <form
          key={`${params.path}|${params.user}|${params.action}|${params.q}`}
          className="flex flex-1 flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const text = (k: string) => String(f.get(k) ?? "").trim() || undefined;
            go({ path: text("path"), user: text("user"), action: text("action"), q: text("q") });
          }}
        >
          <Input name="path" defaultValue={params.path} placeholder="Path" className="w-40" />
          <Input name="user" defaultValue={params.user} placeholder="User email" className="w-48" />
          <Input name="action" defaultValue={params.action} placeholder="Action" className="w-40" />
          <Input name="q" defaultValue={params.q} placeholder="Search messages" className="min-w-48 flex-1" />
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            Search
          </Button>
        </form>
      </div>

      <div className={cn("rounded-[0.15rem] border", pending && "opacity-60")}>
        <Table className="text-[0.9rem]">
          <TableHeader className="bg-muted [&_th]:h-12 [&_th]:font-mono [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
            <TableRow className="hover:bg-muted">
              {COLUMNS.map((c, i) => (
                <TableHead key={i} className={c === "" ? "w-8" : undefined}>
                  {c}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMNS.length} className="h-24 text-center text-muted-foreground">
                  {missingTable ? "The logs table is not up to date in this database (migrations 2026100100100 and 2026100100200)." : "No log lines match."}
                </TableCell>
              </TableRow>
            ) : (
              lines.map((l) => <LogRow key={l.id} line={l} />)
            )}
          </TableBody>
        </Table>
      </div>

      {hasMore && last ? (
        <div className="flex justify-center">
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => startTransition(() => router.push(logParamsHref({ ...params, before: `${last.at}|${last.id}` })))}
          >
            Older
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | undefined;
  options: readonly string[];
  onChange: (v: string | undefined) => void;
}) {
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(!v || v === ALL ? undefined : String(v))}>
      <SelectTrigger className="h-8 w-32">
        <span className="truncate capitalize">{value ?? `${label}: all`}</span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All</SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o} className="capitalize">
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function LogRow({ line }: { line: LogLine }) {
  const [open, setOpen] = useState(false);
  const [related, setRelated] = useState<LogLine[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && line.requestId && related === null) {
      loadRequestLines(line.requestId)
        .then(setRelated)
        .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
    }
  }

  usePageContextSlice(`admin-log-line-${line.id}`, open ? logLineSlice(line, related ? related.length : null) : null);

  const firstLine = (line.message ?? "").split("\n").find((s) => s.trim()) ?? "";
  const others = related?.filter((r) => r.id !== line.id) ?? [];

  return (
    <Fragment>
      <TableRow className="group cursor-pointer align-top [&>td]:py-2.5" onClick={toggle}>
        <TableCell className="text-muted-foreground">
          {open ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
        </TableCell>
        <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">{formatTime(line.at)}</TableCell>
        <TableCell>
          {line.level ? (
            <Badge variant="outline" className={cn("capitalize", LEVEL_BADGE[line.level])}>
              {line.level}
            </Badge>
          ) : (
            <span className="text-muted-foreground">{line.source}</span>
          )}
        </TableCell>
        <TableCell className={cn("tabular-nums", statusTint(line.statusCode))}>{line.statusCode ?? ""}</TableCell>
        <TableCell className="font-mono text-xs">{line.method ?? ""}</TableCell>
        <TableCell className="max-w-56 truncate font-mono text-xs">{line.path ?? ""}</TableCell>
        <TableCell className="max-w-44 truncate text-muted-foreground">{line.userEmail ?? ""}</TableCell>
        <TableCell className="max-w-[28rem] font-mono text-xs">
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1 truncate">{firstLine}</span>
            <CopyLineButton line={line} />
          </div>
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow className="hover:bg-transparent">
          <TableCell />
          <TableCell colSpan={COLUMNS.length - 1} className="whitespace-normal pb-4">
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-muted p-3 font-mono text-xs">
              {line.message ?? ""}
            </pre>
            {loadError ? <p className="mt-2 text-xs text-red-600 dark:text-red-400">{loadError}</p> : null}
            {others.length > 0 ? (
              <div className="mt-3 flex flex-col gap-2">
                {others.map((r) => (
                  <div key={r.id} className="rounded-sm border p-2">
                    <div className="mb-1 flex gap-3 text-xs text-muted-foreground">
                      <span className="tabular-nums">{formatTime(r.at)}</span>
                      <span>{r.source}</span>
                      {r.level ? <span className="capitalize">{r.level}</span> : null}
                      {r.statusCode ? <span className={statusTint(r.statusCode)}>{r.statusCode}</span> : null}
                      {r.userEmail ? <span>{r.userEmail}</span> : null}
                    </div>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{r.message ?? ""}</pre>
                  </div>
                ))}
              </div>
            ) : null}
          </TableCell>
        </TableRow>
      ) : null}
    </Fragment>
  );
}

/** The whole line as text: every field, then the full message. */
function lineText(l: LogLine): string {
  const fields = [
    `time: ${l.at}`,
    `source: ${l.source}`,
    l.level ? `level: ${l.level}` : null,
    l.statusCode ? `status: ${l.statusCode}` : null,
    l.method || l.path ? `request: ${[l.method, l.path].filter(Boolean).join(" ")}` : null,
    l.userEmail || l.userId ? `user: ${l.userEmail ?? l.userId}` : null,
    l.orgId ? `org: ${l.orgId}` : null,
    l.action ? `action: ${l.action}` : null,
    l.requestId ? `request id: ${l.requestId}` : null,
  ].filter(Boolean);
  return `${fields.join("\n")}\n\n${l.message ?? ""}`.trimEnd();
}

/** Copies the row's full log; shows on row hover, like Orion's copy button. */
function CopyLineButton({ line }: { line: LogLine }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(lineText(line));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.error("Copy failed", error);
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? "Copied" : "Copy log"}
      className={cn(
        "shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100",
        copied && "opacity-100"
      )}
    >
      {copied ? <CheckIcon className="size-3.5 text-emerald-600 dark:text-emerald-400" /> : <CopyIcon className="size-3.5" />}
    </button>
  );
}
