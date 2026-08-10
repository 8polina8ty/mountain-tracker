"use client";

import {useEffect, useState, type ChangeEvent,} from "react";
import type { User } from "@supabase/supabase-js";

import { createClient } from "@/Lib/supabase/client";
import {
  ACHIEVEMENT_DEFINITIONS_BY_ID,
  buildAchievements,
  getEarnedAchievementIds,
  type AchievementView,
} from "@/Lib/achievements";
import {
  loadUserAchievements,
  syncUserAchievements,
  type UserAchievementRecord,
} from "@/Lib/achievementService";
import { useAchievementNotification } from "@/components/achievements/AchievementNotificationProvider";
import type React from "react";
import { useTranslations } from "next-intl";

export type Mountain = {
  id: number;
  name: string | null;
  name_de: string | null;
  height: number;

  wikidata: string | null;
  country_code: string | null;
  latitude: number;
  longitude: number;
};

export type Ascent = {
  id: number;
  climbed_at: string | null;
  created_at: string;
  mountains: Mountain;
  image_url: string | null;
  is_photo_public: boolean;
};

type FavoriteMountainDatabaseRow = {
  id: number;
  created_at: string;
  mountains: Mountain[] | Mountain | null;
};

export type FavoriteMountain = {
  id: number;
  created_at: string;
  mountain: Mountain;
};


type UseAccountResult = {
  user: User | null;
  loading: boolean;
  errorMessage: string;

  avatarUrl: string | null;
  avatarUploading: boolean;
  avatarMessage: string;
  handleAvatarUpload: (
    event: ChangeEvent<HTMLInputElement>,
  ) => Promise<void>;

  username: string;

  ascents: Ascent[];
  favoriteMountains: FavoriteMountain[];
  achievements: AchievementView[];

  highestMountain: Mountain | null;
  averageHeight: number;
  latestAscent: Ascent | null;

  unlockedAchievementsCount: number;
  totalMountains: number;
  progressPercent: number;

  getMountainName: (
    mountain: Mountain | null,
  ) => string;

};

export function useAccount(): UseAccountResult {
  const t = useTranslations("Account.Status");
  const {
  showAchievementNotification,
} = useAchievementNotification();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarMessage, setAvatarMessage] = useState("");

  const [ascents, setAscents] = useState<Ascent[]>([]);
  const [favoriteMountains, setFavoriteMountains] =
  useState<FavoriteMountain[]>([]);
  const [userAchievements, setUserAchievements] =
    useState<UserAchievementRecord[]>([]);

  const totalHeight = ascents.reduce(
    (sum, ascent) =>
      sum + Number(ascent.mountains?.height ?? 0),
    0,
  );

  const hasMountainAbove2000 = ascents.some(
    (ascent) =>
      Number(ascent.mountains?.height ?? 0) >= 2000,
  );

  const hasZugspitze = ascents.some((ascent) => {
    const mountainName =
      ascent.mountains?.name_de ??
      ascent.mountains?.name ??
      "";

    return mountainName.toLowerCase().includes("zugspitze");
  });

  const unlockedAtById = new Map(
    userAchievements.map((achievement) => [
      achievement.achievement_id,
      achievement.unlocked_at,
    ]),
  );

  const achievements = buildAchievements({
    ascentsCount: ascents.length,
    totalHeight,
    hasMountainAbove2000,
    hasZugspitze,
    unlockedAtById,
  });

const username =
  user?.user_metadata?.username ||
  user?.email?.split("@")[0] ||
  t("userFallback");

const mountains = ascents
  .map((ascent) => ascent.mountains)
  .filter((mountain): mountain is Mountain => Boolean(mountain));

const highestMountain =
  mountains.length > 0
    ? mountains.reduce((highest, mountain) =>
        mountain.height > highest.height
          ? mountain
          : highest,
      )
    : null;

const averageHeight =
  mountains.length > 0
    ? Math.round(
        mountains.reduce(
          (sum, mountain) => sum + mountain.height,
          0,
        ) / mountains.length,
      )
    : 0;

const latestAscent = ascents[0] ?? null;

const unlockedAchievementsCount =
  achievements.filter(
    (achievement) => achievement.unlocked,
  ).length;

const totalMountains = 5902;

const progressPercent =
  totalMountains > 0
    ? Math.min(
        (ascents.length / totalMountains) * 100,
        100,
      )
    : 0;

function getMountainName(
  mountain: Mountain | null,
): string {
  if (!mountain) {
    return t("unknownMountain");
  }

  return (
    mountain.name_de ??
    mountain.name ??
    t("unnamedMountain")
  );
}

  async function handleAvatarUpload(
  event: React.ChangeEvent<HTMLInputElement>,
) {
  const file = event.target.files?.[0];

  if (!file || !user) {
    return;
  }

  const allowedTypes = [
    "image/jpeg",
    "image/png",
    "image/webp",
  ];

  if (!allowedTypes.includes(file.type)) {
    setAvatarMessage(
      t("avatarInvalidType"),
    );
    event.target.value = "";
    return;
  }

  if (file.size > 2 * 1024 * 1024) {
    setAvatarMessage(
      t("avatarTooLarge"),
    );
    event.target.value = "";
    return;
  }

  setAvatarUploading(true);
  setAvatarMessage("");

  const supabase = createClient();

  try {
    const extension =
      file.name.split(".").pop()?.toLowerCase() || "jpg";

    const filePath =
      `${user.id}/avatar-${Date.now()}.${extension}`;

    const { error: uploadError } =
      await supabase.storage
        .from("avatars")
        .upload(filePath, file, {
          cacheControl: "3600",
          contentType: file.type,
          upsert: false,
        });

    if (uploadError) {
      throw uploadError;
    }

    const {
      data: { publicUrl },
    } = supabase.storage
      .from("avatars")
      .getPublicUrl(filePath);

    const { error: profileError } = await supabase
      .from("profiles")
      .update({
        avatar_url: publicUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    if (profileError) {
      throw profileError;
    }

    setAvatarUrl(publicUrl);
    setAvatarMessage(t("avatarUpdated"));
  } catch (error) {
    console.error("Ошибка загрузки аватара:", error);

    setAvatarMessage(
      error instanceof Error
        ? error.message
        : t("avatarUploadFailed"),
    );
  } finally {
    setAvatarUploading(false);
    event.target.value = "";
  }
}

 useEffect(() => {
  const supabase = createClient();

  async function loadAccount() {
    setLoading(true);
    setErrorMessage("");

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError) {
      console.error(userError);
      setErrorMessage(userError.message);
      setLoading(false);
      return;
    }

    if (!user) {
      setUser(null);
      setLoading(false);
      return;
    }

    setUser(user);

    const { data: profile, error: profileError } =
      await supabase
        .from("profiles")
        .select("avatar_url")
        .eq("id", user.id)
        .maybeSingle();

    if (profileError) {
      console.error("Ошибка загрузки профиля:", profileError);
    } else {
      setAvatarUrl(profile?.avatar_url ?? null);
    }

    let savedAchievements: UserAchievementRecord[] = [];

    try {
      savedAchievements = await loadUserAchievements(
        supabase,
        user.id,
      );
    } catch (achievementError) {
      console.error(
        "Ошибка загрузки достижений:",
        achievementError,
      );
    }

    const { data, error } = await supabase
      .from("ascents")
      .select(`
        id,
        climbed_at,
        created_at,
        image_url,
        is_photo_public,
        mountains (
          id,
          name,
          name_de,
          height,
          wikidata,
          country_code,
          latitude,
          longitude
        )
      `)
      .eq("user_id", user.id)
      .order("climbed_at", { ascending: false });

    if (error) {
      console.error(error);
      setErrorMessage(error.message);
      setUserAchievements(savedAchievements);
      setLoading(false);
      return;
    }

    const loadedAscents =
      (data ?? []) as unknown as Ascent[];

    setAscents(loadedAscents);

    const {
  data: favoritesData,
  error: favoritesError,
} = await supabase
  .from("favorite_mountains")
  .select(`
    id,
    created_at,
    mountains (
      id,
      name,
      name_de,
      height,
      wikidata,
      country_code,
      latitude,
      longitude
    )
  `)
  .eq("user_id", user.id)
  .order("created_at", { ascending: false });

if (favoritesError) {
  console.error(
    "Ошибка загрузки избранных вершин:",
    favoritesError,
  );

  setFavoriteMountains([]);
} else {
  const favoriteRows: FavoriteMountainDatabaseRow[] =
    (favoritesData ?? []).map((row) => ({
      id: Number(row.id),
      created_at: String(row.created_at),
      mountains: row.mountains,
    }));

  const loadedFavoriteMountains: FavoriteMountain[] =
    favoriteRows.flatMap((row) => {
      const mountain = Array.isArray(row.mountains)
        ? row.mountains[0] ?? null
        : row.mountains;

      if (!mountain) {
        return [];
      }

      return [
        {
          id: row.id,
          created_at: row.created_at,
          mountain,
        },
      ];
    });

  setFavoriteMountains(loadedFavoriteMountains);
}

    const ascentsCount = loadedAscents.length;

    const totalHeightFromData = loadedAscents.reduce(
      (sum, ascent) =>
        sum + Number(ascent.mountains?.height ?? 0),
      0,
    );

    const hasMountainAbove2000FromData =
      loadedAscents.some(
        (ascent) =>
          Number(ascent.mountains?.height ?? 0) >= 2000,
      );

    const hasZugspitzeFromData = loadedAscents.some(
      (ascent) => {
        const mountainName =
          ascent.mountains?.name_de ??
          ascent.mountains?.name ??
          "";

        return mountainName
          .toLowerCase()
          .includes("zugspitze");
      },
    );

    const earnedAchievementIds =
      getEarnedAchievementIds({
        ascentsCount,
        totalHeight: totalHeightFromData,
        hasMountainAbove2000:
          hasMountainAbove2000FromData,
        hasZugspitze: hasZugspitzeFromData,
      });

    try {
      const achievementResult =
        await syncUserAchievements({
          supabase,
          userId: user.id,
          earnedAchievementIds,
          savedAchievements,
        });

      setUserAchievements(
        achievementResult.achievements,
      );

      const firstNewAchievement =
        achievementResult.newAchievements[0];

      if (firstNewAchievement) {
        const achievementInfo =
          ACHIEVEMENT_DEFINITIONS_BY_ID.get(
            firstNewAchievement.achievement_id,
          );

        if (achievementInfo) {
          showAchievementNotification({
  id: achievementInfo.id,
  icon: achievementInfo.icon,
});
        }
      }
    } catch (achievementError) {
      console.error(
        "Ошибка сохранения достижений:",
        achievementError,
      );

      setUserAchievements(savedAchievements);
    }

    setLoading(false);
  }

  void loadAccount();
}, [showAchievementNotification, t]);

  return {
  user,
  loading,
  errorMessage,

  avatarUrl,
  avatarUploading,
  avatarMessage,
  handleAvatarUpload,

  username,

  ascents,
  favoriteMountains,
  achievements,

  highestMountain,
  averageHeight,
  latestAscent,

  unlockedAchievementsCount,
  totalMountains,
  progressPercent,

  getMountainName,

};
}
