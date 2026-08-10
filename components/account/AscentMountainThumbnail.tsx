"use client";

import Image from "next/image";
import { Mountain } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import {
  getMountainImageFromWikidata,
  type WikimediaMountainImage,
} from "@/Lib/wikimedia";

type AscentMountainThumbnailProps = {
  wikidataId: string | null;
  mountainName: string;
  customImageUrl: string | null;
};

export default function AscentMountainThumbnail({
  wikidataId,
  mountainName,
  customImageUrl,
}: AscentMountainThumbnailProps) {
  const t = useTranslations("Ascents.Thumbnail");
  const [image, setImage] =
    useState<WikimediaMountainImage | null>(null);

  const [loading, setLoading] = useState(
    Boolean(wikidataId),
  );

  useEffect(() => {
    let cancelled = false;

    async function loadImage() {
      if (!wikidataId) {
        setImage(null);
        setLoading(false);
        return;
      }

      setLoading(true);

      const loadedImage =
        await getMountainImageFromWikidata(wikidataId);

      if (cancelled) {
        return;
      }

      setImage(loadedImage);
      setLoading(false);
    }

    void loadImage();

    return () => {
      cancelled = true;
    };
  }, [wikidataId]);

  if (customImageUrl) {
  return (
    <div className="relative h-32 w-full shrink-0 overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-surface-muted)] sm:h-28 sm:w-40">
      <Image
        src={customImageUrl}
        alt={t("customPhotoAlt", { mountainName })}
        fill
        sizes="(max-width: 640px) 100vw, 160px"
        className="object-cover"
      />

      <div className="absolute bottom-2 left-2 rounded-[var(--radius-sm)] bg-[var(--color-surface-inverse)] px-2 py-1 [font-family:var(--font-technical)] text-[10px] font-bold uppercase tracking-[0.075em] text-[var(--color-text-inverse)]">
        {t("myPhoto")}
      </div>
    </div>
  );
}

  if (loading) {
    return (
      <div className="h-32 w-full animate-pulse rounded-[var(--radius-card)] bg-[var(--color-surface-muted)] sm:h-28 sm:w-40" />
    );
  }

  if (!image) {
    return (
      <div className="flex h-32 w-full shrink-0 items-center justify-center rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface-muted)] sm:h-28 sm:w-40">
        <Mountain aria-hidden="true" className="h-7 w-7 text-[var(--color-granite)]" />
      </div>
    );
  }

  return (
    <div className="relative h-32 w-full shrink-0 overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-surface-muted)] sm:h-28 sm:w-40">
      <Image
        src={image.url}
        alt={t("mountainAlt", { mountainName })}
        fill
        sizes="(max-width: 640px) 100vw, 160px"
        className="object-cover"
      />
    </div>
  );
}
