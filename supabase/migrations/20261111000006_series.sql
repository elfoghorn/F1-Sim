-- =====================================================================
-- F1 SIM: series and seasons. Race Control alone sets up series and
-- catalogues or starts seasons.
-- =====================================================================
create or replace function public.gm_only_collection(c text) returns boolean
language sql immutable as $$
    select c = any (array['f1_teams', 'f1_people', 'f1_seats', 'f1_tracks', 'f1_weekends', 'f1_settings', 'f1_notices', 'f1_series', 'f1_seasons'])
$$;
