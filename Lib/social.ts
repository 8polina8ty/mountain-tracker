export const SOCIAL_PAGE_SIZE = 20;
export const SOCIAL_SEARCH_MIN_LENGTH = 2;

export type RelationshipState =
  | "none"
  | "outgoing_pending"
  | "incoming_pending"
  | "friends"
  | "blocked_or_unavailable";

export type SocialUser = {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  relationshipState: RelationshipState;
  canSendRequest: boolean;
  canCancelRequest: boolean;
  canRespondToRequest: boolean;
  canRemoveFriend: boolean;
  canUnblock: boolean;
  requestId: string | null;
};

export type FriendRequest = {
  requestId: string;
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: string;
};

export function normalizeSocialUser(value: unknown): SocialUser | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const state = row.relationship_state;
  if (
    typeof row.user_id !== "string" ||
    typeof row.username !== "string" ||
    !["none", "outgoing_pending", "incoming_pending", "friends", "blocked_or_unavailable"].includes(String(state))
  ) return null;

  return {
    userId: row.user_id,
    username: row.username,
    displayName: typeof row.display_name === "string" ? row.display_name : null,
    avatarUrl: typeof row.avatar_url === "string" ? row.avatar_url : null,
    relationshipState: state as RelationshipState,
    canSendRequest: row.can_send_request === true,
    canCancelRequest: row.can_cancel_request === true,
    canRespondToRequest: row.can_respond_to_request === true,
    canRemoveFriend: row.can_remove_friend === true,
    canUnblock: row.can_unblock === true,
    requestId: typeof row.request_id === "string" ? row.request_id : null,
  };
}

export function normalizeFriendRequest(value: unknown): FriendRequest | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.request_id !== "string" || typeof row.user_id !== "string" || typeof row.username !== "string" || typeof row.created_at !== "string") return null;
  return {
    requestId: row.request_id,
    userId: row.user_id,
    username: row.username,
    displayName: typeof row.display_name === "string" ? row.display_name : null,
    avatarUrl: typeof row.avatar_url === "string" ? row.avatar_url : null,
    createdAt: row.created_at,
  };
}
