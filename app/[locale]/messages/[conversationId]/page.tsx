import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import ConversationList from "@/components/messages/ConversationList";
import MessageThread from "@/components/messages/MessageThread";
import { isLocale } from "@/i18n/locales";
import { Link } from "@/i18n/navigation";
import { createClient } from "@/Lib/supabase/server";
import { listConversations, listMessages } from "@/Lib/socialMessagingServer";

export default async function ConversationPage({ params }: { params: Promise<{ locale: string; conversationId: string }> }) {
  const { locale, conversationId } = await params; if (!isLocale(locale)) redirect("/de/map"); const client=await createClient();const {data:{user}}=await client.auth.getUser();if(!user)redirect(`/${locale}/auth/login?returnTo=${encodeURIComponent(`/messages/${conversationId}`)}`);
  const t=await getTranslations("Social.Messages");let conversations;let messages;try{[conversations,messages]=await Promise.all([listConversations(),listMessages({conversationId})]);}catch{return <Unavailable t={t}/>;}const conversation=conversations.find((item)=>item.conversationId===conversationId);if(!conversation)return <Unavailable t={t}/>;
  return <main className="h-[calc(100dvh-58px)] min-h-[32rem] bg-[var(--color-bg)] lg:h-[calc(100dvh-66px)] lg:px-6 lg:py-6"><div className="mx-auto flex h-full max-w-7xl overflow-hidden border-[var(--color-border-strong)] bg-[var(--color-surface)] lg:border-y"><aside className="hidden w-[22rem] shrink-0 overflow-y-auto border-r border-[var(--color-border)] lg:block"><div className="border-b border-[var(--color-border)] px-4 py-4"><h2 className="text-lg font-bold">{t("title")}</h2></div><ConversationList conversations={conversations} currentUserId={user.id} activeConversationId={conversationId}/></aside><MessageThread conversation={conversation} initialMessages={messages} currentUserId={user.id}/></div></main>;
}

function Unavailable({t}:{t:Awaited<ReturnType<typeof getTranslations>>}){return <main className="flex min-h-[calc(100dvh-58px)] items-center justify-center bg-[var(--color-bg)] px-4"><section className="max-w-md border-y border-[var(--color-border-strong)] py-10 text-center"><h1 className="text-2xl font-bold">{t("notFoundTitle")}</h1><p className="mt-2 text-[var(--color-text-muted)]">{t("notFound")}</p><Link href="/messages" className="ui-pressable mt-5 inline-flex min-h-11 items-center rounded-[var(--radius-control)] bg-[var(--color-forest)] px-4 font-semibold text-white">{t("backToMessages")}</Link></section></main>}
