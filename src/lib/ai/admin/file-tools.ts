import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import { buildFile, fileName, type FileInput } from "@/lib/admin/orion-file-build";
import type { OrionFile } from "@/lib/ai/file-spec";

/**
 * `create_file`: Orion writes a file the user can view or download from the
 * chat. Built on the server, stored in the private `admin-files` bucket under
 * `orion/<uuid>/`, and returned as an `OrionFile` the chat renders as a card.
 * Not behind approval: it changes nothing anyone else sees, the way an answer
 * does not.
 */

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const sheet = z.object({
  name: z.string().optional().describe("Sheet name (xlsx)."),
  columns: z.array(z.string()).min(1),
  rows: z.array(z.array(cell)).describe("One array per row, cells in column order. Numbers as numbers, not formatted strings."),
});

export function fileTools() {
  return {
    create_file: tool({
      description:
        "Write a file the user can view in the chat or download: csv or xlsx (Excel) for tables, pdf for a finished report or document to share or print, md (Markdown), txt, json, or html. " +
        "Tables go in sheets (csv takes exactly one; xlsx takes one or more, one per tab); the other formats take content. A pdf's content is Markdown (headings, paragraphs, bold/italic, lists, tables, code blocks, quotes, rules), laid out on US Letter with page numbers; Latin text only, other characters print as ?. " +
        "Put every row in the file: build it from tool results (db_query, list_customers and the rest), never from memory, and never trim rows to save space. " +
        "Then tell the user in one line what the file holds; the card with View and Download appears on its own.",
      inputSchema: z.object({
        filename: z.string().min(1).describe("Name without a path, e.g. customers-oct-2026. The extension follows the format."),
        format: z.enum(["csv", "xlsx", "pdf", "md", "txt", "json", "html"]),
        sheets: z.array(sheet).optional().describe("csv / xlsx only."),
        content: z.string().optional().describe("pdf (as Markdown) / md / txt / json / html only."),
      }),
      execute: async ({ filename, format, sheets, content }) => {
        if (!(await isPlatformAdmin())) throw new Error("Platform admin required.");
        let input: FileInput;
        if (format === "csv" || format === "xlsx") {
          if (!sheets?.length) return { ok: false as const, error: `${format} needs sheets (columns + rows).` };
          input = { format, sheets };
        } else {
          if (content === undefined) return { ok: false as const, error: `${format} needs content.` };
          input = format === "pdf" ? { format, content, title: filename } : { format, content };
        }
        let built;
        try {
          built = await buildFile(input);
        } catch (err) {
          return { ok: false as const, error: err instanceof Error ? err.message : "Could not build the file." };
        }
        const name = fileName(filename, format);
        const path = `orion/${crypto.randomUUID()}/${name}`;
        const { error } = await getSupabaseAdmin()
          .storage.from("admin-files")
          .upload(path, built.bytes, { contentType: built.mediaType, upsert: false });
        if (error) return { ok: false as const, error: `Could not save the file: ${error.message}` };
        const file: OrionFile = { path, filename: name, format, sizeBytes: built.bytes.byteLength };
        return { ok: true as const, file };
      },
    }),
  };
}
