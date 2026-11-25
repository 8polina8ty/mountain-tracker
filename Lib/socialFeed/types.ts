export const SOCIAL_FEED_PAGE_SIZE = 20;
export const SOCIAL_POST_MAX_BODY = 5000;
export const SOCIAL_COMMENT_MAX_BODY = 2000;
export const SOCIAL_POST_MAX_PHOTOS = 10;
export const SOCIAL_POST_MAX_BYTES = 10 * 1024 * 1024;

export type SocialVisibility = "public" | "friends" | "private";
export type SocialPostType = "note" | "photo" | "ascent" | "achievement" | "expedition" | "blog";

export type SocialAuthor = {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
};

export type SocialPostMedia = {
  id: string;
  postId: string;
  authorId: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  position: number;
};

export type SocialPost = {
  id: string;
  author: SocialAuthor;
  body: string;
  visibility: SocialVisibility;
  postType: SocialPostType;
  createdAt: string;
  updatedAt: string;
  likeCount: number;
  commentCount: number;
  viewerLiked: boolean;
  media: SocialPostMedia[];
  title?: string | null;
  publishedAt?: string | null;
  mountainAttachment?: { mountainId: number; mountainName: string } | null;
  linkedAscentId?: number | null;
  linkedAchievementId?: string | null;
  linkedProjectId?: string | null;
  ascentAttachment?: { mountainId: number; mountainName: string | null; height: number; climbedAt: string | null; countryCode: string | null; imageUrl: string | null } | null;
  achievementAttachment?: { achievementId: string; icon: string; unlockedAt: string | null } | null;
  expeditionAttachment?: { slug: string | null; title: string | null; available: boolean } | null;
};

export type SocialComment = {
  id: string;
  postId: string;
  author: SocialAuthor;
  body: string;
  createdAt: string;
};

export type SocialFeedCursor = { createdAt: string; postId: string } | null;
export type SocialFeedPage = { posts: SocialPost[]; nextCursor: SocialFeedCursor };
