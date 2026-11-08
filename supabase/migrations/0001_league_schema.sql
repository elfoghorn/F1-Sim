-- F1 SIM 2027 — League Schema
-- Phase 0/1: Accounts, Profiles, League Data
-- Run in: Supabase → SQL Editor

-- ── Enumerations ─────────────────────────────────────────────────────────────

create type public.user_role     as enum ('player','gm','admin');
create type public.round_state   as enum ('scheduled','orders_open','locked','in_progress','complete');
create type public.session_type  as enum ('sprint_quali','sprint','qualifying','race');
create type public.run_status    as enum ('provisional','published','superseded');
create type public.request_kind  as enum ('style_change','number_change');
create type public.request_status as enum ('pending','approved','rejected');

-- ── profiles ─────────────────────────────────────────────────────────────────
-- One row per signed-in user. Auto-created by trigger on auth.users insert.

create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  discord_id    text,
  display_name  text        not null default '',
  avatar_url    text,
  bio           text        default '',
  social_handle text        default '',
  role          user_role   not null default 'player',
  notify_prefs  jsonb       not null default '{"in_app":true,"discord":true}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Auto-create profile on sign-up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, discord_id, display_name, avatar_url)
  values (
    new.id,
    new.raw_user_meta_data->>'provider_id',
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', 'Player'),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do update set
    discord_id   = excluded.discord_id,
    display_name = coalesce(excluded.display_name, profiles.display_name),
    avatar_url   = coalesce(excluded.avatar_url,   profiles.avatar_url),
    updated_at   = now();
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ── seasons ──────────────────────────────────────────────────────────────────

create table public.seasons (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null,
  year        int         not null default extract(year from now())::int,
  status      text        not null default 'draft' check (status in ('draft','active','finished')),
  created_by  uuid        references public.profiles(id),
  created_at  timestamptz not null default now()
);

-- ── teams (per-season) ───────────────────────────────────────────────────────

create table public.league_teams (
  id               uuid primary key default gen_random_uuid(),
  season_id        uuid        not null references public.seasons(id) on delete cascade,
  key              text        not null,              -- matches TEAMS[].id in JSX
  name             text        not null,
  color            text        not null default '#888',
  tier             text        not null default 'mid' check (tier in ('top','mid','low')),
  principal_id     uuid        references public.profiles(id),
  budget_cap_start numeric     not null default 15000000,
  budget_cap       numeric     not null default 15000000,
  car_pace         int         not null default 75 check (car_pace between 1 and 99),
  reliability      int         not null default 75 check (reliability between 1 and 99),
  pit_speed        int         not null default 80 check (pit_speed between 1 and 99),
  tyre_life        int         not null default 65 check (tyre_life between 1 and 99),
  cornering        int         not null default 10 check (cornering between 1 and 20),
  top_speed        int         not null default 10 check (top_speed between 1 and 20),
  strategy         text        not null default 'reactive',
  updated_at       timestamptz not null default now(),
  unique (season_id, key)
);

-- ── drivers (per-season seat) ────────────────────────────────────────────────

create table public.league_drivers (
  id           uuid primary key default gen_random_uuid(),
  season_id    uuid        not null references public.seasons(id) on delete cascade,
  team_id      uuid        not null references public.league_teams(id) on delete cascade,
  owner_id     uuid        references public.profiles(id),   -- null = unclaimed seat
  name         text        not null,
  abbr         text        not null default '',
  number       int         not null check (number between 1 and 99),
  flag         text        not null default '🏁',
  style        text        not null default 'balanced' check (style in ('aggressive','smooth','balanced','defensive','wet_weather')),
  pace         int         not null default 78 check (pace between 1 and 99),
  consistency  int         not null default 78,
  wet          int         not null default 75,
  overtaking   int         not null default 75,
  defense      int         not null default 75,
  experience   int         not null default 65,
  mental       int         not null default 7  check (mental between 1 and 10),
  good_tracks  text[]      not null default '{}',
  bad_tracks   text[]      not null default '{}',
  rivals       text[]      not null default '{}',
  bio          text        default '',
  portrait_url text        default '',
  updated_at   timestamptz not null default now(),
  unique (season_id, number)
);

-- ── parts catalogue ──────────────────────────────────────────────────────────

create table public.parts (
  id           uuid primary key default gen_random_uuid(),
  season_id    uuid        references public.seasons(id) on delete cascade,  -- null = global
  slot         text        not null check (slot in ('engine','front_wing','rear_wing','suspension','brakes')),
  name         text        not null,
  cost         int         not null default 0,
  unlock_round int         not null default 0,
  stats        jsonb       not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

-- ── team loadouts ────────────────────────────────────────────────────────────

create table public.team_loadouts (
  team_id  uuid not null references public.league_teams(id) on delete cascade,
  slot     text not null,
  part_id  uuid not null references public.parts(id),
  primary key (team_id, slot)
);

-- ── rounds ───────────────────────────────────────────────────────────────────

create table public.rounds (
  id              uuid primary key default gen_random_uuid(),
  season_id       uuid        not null references public.seasons(id) on delete cascade,
  number          int         not null,
  circuit_id      text        not null,   -- matches TRACKS[].id
  circuit_name    text        not null default '',
  is_sprint       boolean     not null default false,
  state           round_state not null default 'scheduled',
  orders_close_at timestamptz,
  scheduled_for   timestamptz,
  created_by      uuid        references public.profiles(id),
  created_at      timestamptz not null default now(),
  unique (season_id, number)
);

-- ── round orders (team strategy per round) ───────────────────────────────────

create table public.round_orders (
  round_id      uuid not null references public.rounds(id) on delete cascade,
  team_id       uuid not null references public.league_teams(id) on delete cascade,
  strategy      text not null,
  submitted_by  uuid references public.profiles(id),
  submitted_at  timestamptz not null default now(),
  primary key (round_id, team_id)
);

-- ── round snapshots (inputs frozen at Lock) ──────────────────────────────────

create table public.round_snapshots (
  id          uuid primary key default gen_random_uuid(),
  round_id    uuid        not null unique references public.rounds(id) on delete cascade,
  snapshot    jsonb       not null,
  created_at  timestamptz not null default now()
);

-- ── session runs ─────────────────────────────────────────────────────────────

create table public.session_runs (
  id              uuid primary key default gen_random_uuid(),
  round_id        uuid         not null references public.rounds(id) on delete cascade,
  session         session_type not null,
  attempt         int          not null default 1,
  seed            bigint       not null,
  engine_version  text         not null default '2027.1',
  mode            text         not null default 'single' check (mode in ('single','averaged')),
  run_count       int          not null default 1,
  result          jsonb        not null default '{}'::jsonb,
  status          run_status   not null default 'provisional',
  run_by          uuid         references public.profiles(id),
  run_at          timestamptz  not null default now()
);

-- ── penalties ────────────────────────────────────────────────────────────────

create table public.penalties (
  id          uuid primary key default gen_random_uuid(),
  round_id    uuid not null references public.rounds(id) on delete cascade,
  driver_id   uuid not null references public.league_drivers(id) on delete cascade,
  kind        text not null check (kind in ('time','grid','dsq','warning')),
  value       numeric not null default 0,
  reason      text not null default '',
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);

-- ── change requests ──────────────────────────────────────────────────────────

create table public.change_requests (
  id            uuid primary key default gen_random_uuid(),
  kind          request_kind   not null,
  subject_id    uuid           not null references public.league_drivers(id) on delete cascade,
  payload       jsonb          not null default '{}'::jsonb,
  reason        text           not null default '',
  status        request_status not null default 'pending',
  requested_by  uuid           references public.profiles(id),
  decided_by    uuid           references public.profiles(id),
  created_at    timestamptz    not null default now(),
  decided_at    timestamptz
);

-- ── notifications ────────────────────────────────────────────────────────────

create table public.notifications (
  id           uuid primary key default gen_random_uuid(),
  recipient_id uuid        not null references public.profiles(id) on delete cascade,
  kind         text        not null,
  payload      jsonb       not null default '{}'::jsonb,
  dedupe_key   text,
  read_at      timestamptz,
  created_at   timestamptz not null default now(),
  unique (recipient_id, dedupe_key)
);

create table public.notification_prefs (
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  kind        text not null,
  in_app      boolean not null default true,
  discord     boolean not null default true,
  primary key (profile_id, kind)
);

create table public.notification_outbox (
  id          uuid primary key default gen_random_uuid(),
  notif_id    uuid not null references public.notifications(id) on delete cascade,
  channel     text not null check (channel in ('in_app','discord')),
  status      text not null default 'pending' check (status in ('pending','sent','failed')),
  attempts    int  not null default 0,
  last_error  text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);

-- ── audit log ────────────────────────────────────────────────────────────────

create table public.audit_log (
  id         bigserial primary key,
  actor_id   uuid        references public.profiles(id),
  action     text        not null,
  entity     text        not null,
  entity_id  uuid,
  before     jsonb,
  after      jsonb,
  at         timestamptz not null default now()
);

-- ── standings view ───────────────────────────────────────────────────────────
-- Points are stored directly on session_runs.result for now.
-- This view aggregates published race results into driver/constructor standings.

create or replace view public.standings as
select
  d.id                   as driver_id,
  d.name                 as driver_name,
  d.number               as driver_number,
  t.id                   as team_id,
  t.name                 as team_name,
  t.color                as team_color,
  d.season_id,
  coalesce(sum((p.value->>'points')::numeric), 0) as driver_points
from public.league_drivers d
join public.league_teams t on t.id = d.team_id
left join lateral (
  select jsonb_array_elements(sr.result->'points') as value
  from public.session_runs sr
  join public.rounds r on r.id = sr.round_id
  where r.season_id = d.season_id
    and sr.status = 'published'
    and sr.result->'points' is not null
) p on true
group by d.id, d.name, d.number, t.id, t.name, t.color, d.season_id;
