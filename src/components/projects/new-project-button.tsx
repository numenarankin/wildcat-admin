"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { createProject } from "@/lib/projects/actions";
import { cn } from "@/lib/utils";

export function NewProjectButton({
  create = createProject,
  themed = false,
}: {
  /** The server action that creates the project; the admin side passes its own. */
  create?: (name: string) => Promise<void>;
  /**
   * Take the theme's primary colours instead of the fixed black button, which
   * disappears on the admin side's near-black ground.
   */
  themed?: boolean;
} = {}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [isPending, startTransition] = useTransition();

  function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    startTransition(async () => {
      try {
        await create(trimmed);
        setName("");
        setOpen(false);
        router.refresh();
      } catch (error) {
        console.error("Failed to create project", error);
      }
    });
  }

  return (
    <>
      <Button
        size="lg"
        onClick={() => setOpen(true)}
        className={cn(!themed && "bg-black text-white hover:bg-neutral-800")}
      >
        <PlusIcon />
        New Project
      </Button>

      <SwipeUpModal
        open={open}
        onClose={() => setOpen(false)}
        title="New project"
        className="max-w-[420px]"
      >
        <div className="flex flex-col gap-4 px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="ty-body-2 font-medium text-primary-text">Name</span>
            <Input
              value={name}
              autoFocus
              placeholder="e.g. Spraberry Study"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleCreate();
                }
              }}
            />
          </label>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={!name.trim() || isPending}
          >
            Create project
          </Button>
        </footer>
      </SwipeUpModal>
    </>
  );
}
