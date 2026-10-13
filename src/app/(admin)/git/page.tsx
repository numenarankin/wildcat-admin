import { requireAdminPage } from "@/lib/auth/platform-admin";
import { GitHubNotConfiguredError, listAllCommits, listBranches, listCommits } from "@/lib/admin/git";
import { ALL_BRANCHES } from "@/lib/admin/git-rows";
import { GitWorkspace } from "@/components/admin/git/git-workspace";

export const metadata = { title: "Git" };

/**
 * The app's full commit history: every branch merged (the default), or one
 * branch (`?branch=`), read from GitHub (`lib/admin/git.ts`). Plan: docs/plans/admin-git-page.md.
 */
export default async function AdminGitPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage("git");
  const asked = (await searchParams).branch;
  const data = await readHistory(typeof asked === "string" ? asked : undefined);
  // The one failure worth naming: no token configured.
  if (!data) return <GitWorkspace branch={ALL_BRANCHES} branches={[]} commits={[]} notConfigured />;
  return <GitWorkspace {...data} />;
}

/** The branches and the chosen branch's commits; null when GitHub is not configured. */
async function readHistory(asked: string | undefined) {
  try {
    const branches = await listBranches();
    // An unknown branch in the URL reads every branch rather than failing the page.
    const branch = asked && branches.includes(asked) ? asked : ALL_BRANCHES;
    const commits = branch === ALL_BRANCHES ? await listAllCommits(branches) : await listCommits(branch);
    return { branch, branches, commits };
  } catch (err) {
    if (err instanceof GitHubNotConfiguredError) return null;
    throw err;
  }
}
