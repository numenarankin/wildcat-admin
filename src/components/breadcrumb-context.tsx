"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

type RenameHandler = ((name: string) => void) | null;

interface BreadcrumbContextValue {
  /** Human-readable label for the current detail page, or null on list pages. */
  label: string | null;
  setLabel: Dispatch<SetStateAction<string | null>>;
  /** When set, the trailing crumb becomes click-to-rename. */
  rename: RenameHandler;
  setRename: Dispatch<SetStateAction<RenameHandler>>;
}

const BreadcrumbContext = createContext<BreadcrumbContextValue | null>(null);

export function BreadcrumbProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [label, setLabel] = useState<string | null>(null);
  const [rename, setRename] = useState<RenameHandler>(null);

  return (
    <BreadcrumbContext.Provider value={{ label, setLabel, rename, setRename }}>
      {children}
    </BreadcrumbContext.Provider>
  );
}

export function useBreadcrumbLabel(): BreadcrumbContextValue | null {
  return useContext(BreadcrumbContext);
}

/**
 * Registers a label for the trailing breadcrumb crumb while this component is
 * mounted. Render it from a detail page to set the topbar title (e.g. a well
 * name); it clears the label automatically on unmount. Pass `onRename` to make
 * the crumb click-to-edit (used to rename a project in the topbar).
 */
export function SetPageBreadcrumb({
  label,
  onRename,
}: {
  label: string;
  onRename?: (name: string) => void;
}) {
  const ctx = useContext(BreadcrumbContext);

  useEffect(() => {
    if (!ctx) return;
    const { setLabel, setRename } = ctx;
    setLabel(label);
    setRename(() => onRename ?? null);
    return () => {
      setLabel(null);
      setRename(null);
    };
  }, [ctx, label, onRename]);

  return null;
}
