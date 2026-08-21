"use client";
import { useState } from "react";
import { useFormatter,useTranslations } from "next-intl";
import { Bell,CheckCheck } from "lucide-react";
import { createClient } from "@/Lib/supabase/client";
import { useSocialInbox } from "@/components/messages/SocialInboxProvider";
import { Link } from "@/i18n/navigation";
import { listProjectNotifications,PROJECT_NOTIFICATION_TRANSLATION_KEYS,type ProjectNotificationItem,type ProjectNotificationPage } from "@/Lib/projects/notifications";

export default function ProjectNotifications({initialPage}:{initialPage:ProjectNotificationPage}){
 const t=useTranslations("Notifications"),format=useFormatter(),{refresh}=useSocialInbox(); const [items,setItems]=useState(initialPage.items),[cursor,setCursor]=useState(initialPage.nextCursor),[busy,setBusy]=useState(false); const supabase=createClient();
 const actor=(item:ProjectNotificationItem)=>item.actorName??item.actorUsername??t("someone");
 const values=(item:ProjectNotificationItem)=>({actor:actor(item),project:String(item.metadata.projectName??t("project")),role:String(item.metadata.to??item.metadata.role??"")});
 async function markOne(id:string){const {error}=await supabase.rpc("mark_expedition_project_notification_read",{requested_notification_id:id});if(!error){setItems(v=>v.map(n=>n.id===id?{...n,readAt:n.readAt??new Date().toISOString()}:n));void refresh();}}
 async function markAll(){setBusy(true);const {error}=await supabase.rpc("mark_all_expedition_project_notifications_read");if(!error){const now=new Date().toISOString();setItems(v=>v.map(n=>({...n,readAt:n.readAt??now})));void refresh();}setBusy(false);}
 async function loadMore(){if(!cursor)return;setBusy(true);try{const page=await listProjectNotifications(supabase,cursor);setItems(v=>[...v,...page.items]);setCursor(page.nextCursor);}finally{setBusy(false);}}
 return <section className="mt-7" aria-label={t("title")}>
  <div className="flex justify-end"><button type="button" disabled={busy||!items.some(i=>!i.readAt)} onClick={markAll} className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] px-4 font-bold disabled:opacity-50"><CheckCheck aria-hidden size={17}/>{t("markAll")}</button></div>
  {items.length===0?<div className="py-16 text-center"><Bell className="mx-auto text-[var(--color-forest)]" aria-hidden/><h2 className="mt-4 text-2xl font-bold">{t("emptyTitle")}</h2><p className="mt-2 text-[var(--color-text-muted)]">{t("emptyDescription")}</p></div>:
  <ol className="mt-4 divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border)]">{items.map(item=>{const content=<><p className="font-semibold text-[var(--color-text)]">{t(`types.${PROJECT_NOTIFICATION_TRANSLATION_KEYS[item.type]}`,values(item))}</p><time className="mt-1 block text-xs text-[var(--color-text-muted)]" dateTime={item.createdAt}>{format.relativeTime(new Date(item.createdAt))}</time></>;const href=item.type==="invitation.received"?"/projects":item.canNavigate&&item.projectId?`/projects/${item.projectId}`:null;return <li key={item.id} className={`relative py-4 pl-5 pr-3 ${item.readAt?"":"bg-[var(--color-surface-muted)]"}`}><span className={`absolute left-1 top-6 h-2 w-2 rounded-full ${item.readAt?"bg-transparent":"bg-[var(--color-forest)]"}`}/>{href?<Link href={href} onClick={()=>void markOne(item.id)} className="block rounded-[var(--radius-control)] p-2 hover:bg-[var(--color-surface)]">{content}</Link>:<button type="button" onClick={()=>void markOne(item.id)} className="block w-full rounded-[var(--radius-control)] p-2 text-left hover:bg-[var(--color-surface)]">{content}</button>}</li>})}</ol>}
  {cursor&&<div className="mt-6 text-center"><button type="button" disabled={busy} onClick={loadMore} className="ui-pressable min-h-11 rounded-[var(--radius-control)] border border-[var(--color-border)] px-5 font-bold">{busy?t("loading"):t("loadMore")}</button></div>}
 </section>;
}
