import { describe, it, expect } from "vitest";
import {
  ADMIN_PAGE_DEFS,
  ADMIN_PAGE_KEYS,
  cleanPages,
  pageKeyForPath,
  pagesAllowPath,
  pagesLabel,
} from "./pages";
import { adminNavLinks } from "@/components/app-shared";

/**
 * The page catalog is the one source of truth for what an admin can be
 * granted. These hold it in step with the sidebar and pin the helpers every
 * gate reads.
 */
describe("admin page catalog", () => {
  it("names every page the sidebar links, and nothing else", () => {
    const navKeys = adminNavLinks.map((item) => pageKeyForPath(item.path ?? "")).sort();
    expect(navKeys).not.toContain(null);
    expect(navKeys).toEqual([...ADMIN_PAGE_KEYS].sort());
  });

  it("has one def per key, whose path is the key", () => {
    expect(ADMIN_PAGE_DEFS.map((d) => d.key)).toEqual([...ADMIN_PAGE_KEYS]);
    for (const def of ADMIN_PAGE_DEFS) expect(def.path).toBe(`/${def.key}`);
  });

  it("maps a path to its page by first segment", () => {
    expect(pageKeyForPath("/projects/8f2a")).toBe("projects");
    expect(pageKeyForPath("/drive/docs/1")).toBe("drive");
    expect(pageKeyForPath("/settings?section=team")).toBe(null); // query is not a path
    expect(pageKeyForPath("/settings")).toBe("settings");
    expect(pageKeyForPath("/")).toBe(null);
    expect(pageKeyForPath("/_404")).toBe(null);
    expect(pageKeyForPath("/auth")).toBe(null);
  });

  it("cleans a list to known keys in catalog order", () => {
    expect(cleanPages(["git", "nope", "dashboard", "git"])).toEqual(["dashboard", "git"]);
    expect(cleanPages([])).toEqual([]);
  });

  it("opens a page only when it is on the list; a non-page path is open", () => {
    expect(pagesAllowPath(["tasks"], "/tasks")).toBe(true);
    expect(pagesAllowPath(["tasks"], "/tasks/anything")).toBe(true);
    expect(pagesAllowPath(["tasks"], "/dashboard")).toBe(false);
    expect(pagesAllowPath([], "/_404")).toBe(true);
  });

  it("summarises what is granted", () => {
    expect(pagesLabel([])).toBe("No pages");
    expect(pagesLabel(["tasks"])).toBe("1 page");
    expect(pagesLabel(["tasks", "git"])).toBe("2 pages");
    expect(pagesLabel([...ADMIN_PAGE_KEYS])).toBe("All pages");
  });
});
