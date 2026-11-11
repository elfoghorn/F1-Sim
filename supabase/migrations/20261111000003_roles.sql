-- =====================================================================
-- F1 SIM: roles. Practice runs, upgrade orders and driver development
-- belong to the account that made them, like characters and posts.
-- Race Control locks upgrade orders in when it opens a weekend; the app
-- checks every record against the seats and the budget before using it.
-- =====================================================================
create or replace function public.owned_collection(c text) returns boolean
language sql immutable as $$
    select c = any (array['characters', 'f1_applications', 'f1_posts', 'f1_calls', 'f1_runs', 'f1_projects', 'f1_dev'])
$$;
