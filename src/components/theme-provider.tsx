"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { THEME_CLASSES, THEME_COOKIE, type Theme } from "@/lib/theme";

const ThemeContext = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({
  theme: "dark",
  setTheme: () => {},
});

/**
 * Holds the theme the server rendered with and switches it in place: swaps
 * the classes on <html> (where portalled menus, dialogs and toasts read them),
 * re-renders anything reading {@link useTheme}, and writes the cookie so the
 * next server render matches.
 */
export function ThemeProvider({
  initialTheme,
  children,
}: {
  initialTheme: Theme;
  children: React.ReactNode;
}) {
  const [theme, setThemeState] = useState<Theme>(initialTheme);

  const setTheme = useCallback((next: Theme) => {
    const html = document.documentElement;
    html.classList.remove(...THEME_CLASSES.dark, ...THEME_CLASSES.light);
    html.classList.add(...THEME_CLASSES[next]);
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    setThemeState(next);
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
