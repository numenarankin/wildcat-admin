/**
 * The Git page's rows, mapped from GitHub's REST payloads. Pure, so the
 * mapping has a hand oracle; the reading is in `git.ts`.
 */

export const GIT_OWNER = "numenarankin";
export const GIT_REPO = "skynet";
/** The picker's merged view of every branch; the page's default. */
export const ALL_BRANCHES = "all";

export interface CommitRow {
  sha: string;
  /** First 7 characters of the SHA, as GitHub shows it. */
  shortSha: string;
  /** The message's first line. */
  title: string;
  /** The whole message. */
  message: string;
  /** GitHub login when the commit is linked to an account, else the git author name. */
  author: string;
  /** Author date, ISO. */
  at: string;
  url: string;
  /** In the all-branches view: every branch the commit is on, main first. */
  branches?: string[];
}

/** The fields of `GET /repos/{owner}/{repo}/commits` the page reads. */
export interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    author: { name: string; date: string } | null;
    committer: { name: string; date: string } | null;
  };
  author: { login: string } | null;
}

export const commitUrl = (sha: string) => `https://github.com/${GIT_OWNER}/${GIT_REPO}/commit/${sha}`;

export function toCommitRow(c: GitHubCommit): CommitRow {
  const message = c.commit.message.trimEnd();
  return {
    sha: c.sha,
    shortSha: c.sha.slice(0, 7),
    title: message.split("\n")[0],
    message,
    author: c.author?.login ?? c.commit.author?.name ?? c.commit.committer?.name ?? "",
    at: c.commit.author?.date ?? c.commit.committer?.date ?? "",
    url: commitUrl(c.sha),
  };
}

/** A file as GitHub's commit and compare payloads list it. */
export interface GitHubFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  previous_filename?: string;
  /** Absent for binary files and very large diffs. */
  patch?: string;
}

export interface GitHubCommitDetail extends GitHubCommit {
  stats?: { additions: number; deletions: number; total: number };
  files?: GitHubFile[];
}

export interface FileChange {
  path: string;
  /** added, removed, modified, renamed, copied, changed or unchanged. */
  status: string;
  additions: number;
  deletions: number;
  /** The path before a rename. */
  previousPath?: string;
  /** The unified diff, when GitHub sends one. */
  patch?: string;
}

export interface CommitDetail extends CommitRow {
  additions: number;
  deletions: number;
  files: FileChange[];
}

export function toFileChange(f: GitHubFile): FileChange {
  return {
    path: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    ...(f.previous_filename ? { previousPath: f.previous_filename } : {}),
    ...(f.patch !== undefined ? { patch: f.patch } : {}),
  };
}

export function toCommitDetail(c: GitHubCommitDetail): CommitDetail {
  return {
    ...toCommitRow(c),
    additions: c.stats?.additions ?? 0,
    deletions: c.stats?.deletions ?? 0,
    files: (c.files ?? []).map(toFileChange),
  };
}

/** The `rel="next"` URL of a GitHub `Link` header, or null on the last page. */
export function nextPageUrl(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Every branch's history as one list: each commit once, tagged with every
 * branch it is on, newest author date first. Branch order is kept in each tag.
 */
export function mergeBranchHistories(histories: { branch: string; commits: CommitRow[] }[]): CommitRow[] {
  const bySha = new Map<string, CommitRow & { branches: string[] }>();
  for (const { branch, commits } of histories) {
    for (const c of commits) {
      const seen = bySha.get(c.sha);
      if (seen) seen.branches.push(branch);
      else bySha.set(c.sha, { ...c, branches: [branch] });
    }
  }
  return [...bySha.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Whether a row matches the search box: message, author, SHA or branch, case-insensitive. */
export function matchesCommit(row: CommitRow, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return (
    row.message.toLowerCase().includes(needle) ||
    row.author.toLowerCase().includes(needle) ||
    row.sha.startsWith(needle) ||
    (row.branches ?? []).some((b) => b.toLowerCase().includes(needle))
  );
}
