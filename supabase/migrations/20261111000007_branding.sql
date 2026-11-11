-- =====================================================================
-- F1 SIM: team branding. A team principal's uploaded pictures belong to
-- the account that uploaded them; the app shows them while that
-- character holds the team's principal seat. Race Control's go on the
-- team itself.
-- =====================================================================
create or replace function public.owned_collection(c text) returns boolean
language sql immutable as $$
    select c = any (array['characters', 'f1_applications', 'f1_posts', 'f1_calls', 'f1_runs', 'f1_projects', 'f1_dev', 'f1_plans',
                          'f1_diary', 'f1_relations', 'f1_votes', 'f1_parts', 'f1_contracts', 'f1_branding'])
$$;
