export type UnifiedNotificationKind = "social" | "expedition";
export type UnifiedNotification = {
  id: string;
  kind: UnifiedNotificationKind;
  type: string;
  postId: string | null;
  commentId: string | null;
  projectId: string | null;
  actorUsername: string | null;
  metadata: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
  canNavigate: boolean;
};
export type UnifiedPage = { items: UnifiedNotification[]; nextCursor: { createdAt: string; id: string } | null };
