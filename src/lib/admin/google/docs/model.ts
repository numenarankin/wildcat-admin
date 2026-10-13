/**
 * A Google Doc (Docs API v1 `documents.get`) as the HTML our editor renders.
 * Plan: docs/plans/google-integration.md section 8.2, read only for now: the
 * index map that editing needs comes with phase 8.
 *
 * Kept to what `MarkdownEditor` (TipTap StarterKit + Link, headings 1 to 3)
 * shows: paragraphs, headings, bold, italic, underline, strike, links, nested
 * bullet and numbered lists, horizontal rules. Things it cannot show are named
 * in place, never silently dropped: a table becomes one paragraph per row with
 * its cells separated by " | ", an image or other embedded object becomes
 * "[Image]", a smart chip becomes its link or name.
 */

export interface DocsTextStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  link?: { url?: string; headingId?: string; bookmarkId?: string };
}

export interface DocsParagraphElement {
  textRun?: { content?: string; textStyle?: DocsTextStyle };
  inlineObjectElement?: { inlineObjectId?: string };
  horizontalRule?: object;
  pageBreak?: object;
  footnoteReference?: { footnoteNumber?: string };
  person?: { personProperties?: { name?: string; email?: string } };
  richLink?: { richLinkProperties?: { title?: string; uri?: string } };
  equation?: object;
}

export interface DocsParagraph {
  elements?: DocsParagraphElement[];
  paragraphStyle?: { namedStyleType?: string };
  bullet?: { listId?: string; nestingLevel?: number };
}

export interface DocsStructuralElement {
  paragraph?: DocsParagraph;
  table?: { tableRows?: { tableCells?: { content?: DocsStructuralElement[] }[] }[] };
  sectionBreak?: object;
  tableOfContents?: { content?: DocsStructuralElement[] };
}

export interface DocsDocument {
  documentId?: string;
  title?: string;
  revisionId?: string;
  body?: { content?: DocsStructuralElement[] };
  lists?: Record<string, { listProperties?: { nestingLevels?: { glyphType?: string; glyphSymbol?: string }[] } }>;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Only links a browser can follow safely. */
function safeUrl(url: string | undefined): string | null {
  if (!url) return null;
  return /^(https?:|mailto:)/i.test(url) ? url : null;
}

function link(href: string, inner: string): string {
  return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
}

function runHtml(content: string, style: DocsTextStyle = {}): string {
  // A paragraph's own trailing newline is structure, not text; \u000b is a soft line break.
  let html = esc(content.replace(/\n$/, "")).replace(/\u000b/g, "<br>");
  if (!html) return "";
  if (style.bold) html = `<strong>${html}</strong>`;
  if (style.italic) html = `<em>${html}</em>`;
  if (style.underline && !style.link) html = `<u>${html}</u>`;
  if (style.strikethrough) html = `<s>${html}</s>`;
  const href = safeUrl(style.link?.url);
  return href ? link(href, html) : html;
}

/** A paragraph's inline HTML, and whether it carried a horizontal rule. */
function inlineHtml(p: DocsParagraph): { html: string; rule: boolean } {
  let html = "";
  let rule = false;
  for (const el of p.elements ?? []) {
    if (el.textRun) html += runHtml(el.textRun.content ?? "", el.textRun.textStyle);
    else if (el.inlineObjectElement) html += "<em>[Image]</em>";
    else if (el.horizontalRule) rule = true;
    else if (el.footnoteReference) html += `<sup>${esc(el.footnoteReference.footnoteNumber ?? "")}</sup>`;
    else if (el.person) {
      const { name, email } = el.person.personProperties ?? {};
      const label = esc(name || email || "");
      html += email ? link(`mailto:${email}`, label) : label;
    } else if (el.richLink) {
      const { title, uri } = el.richLink.richLinkProperties ?? {};
      const href = safeUrl(uri);
      const label = esc(title || uri || "");
      html += href ? link(href, label) : label;
    } else if (el.equation) html += "<em>[Equation]</em>";
  }
  return { html, rule };
}

function headingTag(style: string | undefined): string {
  switch (style) {
    case "TITLE":
    case "HEADING_1":
      return "h1";
    case "SUBTITLE":
    case "HEADING_2":
      return "h2";
    case "HEADING_3":
    case "HEADING_4":
    case "HEADING_5":
    case "HEADING_6":
      return "h3";
    default:
      return "p";
  }
}

/** Numbered when the level has a glyph type and no bullet symbol. */
function isOrdered(doc: DocsDocument, listId: string | undefined, level: number): boolean {
  const lvl = listId ? doc.lists?.[listId]?.listProperties?.nestingLevels?.[level] : undefined;
  if (!lvl || lvl.glyphSymbol) return false;
  return Boolean(lvl.glyphType && lvl.glyphType !== "GLYPH_TYPE_UNSPECIFIED" && lvl.glyphType !== "NONE");
}

/** The plain text of structural elements, for table cells. */
function plainText(content: DocsStructuralElement[] | undefined): string {
  const parts: string[] = [];
  for (const el of content ?? []) {
    if (!el.paragraph) continue;
    const text = (el.paragraph.elements ?? [])
      .map((e) => e.textRun?.content ?? e.person?.personProperties?.name ?? e.richLink?.richLinkProperties?.title ?? "")
      .join("")
      .replace(/[\n\u000b]+/g, " ")
      .trim();
    if (text) parts.push(text);
  }
  return parts.join(" ");
}

export function docToHtml(doc: DocsDocument): string {
  const out: string[] = [];
  // Open lists, outermost first: one entry per nesting level.
  const stack: { tag: "ul" | "ol"; listId: string | undefined }[] = [];
  let liOpen = false;

  const closeTo = (depth: number) => {
    while (stack.length > depth) {
      if (liOpen) out.push("</li>");
      out.push(`</${stack.pop()!.tag}>`);
      liOpen = stack.length > 0;
    }
  };

  for (const el of doc.body?.content ?? []) {
    const p = el.paragraph;
    if (p?.bullet) {
      const level = Math.max(0, Math.min(8, p.bullet.nestingLevel ?? 0));
      const listId = p.bullet.listId;
      // A different list at the same top level starts a new list.
      if (stack.length > 0 && stack[0].listId !== listId) closeTo(0);
      if (stack.length > level + 1) closeTo(level + 1);
      while (stack.length < level + 1) {
        const tag = isOrdered(doc, listId, stack.length) ? "ol" : "ul";
        // A deeper level opens inside the current item; skipped levels get an empty item.
        if (stack.length > 0 && !liOpen) out.push("<li>");
        out.push(`<${tag}>`);
        stack.push({ tag, listId });
        liOpen = false;
      }
      if (liOpen) out.push("</li>");
      const { html } = inlineHtml(p);
      out.push(`<li><p>${html}</p>`);
      liOpen = true;
      continue;
    }

    closeTo(0);
    if (p) {
      const { html, rule } = inlineHtml(p);
      const tag = headingTag(p.paragraphStyle?.namedStyleType);
      if (html || tag !== "p") out.push(`<${tag}>${html}</${tag}>`);
      else if (!rule) out.push("<p></p>");
      if (rule) out.push("<hr>");
    } else if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        const cells = (row.tableCells ?? []).map((c) => esc(plainText(c.content)));
        out.push(`<p>${cells.join(" | ")}</p>`);
      }
    }
    // sectionBreak and tableOfContents carry no readable content of their own.
  }
  closeTo(0);
  return out.join("");
}
