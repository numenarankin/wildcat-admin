import { marked, type Token, type Tokens } from "marked";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

/**
 * Markdown to PDF for Orion's `create_file`: headings, paragraphs with bold,
 * italic, code and links, bulleted and numbered lists (nested), tables,
 * code blocks, block quotes and rules, on US Letter with page numbers.
 *
 * The standard PDF fonts (Helvetica, Courier) cover Latin text and common
 * punctuation (WinAnsi). A character outside that set (an emoji, CJK) prints
 * as "?" rather than failing the whole file.
 */

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BODY = 10.5;
const LEAD = 1.4;
const TEXT = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.46);
const RULE = rgb(0.82, 0.82, 0.85);
const SHADE = rgb(0.95, 0.95, 0.96);
const HEADING_SIZE: Record<number, number> = { 1: 20, 2: 15.5, 3: 13, 4: 11.5, 5: 11, 6: 10.5 };

const ASCII_FALLBACK: Record<string, string> = {
  "\u2192": "->", "\u2190": "<-", "\u2194": "<->", "\u21d2": "=>", "\u2191": "^", "\u2193": "v",
  "\u2264": "<=", "\u2265": ">=", "\u2260": "!=", "\u2248": "~", "\u2212": "-",
  "\u2713": "x", "\u2714": "x", "\u2717": "-", "\u2718": "-", "\u2022": "\u2022",
  "\u00a0": " ", "\u2009": " ", "\u202f": " ",
};

interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  mono?: boolean;
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
  mono: PDFFont;
}

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Inline tokens flattened into styled runs. */
function runsOf(tokens: Token[] | undefined, style: Omit<Run, "text"> = {}): Run[] {
  const out: Run[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "strong":
        out.push(...runsOf((t as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case "em":
        out.push(...runsOf((t as Tokens.Em).tokens, { ...style, italic: true }));
        break;
      case "codespan":
        out.push({ ...style, mono: true, text: decode((t as Tokens.Codespan).text) });
        break;
      case "link": {
        const l = t as Tokens.Link;
        out.push(...runsOf(l.tokens, style));
        const label = l.tokens?.map((x) => ("text" in x ? x.text : "")).join("") ?? "";
        if (l.href && l.href !== label) out.push({ ...style, text: ` (${l.href})` });
        break;
      }
      case "br":
        out.push({ ...style, text: "\n" });
        break;
      case "text": {
        const tx = t as Tokens.Text;
        if (tx.tokens?.length) out.push(...runsOf(tx.tokens, style));
        else out.push({ ...style, text: decode(tx.text) });
        break;
      }
      case "escape":
        out.push({ ...style, text: decode((t as Tokens.Escape).text) });
        break;
      default:
        if ("text" in t && typeof t.text === "string") out.push({ ...style, text: decode(t.text) });
    }
  }
  return out;
}

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(
    private doc: PDFDocument,
    private fonts: Fonts,
    private charset: Set<number>
  ) {
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
  }

  ensure(height: number) {
    if (this.y - height < MARGIN) this.newPage();
  }

  font(r: Omit<Run, "text">): PDFFont {
    if (r.mono) return this.fonts.mono;
    if (r.bold && r.italic) return this.fonts.boldItalic;
    if (r.bold) return this.fonts.bold;
    if (r.italic) return this.fonts.italic;
    return this.fonts.regular;
  }

  /**
   * Characters the standard fonts cannot draw: common symbols spelled out in
   * ASCII, anything else as "?".
   */
  clean(s: string): string {
    let out = "";
    for (const ch of s.replace(/\t/g, "    ")) {
      if (ch === "\n" || this.charset.has(ch.codePointAt(0)!)) out += ch;
      else out += ASCII_FALLBACK[ch] ?? "?";
    }
    return out;
  }

  /** Wrap runs into lines of (run piece) arrays no wider than `width`. */
  wrap(runs: Run[], size: number, width: number): Run[][] {
    const lines: Run[][] = [[]];
    let lineW = 0;
    for (const r of runs) {
      const f = this.font(r);
      for (const piece of this.clean(r.text).split(/(\s+)/)) {
        if (!piece) continue;
        if (piece.includes("\n")) {
          for (let i = 0; i < (piece.match(/\n/g) ?? []).length; i++) lines.push([]);
          lineW = 0;
          continue;
        }
        const isSpace = /^\s+$/.test(piece);
        const text = isSpace ? " " : piece;
        let w = f.widthOfTextAtSize(text, size);
        if (isSpace && lineW === 0) continue;
        if (!isSpace && lineW + w > width && lineW > 0) {
          lines.push([]);
          lineW = 0;
        }
        // A single word wider than the line is broken by characters.
        let rest = text;
        while (!isSpace && w > width) {
          let n = rest.length;
          while (n > 1 && f.widthOfTextAtSize(rest.slice(0, n), size) > width - lineW) n--;
          lines[lines.length - 1].push({ ...r, text: rest.slice(0, n) });
          lines.push([]);
          lineW = 0;
          rest = rest.slice(n);
          w = f.widthOfTextAtSize(rest, size);
        }
        if (!rest) continue;
        lines[lines.length - 1].push({ ...r, text: rest });
        lineW += w;
      }
    }
    // Trailing spaces would push right-aligned measurements; drop them.
    for (const l of lines) while (l.length && /^\s+$/.test(l[l.length - 1].text)) l.pop();
    return lines;
  }

  /** Draw wrapped runs at x, advancing y. */
  paragraph(runs: Run[], opts: { size?: number; x?: number; width?: number; color?: ReturnType<typeof rgb>; after?: number } = {}) {
    const size = opts.size ?? BODY;
    const x = opts.x ?? MARGIN;
    const width = opts.width ?? CONTENT_W - (x - MARGIN);
    const lh = size * LEAD;
    for (const line of this.wrap(runs, size, width)) {
      this.ensure(lh);
      let cx = x;
      for (const r of line) {
        const f = this.font(r);
        this.page.drawText(r.text, { x: cx, y: this.y - size, size, font: f, color: opts.color ?? TEXT });
        cx += f.widthOfTextAtSize(r.text, size);
      }
      this.y -= lh;
    }
    this.y -= opts.after ?? size * 0.6;
  }

  rule() {
    this.ensure(12);
    this.y -= 4;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 0.75, color: RULE });
    this.y -= 10;
  }

  code(text: string) {
    const size = 9;
    const lh = size * 1.35;
    const lines = this.wrap([{ text, mono: true }], size, CONTENT_W - 16);
    for (const line of lines) {
      this.ensure(lh + 4);
      this.page.drawRectangle({ x: MARGIN, y: this.y - lh - 2, width: CONTENT_W, height: lh + 2, color: SHADE });
      this.page.drawText(line.map((r) => r.text).join(""), { x: MARGIN + 8, y: this.y - size - 1, size, font: this.fonts.mono, color: TEXT });
      this.y -= lh;
    }
    this.y -= 8;
  }

  table(t: Tokens.Table) {
    const size = 9;
    const lh = size * 1.35;
    const pad = 4;
    const header = t.header.map((c) => runsOf(c.tokens, { bold: true }));
    const rows = t.rows.map((r) => r.map((c) => runsOf(c.tokens)));
    const n = header.length;
    // Columns share the width in proportion to their longest cell, with a floor.
    const natural = header.map((h, i) =>
      Math.max(
        ...[h, ...rows.map((r) => r[i] ?? [])].map((cell) =>
          cell.reduce((w, r) => w + this.font(r).widthOfTextAtSize(this.clean(r.text), size), 0)
        ),
        20
      )
    );
    const total = natural.reduce((a, b) => a + b, 0);
    const widths = natural.map((w) => Math.max(36, (w / total) * CONTENT_W));
    const scale = CONTENT_W / widths.reduce((a, b) => a + b, 0);
    for (let i = 0; i < n; i++) widths[i] *= scale;

    const drawRow = (cells: Run[][], shaded: boolean) => {
      const wrapped = cells.map((c, i) => this.wrap(c, size, widths[i] - pad * 2));
      const h = Math.max(1, ...wrapped.map((w) => w.length)) * lh + pad * 2;
      if (this.y - h < MARGIN) {
        this.newPage();
        if (!shaded) drawRow(header, true);
      }
      let x = MARGIN;
      wrapped.forEach((lines, i) => {
        this.page.drawRectangle({
          x, y: this.y - h, width: widths[i], height: h,
          color: shaded ? SHADE : undefined, borderColor: RULE, borderWidth: 0.5,
        });
        lines.forEach((line, li) => {
          const lineW = line.reduce((w, r) => w + this.font(r).widthOfTextAtSize(r.text, size), 0);
          const align = t.align[i];
          let cx =
            align === "right" ? x + widths[i] - pad - lineW : align === "center" ? x + (widths[i] - lineW) / 2 : x + pad;
          for (const r of line) {
            const f = this.font(r);
            this.page.drawText(r.text, { x: cx, y: this.y - pad - size - li * lh, size, font: f, color: TEXT });
            cx += f.widthOfTextAtSize(r.text, size);
          }
        });
        x += widths[i];
      });
      this.y -= h;
    };
    this.ensure(lh * 2 + pad * 4);
    drawRow(header, true);
    for (const r of rows) drawRow(Array.from({ length: n }, (_, i) => r[i] ?? []), false);
    this.y -= 10;
  }

  blocks(tokens: Token[], indent = 0) {
    for (const t of tokens) {
      const x = MARGIN + indent;
      switch (t.type) {
        case "heading": {
          const h = t as Tokens.Heading;
          const size = HEADING_SIZE[h.depth] ?? BODY;
          this.y -= size * 0.5;
          this.ensure(size * LEAD * 2);
          this.paragraph(runsOf(h.tokens, { bold: true }), { size, x, after: size * 0.35 });
          break;
        }
        case "paragraph":
          this.paragraph(runsOf((t as Tokens.Paragraph).tokens), { x });
          break;
        case "list": {
          const l = t as Tokens.List;
          l.items.forEach((item, i) => {
            const marker = l.ordered ? `${(Number(l.start) || 1) + i}.` : "•";
            const markerW = 16;
            this.ensure(BODY * LEAD);
            this.page.drawText(marker, { x, y: this.y - BODY, size: BODY, font: this.fonts.regular, color: TEXT });
            const startY = this.y;
            const inner = item.tokens.filter((c) => c.type !== "list");
            const runs = inner.flatMap((c) => runsOf("tokens" in c ? (c.tokens as Token[]) : [c]));
            this.paragraph(runs, { x: x + markerW, after: BODY * 0.2 });
            if (this.y > startY) this.y = startY - BODY * LEAD;
            const nested = item.tokens.filter((c) => c.type === "list");
            if (nested.length) this.blocks(nested, indent + markerW);
          });
          // A nested list runs straight on into its parent's next item.
          if (indent === 0) this.y -= BODY * 0.4;
          break;
        }
        case "table":
          this.table(t as Tokens.Table);
          break;
        case "code":
          this.code((t as Tokens.Code).text);
          break;
        case "blockquote": {
          const top = this.y;
          const page = this.page;
          this.blocks((t as Tokens.Blockquote).tokens, indent + 14);
          if (this.page === page) {
            page.drawLine({ start: { x: x + 3, y: top }, end: { x: x + 3, y: this.y + 6 }, thickness: 2, color: RULE });
          }
          break;
        }
        case "hr":
          this.rule();
          break;
        case "space":
          break;
        default:
          if ("text" in t && typeof t.text === "string" && t.text.trim()) this.paragraph([{ text: decode(t.text) }], { x });
      }
    }
  }
}

export async function buildPdf(markdown: string, title?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
  if (title) doc.setTitle(title);
  doc.setCreator("Wildcat Orion");
  const charset = new Set([...fonts.regular.getCharacterSet(), 32]);
  const w = new Writer(doc, fonts, charset);
  w.blocks(marked.lexer(markdown));

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = `${i + 1} / ${pages.length}`;
    const size = 8.5;
    p.drawText(label, {
      x: PAGE_W - MARGIN - fonts.regular.widthOfTextAtSize(label, size),
      y: MARGIN / 2,
      size,
      font: fonts.regular,
      color: MUTED,
    });
  });
  return doc.save();
}
