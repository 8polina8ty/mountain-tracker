import type { SocialAuthor, SocialComment, SocialPost, SocialPostMedia } from "./types.ts";

function isUuid(v: unknown): boolean {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}
function stringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
export function normalizeSocialAuthor(value: unknown): SocialAuthor | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (typeof r.userId !== "string" && typeof r.author_id !== "string") return null;
  const userId = (r.userId ?? r.author_id) as string;
  const username = (r.username ?? r.user_name) as string;
  if (!isUuid(userId) || typeof username !== "string") return null;
  return {
    userId,
    username,
    displayName: stringOrNull(r.displayName ?? r.display_name),
    avatarUrl: stringOrNull(r.avatarUrl ?? r.avatar_url),
  };
}

export function normalizeSocialPostMedia(value: unknown): SocialPostMedia | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const id = r.id;
  const postId = r.post_id ?? r.postId;
  const authorId = r.author_id ?? r.authorId;
  if (!isUuid(String(id)) || !isUuid(String(postId)) || !isUuid(String(authorId))) return null;
  const mime = String(r.mime_type ?? r.mimeType ?? "");
  if (!["image/jpeg","image/png","image/webp"].includes(mime)) return null;
  const size = Number(r.size_bytes ?? r.sizeBytes);
  const pos = Number(r.position);
  if (!Number.isInteger(pos) || pos < 0 || pos >= 10) return null;
  return {
    id: String(id),
    postId: String(postId),
    authorId: String(authorId),
    mimeType: mime,
    sizeBytes: Number.isFinite(size) ? size : 0,
    width: typeof r.width === "number" ? r.width : null,
    height: typeof r.height === "number" ? r.height : null,
    position: pos,
  };
}

export function normalizeSocialPost(value: unknown): SocialPost | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const id = r.post_id ?? r.id;
  if (!isUuid(String(id))) return null;
  const authorId = r.author_id ?? r.authorId;
  const username = r.username;
  if (!isUuid(String(authorId)) || typeof username !== "string") return null;
  const visibility = r.visibility;
  if (!["public","friends","private"].includes(String(visibility))) return null;
  const body = typeof r.body === "string" ? r.body : "";
  if ([...body].length > (r.post_type === "blog" || r.postType === "blog" ? 20000 : 5000)) return null;
  const createdAt = r.created_at ?? r.createdAt;
  if (typeof createdAt !== "string") return null;
  const mediaRaw = Array.isArray(r.media) ? r.media : [];
  const media = mediaRaw.map(normalizeSocialPostMedia).filter((m): m is SocialPostMedia => m !== null).sort((a,b)=>a.position-b.position);
  return {
    id: String(id),
    author: {
      userId: String(authorId),
      username: String(username),
      displayName: stringOrNull(r.display_name ?? r.displayName),
      avatarUrl: stringOrNull(r.avatar_url ?? r.avatarUrl),
    },
    body,
    title: stringOrNull(r.title),
    publishedAt: stringOrNull(r.published_at),
    mountainAttachment: r.mountain_attachment as SocialPost["mountainAttachment"] ?? null,
    visibility: String(visibility) as SocialPost["visibility"],
    postType: String(r.post_type ?? r.postType ?? "note") as SocialPost["postType"],
    createdAt: String(createdAt),
    updatedAt: String(r.updated_at ?? r.updatedAt ?? createdAt),
    likeCount: Number(r.like_count ?? r.likeCount ?? 0),
    commentCount: Number(r.comment_count ?? r.commentCount ?? 0),
    viewerLiked: r.viewer_liked === true || r.viewerLiked === true,
    media,
    linkedAscentId: typeof r.linked_ascent_id === "number" ? r.linked_ascent_id : null,
    linkedAchievementId: typeof r.linked_achievement_id === "string" ? r.linked_achievement_id : null,
    linkedProjectId: typeof r.linked_project_id === "string" ? r.linked_project_id : null,
    ascentAttachment: r.ascent_attachment as SocialPost["ascentAttachment"] ?? null,
    achievementAttachment: r.achievement_attachment as SocialPost["achievementAttachment"] ?? null,
    expeditionAttachment: r.expedition_attachment as SocialPost["expeditionAttachment"] ?? null,
  };
}

export function normalizeSocialComment(value: unknown): SocialComment | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const id = r.comment_id ?? r.id;
  if (!isUuid(String(id))) return null;
  const body = r.body;
  if (typeof body !== "string" || body.trim().length === 0 || body.trim().length > 2000) return null;
  const authorId = r.author_id ?? r.authorId;
  if (!isUuid(String(authorId)) || typeof r.username !== "string") return null;
  return {
    id: String(id),
    postId: String(r.post_id ?? r.postId),
    author: {
      userId: String(authorId),
      username: String(r.username),
      displayName: stringOrNull(r.display_name ?? r.displayName),
      avatarUrl: stringOrNull(r.avatar_url ?? r.avatarUrl),
    },
    body: String(body),
    createdAt: String(r.created_at ?? r.createdAt),
  };
}
