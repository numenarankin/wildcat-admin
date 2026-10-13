import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth/platform-admin";
import {
  getAdminProjectBySlug,
  getAdminProjectFiles,
  getAdminProjectNotes,
} from "@/lib/admin/projects";
import { getAdminTasks } from "@/lib/admin/tasks";
import { listPlatformAdmins } from "@/lib/admin/team";
import { getAdminConversations } from "@/lib/ai/admin/conversations";
import { getProfile } from "@/lib/settings/profile";
import { getSessionUser } from "@/lib/auth/session";
import { displayFirstName } from "@/lib/user";
import { AdminProjectWorkspace } from "@/components/admin/projects/admin-project-workspace";

export const metadata = { title: "Project" };

/** One admin project: the customer `/projects/[folder]` page over the admin tables. */
export default async function AdminProjectPage({
  params,
}: {
  params: Promise<{ project: string }>;
}) {
  await requireAdminPage("projects");
  const { project: slug } = await params;
  const project = await getAdminProjectBySlug(slug);
  if (!project) notFound();

  const [tasks, admins, conversations, notes, files, profile, user] = await Promise.all([
    getAdminTasks(project.id),
    listPlatformAdmins(),
    getAdminConversations(project.id),
    getAdminProjectNotes(project),
    getAdminProjectFiles(project.id),
    getProfile(),
    getSessionUser(),
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AdminProjectWorkspace
        projectId={project.id}
        projectName={project.name}
        tasks={tasks}
        // The admin roster is the assignee list, as on the admin task board.
        assignees={admins.map((a) => a.email)}
        orionConversations={conversations}
        firstName={displayFirstName(profile.name, user?.email)}
        notes={notes}
        files={files}
      />
    </div>
  );
}
