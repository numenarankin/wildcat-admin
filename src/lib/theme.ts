/**
 * The admin app's colour theme. Dark unless the viewer has switched to light
 * from the profile menu; the choice lives in a cookie so the server renders
 * the right classes on <html> and nothing flashes the other theme.
 */

export type Theme = "dark" | "light";

export const THEME_COOKIE = "admin-theme";

export function parseTheme(value: string | undefined | null): Theme {
  return value === "light" ? "light" : "dark";
}

/**
 * The classes a theme puts on <html> and on the shell wrapper. Dark is
 * `.dark` plus the admin near-black ground (`.admin` in globals.css); light is
 * none, which leaves the `:root` light tokens the customer app uses.
 */
export const THEME_CLASSES: Record<Theme, string[]> = {
  dark: ["dark", "admin"],
  light: [],
};
