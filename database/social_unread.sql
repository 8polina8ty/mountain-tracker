-- Social System v1, Phase E. MANUAL DEPLOYMENT ONLY.
-- A single current-user aggregate; message rows and counterpart activity are not exposed.

create or replace function public.get_social_inbox_summary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
with unread_by_conversation as (
  select
    cm.conversation_id,
    count(*)::integer as unread_count
  from public.conversation_members as cm
  join public.messages as m
    on m.conversation_id = cm.conversation_id
   and m.id > coalesce(cm.last_read_message_id, 0)
   and m.sender_id <> cm.user_id
   and m.deleted_at is null
  where cm.user_id = auth.uid()
    and cm.left_at is null
  group by cm.conversation_id
)
select jsonb_build_object(
  'totalUnreadMessages', coalesce(sum(unread_count), 0)::integer,
  'unreadConversations', coalesce(
    jsonb_object_agg(conversation_id::text, unread_count),
    '{}'::jsonb
  )
)
from unread_by_conversation;
$function$;

revoke all on function public.get_social_inbox_summary() from public, anon;
grant execute on function public.get_social_inbox_summary() to authenticated;
