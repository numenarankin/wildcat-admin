"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronRightIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FolderIcon,
  ImageIcon,
  PresentationIcon,
  SearchIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SettingsMessage } from "@/components/settings/panel";
import type { DriveKind, DriveRow } from "@/lib/admin/google/drive/map";
import { usePageContextSlice } from "@/lib/ai/use-ai-context";
import { driveSlice } from "@/lib/ai/admin/page-slices";

/**
 * /admin/drive: the admin's Google Drive, read only. The customer Files
 * browser's header (breadcrumbs left, search right) and borderless table,
 * classes copied from `components/files/file-browser.tsx`; that component is
 * bound to the KB tree, so it is not reused directly. Rows are read live from
 * Drive (plan D1). Folders open here, Google Docs open in our editor (read
 * only), everything else opens in Google.
 */

const KIND_ICON: Record<DriveKind, LucideIcon> = {
  folder: FolderIcon,
  doc: FileTextIcon,
  sheet: FileSpreadsheetIcon,
  slides: PresentationIcon,
  pdf: FileTextIcon,
  image: ImageIcon,
  file: FileIcon,
};

export interface DriveCrumb {
  id: string;
  name: string;
}

export function driveFolderHref(folderId: string): string {
  return folderId === "root" ? "/drive" : `/drive?folder=${encodeURIComponent(folderId)}`;
}

export function DriveBrowser({
  crumbs,
  rows,
  query,
  truncated,
  error,
}: {
  /** From the top level to the open folder; the last is the open one. */
  crumbs: DriveCrumb[];
  rows: DriveRow[];
  /** The search being shown, or "" for the folder listing. */
  query: string;
  /** Drive had more than the listing cap. */
  truncated: boolean;
  error: string | null;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(query);
  const current = crumbs[crumbs.length - 1];
  usePageContextSlice(
    "admin-drive",
    driveSlice({
      path: crumbs.map((c) => c.name),
      folderId: current?.id ?? null,
      query,
      rows,
      truncated,
    })
  );

  function search(term: string) {
    const t = term.trim();
    router.push(t ? `/drive?q=${encodeURIComponent(t)}` : driveFolderHref(current?.id ?? "root"));
  }

  function open(row: DriveRow) {
    if (row.kind === "folder") router.push(driveFolderHref(row.id));
    else if (row.kind === "doc") {
      router.push(`/drive/docs/${encodeURIComponent(row.id)}?from=${encodeURIComponent(current?.id ?? "root")}`);
    } else if (row.webViewLink) window.open(row.webViewLink, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <nav className="flex flex-wrap items-center gap-1">
          {(query ? [...crumbs, { id: "__search__", name: `“${query}”` }] : crumbs).map((folder, i, all) => {
            const isLast = i === all.length - 1;
            return (
              <span key={folder.id} className="flex items-center gap-1">
                {i > 0 && <ChevronRightIcon className="size-5 text-tertiary-text" />}
                <button
                  type="button"
                  disabled={isLast}
                  onClick={() => {
                    setDraft("");
                    router.push(driveFolderHref(folder.id));
                  }}
                  className={cn(
                    "rounded px-1.5 py-0.5 font-heading text-2xl font-semibold tracking-tight",
                    isLast
                      ? "text-primary-text"
                      : "text-tertiary-text hover:bg-background-hover hover:text-primary-text"
                  )}
                >
                  {folder.name}
                </button>
              </span>
            );
          })}
        </nav>

        <div className="flex items-center gap-2">
          {/* Same search control as the Files browser. Drive searches its
              whole index, so a search is not limited to the open folder. */}
          <div className="flex items-center gap-2 rounded-sm border border-input px-2">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") search(draft);
                if (e.key === "Escape") {
                  setDraft("");
                  if (query) search("");
                }
              }}
              placeholder="Search Drive…"
              aria-label="Search Google Drive"
              className="h-8 w-48 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
      </div>

      {error ? (
        <SettingsMessage error={error} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead className="w-10 pl-3.5" />
                <TableHead>Name</TableHead>
                <TableHead className="w-24">Type</TableHead>
                <TableHead className="w-24">Size</TableHead>
                <TableHead className="w-32">Modified</TableHead>
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const Icon = KIND_ICON[row.kind];
                return (
                  <TableRow key={row.id} className="group/row cursor-pointer" onClick={() => open(row)}>
                    <TableCell className="pl-3.5">
                      {row.kind === "folder" ? (
                        <FolderIcon className="size-4 text-data-accent" fill="currentColor" />
                      ) : (
                        <Icon className="size-4 text-tertiary-text" />
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="text-primary-text">{row.name}</span>
                    </TableCell>
                    <TableCell className="uppercase text-tertiary-text">{row.type}</TableCell>
                    <TableCell className="text-tertiary-text">{row.size}</TableCell>
                    <TableCell className="text-tertiary-text">{row.modified}</TableCell>
                    <TableCell>
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className={cn(
                          "flex items-center justify-end gap-0.5 transition-opacity",
                          "opacity-0 group-hover/row:opacity-100 focus-within:opacity-100"
                        )}
                      >
                        {row.downloadable && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Download ${row.name}`}
                            className="hover:text-data-accent"
                            nativeButton={false}
                            render={
                              <a href={`/api/admin/google/drive/download?id=${encodeURIComponent(row.id)}`} download />
                            }
                          >
                            <DownloadIcon />
                          </Button>
                        )}
                        {row.webViewLink && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Open ${row.name} in Google`}
                            className="hover:text-data-accent"
                            nativeButton={false}
                            render={<a href={row.webViewLink} target="_blank" rel="noopener noreferrer" />}
                          >
                            <ExternalLinkIcon />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}

              {rows.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={6} className="py-10 text-center text-tertiary-text">
                    {query ? `Nothing in Drive matching “${query}”.` : "This folder is empty."}
                  </TableCell>
                </TableRow>
              )}
              {truncated && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={6} className="py-6 text-center text-tertiary-text">
                    Showing the first {rows.length.toLocaleString("en-US")}. Search to find the rest.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
