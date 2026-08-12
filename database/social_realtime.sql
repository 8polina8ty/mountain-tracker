-- Social System v1, Phase E. MANUAL DEPLOYMENT ONLY.
-- Postgres Changes remains protected by the messages SELECT RLS policy.

do $publication$
begin
  if not exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end
$publication$;
