"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ADMIN_TIME_ZONE } from "@/lib/admin/time-zone";
import { ALL_BRANCHES, matchesCommit, type CommitRow } from "@/lib/admin/git-rows";
import { usePageContextSlice } from "@/lib/ai/use-ai-context";
import { gitSlice } from "@/lib/ai/admin/page-slices";

/**
 * /admin/git: a branch picker, a search box and the commit table. The default
 * view is every branch merged, each commit tagged with the branches it is on.
 * The branch lives in the URL, so the server page does the reading and a branch can be
 * linked; the search filters the rows already loaded. Looks like the Logs table.
 */

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  day: "2-digit",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: ADMIN_TIME_ZONE,
});
const formatTime = (iso: string) => (iso ? timeFormatter.format(new Date(iso)) : "");

const COLUMNS = ["Commit", "Message", "Author", "Date"];
const ALL_COLUMNS = ["Commit", "Branches", "Message", "Author", "Date"];
const branchLabel = (b: string) => (b === ALL_BRANCHES ? "All branches" : b);

export function GitWorkspace({
  branch,
  branches,
  commits,
  notConfigured = false,
}: {
  branch: string;
  branches: string[];
  commits: CommitRow[];
  notConfigured?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState("");
  const rows = commits.filter((c) => matchesCommit(c, q));
  const all = branch === ALL_BRANCHES;
  const columns = all ? ALL_COLUMNS : COLUMNS;
  usePageContextSlice("admin-git", gitSlice(rows, q.trim(), all ? null : branch));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">Git</h1>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={branch}
          onValueChange={(v) => {
            const next = String(v ?? ALL_BRANCHES);
            setQ("");
            startTransition(() =>
              router.push(next === ALL_BRANCHES ? "/git" : `/git?branch=${encodeURIComponent(next)}`)
            );
          }}
        >
          <SelectTrigger className="h-8 w-56">
            <span className={cn("truncate text-xs", !all && "font-mono")}>{branchLabel(branch)}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_BRANCHES} className="text-xs">
              {branchLabel(ALL_BRANCHES)}
            </SelectItem>
            {branches.map((b) => (
              <SelectItem key={b} value={b} className="font-mono text-xs">
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search message, author or SHA"
          className="min-w-48 flex-1"
        />
        <span className="text-sm tabular-nums text-muted-foreground">
          {q.trim() ? `${rows.length} of ${commits.length}` : commits.length} commits
        </span>
      </div>

      <div className={cn("rounded-[0.15rem] border", pending && "opacity-60")}>
        <Table className="text-[0.9rem]">
          <TableHeader className="bg-muted [&_th]:h-12 [&_th]:font-mono [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
            <TableRow className="hover:bg-muted">
              {columns.map((c) => (
                <TableHead key={c}>{c}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                  {notConfigured ? "GITHUB_TOKEN is not set for this deployment." : "No commits match."}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((c) => (
                <TableRow key={c.sha} className="align-top [&>td]:py-2.5">
                  <TableCell className="font-mono text-xs">
                    <a href={c.url} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">
                      {c.shortSha}
                    </a>
                  </TableCell>
                  {all ? (
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {(c.branches ?? []).map((b) => (
                          <Badge key={b} variant="outline" className="font-mono text-[0.7rem]">
                            {b}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                  ) : null}
                  <TableCell className="max-w-[36rem]">
                    {c.message === c.title ? (
                      <span className="block truncate">{c.title}</span>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger render={<span className="block cursor-help truncate" />}>{c.title}</TooltipTrigger>
                        <TooltipContent className="max-w-[32rem] whitespace-pre-wrap text-left font-mono text-xs">
                          {c.message}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </TableCell>
                  <TableCell className="max-w-44 truncate text-muted-foreground">{c.author}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">{formatTime(c.at)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
