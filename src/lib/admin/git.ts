import "server-only";
import { isPlatformAdmin } from "@/lib/auth/platform-admin";
import {
  GIT_OWNER,
  GIT_REPO,
  mergeBranchHistories,
  nextPageUrl,
  toCommitDetail,
  toCommitRow,
  toFileChange,
  type CommitDetail,
  type CommitRow,
  type FileChange,
  type GitHubCommit,
  type GitHubCommitDetail,
  type GitHubFile,
} from "./git-rows";

/**
 * The app's commit history, read from the GitHub REST API: a Vercel
 * deployment has no `.git` to run `git log` against. Needs `GITHUB_TOKEN`, a
 * fine-grained token on numenarankin/skynet with Contents + Metadata read.
 * Every read is gated on `isPlatformAdmin()` first, like the other admin
 * readers, so the admin Orion's git tools refuse anyone else.
 * Plan: docs/plans/admin-git-page.md.
 */

const API = `https://api.github.com/repos/${GIT_OWNER}/${GIT_REPO}`;
/** A new push shows within this many seconds. */
const REVALIDATE_S = 300;
/** A runaway guard, far above today's ~320 commits. */
const MAX_PAGES = 200;

export class GitHubNotConfiguredError extends Error {
  constructor() {
    super("GITHUB_TOKEN is not set");
  }
}

function headers(): HeadersInit {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new GitHubNotConfiguredError();
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function get(url: string): Promise<Response> {
  if (!(await isPlatformAdmin())) throw new Error("Platform admin required.");
  const res = await fetch(url, { headers: headers(), next: { revalidate: REVALIDATE_S, tags: ["github-commits"] } });
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${url.replace(API, "")}: ${await res.text()}`);
  return res;
}

/** Every branch name, `main` first, the rest alphabetical. */
export async function listBranches(): Promise<string[]> {
  const names: string[] = [];
  let url: string | null = `${API}/branches?per_page=100`;
  for (let i = 0; url && i < MAX_PAGES; i++) {
    const res = await get(url);
    names.push(...((await res.json()) as { name: string }[]).map((b) => b.name));
    url = nextPageUrl(res.headers.get("link"));
  }
  return names.sort((a, b) => (a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b)));
}

/** The branch's whole history, newest first, exactly as GitHub's commit list orders it. */
export async function listCommits(branch: string): Promise<CommitRow[]> {
  const rows: CommitRow[] = [];
  let url: string | null = `${API}/commits?sha=${encodeURIComponent(branch)}&per_page=100`;
  for (let i = 0; url && i < MAX_PAGES; i++) {
    const res = await get(url);
    rows.push(...((await res.json()) as GitHubCommit[]).map(toCommitRow));
    url = nextPageUrl(res.headers.get("link"));
  }
  return rows;
}

/** Every branch's history merged (`mergeBranchHistories`), branches read in `branches` order. */
export async function listAllCommits(branches: string[]): Promise<CommitRow[]> {
  const histories = await Promise.all(branches.map(async (branch) => ({ branch, commits: await listCommits(branch) })));
  return mergeBranchHistories(histories);
}

/** GitHub's file cap for one commit, across its file pages. */
export const COMMIT_FILE_CAP = 3_000;
/** GitHub's file cap for a comparison: one page, no more. */
export const COMPARE_FILE_CAP = 300;

/**
 * One commit: message, author, line totals and every file it touched with its
 * patch. GitHub pages a commit's files 300 at a time (up to 3,000), each page
 * repeating the commit, so the pages are followed and only the files joined.
 */
export async function getCommit(ref: string): Promise<CommitDetail & { filesComplete: boolean }> {
  let res = await get(`${API}/commits/${encodeURIComponent(ref)}`);
  const first = (await res.json()) as GitHubCommitDetail;
  const files = [...(first.files ?? [])];
  let url = nextPageUrl(res.headers.get("link"));
  for (let i = 0; url && i < MAX_PAGES; i++) {
    res = await get(url);
    files.push(...(((await res.json()) as GitHubCommitDetail).files ?? []));
    url = nextPageUrl(res.headers.get("link"));
  }
  return { ...toCommitDetail({ ...first, files }), filesComplete: files.length < COMMIT_FILE_CAP };
}

export interface BranchComparison {
  base: string;
  head: string;
  /** GitHub's word: ahead, behind, diverged or identical. */
  status: string;
  aheadBy: number;
  behindBy: number;
  /** The commits on head and not on base, newest first. GitHub returns at most 250. */
  commits: CommitRow[];
  /** False when head is more commits ahead than GitHub listed. */
  commitsComplete: boolean;
  /** The files that differ between the merge base and head. GitHub returns at most 300. */
  files: FileChange[];
  /** False when GitHub hit its 300-file cap: more files differ than are listed, how many is unknown. */
  filesComplete: boolean;
}

/** What `head` has that `base` does not (`base...head`, three dots: from their merge base). */
export async function compareBranches(base: string, head: string): Promise<BranchComparison> {
  const res = await get(`${API}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
  const body = (await res.json()) as {
    status: string;
    ahead_by: number;
    behind_by: number;
    commits: GitHubCommit[];
    files?: GitHubFile[];
  };
  return {
    base,
    head,
    status: body.status,
    aheadBy: body.ahead_by,
    behindBy: body.behind_by,
    // GitHub lists compare commits oldest first; the page and the tools read newest first.
    commits: body.commits.map(toCommitRow).reverse(),
    commitsComplete: body.commits.length >= body.ahead_by,
    files: (body.files ?? []).map(toFileChange),
    filesComplete: (body.files ?? []).length < COMPARE_FILE_CAP,
  };
}
