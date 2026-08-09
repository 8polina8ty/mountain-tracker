"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

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
    <div className="relative h-24 w-full shrink-0 overflow-hidden rounded-2xl bg-gray-100 sm:h-28 sm:w-40">
      <Image
        src={customImageUrl}
        alt={`Фотография восхождения на ${mountainName}`}
        fill
        sizes="(max-width: 640px) 100vw, 160px"
        className="object-cover transition duration-300 hover:scale-105"
      />

      <div className="absolute bottom-2 left-2 rounded-lg bg-black/60 px-2 py-1 text-xs font-semibold text-white">
        Моё фото
      </div>
    </div>
  );
}

  if (loading) {
    return (
      <div className="h-24 w-full animate-pulse rounded-2xl bg-gray-200 sm:h-28 sm:w-40" />
    );
  }

  if (!image) {
    return (
      <div className="flex h-24 w-full shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-green-100 to-gray-100 text-3xl sm:h-28 sm:w-40">
        🏔️
      </div>
    );
  }

  return (
    <div className="relative h-24 w-full shrink-0 overflow-hidden rounded-2xl bg-gray-100 sm:h-28 sm:w-40">
      <Image
        src={image.url}
        alt={`Вершина ${mountainName}`}
        fill
        sizes="(max-width: 640px) 100vw, 160px"
        className="object-cover transition duration-300 hover:scale-105"
      />
    </div>
  );
}