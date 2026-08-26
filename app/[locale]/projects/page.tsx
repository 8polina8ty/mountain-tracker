import { requireProjectUser } from "@/Lib/projects/auth";
import { listUserProjects } from "@/Lib/projects/queries";
import { listIncomingProjectInvitations, listSharedProjects } from "@/Lib/projects/collaboration";
import type { Locale } from "@/i18n/locales";
import ProjectsClient from "@/components/projects/ProjectsClient";

export default async function ProjectsPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  const { supabase, user } = await requireProjectUser(locale, "/projects");
  const [projects, invitations, sharedProjects] = await Promise.all([
    listUserProjects(supabase, user.id),
    listIncomingProjectInvitations(supabase),
    listSharedProjects(supabase),
  ]);
  const lifecycleOrder = { active: 0, ready: 0, planning: 1, completed: 2, archived: 3 } as const;
  const orderedProjects = [...projects].sort((a, b) => lifecycleOrder[a.status] - lifecycleOrder[b.status]);

  const statusTone: Record<string, "success" | "warning" | "info" | "neutral" | "danger"> = {
    active: "success",
    ready: "info",
    planning: "warning",
    completed: "neutral",
    archived: "neutral",
  };

  return (
    <ProjectsClient
      orderedProjects={orderedProjects}
      invitations={invitations}
      sharedProjects={sharedProjects}
      statusTone={statusTone}
    />
  );
}
