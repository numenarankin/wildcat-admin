/**
 * Knowledge-base types shared by the file tree and editor.
 *
 * Prototype scope: these describe the shape the UI renders against. The real
 * data source (Supabase / GitHub) gets wired up later.
 */

export type KBFileType =
  | "pdf"
  | "doc"
  | "md"
  | "transcript"
  | "note"
  | "url"
  | "image"
  | "las";

export interface KBFile {
  id: string;
  name: string;
  /** Full path within the folder, e.g. "geology/structure-map.md". */
  path: string;
  type: KBFileType;
  /** Owning folder id; "" means the repo root. */
  folder_id: string;
}

export interface KBFolder {
  id: string;
  name: string;
}

export interface KBTreeNode {
  folder: KBFolder;
  subfolders: KBTreeNode[];
  files: KBFile[];
}

/** A file in the company knowledge base, available to add to a project. */
export interface RepoFile extends KBFile {
  size: string;
  modified: string;
  /** When the file was added, ISO. `modified` is the display form; this sorts. */
  createdAt?: string | null;
  /** Pinned within its current folder (floats to the top). */
  pinned?: boolean;
  /**
   * Listed here because a domain row points at it (an invoice filed against
   * the well, a service entry's source, a run ticket's photo), not because it
   * was placed in this folder. It can be opened and downloaded; it cannot be
   * moved, pinned, renamed or deleted from here, since there is no placement
   * to act on. See `lib/files/attached-pure.ts`.
   */
  attached?: boolean;
}

/** A folder in the company knowledge base — may hold subfolders and files. */
export interface RepoFolder {
  id: string;
  name: string;
  folders: RepoFolder[];
  files: RepoFile[];
  modified: string;
}
