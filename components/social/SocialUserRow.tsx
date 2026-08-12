"use client";

import Image from "next/image";
import type { ReactNode } from "react";

import { Link } from "@/i18n/navigation";

type Props = {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  action?: ReactNode;
  detail?: ReactNode;
};

export default function SocialUserRow({
  userId,
  username,
  displayName,
  avatarUrl,
  action,
  detail,
}: Props) {
  return (
    <li className="flex min-w-0 flex-col gap-3 border-b border-[var(--color-border-soft)] py-4 last:border-b-0 sm:flex-row sm:items-center">
      <Link
        href={`/users/${userId}`}
        className="ui-pressable flex min-w-0 flex-1 items-center gap-3 rounded-[var(--radius-control)]"
      >
        <span className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] font-bold text-[var(--color-forest)]">
          {avatarUrl ? (
            <Image
              src={avatarUrl}
              alt=""
              fill
              sizes="44px"
              className="object-cover"
            />
          ) : (
            <span aria-hidden="true">
              {username.slice(0, 1).toUpperCase()}
            </span>
          )}
        </span>

        <span className="min-w-0">
          <span className="block truncate font-semibold text-[var(--color-text)]">
            {username}
          </span>

          {displayName && displayName !== username && (
            <span className="block truncate text-sm text-[var(--color-text-muted)]">
              {displayName}
            </span>
          )}

          {detail && (
            <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">
              {detail}
            </div>
          )}
        </span>
      </Link>

      {action && (
        <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          {action}
        </div>
      )}
    </li>
  );
}
