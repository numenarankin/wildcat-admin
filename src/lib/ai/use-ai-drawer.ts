"use client";

import { create } from "zustand";

/** Bounds for the user-resizable drawer width, in pixels. */
export const DRAWER_MIN_WIDTH = 320;
export const DRAWER_MAX_WIDTH = 720;
export const DRAWER_DEFAULT_WIDTH = 384;

interface AiDrawerState {
  /** Whether the Orion chat drawer is open. */
  open: boolean;
  /** Current drawer width in pixels (user-resizable). */
  width: number;
  toggle: () => void;
  setOpen: (open: boolean) => void;
  setWidth: (width: number) => void;
}

/**
 * Global state for the Orion AI drawer so the topbar trigger and the drawer
 * (both rendered in the app shell) stay in sync from anywhere in the app.
 */
export const useAiDrawer = create<AiDrawerState>((set) => ({
  open: false,
  width: DRAWER_DEFAULT_WIDTH,
  toggle: () => set((state) => ({ open: !state.open })),
  setOpen: (open) => set({ open }),
  setWidth: (width) =>
    set({
      width: Math.min(DRAWER_MAX_WIDTH, Math.max(DRAWER_MIN_WIDTH, width)),
    }),
}));
