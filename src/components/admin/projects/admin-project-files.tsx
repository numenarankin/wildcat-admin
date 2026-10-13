"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  DownloadIcon,
  FileIcon,
  FileTextIcon,
  ImageIcon,
  Loader2Icon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useServerState } from "@/hooks/use-server-state";
import { formatBytes } from "@/lib/files/limits";
import {
  deleteAdminProjectFile,
  getAdminProjectFileUrl,
} from "@/lib/admin/project-actions";
import type { AdminProjectFile } from "@/lib/admin/project-types";

const dayFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  year: "numeric",
});

/** "PDF", "PNG"... from the name, as the customer table's Type column reads. */
function typeLabel(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : "File";
}

function iconFor(file: AdminProjectFile): LucideIcon {
  if (file.mimeType?.startsWith("image/")) return ImageIcon;
  if (file.mimeType === "application/pdf" || file.mimeType?.startsWith("text/")) return FileTextIcon;
  return FileIcon;
}

/**
 * An admin project's Files tab: the customer file table's columns and row
 * actions over `admin_project_files`. The customer browser's folders, docs,
 * scan and ingest all write into an org's knowledge base, so none of them
 * belong here; a row opens the file in a new tab and downloads or deletes.
 * Uploading lives in the project toolbar's Add File, as it does on the
 * customer project page; the in-flight names come from there.
 */
export function AdminProjectFiles({
  files: initial,
  uploadingNames,
}: {
  files: AdminProjectFile[];
  uploadingNames: string[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [files, setFiles] = useServerState<AdminProjectFile[]>(initial);
  const [deleting, setDeleting] = useState<AdminProjectFile | null>(null);

  async function open(file: AdminProjectFile, download: boolean) {
    // Opened before the await so the browser treats it as the click's popup.
    const tab = download ? null : window.open("", "_blank");
    try {
      const url = await getAdminProjectFileUrl(file.id, { download });
      if (!url) throw new Error("File not found.");
      if (tab) tab.location.replace(url);
      else window.location.assign(url);
    } catch (error) {
      tab?.close();
      console.error("Failed to open file", error);
      toast.error("Couldn't open the file.");
    }
  }

  function handleConfirmDelete() {
    const file = deleting;
    if (!file) return;
    setFiles((prev) => prev.filter((f) => f.id !== file.id));
    startTransition(async () => {
      try {
        await deleteAdminProjectFile(file.id);
      } catch (error) {
        console.error("Failed to delete file", error);
        toast.error("Couldn't delete the file.");
      }
      router.refresh();
    });
  }

  const empty = files.length === 0 && uploadingNames.length === 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow>
            <TableHead className="w-10" />
            <TableHead>Name</TableHead>
            <TableHead className="w-24">Type</TableHead>
            <TableHead className="w-24">Size</TableHead>
            <TableHead className="w-32">Modified</TableHead>
            <TableHead className="w-24" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {uploadingNames.map((name, i) => (
            <TableRow key={`uploading-${i}`} className="hover:bg-transparent">
              <TableCell>
                <Loader2Icon className="size-4 animate-spin text-tertiary-text" />
              </TableCell>
              <TableCell>
                <span className="text-primary-text">{name}</span>
              </TableCell>
              <TableCell colSpan={4} className="text-tertiary-text">
                Uploading…
              </TableCell>
            </TableRow>
          ))}
          {empty ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={6} className="py-10 text-center text-tertiary-text">
                No files yet.
              </TableCell>
            </TableRow>
          ) : (
            files.map((file) => {
              const Icon = iconFor(file);
              return (
                <TableRow
                  key={file.id}
                  className="group/row cursor-pointer"
                  onClick={() => void open(file, false)}
                >
                  <TableCell>
                    <Icon className="size-4 text-tertiary-text" />
                  </TableCell>
                  <TableCell>
                    <span className="text-primary-text">{file.name}</span>
                  </TableCell>
                  <TableCell className="text-tertiary-text">{typeLabel(file.name)}</TableCell>
                  <TableCell className="text-tertiary-text">{formatBytes(file.sizeBytes)}</TableCell>
                  <TableCell className="text-tertiary-text">
                    {dayFormatter.format(new Date(file.createdAt))}
                  </TableCell>
                  <TableCell>
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className={cn(
                        "flex items-center justify-end gap-0.5 transition-opacity",
                        "opacity-0 group-hover/row:opacity-100 focus-within:opacity-100"
                      )}
                    >
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Download"
                        onClick={() => void open(file, true)}
                        className="hover:text-data-accent"
                      >
                        <DownloadIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Delete"
                        onClick={() => setDeleting(file)}
                        className="hover:text-error"
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={handleConfirmDelete}
        title={deleting ? `Delete ${deleting.name}?` : "Delete?"}
        description="This permanently removes the file. This can't be undone."
        confirmLabel="Delete"
        destructive
      />
    </div>
  );
}
