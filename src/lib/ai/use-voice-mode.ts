"use client";

import { create } from "zustand";

interface VoiceModeState {
  /** Whether hands-free voice conversation with Orion is active. */
  enabled: boolean;
  toggle: () => void;
  setEnabled: (enabled: boolean) => void;
}

/**
 * Global on/off for talking to Orion by voice. The topbar mic toggle and the
 * (app-shell-mounted) voice controller both read this, so the conversation loop
 * runs regardless of which page the user is on.
 */
export const useVoiceMode = create<VoiceModeState>((set) => ({
  enabled: false,
  toggle: () => set((state) => ({ enabled: !state.enabled })),
  setEnabled: (enabled) => set({ enabled }),
}));
