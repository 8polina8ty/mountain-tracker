-- Achievement System v2, Phase H.
-- Reviewed deployment artifact: apply manually through the Supabase SQL workflow.
-- This SECURITY DEFINER function deliberately exposes only fixed aggregates and
-- registry entries explicitly classified as safe for automatic public display.

create or replace function public.get_public_user_achievement_summary(
  requested_user_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
with registered as (
  select distinct on (ua.achievement_id)
    ua.achievement_id,
    ua.unlocked_at,
    case
      when ua.achievement_id = any (array[
        'summits-750','summits-1000','summit-elevation-total-750000','summit-elevation-total-1000000',
        'countries-30','gps-tracks-500','gps-distance-km-10000','gps-elevation-gain-1000000',
        'gps-linked-summits-500','active-months-120','active-years-15'
      ]::text[]) then 'legendary'
      when ua.achievement_id = any (array[
        'summits-250','summits-500','summit-elevation-total-250000','summit-elevation-total-500000',
        'summit-height-3500','summit-height-4000','altitude-zones-7','countries-15','countries-20',
        'gps-tracks-250','gps-distance-km-2500','gps-distance-km-5000','gps-elevation-gain-250000',
        'gps-elevation-gain-500000','gps-linked-summits-250','active-months-60','active-years-10',
        'summits-in-year-50','calendar-months-represented-12'
      ]::text[]) then 'epic'
      when ua.achievement_id = any (array[
        'fifty-ascents','summits-100','summit-elevation-total-50000','summit-elevation-total-100000',
        'summit-height-2500','summit-height-3000','altitude-zone-3000-3499','altitude-zone-3500-plus',
        'altitude-zones-5','countries-5','countries-10','gps-tracks-50','gps-tracks-100',
        'gps-distance-km-500','gps-distance-km-1000','gps-elevation-gain-50000',
        'gps-elevation-gain-100000','gps-linked-summits-50','gps-linked-summits-100',
        'active-months-24','active-months-36','active-years-5','summits-in-year-25',
        'calendar-months-represented-9','ascent-photos-50','ascent-photos-100'
      ]::text[]) then 'rare'
      when ua.achievement_id = any (array[
        'ten-ascents','twenty-five-ascents','ten-thousand-height','summit-elevation-total-25000',
        'summit-height-1500','above-clouds','altitude-zone-2000-2499','altitude-zone-2500-2999',
        'altitude-zones-3','countries-2','countries-3','gps-tracks-10','gps-tracks-25',
        'gps-distance-km-100','gps-distance-km-250','gps-elevation-gain-10000',
        'gps-elevation-gain-25000','gps-linked-summits-10','gps-linked-summits-25',
        'active-months-6','active-months-12','active-years-2','active-years-3',
        'summits-in-year-10','calendar-months-represented-6','ascent-photos-10',
        'ascent-photos-25','favorites-10','favorites-25','zugspitze'
      ]::text[]) then 'uncommon'
      else 'common'
    end as rarity
  from public.user_achievements as ua
  where ua.user_id = requested_user_id
    and public.is_registered_achievement_id(ua.achievement_id)
  order by ua.achievement_id, ua.unlocked_at desc
),
aggregates as (
  select
    count(*)::integer as unlocked_count,
    coalesce(sum(case rarity
      when 'legendary' then 250
      when 'epic' then 100
      when 'rare' then 50
      when 'uncommon' then 25
      else 10
    end), 0)::integer as milestone_points,
    count(*) filter (where rarity = 'rare')::integer as distinguished_count,
    count(*) filter (where rarity = 'epic')::integer as exceptional_count,
    count(*) filter (where rarity = 'legendary')::integer as lifetime_count
  from registered
),
safe_rows as (
  select achievement_id, unlocked_at
  from registered
  where achievement_id = any (array[
    'first-ascent','five-ascents','ten-ascents','twenty-five-ascents','fifty-ascents',
    'summits-100','summits-250','summits-500','summits-750','summits-1000',
    'summit-elevation-total-1000','summit-elevation-total-5000','ten-thousand-height',
    'summit-elevation-total-25000','summit-elevation-total-50000','summit-elevation-total-100000',
    'summit-elevation-total-250000','summit-elevation-total-500000',
    'summit-elevation-total-750000','summit-elevation-total-1000000',
    'summit-height-500','summit-height-1000','summit-height-1500','above-clouds',
    'summit-height-2500','summit-height-3000','summit-height-3500','summit-height-4000',
    'altitude-zone-below-1000','altitude-zone-1000-1499','altitude-zone-1500-1999',
    'altitude-zone-2000-2499','altitude-zone-2500-2999','altitude-zone-3000-3499',
    'altitude-zone-3500-plus','altitude-zones-3','altitude-zones-5','altitude-zones-7',
    'active-months-1','active-months-3','active-months-6','active-months-12',
    'active-months-24','active-months-36','active-months-60','active-months-120',
    'active-years-2','active-years-3','active-years-5','active-years-10','active-years-15',
    'summits-in-year-5','summits-in-year-10','summits-in-year-25','summits-in-year-50',
    'calendar-months-represented-3','calendar-months-represented-6',
    'calendar-months-represented-9','calendar-months-represented-12','zugspitze'
  ]::text[])
),
safe_json as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object('id', achievement_id, 'unlockedAt', unlocked_at)
      order by unlocked_at desc, achievement_id
    ),
    '[]'::jsonb
  ) as achievements
  from safe_rows
)
select jsonb_build_object(
  'unlockedCount', aggregates.unlocked_count,
  'totalDefinitions', 111,
  'milestonePoints', aggregates.milestone_points,
  'completionPercent', round((aggregates.unlocked_count::numeric / 111) * 100),
  'distinguishedCount', aggregates.distinguished_count,
  'exceptionalCount', aggregates.exceptional_count,
  'lifetimeCount', aggregates.lifetime_count,
  'safeAchievements', safe_json.achievements
)
from aggregates
cross join safe_json;
$function$;

revoke all on function public.get_public_user_achievement_summary(uuid) from public;
grant execute on function public.get_public_user_achievement_summary(uuid) to anon, authenticated;
