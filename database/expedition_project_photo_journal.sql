-- Expedition Projects Phase 6C: permit photo-only journal entries.
-- MANUAL REVIEW AND DEPLOYMENT ONLY. DO NOT run from application code.
--
-- Prerequisite: the Phase 1 journal table and Phase 6A media contract are
-- already deployed. The application continues to reject an empty body when no
-- valid media is selected; this incremental constraint only makes the required
-- create-entry-then-upload compensation flow possible for media-only entries.

begin;

alter table public.expedition_project_journal_entries
  drop constraint expedition_project_journal_body_check;

alter table public.expedition_project_journal_entries
  add constraint expedition_project_journal_body_check
    check (char_length(body) <= 12000);

commit;
