import type { ChangeEvent } from "react";
import { Camera, Compass } from "lucide-react";

type ProfileCardProps = {
  username: string;
  email: string | null;
  avatarUrl: string | null;
  avatarUploading: boolean;
  avatarMessage: string;
  handleAvatarUpload: (
    event: ChangeEvent<HTMLInputElement>,
  ) => Promise<void>;
};

export default function ProfileCard({
  username,
  email,
  avatarUrl,
  avatarUploading,
  avatarMessage,
  handleAvatarUpload,
}: ProfileCardProps) {
  return (
    <section className="border-b border-[var(--color-border-strong)] bg-[var(--color-surface-inverse)] px-5 py-7 text-[var(--color-text-inverse)] sm:px-8 sm:py-9">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
        <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-white/30 bg-white/10 text-4xl font-bold sm:h-28 sm:w-28">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={`Аватар пользователя ${username}`}
              className="h-full w-full object-cover"
            />
          ) : (
            username.charAt(0).toUpperCase()
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 [font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-white/65">
            <Compass aria-hidden="true" className="h-3.5 w-3.5" />
            Личная экспедиционная запись
          </p>

          <h1 className="mt-2 break-words text-4xl font-bold sm:text-5xl">
            {username}
          </h1>

          {email && (
            <p className="mt-2 break-all text-sm text-white/65">
              {email}
            </p>
          )}

          <div className="mt-5 flex flex-col items-start gap-2">
            <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-[var(--radius-control)] border border-white/30 px-4 py-2 text-sm font-semibold text-white transition-colors duration-[var(--duration-fast)] hover:bg-white/10">
              <Camera aria-hidden="true" className="h-4 w-4" />
              {avatarUploading
                ? "Загрузка..."
                : "Изменить аватар"}

              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={avatarUploading}
                onChange={handleAvatarUpload}
                className="hidden"
              />
            </label>

            {avatarMessage && (
              <p className="text-sm text-white/70" role="status">
                {avatarMessage}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
