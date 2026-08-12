-- Social System v1, Phase B: public profile search support.
-- MANUAL DEPLOYMENT ONLY. This artifact does not rewrite existing usernames.
-- Before applying, reviewers should confirm current profile indexes and document
-- whether a case-insensitive username uniqueness rule already exists. These
-- non-unique indexes are safe for existing mixed-case accounts.

create index if not exists profiles_username_prefix_lower_idx
  on public.profiles (lower(username) text_pattern_ops, id);
create index if not exists profiles_display_name_prefix_lower_idx
  on public.profiles (lower(display_name) text_pattern_ops, id)
  where display_name is not null;

