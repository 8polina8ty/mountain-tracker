import type { SupabaseClient } from "@supabase/supabase-js";

export const PROJECT_NOTIFICATION_PAGE_SIZE = 20;
export const PROJECT_NOTIFICATION_TYPES = ["invitation.received","invitation.accepted","member.role_changed","member.removed","member.left","project.status_changed","mountain.added","journal.created","track.linked","sharing.enabled","sharing.disabled"] as const;
export type ProjectNotificationType = typeof PROJECT_NOTIFICATION_TYPES[number];
export const PROJECT_NOTIFICATION_TRANSLATION_KEYS = {
  "invitation.received": "invitationReceived",
  "invitation.accepted": "invitationAccepted",
  "member.role_changed": "memberRoleChanged",
  "member.removed": "memberRemoved",
  "member.left": "memberLeft",
  "project.status_changed": "projectStatusChanged",
  "mountain.added": "mountainAdded",
  "journal.created": "journalCreated",
  "track.linked": "trackLinked",
  "sharing.enabled": "sharingEnabled",
  "sharing.disabled": "sharingDisabled",
} as const satisfies Record<ProjectNotificationType, string>;
export type ProjectNotificationCursor = { createdAt: string; id: string };
export type ProjectNotificationItem = { id:string; actorName:string|null; actorUsername:string|null; projectId:string|null; canNavigate:boolean; type:ProjectNotificationType; metadata:Record<string,unknown>; readAt:string|null; createdAt:string };
export type ProjectNotificationPage = { items:ProjectNotificationItem[]; nextCursor:ProjectNotificationCursor|null };

export async function listProjectNotifications(supabase:SupabaseClient,cursor:ProjectNotificationCursor|null=null,limit=PROJECT_NOTIFICATION_PAGE_SIZE):Promise<ProjectNotificationPage>{
  const bounded=Math.min(Math.max(Math.trunc(limit),1),50);
  let query=supabase.from("expedition_project_notifications").select("id,actor_user_id,project_id,notification_type,metadata,read_at,created_at").order("created_at",{ascending:false}).order("id",{ascending:false}).limit(bounded+1);
  if(cursor) query=query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
  const {data,error}=await query; if(error) throw error;
  const rows=(data??[]).slice(0,bounded);
  const actorIds=[...new Set(rows.flatMap(r=>typeof r.actor_user_id==="string"?[r.actor_user_id]:[]))];
  const projectIds=[...new Set(rows.flatMap(r=>typeof r.project_id==="string"?[r.project_id]:[]))];
  const [{data:profiles,error:profileError},{data:projects,error:projectError}]=await Promise.all([
    actorIds.length?supabase.from("profiles").select("id,username,display_name").in("id",actorIds):Promise.resolve({data:[],error:null}),
    projectIds.length?supabase.from("expedition_projects").select("id").in("id",projectIds):Promise.resolve({data:[],error:null}),
  ]);
  if(profileError) throw profileError; if(projectError) throw projectError;
  const profileById=new Map((profiles??[]).map(p=>[String(p.id),p])); const accessible=new Set((projects??[]).map(p=>String(p.id)));
  const items=rows.flatMap((r):ProjectNotificationItem[]=>{
    if(typeof r.id!=="string"||typeof r.notification_type!=="string"||!PROJECT_NOTIFICATION_TYPES.includes(r.notification_type as ProjectNotificationType)||typeof r.created_at!=="string") return [];
    const profile=typeof r.actor_user_id==="string"?profileById.get(r.actor_user_id):undefined;
    const projectId=typeof r.project_id==="string"?r.project_id:null;
    return [{id:r.id,actorName:typeof profile?.display_name==="string"?profile.display_name:null,actorUsername:typeof profile?.username==="string"?profile.username:null,projectId,canNavigate:projectId!==null&&accessible.has(projectId),type:r.notification_type as ProjectNotificationType,metadata:r.metadata&&typeof r.metadata==="object"&&!Array.isArray(r.metadata)?r.metadata as Record<string,unknown>:{},readAt:typeof r.read_at==="string"?r.read_at:null,createdAt:r.created_at}];
  });
  const last=items.at(-1); return {items,nextCursor:(data?.length??0)>bounded&&last?{createdAt:last.createdAt,id:last.id}:null};
}
