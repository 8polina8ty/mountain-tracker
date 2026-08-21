import type { SupabaseClient } from "@supabase/supabase-js";

export const PROJECT_MEMBER_ROLES = ["editor", "viewer"] as const;
export type ProjectMemberRole = (typeof PROJECT_MEMBER_ROLES)[number];
export type ProjectAccessRole = "owner" | ProjectMemberRole | "none";
export type ProjectIdentity = { userId: string; username: string; displayName: string | null; avatarUrl: string | null };
export type ProjectMember = ProjectIdentity & { id: string; role: ProjectMemberRole; createdAt: string };
export type ProjectInvitation = ProjectIdentity & { id: string; role: ProjectMemberRole; createdAt: string };
export type IncomingProjectInvitation = ProjectInvitation & { projectId: string; projectName: string; projectStatus: string };
export type SharedProjectSummary = { projectId: string; projectName: string; projectStatus: string; startDate: string | null; endDate: string | null; role: ProjectMemberRole; owner: ProjectIdentity; updatedAt: string };
export type ProjectTeam = { owner: ProjectIdentity | null; members: ProjectMember[]; invitations: ProjectInvitation[] };

export function canViewProject(role: ProjectAccessRole) { return role !== "none"; }
export function canEditProject(role: ProjectAccessRole) { return role === "owner" || role === "editor"; }
export function canManageProjectMembers(role: ProjectAccessRole) { return role === "owner"; }
export function canManageSharing(role: ProjectAccessRole) { return role === "owner"; }
export function canDeleteProject(role: ProjectAccessRole) { return role === "owner"; }
export function canChangeLifecycle(role: ProjectAccessRole, targetStatus: string) { return role === "owner" || (role === "editor" && targetStatus !== "archived"); }

function identity(row: Record<string, unknown>): ProjectIdentity | null {
  if (typeof row.user_id !== "string" || typeof row.username !== "string") return null;
  return { userId: row.user_id, username: row.username, displayName: typeof row.display_name === "string" ? row.display_name : null, avatarUrl: typeof row.avatar_url === "string" ? row.avatar_url : null };
}

export async function getProjectAccessRole(supabase: SupabaseClient, projectId: string): Promise<ProjectAccessRole> {
  const { data, error } = await supabase.rpc("get_expedition_project_access_role", { requested_project_id: projectId });
  if (error) throw error;
  return ["owner", "editor", "viewer"].includes(String(data)) ? data as ProjectAccessRole : "none";
}

export async function getOwnedProjectTeam(supabase: SupabaseClient, ownerId: string, projectId: string): Promise<ProjectTeam> {
  const [{ data: project, error: projectError }, { data: members, error: memberError }, { data: invitations, error: invitationError }] = await Promise.all([
    supabase.from("expedition_projects").select("user_id").eq("id", projectId).eq("user_id", ownerId).maybeSingle(),
    supabase.from("expedition_project_members").select("id,user_id,role,created_at").eq("project_id", projectId).order("created_at"),
    supabase.from("expedition_project_invitations").select("id,invitee_user_id,role,created_at").eq("project_id", projectId).eq("status", "pending").order("created_at"),
  ]);
  if (projectError || memberError || invitationError) throw projectError ?? memberError ?? invitationError;
  if (!project) return { owner: null, members: [], invitations: [] };
  const ids = [ownerId, ...(members ?? []).map((row) => String(row.user_id)), ...(invitations ?? []).map((row) => String(row.invitee_user_id))];
  const { data: profiles, error: profileError } = await supabase.from("profiles").select("id,username,display_name,avatar_url").in("id", [...new Set(ids)]);
  if (profileError) throw profileError;
  const byId = new Map((profiles ?? []).map((row) => [String(row.id), { user_id: row.id, ...row } as Record<string, unknown>]));
  const owner = identity(byId.get(ownerId) ?? {});
  return {
    owner,
    members: (members ?? []).flatMap((row) => { const user = identity(byId.get(String(row.user_id)) ?? {}); return user && PROJECT_MEMBER_ROLES.includes(row.role as ProjectMemberRole) ? [{ ...user, id: String(row.id), role: row.role as ProjectMemberRole, createdAt: String(row.created_at) }] : []; }),
    invitations: (invitations ?? []).flatMap((row) => { const user = identity(byId.get(String(row.invitee_user_id)) ?? {}); return user && PROJECT_MEMBER_ROLES.includes(row.role as ProjectMemberRole) ? [{ ...user, id: String(row.id), role: row.role as ProjectMemberRole, createdAt: String(row.created_at) }] : []; }),
  };
}

export async function listIncomingProjectInvitations(supabase: SupabaseClient): Promise<IncomingProjectInvitation[]> {
  const { data, error } = await supabase.rpc("list_incoming_expedition_project_invitations", { result_limit: 50 });
  if (error) throw error;
  return (data ?? []).flatMap((value: unknown) => { const row = value as Record<string, unknown>; const user = identity({ user_id: row.inviter_user_id, username: row.inviter_username, display_name: row.inviter_display_name, avatar_url: row.inviter_avatar_url }); return user && typeof row.invitation_id === "string" && typeof row.project_id === "string" && typeof row.project_name === "string" && PROJECT_MEMBER_ROLES.includes(row.role as ProjectMemberRole) ? [{ ...user, id: row.invitation_id, projectId: row.project_id, projectName: row.project_name, projectStatus: String(row.project_status), role: row.role as ProjectMemberRole, createdAt: String(row.created_at) }] : []; });
}

export async function listSharedProjects(supabase: SupabaseClient): Promise<SharedProjectSummary[]> {
  const { data, error } = await supabase.rpc("list_shared_expedition_projects", { result_limit: 50 });
  if (error) throw error;
  return (data ?? []).flatMap((value: unknown) => { const row = value as Record<string, unknown>; const owner = identity({ user_id: row.owner_user_id, username: row.owner_username, display_name: row.owner_display_name, avatar_url: row.owner_avatar_url }); return owner && typeof row.project_id === "string" && typeof row.project_name === "string" && PROJECT_MEMBER_ROLES.includes(row.role as ProjectMemberRole) ? [{ projectId: row.project_id, projectName: row.project_name, projectStatus: String(row.project_status), startDate: typeof row.start_date === "string" ? row.start_date : null, endDate: typeof row.end_date === "string" ? row.end_date : null, role: row.role as ProjectMemberRole, owner, updatedAt: String(row.updated_at) }] : []; });
}

export async function searchProjectParticipants(supabase: SupabaseClient, query: string): Promise<ProjectIdentity[]> {
  if (query.trim().length < 2) return [];
  const { data, error } = await supabase.rpc("search_public_users", { search_text: query.trim(), result_limit: 10, cursor_username: null, cursor_user_id: null });
  if (error) throw error;
  return (data ?? []).map((row: unknown) => identity(row as Record<string, unknown>)).filter((row: ProjectIdentity | null): row is ProjectIdentity => row !== null);
}

async function rpc(supabase: SupabaseClient, name: string, args: Record<string, unknown>) { const { error } = await supabase.rpc(name, args); return { ok: !error, code: error?.code ?? null }; }
export const inviteProjectMember = (s: SupabaseClient, projectId: string, userId: string, role: ProjectMemberRole) => rpc(s, "invite_expedition_project_member", { requested_project_id: projectId, requested_invitee_id: userId, requested_role: role });
export const acceptProjectInvitation = (s: SupabaseClient, id: string) => rpc(s, "accept_expedition_project_invitation", { invitation_id: id });
export const declineProjectInvitation = (s: SupabaseClient, id: string) => rpc(s, "decline_expedition_project_invitation", { invitation_id: id });
export const cancelProjectInvitation = (s: SupabaseClient, id: string) => rpc(s, "cancel_expedition_project_invitation", { invitation_id: id });
export const changeProjectMemberRole = (s: SupabaseClient, projectId: string, userId: string, role: ProjectMemberRole) => rpc(s, "change_expedition_project_member_role", { requested_project_id: projectId, requested_user_id: userId, requested_role: role });
export const removeProjectMember = (s: SupabaseClient, projectId: string, userId: string) => rpc(s, "remove_expedition_project_member", { requested_project_id: projectId, requested_user_id: userId });
export const leaveProject = (s: SupabaseClient, projectId: string) => rpc(s, "leave_expedition_project", { requested_project_id: projectId });
