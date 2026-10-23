"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { DownloadIcon, EyeIcon, FileSpreadsheetIcon, FileTextIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { getOrionFileUrl } from "@/lib/admin/orion-file-actions";
import { parseCsv, type OrionFile } from "@/lib/ai/file-spec";

/**
 * A file Orion wrote (`create_file`), as a card in the chat: name, size, View
 * and Download. View opens the file in a modal (tables as a grid, a PDF in
 * the browser's viewer, Markdown rendered, text and JSON as written, HTML in
 * a sandboxed frame with no scripts); Download saves it under its own name. Links are signed per click.
 */

type Preview =
  | { kind: "table"; sheets: { name: string; rows: string[][] }[] }
  | { kind: "markdown"; text: string }
  | { kind: "text"; text: string }
  | { kind: "html"; text: string }
  | { kind: "pdf"; url: string };

const SURFACE_W = { page: "max-w-[640px]", drawer: "max-w-full" } as const;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadPreview(file: OrionFile, url: string): Promise<Preview> {
  // The browser's own viewer, from the signed link.
  if (file.format === "pdf") return { kind: "pdf", url };
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (file.format === "xlsx") {
    const XLSX = await import("xlsx");
    const book = XLSX.read(await res.arrayBuffer(), { type: "array" });
    return {
      kind: "table",
      sheets: book.SheetNames.map((name) => ({
        name,
        rows: XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name], { header: 1, defval: "" }).map((r) =>
          r.map((c) => (c == null ? "" : String(c)))
        ),
      })),
    };
  }
  const text = await res.text();
  if (file.format === "csv") return { kind: "table", sheets: [{ name: file.filename, rows: parseCsv(text) }] };
  if (file.format === "md") return { kind: "markdown", text };
  if (file.format === "html") return { kind: "html", text };
  return { kind: "text", text };
}

export function OrionFileCard({ file, surface = "page" }: { file: OrionFile; surface?: "page" | "drawer" }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(0);
  const [busy, setBusy] = useState(false);
  const Icon = file.format === "csv" || file.format === "xlsx" ? FileSpreadsheetIcon : FileTextIcon;

  async function view() {
    setBusy(true);
    try {
      const url = await getOrionFileUrl(file.path);
      if (!url) throw new Error("No link");
      setPreview(await loadPreview(file, url));
      setSheet(0);
      setOpen(true);
    } catch (error) {
      console.error("Failed to open file", error);
      toast.error("Couldn't open the file.");
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    try {
      const url = await getOrionFileUrl(file.path, { download: file.filename });
      if (!url) throw new Error("No link");
      window.location.href = url;
    } catch (error) {
      console.error("Failed to download file", error);
      toast.error("Couldn't download the file.");
    }
  }

  const current = preview?.kind === "table" ? preview.sheets[sheet] : null;

  return (
    <>
      <div className={cn("my-2 flex w-full items-center gap-3 rounded-lg border bg-background-surface px-3 py-2.5", SURFACE_W[surface])}>
        <Icon className="size-5 shrink-0 text-tertiary-text" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-primary-text">{file.filename}</div>
          <div className="text-xs text-tertiary-text">{formatSize(file.sizeBytes)}</div>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void view()}>
          <EyeIcon className="size-4" />
          View
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => void download()}>
          <DownloadIcon className="size-4" />
          Download
        </Button>
      </div>

      <SwipeUpModal open={open} onClose={() => setOpen(false)} title={file.filename} className="max-h-[85vh] max-w-5xl">
        <div className="flex min-h-0 flex-1 flex-col">
          {preview?.kind === "table" && preview.sheets.length > 1 && (
            <div className="flex flex-wrap gap-1 border-b px-4 py-2">
              {preview.sheets.map((s, i) => (
                <Button key={s.name} type="button" size="sm" variant={i === sheet ? "secondary" : "ghost"} onClick={() => setSheet(i)}>
                  {s.name}
                </Button>
              ))}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {current && (
              <Table className="text-[0.9rem]">
                <TableHeader>
                  <TableRow>
                    {(current.rows[0] ?? []).map((h, i) => (
                      <TableHead key={i} className="whitespace-nowrap">
                        {h}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {current.rows.slice(1).map((r, i) => (
                    <TableRow key={i}>
                      {r.map((c, j) => (
                        <TableCell key={j} className="whitespace-nowrap">
                          {c}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {preview?.kind === "markdown" && (
              <div className="prose-sm text-[15px] leading-relaxed text-primary-text [&>*+*]:mt-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_table]:w-full [&_td]:border [&_td]:px-3 [&_td]:py-1.5 [&_th]:border [&_th]:bg-background-subtle [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_ul]:list-disc [&_ul]:pl-5">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview.text}</ReactMarkdown>
              </div>
            )}
            {preview?.kind === "text" && (
              <pre className="whitespace-pre-wrap break-words font-mono text-[0.85rem] text-primary-text">{preview.text}</pre>
            )}
            {preview?.kind === "pdf" && (
              <iframe title={file.filename} src={preview.url} className="h-[75vh] w-full rounded border" />
            )}
            {preview?.kind === "html" && (
              // No scripts, no same-origin: the page renders, it cannot act.
              <iframe title={file.filename} sandbox="" srcDoc={preview.text} className="h-[70vh] w-full rounded border bg-white" />
            )}
          </div>
        </div>
      </SwipeUpModal>
    </>
  );
}
