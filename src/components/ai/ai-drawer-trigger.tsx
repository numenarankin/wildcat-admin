"use client";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SparkleIcon } from "@/components/ai/sparkle-icon";
import { useAiDrawer } from "@/lib/ai/use-ai-drawer";

export function AiDrawerTrigger() {
  const open = useAiDrawer((s) => s.open);
  const toggle = useAiDrawer((s) => s.toggle);

  return (
    <Button
      aria-label="Chat with Orion"
      aria-pressed={open}
      size="icon-sm"
      variant="outline"
      onClick={toggle}
    >
      <SparkleIcon className={cn(open && "text-primary")} />
    </Button>
  );
}
