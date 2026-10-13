import { FolderList } from "@/components/projects/folder-list";
import { PageContextSlice } from "@/components/ai/page-context-slice";
import { projectsListSlice } from "@/lib/ai/admin/page-slices";
import { NewProjectButton } from "@/components/projects/new-project-button";
import { requireAdminPage } from "@/lib/auth/platform-admin";
import { getAdminProjects } from "@/lib/admin/projects";
import { createAdminProject } from "@/lib/admin/project-actions";

export const metadata = { title: "Projects" };

/** The customer Projects page over `admin_projects`. */
export default async function AdminProjectsPage() {
  await requireAdminPage("projects");
  const projects = await getAdminProjects();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Projects
        </h1>
        <NewProjectButton create={createAdminProject} themed />
      </div>
      <PageContextSlice sliceKey="admin-projects" slice={projectsListSlice(projects)} />
      <FolderList folders={projects} basePath="/projects" />
    </div>
  );
}
