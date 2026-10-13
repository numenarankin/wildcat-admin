"use client";

import { Button } from "@/components/ui/button";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm action as destructive (red). */
  destructive?: boolean;
  /** Raise above the modal that asked, so its backdrop dims and blurs it. */
  elevated?: boolean;
}

/**
 * A small yes/no confirmation modal — the in-app replacement for
 * `window.confirm`. Built on {@link SwipeUpModal} so it matches the rest of the
 * app's modals (backdrop, animation, Escape-to-close). The confirm handler runs
 * and the modal closes on confirm.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  elevated = false,
}: ConfirmDialogProps) {
  function handleConfirm() {
    onConfirm();
    onClose();
  }

  return (
    <SwipeUpModal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      elevated={elevated}
    >
      <div className="flex items-center justify-end gap-2 px-5 py-4">
        <Button type="button" variant="outline" onClick={onClose}>
          {cancelLabel}
        </Button>
        <Button
          type="button"
          variant={destructive ? "destructive" : "default"}
          onClick={handleConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </SwipeUpModal>
  );
}
