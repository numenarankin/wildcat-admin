"use client";

import { useRouter } from "next/navigation";
import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsMessage } from "@/components/settings/panel";
import { MarkdownEditor } from "@/components/projects/markdown-editor";
import { driveFolderHref } from "@/components/admin/drive/drive-browser";
import { usePageContextSlice } from "@/lib/ai/use-ai-context";
import { driveDocSlice } from "@/lib/ai/admin/page-slices";

/**
 * A Google Doc, read only: `DocumentEditor`'s shape (Back, title, the bordered
 * editor surface) with "Open in Google" where the save state sits, since
 * editing happens in Google until phase 8.
 */
export function DriveDocView({
  id,
  title,
  html,
  webViewLink,
  backFolder,
  error,
}: {
  id: string;
  title: string;
  html: string | null;
  webViewLink: string | null;
  backFolder: string;
  error: string | null;
}) {
  const router = useRouter();
  usePageContextSlice("admin-drive-doc", driveDocSlice(id, title));
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="icon-sm" aria-label="Back" onClick={() => router.push(driveFolderHref(backFolder))}>
          <ArrowLeftIcon />
        </Button>
        <h1 className="min-w-0 flex-1 truncate px-1 font-heading text-2xl font-semibold tracking-tight">{title}</h1>
        {webViewLink && (
          <Button
            variant="outline"
            size="lg"
            nativeButton={false}
            render={<a href={webViewLink} target="_blank" rel="noopener noreferrer" />}
          >
            <ExternalLinkIcon />
            Open in Google
          </Button>
        )}
      </div>

      {error || html === null ? (
        <SettingsMessage error={error ?? "Couldn't open this doc."} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[0.15rem] border border-border bg-background">
          <MarkdownEditor key={id} fileId={id} initialContent={html} onChange={() => {}} readOnly />
        </div>
      )}
    </div>
  );
}
