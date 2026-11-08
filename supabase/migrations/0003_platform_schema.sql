-- F1 SIM 2027 — Platform Schema (Phase 2)
-- Characters, Applications, Stats, Contracts, Rolls, Announcements
-- Run after 0001 and 0002

-- ── Enumerations ─────────────────────────────────────────────────────────────

create type public.character_type   as enum ('driver','mechanic','engineer','team_principal');
create type public.app_status       as enum ('draft','submitted','under_review','revision_requested','approved','rejected','archived');
create type public.staff_role       as enum ('mechanic','engineer','strategist','team_principal');

-- ── characters ───────────────────────────────────────────────────────────────
-- Player-created characters (drivers and staff)

create table public.characters (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid        not null references public.profiles(id) on delete cascade,
  season_id       uuid        references public.seasons(id) on delete set null,
  type            character_type not null,
  name            text        not null,
  nationality     text        not null default '',
  flag            text        not null default '🏁',
  number          int         check (number between 1 and 99),  -- drivers only
  abbr            text        not null default '',              -- drivers only
  portrait_url    text        not null default '',
  bio             text        not null default '',
  backstory       text        not null default '',
  -- Driver stats
  pace            int         not null default 70 check (pace between 1 and 99),
  consistency     int         not null default 70,
  wet             int         not null default 70,
  overtaking      int         not null default 70,
  defense         int         not null default 70,
  experience      int         not null default 50,
  mental          int         not null default 7  check (mental between 1 and 10),
  style           text        not null default 'balanced',
  good_tracks     text[]      not null default '{}',
  bad_tracks      text[]      not null default '{}',
  -- Staff stats
  technical       int         not null default 70,
  strategy_skill  int         not null default 70,
  leadership      int         not null default 70,
  morale          int         not null default 70,
  -- Meta
  is_active       boolean     not null default false,  -- GM-approved and in-league
  team_id         uuid        references public.league_teams(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ── applications ─────────────────────────────────────────────────────────────

create table public.applications (
  id              uuid primary key default gen_random_uuid(),
  character_id    uuid        not null references public.characters(id) on delete cascade,
  applicant_id    uuid        not null references public.profiles(id) on delete cascade,
  season_id       uuid        references public.seasons(id) on delete set null,
  desired_team_id uuid        references public.league_teams(id) on delete set null,
  status          app_status  not null default 'draft',
  form_data       jsonb       not null default '{}'::jsonb,  -- multi-step form answers
  gm_notes        text        not null default '',
  revision_note   text        not null default '',           -- what GM wants revised
  submitted_at    timestamptz,
  reviewed_by     uuid        references public.profiles(id),
  decided_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ── driver_stats_history ─────────────────────────────────────────────────────
-- Audit trail of GM stat edits

create table public.driver_stats_history (
  id          bigserial   primary key,
  character_id uuid       not null references public.characters(id) on delete cascade,
  stat        text        not null,
  old_value   int,
  new_value   int,
  reason      text        not null default '',
  changed_by  uuid        references public.profiles(id),
  changed_at  timestamptz not null default now()
);

-- ── contracts ────────────────────────────────────────────────────────────────

create table public.contracts (
  id          uuid primary key default gen_random_uuid(),
  character_id uuid       not null references public.characters(id) on delete cascade,
  team_id     uuid        not null references public.league_teams(id) on delete cascade,
  season_id   uuid        not null references public.seasons(id) on delete cascade,
  role        text        not null,
  salary      numeric     not null default 0,
  start_round int         not null default 1,
  end_round   int,
  is_active   boolean     not null default true,
  signed_at   timestamptz not null default now(),
  signed_by   uuid        references public.profiles(id)
);

-- ── roll_history ─────────────────────────────────────────────────────────────
-- Records every dice/stat roll with seed for reproducibility

create table public.roll_history (
  id          bigserial   primary key,
  round_id    uuid        references public.rounds(id) on delete set null,
  roll_type   text        not null check (roll_type in ('qualifying','race','sprint','sprint_quali','custom')),
  seed        bigint      not null,
  config      jsonb       not null default '{}'::jsonb,
  result      jsonb       not null default '{}'::jsonb,
  rolled_by   uuid        references public.profiles(id),
  rolled_at   timestamptz not null default now()
);

-- ── announcements ────────────────────────────────────────────────────────────

create table public.announcements (
  id          uuid primary key default gen_random_uuid(),
  title       text        not null,
  body        text        not null,
  kind        text        not null default 'general' check (kind in ('general','race','transfer','rules','emergency')),
  is_pinned   boolean     not null default false,
  author_id   uuid        references public.profiles(id),
  season_id   uuid        references public.seasons(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── RLS ──────────────────────────────────────────────────────────────────────

alter table public.characters             enable row level security;
alter table public.applications           enable row level security;
alter table public.driver_stats_history   enable row level security;
alter table public.contracts              enable row level security;
alter table public.roll_history           enable row level security;
alter table public.announcements          enable row level security;

-- characters: players see their own; GMs see all; everyone can see active chars
create policy "chars_read_own"   on public.characters for select using (owner_id = auth.uid() or is_active = true or public.my_role() in ('gm','admin'));
create policy "chars_insert_own" on public.characters for insert with check (owner_id = auth.uid());
create policy "chars_update_own" on public.characters for update using (owner_id = auth.uid() or public.my_role() in ('gm','admin'));
create policy "chars_delete_own" on public.characters for delete using (owner_id = auth.uid() or public.my_role() in ('gm','admin'));

-- applications
create policy "apps_read"        on public.applications for select using (applicant_id = auth.uid() or public.my_role() in ('gm','admin'));
create policy "apps_insert"      on public.applications for insert with check (applicant_id = auth.uid());
create policy "apps_update_own"  on public.applications for update using (applicant_id = auth.uid() or public.my_role() in ('gm','admin'));

-- stat history: GMs only
create policy "stats_hist_gm"    on public.driver_stats_history for select using (public.my_role() in ('gm','admin'));
create policy "stats_hist_insert" on public.driver_stats_history for insert with check (public.my_role() in ('gm','admin'));

-- contracts
create policy "contracts_read"   on public.contracts for select using (auth.uid() is not null);
create policy "contracts_gm"     on public.contracts for all using (public.my_role() in ('gm','admin'));

-- roll history
create policy "rolls_read_gm"    on public.roll_history for select using (public.my_role() in ('gm','admin'));
create policy "rolls_insert_gm"  on public.roll_history for insert with check (public.my_role() in ('gm','admin'));

-- announcements: everyone reads; GMs write
create policy "ann_read"         on public.announcements for select using (auth.uid() is not null);
create policy "ann_write_gm"     on public.announcements for all using (public.my_role() in ('gm','admin'));
