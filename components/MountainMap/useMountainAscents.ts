import { useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { SelectedPeak } from "./types";

type UseMountainAscentsParams = {
  supabase: SupabaseClient;
  selectedPeak: SelectedPeak | null;
};

export function useMountainAscents({
  supabase,
  selectedPeak,
}: UseMountainAscentsParams) {
  const [selectedPeakClimbed, setSelectedPeakClimbed] =
    useState(false);
  const [ascentLoading, setAscentLoading] = useState(false);
  const [ascentMessage, setAscentMessage] = useState("");

  const messageTimeoutRef =
    useRef<ReturnType<typeof setTimeout> | null>(null);

  const [climbedMountainIds, setClimbedMountainIds] =
  useState<Set<number>>(new Set());

  function clearMessageTimeout() {
    if (messageTimeoutRef.current) {
      clearTimeout(messageTimeoutRef.current);
      messageTimeoutRef.current = null;
    }
  }

  function clearAscentMessage() {
    clearMessageTimeout();
    setAscentMessage("");
  }

  function hideMessageAfterDelay() {
    clearMessageTimeout();

    messageTimeoutRef.current = setTimeout(() => {
      setAscentMessage("");
      messageTimeoutRef.current = null;
    }, 1000);
  }

async function loadClimbedMountains() {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    setClimbedMountainIds(new Set());
    return;
  }

  const { data, error } = await supabase
    .from("ascents")
    .select("mountain_id")
    .eq("user_id", user.id);

  if (error) {
    console.error(error);
    return;
  }

  setClimbedMountainIds(
    new Set(
      (data ?? []).map((row) =>
        Number(row.mountain_id),
      ),
    ),
  );
}

  async function checkSelectedPeakAscent(
    mountainId: number,
  ) {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      setSelectedPeakClimbed(false);
      return;
    }

    const { data, error } = await supabase
      .from("ascents")
      .select("id")
      .eq("user_id", user.id)
      .eq("mountain_id", mountainId)
      .maybeSingle();

    if (error) {
      console.error(error);
      setSelectedPeakClimbed(false);
      return;
    }

    setSelectedPeakClimbed(Boolean(data));
  }

  async function handleAscent() {
    if (!selectedPeak || ascentLoading) {
      return;
    }

    setAscentLoading(true);
    clearAscentMessage();

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      if (userError) {
        console.error(userError);
      }

      setAscentMessage(
        "Сначала войдите в аккаунт, чтобы отметить вершину.",
      );
      setAscentLoading(false);
      return;
    }

    if (selectedPeakClimbed) {
      const { error: deleteError } = await supabase
        .from("ascents")
        .delete()
        .eq("user_id", user.id)
        .eq("mountain_id", selectedPeak.id);

      if (deleteError) {
        console.error(deleteError);
        setAscentMessage(deleteError.message);
        setAscentLoading(false);
        return;
      }

      setSelectedPeakClimbed(false);

setClimbedMountainIds((currentIds) => {
  const nextIds = new Set(currentIds);
  nextIds.delete(Number(selectedPeak.id));
  return nextIds;
});

      setAscentMessage("Восхождение отменено.");
      hideMessageAfterDelay();
      setAscentLoading(false);
      return;
    }

    const { error: insertError } = await supabase
      .from("ascents")
      .insert({
        user_id: user.id,
        mountain_id: selectedPeak.id,
        climbed_at: new Date().toISOString().slice(0, 10),
      });

    if (insertError) {
      if (insertError.code === "23505") {
        setSelectedPeakClimbed(true);

  setClimbedMountainIds((currentIds) => {
    const nextIds = new Set(currentIds);
    nextIds.add(Number(selectedPeak.id));
    return nextIds;
  });

        setAscentMessage("Эта вершина уже отмечена.");
      } else {
        console.error(insertError);
        setAscentMessage(insertError.message);
      }

      setAscentLoading(false);
      return;
    }

    setSelectedPeakClimbed(true);

setClimbedMountainIds((currentIds) => {
  const nextIds = new Set(currentIds);
  nextIds.add(Number(selectedPeak.id));
  return nextIds;
});

    setAscentMessage(
      "Вершина добавлена в ваши восхождения.",
    );

    hideMessageAfterDelay();
    setAscentLoading(false);
  }

  useEffect(() => {
    return () => {
      clearMessageTimeout();
    };
  }, []);

  return {
  climbedMountainIds,
  selectedPeakClimbed,
  ascentLoading,
  ascentMessage,
  setSelectedPeakClimbed,
  checkSelectedPeakAscent,
  loadClimbedMountains,
  handleAscent,
  clearAscentMessage,
};
}