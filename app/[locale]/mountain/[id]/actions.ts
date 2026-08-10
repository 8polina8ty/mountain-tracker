"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/Lib/supabase/server";
import type { Locale } from "@/i18n/locales";

export async function toggleFavoriteMountain(
  mountainId: number,
  locale: Locale,
) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return;
  }

  const existing = await supabase
    .from("favorite_mountains")
    .select("id")
    .eq("user_id", user.id)
    .eq("mountain_id", mountainId)
    .maybeSingle();

  if (existing.data) {
    await supabase
      .from("favorite_mountains")
      .delete()
      .eq("id", existing.data.id);
  } else {
    await supabase
      .from("favorite_mountains")
      .insert({
        user_id: user.id,
        mountain_id: mountainId,
      });
  }

  revalidatePath(`/${locale}/mountain/${mountainId}`);
}
