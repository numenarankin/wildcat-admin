"use client";

import { useEffect, useState } from "react";
import { MicIcon, MicOffIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useVoiceMode } from "@/lib/ai/use-voice-mode";
import { isVoiceInputSupported } from "@/components/ai/voice-controller";

/**
 * Topbar toggle for hands-free voice conversation with Orion. Sits just left of
 * the Orion sparkle. When on, the mic icon's outline turns the accent blue.
 */
export function VoiceModeToggle() {
  const enabled = useVoiceMode((s) => s.enabled);
  const toggle = useVoiceMode((s) => s.toggle);
  // Speech recognition is browser-gated (Chromium/Safari). Resolve after mount
  // to avoid an SSR/client mismatch.
  const [supported, setSupported] = useState(true);
  useEffect(() => {
    setSupported(isVoiceInputSupported());
  }, []);

  return (
    <Button
      aria-label={
        supported
          ? enabled
            ? "Turn off voice conversation"
            : "Talk to Orion"
          : "Voice not supported in this browser"
      }
      aria-pressed={enabled}
      title={
        supported ? "Talk to Orion" : "Voice not supported in this browser"
      }
      size="icon-sm"
      variant="outline"
      disabled={!supported}
      onClick={toggle}
    >
      {supported ? (
        <MicIcon className={cn(enabled && "text-data-accent")} />
      ) : (
        <MicOffIcon />
      )}
    </Button>
  );
}
