/** Turn a display name into a URL-safe slug, e.g. "Spraberry Study" → "spraberry-study". */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}
