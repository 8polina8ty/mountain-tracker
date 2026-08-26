import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import ConversationList from "@/components/messages/ConversationList";
import { isLocale } from "@/i18n/locales";
import { createClient } from "@/Lib/supabase/server";
import { listConversations } from "@/Lib/socialMessagingServer";
import type { ConversationSummary } from "@/Lib/socialMessaging";
import { PageHero } from "@/components/ui-v2";

export default async function MessagesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) redirect("/de/map");
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) redirect(`/${locale}/auth/login?returnTo=${encodeURIComponent("/messages")}`);
  const t = await getTranslations("Social.Messages");
  let conversations: ConversationSummary[] = [];
  let error = false;
  try {
    conversations = await listConversations();
  } catch {
    error = true;
  }

  return (
    <main className="min-h-[calc(100dvh-64px)] bg-[var(--color-bg)] px-4 py-8 lg:px-6 lg:py-12">
      <div className="mx-auto max-w-7xl space-y-10">
        <PageHero
          eyebrow={t("eyebrow") ?? "Messages"}
          title={t("title") ?? "Conversations"}
          subtitle={t("description") ?? "Stay connected with your climbing partners."}
        />

        <div className="min-h-[34rem] overflow-hidden border-y border-[var(--color-border-strong)] bg-[var(--color-surface)] lg:grid lg:grid-cols-[22rem_minmax(0,1fr)]">
          <section className="border-[var(--color-border)] lg:border-r" aria-label={t("conversationList")}>
            {error ? (
              <div className="p-5 text-sm text-[var(--color-danger)]" role="alert">
                {t("loadError")}
              </div>
            ) : (
              <ConversationList conversations={conversations} currentUserId={user.id} />
            )}
          </section>
          <section className="hidden items-center justify-center p-8 text-center lg:flex">
            <div>
              <h2 className="text-xl font-bold">{t("selectConversation")}</h2>
              <p className="mt-2 text-sm text-[var(--color-text-muted)]">{t("selectConversationDescription")}</p>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}