-- F1 SIM 2027 — Row Level Security Policies
-- Authorization lives in Postgres: RLS for reads/plain writes,
-- security-definer functions for rule-bound actions.

-- ── Enable RLS on all league tables ──────────────────────────────────────────

alter table public.profiles           enable row level security;
alter table public.seasons            enable row level security;
alter table public.league_teams       enable row level security;
alter table public.league_drivers     enable row level security;
alter table public.parts              enable row level security;
alter table public.team_loadouts      enable row level security;
alter table public.rounds             enable row level security;
alter table public.round_orders       enable row level security;
alter table public.round_snapshots    enable row level security;
alter table public.session_runs       enable row level security;
alter table public.penalties          enable row level security;
alter table public.change_requests    enable row level security;
alter table public.notifications      enable row level security;
alter table public.notification_prefs enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.audit_log          enable row level security;

-- ── Helper: get caller's role ─────────────────────────────────────────────────

create or replace function public.my_role()
returns public.user_role language sql stable security definer as $$
  select role from public.profiles where id = auth.uid();
$$;

-- ── profiles ─────────────────────────────────────────────────────────────────

-- Any signed-in user can read all profiles
create policy "profiles_read_all"       on public.profiles for select using (auth.uid() is not null);
-- Players update their own player-owned fields only
create policy "profiles_update_own"     on public.profiles for update using (id = auth.uid());
-- GMs/Admins can update any profile
create policy "profiles_update_gm"      on public.profiles for update using (public.my_role() in ('gm','admin'));

-- ── seasons ──────────────────────────────────────────────────────────────────

create policy "seasons_read"            on public.seasons for select using (auth.uid() is not null);
create policy "seasons_write_gm"        on public.seasons for all    using (public.my_role() in ('gm','admin'));

-- ── league_teams ─────────────────────────────────────────────────────────────

create policy "teams_read"              on public.league_teams for select using (auth.uid() is not null);
create policy "teams_write_gm"          on public.league_teams for all    using (public.my_role() in ('gm','admin'));
-- Team Principal can update their own team (non-stat fields)
create policy "teams_update_principal"  on public.league_teams for update using (principal_id = auth.uid());

-- ── league_drivers ───────────────────────────────────────────────────────────

create policy "drivers_read"            on public.league_drivers for select using (auth.uid() is not null);
create policy "drivers_write_gm"        on public.league_drivers for all    using (public.my_role() in ('gm','admin'));
-- Players can update their own driver's player-owned fields (bio, portrait_url)
create policy "drivers_update_owner"    on public.league_drivers for update using (owner_id = auth.uid());

-- ── parts ────────────────────────────────────────────────────────────────────

create policy "parts_read"              on public.parts for select using (auth.uid() is not null);
create policy "parts_write_gm"          on public.parts for all    using (public.my_role() in ('gm','admin'));

-- ── team_loadouts ────────────────────────────────────────────────────────────

create policy "loadouts_read"           on public.team_loadouts for select using (auth.uid() is not null);
-- equip_part function (security definer) handles writes — no direct write policy

-- ── rounds ───────────────────────────────────────────────────────────────────

create policy "rounds_read"             on public.rounds for select using (auth.uid() is not null);
create policy "rounds_write_gm"         on public.rounds for all    using (public.my_role() in ('gm','admin'));

-- ── round_orders ─────────────────────────────────────────────────────────────

create policy "orders_read_own"         on public.round_orders for select using (
  auth.uid() is not null and (
    public.my_role() in ('gm','admin') or
    team_id in (select id from public.league_teams where principal_id = auth.uid())
  )
);
create policy "orders_write_principal"  on public.round_orders for all using (
  team_id in (select id from public.league_teams where principal_id = auth.uid())
  or public.my_role() in ('gm','admin')
);

-- ── round_snapshots ──────────────────────────────────────────────────────────

create policy "snapshots_read_gm"       on public.round_snapshots for select using (public.my_role() in ('gm','admin'));
create policy "snapshots_write_gm"      on public.round_snapshots for all    using (public.my_role() in ('gm','admin'));

-- ── session_runs ─────────────────────────────────────────────────────────────

-- Everyone can read published runs; GMs see all
create policy "runs_read_published"     on public.session_runs for select using (
  status = 'published' or public.my_role() in ('gm','admin')
);
create policy "runs_write_gm"           on public.session_runs for all    using (public.my_role() in ('gm','admin'));

-- ── penalties ────────────────────────────────────────────────────────────────

create policy "penalties_read"          on public.penalties for select using (auth.uid() is not null);
create policy "penalties_write_gm"      on public.penalties for all    using (public.my_role() in ('gm','admin'));

-- ── change_requests ──────────────────────────────────────────────────────────

create policy "requests_read"           on public.change_requests for select using (
  requested_by = auth.uid() or public.my_role() in ('gm','admin')
);
create policy "requests_insert_player"  on public.change_requests for insert with check (
  requested_by = auth.uid()
);
create policy "requests_decide_gm"      on public.change_requests for update using (public.my_role() in ('gm','admin'));

-- ── notifications ────────────────────────────────────────────────────────────

create policy "notifs_read_own"         on public.notifications for select using (recipient_id = auth.uid());
create policy "notifs_read_gm"          on public.notifications for select using (public.my_role() in ('gm','admin'));
-- Only server-side functions create notifications — no direct insert policy for anon/player

-- ── notification_prefs ───────────────────────────────────────────────────────

create policy "prefs_own"               on public.notification_prefs for all using (profile_id = auth.uid());

-- ── notification_outbox ──────────────────────────────────────────────────────

create policy "outbox_read_gm"          on public.notification_outbox for select using (public.my_role() in ('gm','admin'));

-- ── audit_log ────────────────────────────────────────────────────────────────

-- Append-only: no update or delete policies
create policy "audit_read_gm"           on public.audit_log for select using (public.my_role() in ('gm','admin'));
-- Service role writes via security-definer functions

-- ── Realtime: allow players to subscribe to their own notifications ───────────

-- (Enable Realtime on the notifications table in the Supabase dashboard)
-- Auth setup note: in Supabase → Auth → Settings, disable "Confirm email"
-- so users can sign in immediately after creating their account.
