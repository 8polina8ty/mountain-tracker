import type { ChangeEvent } from "react";

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
    <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
        <div className="flex h-28 w-28 shrink-0 items-center justify-center overflow-hidden rounded-full bg-green-100 text-4xl font-bold text-green-700">
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

        <div className="flex-1">
          <p className="text-sm font-semibold uppercase tracking-wide text-green-600">
            Профиль
          </p>

          <h1 className="mt-1 text-3xl font-bold text-gray-900">
            {username}
          </h1>

          {email && (
            <p className="mt-2 text-gray-500">
              {email}
            </p>
          )}

          <div className="mt-5">
            <label className="inline-flex cursor-pointer items-center rounded-xl bg-green-600 px-4 py-2 font-semibold text-white transition hover:bg-green-700">
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
              <p className="mt-2 text-sm text-gray-600">
                {avatarMessage}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}