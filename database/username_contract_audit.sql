-- Username contract audit for Mountain Tracker (manual, do not apply automatically)
-- Canonical new-user contract (Phase 3):
-- - trim before validation
-- - length 3..20 Unicode codepoints (characters)
-- - allowed ASCII: A-Z a-z 0-9 _ . -
-- - first/last: A-Z a-z 0-9 _
-- - case-insensitive identity (lower(username) unique is future, not yet enforced)
-- Existing usernames may be legacy and remain valid accounts but not @mentionable until rename.

-- 1) Invalid usernames per canonical contract (legacy)
select id, username
from public.profiles
where
  username is null
  or username <> btrim(username)
  or char_length(username) < 3
  or char_length(username) > 20
  or username !~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{1,18}[A-Za-z0-9_]$';

-- 2) Case-insensitive duplicates (ambiguous mentions → resolve_mention_user returns null)
select lower(username) as lower_username, count(*) as cnt, array_agg(id) as ids, array_agg(username) as usernames
from public.profiles
group by lower(username)
having count(*) > 1;

-- 3) Usernames containing disallowed characters (outside canonical)
select id, username
from public.profiles
where username ~ '[^A-Za-z0-9_.-]';

-- 4) Usernames with leading/trailing . or -
select id, username
from public.profiles
where username ~ '^[.-]' or username ~ '[.-]$';

-- Do NOT add CHECK/unique(lower(username)) until above queries return 0 rows.
-- If any rows exist, keep them as legacy (not mentionable) and plan separate rename migration.
-- Future strict contract (reviewed, not auto-applied):
-- alter table public.profiles add constraint profiles_username_canonical_check check (username ~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{1,18}[A-Za-z0-9_]$');
-- create unique index if not exists profiles_username_lower_unique on public.profiles (lower(username));
