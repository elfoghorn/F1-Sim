-- =====================================================================
-- F1 SIM: race strategy. Each team member's saved plans for a car belong
-- to the account that saved them; the app uses the latest saved by
-- someone allowed to plan that car.
-- =====================================================================
create or replace function public.owned_collection(c text) returns boolean
language sql immutable as $$
    select c = any (array['characters', 'f1_applications', 'f1_posts', 'f1_calls', 'f1_runs', 'f1_projects', 'f1_dev', 'f1_plans'])
$$;
