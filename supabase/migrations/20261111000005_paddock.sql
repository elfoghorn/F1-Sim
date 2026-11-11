-- =====================================================================
-- F1 SIM: announcements, profiles, awards and team depth.
--   f1_notices     Race Control's announcements (Race Control writes).
--   f1_diary, f1_relations, f1_votes, f1_parts, f1_contracts
--                  belong to the account that made them: diary entries,
--                  declared relationships, Driver of the Day votes,
--                  power unit orders, and contracts, offers and sponsor
--                  deals. The app checks each against the seats.
-- =====================================================================
create or replace function public.gm_only_collection(c text) returns boolean
language sql immutable as $$
    select c = any (array['f1_teams', 'f1_people', 'f1_seats', 'f1_tracks', 'f1_weekends', 'f1_settings', 'f1_notices'])
$$;
create or replace function public.owned_collection(c text) returns boolean
language sql immutable as $$
    select c = any (array['characters', 'f1_applications', 'f1_posts', 'f1_calls', 'f1_runs', 'f1_projects', 'f1_dev', 'f1_plans',
                          'f1_diary', 'f1_relations', 'f1_votes', 'f1_parts', 'f1_contracts'])
$$;
