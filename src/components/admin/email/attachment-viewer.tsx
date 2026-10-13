"use client";

import { DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import type { GmailAttachment } from "@/lib/admin/google/gmail/types";

/**
 * One attachment shown in place: images as an image, PDFs and text in the
 * browser's own viewer. Only `VIEWABLE_TYPES` open here; the route serves
 * anything else as a download whatever is asked.
 */
export function AttachmentViewer({
  attachment,
  href,
  onClose,
}: {
  attachment: GmailAttachment | null;
  /** The attachment route for this file, without `view`. */
  href: string;
  onClose: () => void;
}) {
  const view = `${href}&view=1`;
  return (
    <SwipeUpModal
      open={attachment !== null}
      onClose={onClose}
      title={attachment?.filename ?? "Attachment"}
      headerAction={
        <Button variant="outline" size="sm" render={<a href={href} />} nativeButton={false}>
          <DownloadIcon />
          Download
        </Button>
      }
      className="light h-[90vh] max-w-[min(92vw,72rem)]"
    >
      {attachment && (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted">
          {attachment.mimeType.startsWith("image/") ? (
            // eslint-disable-next-line @next/next/no-img-element -- a private, streamed attachment
            <img src={view} alt={attachment.filename} className="max-h-full max-w-full object-contain" />
          ) : (
            <iframe src={view} title={attachment.filename} className="size-full border-0 bg-white" />
          )}
        </div>
      )}
    </SwipeUpModal>
  );
}
