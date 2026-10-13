/**
 * Drive API v3 files as Drive browser rows. Pure, so it is tested directly.
 * Plan: docs/plans/google-integration.md section 7.4 (read only for now).
 */

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const DOC_MIME = "application/vnd.google-apps.document";

/** The `fields` every listing asks for, and nothing more. */
export const FILE_FIELDS = "id,name,mimeType,modifiedTime,size,webViewLink,parents";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  /** Bytes as a string; absent on Google-native files and folders. */
  size?: string;
  webViewLink?: string;
  parents?: string[];
}

export type DriveKind = "folder" | "doc" | "sheet" | "slides" | "pdf" | "image" | "file";

export interface DriveRow {
  id: string;
  name: string;
  kind: DriveKind;
  /** Column text: "Folder", "Doc", "PDF", or the file's extension. */
  type: string;
  size: string;
  modified: string;
  webViewLink: string | null;
  /** Whether Download can fetch it (Google forms, sites and maps cannot be exported). */
  downloadable: boolean;
}

/** Google-native types and what Download exports them as. */
export const EXPORTS: Record<string, { mimeType: string; ext: string }> = {
  [DOC_MIME]: {
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ext: "docx",
  },
  "application/vnd.google-apps.spreadsheet": {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: "xlsx",
  },
  "application/vnd.google-apps.presentation": {
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ext: "pptx",
  },
  "application/vnd.google-apps.drawing": { mimeType: "application/pdf", ext: "pdf" },
};

function kindOf(mime: string): DriveKind {
  if (mime === FOLDER_MIME) return "folder";
  if (mime === DOC_MIME) return "doc";
  if (mime === "application/vnd.google-apps.spreadsheet") return "sheet";
  if (mime === "application/vnd.google-apps.presentation") return "slides";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  return "file";
}

const TYPE_LABEL: Partial<Record<DriveKind, string>> = {
  folder: "Folder",
  doc: "Doc",
  sheet: "Sheet",
  slides: "Slides",
  pdf: "PDF",
};

function typeLabel(file: DriveFile, kind: DriveKind): string {
  const label = TYPE_LABEL[kind];
  if (label) return label;
  const dot = file.name.lastIndexOf(".");
  return dot > 0 && dot < file.name.length - 1 ? file.name.slice(dot + 1).toUpperCase() : "File";
}

/** Same shape as the KB browser's size column (`lib/kb/files.ts`). */
export function formatSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const rounded = value < 10 && i > 0 ? value.toFixed(1) : String(Math.round(value));
  return `${rounded} ${units[i]}`;
}

// Fixed zone for the same reason as the admin customers table: this server-renders.
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  year: "numeric",
  timeZone: "America/Chicago",
});

export function formatModified(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : dateFormatter.format(d);
}

export function isDownloadable(mime: string): boolean {
  if (mime === FOLDER_MIME) return false;
  return !mime.startsWith("application/vnd.google-apps.") || mime in EXPORTS;
}

export function toDriveRow(file: DriveFile): DriveRow {
  const kind = kindOf(file.mimeType);
  return {
    id: file.id,
    name: file.name,
    kind,
    type: typeLabel(file, kind),
    size: formatSize(file.size ? Number(file.size) : null),
    modified: formatModified(file.modifiedTime),
    webViewLink: file.webViewLink ?? null,
    downloadable: isDownloadable(file.mimeType),
  };
}

/** Drive file ids are URL-safe tokens; "root" is My Drive. */
export function isDriveId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,200}$/.test(id);
}

/** A Drive `q` string literal: backslash and single quote escaped, per the search guide. */
export function qLiteral(text: string): string {
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** A download's file name: Google-native files get their export extension. */
export function downloadName(file: Pick<DriveFile, "name" | "mimeType">): string {
  const ex = EXPORTS[file.mimeType];
  return ex ? `${file.name}.${ex.ext}` : file.name;
}
