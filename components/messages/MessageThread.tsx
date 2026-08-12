"use client";

import { ArrowDown, ArrowLeft, Send, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createClient } from "@/Lib/supabase/client";
import { Link } from "@/i18n/navigation";
import { applyRealtimeMessage, canDeleteMessage, isMessageDraftSendable, mergeMessagePages, MESSAGE_MAX_CHARACTERS, MESSAGE_PAGE_SIZE, normalizeConversationSummary, normalizeMessageRecord, type ConversationSummary, type MessageRecord } from "@/Lib/socialMessaging";
import { useSocialInbox } from "@/components/messages/SocialInboxProvider";

export default function MessageThread({ conversation, initialMessages, currentUserId }: { conversation: ConversationSummary; initialMessages: MessageRecord[]; currentUserId: string }) {
  const t=useTranslations("Social.Messages");const a11y=useTranslations("Social.Accessibility");const format=useFormatter();
  const { refresh: refreshInbox }=useSocialInbox();
  const [messages,setMessages]=useState(()=>mergeMessagePages([],initialMessages));const [availability,setAvailability]=useState(conversation.messagingAvailability);const [draft,setDraft]=useState("");const [sending,setSending]=useState(false);const [loadingOlder,setLoadingOlder]=useState(false);const [hasOlder,setHasOlder]=useState(initialMessages.length===MESSAGE_PAGE_SIZE);const [error,setError]=useState("");const [newMessageCount,setNewMessageCount]=useState(0);const [announcement,setAnnouncement]=useState("");const [realtimeState,setRealtimeState]=useState<"connecting"|"connected"|"unavailable">("connecting");
  const scrollRef=useRef<HTMLDivElement>(null);
  const textareaRef=useRef<HTMLTextAreaElement>(null);
  const markedRef=useRef<number|null>(null);
  const markingRef=useRef<number|null>(null);
  const nearBottomRef=useRef(true);
  useLayoutEffect(()=>{const node=scrollRef.current;if(node)node.scrollTop=node.scrollHeight;},[]);
  const latestId=messages.at(-1)?.id??null;
const markThrough = useCallback(async (id: number) => {
  if (
    document.visibilityState !== "visible" ||
    !nearBottomRef.current ||
    (markedRef.current !== null && id <= markedRef.current) ||
    (markingRef.current !== null && id <= markingRef.current)
  ) {
    return;
  }

  markingRef.current = id;

  const result = await createClient().rpc("mark_conversation_read", {
    requested_conversation_id: conversation.conversationId,
    through_message_id: id,
  });

  if (markingRef.current === id) {
    markingRef.current = null;
  }

  if (result.error) {
    return;
  }

  if (markedRef.current === null || id > markedRef.current) {
    markedRef.current = id;
  }

  await refreshInbox();
}, [conversation.conversationId, refreshInbox]);
  useEffect(()=>{if(latestId!==null)void markThrough(latestId);},[latestId,markThrough]);
  useEffect(()=>{const onVisibility=()=>{if(document.visibilityState==="visible"&&nearBottomRef.current&&latestId!==null)void markThrough(latestId);};document.addEventListener("visibilitychange",onVisibility);return()=>document.removeEventListener("visibilitychange",onVisibility);},[latestId,markThrough]);
  useEffect(()=>{const supabase=createClient();let active=true;async function recover(){const result=await supabase.rpc("list_messages",{requested_conversation_id:conversation.conversationId,result_limit:MESSAGE_PAGE_SIZE,before_message_id:null});if(!active||result.error)return;const latest=((result.data??[])as unknown[]).map(normalizeMessageRecord).filter((message):message is MessageRecord=>message!==null);setMessages((current)=>mergeMessagePages(current,latest));}
    const receive=(raw:unknown,isInsert:boolean)=>{const message=normalizeMessageRecord(raw);if(!message)return;setMessages((current)=>applyRealtimeMessage(current,message));if(isInsert&&message.senderId!==currentUserId){setAnnouncement(a11y("newMessageFrom",{username:conversation.counterpartUsername}));if(nearBottomRef.current){requestAnimationFrame(()=>{const node=scrollRef.current;if(node)node.scrollTop=node.scrollHeight;});}else setNewMessageCount((count)=>count+1);}};
    const channel=supabase.channel(`social-thread:${conversation.conversationId}`).on("postgres_changes",{event:"INSERT",schema:"public",table:"messages",filter:`conversation_id=eq.${conversation.conversationId}`},(payload)=>receive(payload.new,true)).on("postgres_changes",{event:"UPDATE",schema:"public",table:"messages",filter:`conversation_id=eq.${conversation.conversationId}`},(payload)=>receive(payload.new,false)).subscribe((status)=>{if(status==="SUBSCRIBED"){setRealtimeState("connected");void recover();}else if(status==="CHANNEL_ERROR"||status==="TIMED_OUT"||status==="CLOSED")setRealtimeState("unavailable");});
    return()=>{active=false;void supabase.removeChannel(channel);};
  },[a11y,conversation.conversationId,conversation.counterpartUsername,currentUserId]);
  async function refreshAvailability(){const result=await createClient().rpc("list_conversations",{result_limit:30,cursor_updated_at:null,cursor_conversation_id:null});if(!result.error){const row=((result.data??[])as unknown[]).map(normalizeConversationSummary).find((item)=>item?.conversationId===conversation.conversationId);if(row)setAvailability(row.messagingAvailability);}}
  async function send(){if(!isMessageDraftSendable(draft)||sending)return;setSending(true);setError("");const result=await createClient().rpc("send_message",{requested_conversation_id:conversation.conversationId,message_body:draft});const raw=Array.isArray(result.data)?result.data[0]:result.data;const confirmed=normalizeMessageRecord(raw);setSending(false);if(result.error||!confirmed){setError(t("sendError"));await refreshAvailability();textareaRef.current?.focus();return;}setMessages((current)=>mergeMessagePages(current,[confirmed]));setDraft("");requestAnimationFrame(()=>{const node=scrollRef.current;if(node)node.scrollTop=node.scrollHeight;textareaRef.current?.focus();});}
  async function loadOlder(){const node=scrollRef.current;const oldest=messages[0]?.id;if(!node||!oldest||loadingOlder)return;const previousHeight=node.scrollHeight;const previousTop=node.scrollTop;setLoadingOlder(true);const result=await createClient().rpc("list_messages",{requested_conversation_id:conversation.conversationId,result_limit:MESSAGE_PAGE_SIZE,before_message_id:oldest});setLoadingOlder(false);if(result.error){setError(t("loadError"));return;}const page=((result.data??[])as unknown[]).map(normalizeMessageRecord).filter((m):m is MessageRecord=>m!==null);setMessages((current)=>mergeMessagePages(current,page));setHasOlder(page.length===MESSAGE_PAGE_SIZE);requestAnimationFrame(()=>{node.scrollTop=node.scrollHeight-previousHeight+previousTop;});}
  async function remove(
  message: MessageRecord,
  button: HTMLButtonElement
) {
  if (!window.confirm(t("deleteConfirm"))) {
    return;
  }

  const result = await createClient().rpc("delete_message", {
    requested_message_id: message.id,
  });

  if (result.error) {
    setError(t("deleteError"));
    button.focus();
    return;
  }

  setMessages((current) =>
    current.map((item) =>
      item.id === message.id
        ? {
            ...item,
            body: null,
            deletedAt: new Date().toISOString(),
          }
        : item
    )
  );

  await refreshInbox();

  requestAnimationFrame(() => {
    textareaRef.current?.focus();
  });
}
  function handleScroll(){const node=scrollRef.current;if(!node)return;nearBottomRef.current=node.scrollHeight-node.scrollTop-node.clientHeight<96;if(nearBottomRef.current){setNewMessageCount(0);if(latestId!==null)void markThrough(latestId);}}
  function jumpToLatest(){const node=scrollRef.current;if(!node)return;nearBottomRef.current=true;node.scrollTo({top:node.scrollHeight,behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"});setNewMessageCount(0);if(latestId!==null)void markThrough(latestId);}
  const sendable=availability==="available"&&isMessageDraftSendable(draft)&&!sending;const count=[...draft].length;
  return <section className="flex min-h-0 flex-1 flex-col bg-[var(--color-surface)]" aria-labelledby="conversation-title">
    <header className="flex min-h-16 items-center gap-3 border-b border-[var(--color-border)] px-4 py-3"><Link href="/messages" aria-label={t("backToMessages")} className="ui-pressable flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] lg:hidden"><ArrowLeft aria-hidden="true"/></Link><div className="min-w-0 flex-1"><h1 id="conversation-title" className="truncate text-xl font-bold">{conversation.counterpartUsername}</h1>{conversation.counterpartDisplayName&&conversation.counterpartDisplayName!==conversation.counterpartUsername&&<p className="truncate text-sm text-[var(--color-text-muted)]">{conversation.counterpartDisplayName}</p>}</div><Link href={`/users/${conversation.counterpartUserId}`} className="ui-pressable min-h-11 px-3 py-2 text-sm font-semibold text-[var(--color-forest)]">{t("openProfile")}</Link></header>
    <div className="relative min-h-0 flex flex-1 flex-col"><div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6" aria-label={a11y("messageThread")}><div className="mx-auto max-w-3xl">{hasOlder&&<div className="mb-5 text-center"><button type="button" disabled={loadingOlder} onClick={loadOlder} className="ui-pressable min-h-11 rounded-[var(--radius-control)] border border-[var(--color-border)] px-4 text-sm font-semibold">{loadingOlder?t("loadingOlder"):t("loadOlder")}</button></div>}
      {messages.length===0?<div className="py-16 text-center"><p className="text-[var(--color-text-muted)]">{availability==="available"?t("emptyThread"):availability==="friendship_required"?t("friendshipRequired"):t("unavailable")}</p></div>:<ol className="space-y-4">{messages.map((message)=>{const own=message.senderId===currentUserId;return <li key={message.id} className={`flex ${own?"justify-end":"justify-start"}`}><article className={`group max-w-[min(38rem,88%)] border px-4 py-3 ${own?"border-[var(--color-border-strong)] bg-[var(--color-surface-muted)]":"border-[var(--color-border-soft)] bg-[var(--color-surface-raised)]"}`} aria-label={own?a11y("outgoingMessage"):a11y("incomingMessage")}>
        {message.deletedAt?<p className="italic text-[var(--color-text-muted)]">{t("deleted")}</p>:<p className="whitespace-pre-wrap break-words text-[var(--color-text)]">{message.body}</p>}<footer className="mt-2 flex items-center justify-end gap-2 text-xs text-[var(--color-text-muted)]"><time>{formatMessageTime(new Date(message.createdAt),format)}</time>{canDeleteMessage(message,currentUserId)&&<button type="button" aria-label={a11y("deleteMessage")} onClick={(event)=>void remove(message,event.currentTarget)} className="ui-pressable flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] text-[var(--color-text-muted)] opacity-100 hover:text-[var(--color-danger)] sm:opacity-0 sm:focus:opacity-100 sm:group-hover:opacity-100"><Trash2 aria-hidden="true" className="h-4 w-4"/></button>}</footer>
      </article></li>;})}</ol>}</div></div>{newMessageCount>0&&<button type="button" onClick={jumpToLatest} className="ui-pressable absolute bottom-4 left-1/2 flex min-h-11 -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 text-sm font-semibold shadow-[var(--shadow-control)]"><ArrowDown aria-hidden="true" className="h-4 w-4"/>{t("newMessages",{count:newMessageCount})}</button>}</div>
    <div className="sticky bottom-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">{availability!=="available"?<div className="mx-auto max-w-3xl border-l-2 border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-4 py-3 text-sm text-[var(--color-text-secondary)]">{availability==="friendship_required"?<>{t("friendshipRequired")} <Link href={`/users/${conversation.counterpartUserId}`} className="font-semibold text-[var(--color-forest)] underline">{t("openProfile")}</Link></>:t("unavailable")}</div>:<div className="mx-auto max-w-3xl"><label htmlFor="message-composer" className="sr-only">{a11y("composerLabel")}</label><div className="flex items-end gap-2"><textarea ref={textareaRef} id="message-composer" rows={1} maxLength={MESSAGE_MAX_CHARACTERS} value={draft} onChange={(e)=>{setDraft(e.target.value);setError("");}} onKeyDown={(e)=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();void send();}}} placeholder={t("composer")} className="ui-field max-h-40 min-h-11 flex-1 resize-y rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2.5"/><button type="button" onClick={send} disabled={!sendable} aria-label={a11y("sendMessage")} className="ui-pressable flex h-11 min-w-11 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"><Send aria-hidden="true" className="h-4 w-4"/><span className="hidden sm:inline">{sending?t("sending"):t("send")}</span></button></div>{count>=3500&&<p className="mt-1 text-right text-xs text-[var(--color-text-muted)]">{t("characterCount",{count,maximum:MESSAGE_MAX_CHARACTERS})}</p>}</div>}{error&&<p role="status" aria-live="polite" className="mx-auto mt-2 max-w-3xl text-sm text-[var(--color-danger)]">{error}</p>}</div>
    <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>{realtimeState==="unavailable"&&<p role="status" className="sr-only">{t("realtimeUnavailable")}</p>}
  </section>;
}

function formatMessageTime(
  date: Date,
  format: ReturnType<typeof useFormatter>
) {
  const now = new Date();

  const same =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  return format.dateTime(
    date,
    same
      ? {
          hour: "2-digit",
          minute: "2-digit",
        }
      : {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        }
  );
}
