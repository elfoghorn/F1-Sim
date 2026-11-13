-- F1 SIM: endurance race weekends (Endurance Phase 4).
-- Endurance weekends live in their own collection, f1_endw, written only by Race Control, like f1_weekends.
-- Crews' stint plans and live calls use the existing player-owned collections f1_plans and f1_calls (marked kind = 'end').

create or replace function public.gm_only_collection(c text) returns boolean
language sql immutable as $$
    select c = any (array['f1_teams', 'f1_people', 'f1_seats', 'f1_tracks', 'f1_weekends', 'f1_settings', 'f1_notices', 'f1_series', 'f1_seasons', 'f1_endw'])
$$;
