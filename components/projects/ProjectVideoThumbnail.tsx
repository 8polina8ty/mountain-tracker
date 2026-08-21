"use client";

import { useEffect, useRef, useState } from "react";
import { Play, Video } from "lucide-react";
import { formatProjectVideoDuration } from "./videoThumbnailPresentation";

const MAX_POSTER_WIDTH = 256;
const POSTER_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_POSTERS = 2;
let activePosterExtractions = 0;
const posterQueue: Array<() => void> = [];

async function acquirePosterSlot(): Promise<() => void> {
  if (activePosterExtractions >= MAX_CONCURRENT_POSTERS) await new Promise<void>((resolve) => posterQueue.push(resolve));
  activePosterExtractions += 1;
  return () => {
    activePosterExtractions -= 1;
    posterQueue.shift()?.();
  };
}

async function extractVideoPoster(sourceUrl: string, signal: AbortSignal): Promise<string> {
  const release = await acquirePosterSlot();
  if (signal.aborted) { release(); throw new Error("poster-aborted"); }
  const video = document.createElement("video");
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      let timeout = 0;
      const finish = (callback: () => void) => { if (settled) return; settled = true; window.clearTimeout(timeout); callback(); };
      timeout = window.setTimeout(() => finish(() => reject(new Error("poster-timeout"))), POSTER_TIMEOUT_MS);
      signal.addEventListener("abort", () => finish(() => reject(new Error("poster-aborted"))), { once: true });
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = "anonymous";
      video.onloadedmetadata = () => {
        if (!Number.isFinite(video.duration) || video.videoWidth <= 0 || video.videoHeight <= 0) {
          finish(() => reject(new Error("poster-metadata")));
          return;
        }
        video.currentTime = Math.min(1, video.duration * 0.1);
      };
      video.onseeked = () => {
        const width = Math.min(MAX_POSTER_WIDTH, video.videoWidth);
        const height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) { finish(() => reject(new Error("poster-canvas"))); return; }
        try {
          context.drawImage(video, 0, 0, width, height);
          canvas.toBlob((blob) => finish(() => blob ? resolve(URL.createObjectURL(blob)) : reject(new Error("poster-blob"))), "image/jpeg", 0.72);
        } catch { finish(() => reject(new Error("poster-cors"))); }
      };
      video.onerror = () => finish(() => reject(new Error("poster-video")));
      video.src = sourceUrl;
    });
  } finally {
    video.removeAttribute("src");
    video.load();
    release();
  }
}

export default function ProjectVideoThumbnail({ sourceUrl, durationSeconds, lazy = true, showPlay = true }: {
  sourceUrl: string;
  durationSeconds: number | null;
  lazy?: boolean;
  showPlay?: boolean;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const [shouldLoad, setShouldLoad] = useState(!lazy);
  const [posterUrl, setPosterUrl] = useState<string | null>(null);

  useEffect(() => {
    if (shouldLoad || !rootRef.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setShouldLoad(true); observer.disconnect(); }
    }, { rootMargin: "160px" });
    observer.observe(rootRef.current);
    return () => observer.disconnect();
  }, [shouldLoad]);

  useEffect(() => {
    if (!shouldLoad) return;
    let active = true;
    let generatedUrl: string | null = null;
    const controller = new AbortController();
    void extractVideoPoster(sourceUrl, controller.signal).then((url) => {
      generatedUrl = url;
      if (active) setPosterUrl(url);
      else URL.revokeObjectURL(url);
    }).catch(() => undefined);
    return () => {
      active = false;
      controller.abort();
      if (generatedUrl) URL.revokeObjectURL(generatedUrl);
    };
  }, [shouldLoad, sourceUrl]);

  return <span ref={rootRef} className="relative flex h-full w-full items-center justify-center overflow-hidden bg-[var(--color-surface-muted)] text-[var(--color-forest)]">
    {posterUrl ? <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={posterUrl} alt="" className="h-full w-full object-cover" />
    </> : <Video aria-hidden="true" size={24} className="opacity-55" />}
    {showPlay && <span className="absolute inset-0 flex items-center justify-center"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/65 text-white shadow-sm"><Play aria-hidden="true" size={17} className="translate-x-px" /></span></span>}
    {showPlay && <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white">{formatProjectVideoDuration(durationSeconds)}</span>}
  </span>;
}
