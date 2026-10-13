"use client";

import { create } from "zustand";

interface ProjectScope {
  folderId: string;
  projectName: string;
}

interface ProjectScopeState {
  /** The project the user is currently inside, or null. */
  scope: ProjectScope | null;
  setScope: (scope: ProjectScope | null) => void;
}

/**
 * Which project (folder) the user is currently inside. Set by the project page;
 * read by the global Orion drawer so its chat runs the project-scoped pipeline
 * (folder retrieval + project memory + the project's task/budget data) — the
 * same intricate AI the project has always used, just delivered through the
 * shared drawer. Null everywhere else, so the drawer stays a global chat.
 */
export const useProjectScope = create<ProjectScopeState>((set) => ({
  scope: null,
  setScope: (scope) => set({ scope }),
}));
