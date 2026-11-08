-- =============================================================================
-- F1 Sim 2027 — Base Schema Migration
-- Run once against your Supabase project.
-- Safe to re-run: all statements use IF NOT EXISTS / ON CONFLICT DO UPDATE.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PROFILES — ensure role column exists (created by Supabase auth trigger)
-- ---------------------------------------------------------------------------
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'player';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS nationality TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- ---------------------------------------------------------------------------
-- LEAGUE_TEAMS — text primary key so engine IDs (mclaren, ferrari…) can be used
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS league_teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  abbr        TEXT,
  color       TEXT DEFAULT '#E8002D',
  tier        TEXT DEFAULT 'mid',         -- top | mid | low
  strategy    TEXT DEFAULT 'reactive',
  car_pace    INTEGER DEFAULT 75,
  reliability INTEGER DEFAULT 75,
  pit_speed   INTEGER DEFAULT 80,
  tyre_life   INTEGER DEFAULT 75,
  cornering   INTEGER DEFAULT 10,
  top_speed   INTEGER DEFAULT 10,
  budget_cap  INTEGER DEFAULT 15,
  lore        TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Seed / sync the 11 base teams (matches engine TEAMS array exactly)
INSERT INTO league_teams (id, name, abbr, color, tier, strategy, car_pace, reliability, pit_speed, tyre_life, cornering, top_speed)
VALUES
  ('mclaren',     'McLaren',      'MCL', '#FF8000', 'top', 'aggressive_two', 96, 88, 92, 82, 18, 14),
  ('ferrari',     'Ferrari',      'FER', '#E8002D', 'top', 'overcut',        93, 84, 87, 76, 16, 16),
  ('redbull',     'Red Bull',     'RBR', '#3671C6', 'top', 'one_stop',       91, 83, 95, 79, 16, 15),
  ('mercedes',    'Mercedes',     'MER', '#00D2BE', 'top', 'undercut_king',  89, 91, 88, 83, 14, 14),
  ('williams',    'Williams',     'WIL', '#37BEDD', 'mid', 'fuel_save',      82, 82, 83, 78, 11, 13),
  ('racingbulls', 'Racing Bulls', 'RBX', '#6692FF', 'mid', 'reactive',       81, 79, 84, 74, 12, 13),
  ('astonmartin', 'Aston Martin', 'AMR', '#358C75', 'mid', 'safety_car',     79, 80, 82, 75, 12, 12),
  ('alpine',      'Alpine',       'ALP', '#0093CC', 'mid', 'reactive',       77, 77, 79, 72, 10, 12),
  ('haas',        'Haas',         'HAS', '#B6BABD', 'low', 'tyre_banker',    75, 76, 80, 71, 10, 11),
  ('audi',        'Audi',         'AUD', '#B30000', 'low', 'one_stop',       71, 72, 78, 66,  9, 10),
  ('cadillac',    'Cadillac',     'CAD', '#6B6B6B', 'low', 'fuel_save',      67, 70, 76, 62,  8,  9)
ON CONFLICT (id) DO UPDATE SET
  name        = EXCLUDED.name,
  abbr        = EXCLUDED.abbr,
  color       = EXCLUDED.color,
  tier        = EXCLUDED.tier,
  strategy    = EXCLUDED.strategy,
  car_pace    = EXCLUDED.car_pace,
  reliability = EXCLUDED.reliability,
  pit_speed   = EXCLUDED.pit_speed,
  tyre_life   = EXCLUDED.tyre_life,
  cornering   = EXCLUDED.cornering,
  top_speed   = EXCLUDED.top_speed;

-- ---------------------------------------------------------------------------
-- CHARACTERS — add all Phase 8 columns
-- ---------------------------------------------------------------------------
ALTER TABLE characters ADD COLUMN IF NOT EXISTS sim_style           TEXT;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS mental              INTEGER DEFAULT 7;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS good_tracks         TEXT;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS bad_tracks          TEXT;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS backstory_origin    TEXT;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS backstory_journey   TEXT;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS preferred_conditions TEXT;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS personality         TEXT;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS paddock_reputation  TEXT;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS media_persona       TEXT;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS iconic_quote        TEXT;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS ooc_notes           TEXT;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS paddock_relations   TEXT;

-- Add team_id FK to league_teams (text) — skipped if already exists
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'characters' AND column_name = 'team_id'
  ) THEN
    ALTER TABLE characters
      ADD COLUMN team_id TEXT REFERENCES league_teams(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- LEAGUE_DRIVERS — one record per character on the active grid
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS league_drivers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  team_id      TEXT REFERENCES league_teams(id) ON DELETE SET NULL,
  number       INTEGER,
  is_active    BOOLEAN DEFAULT TRUE,
  joined_at    TIMESTAMPTZ DEFAULT NOW(),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS league_drivers_character_uniq ON league_drivers(character_id);

-- ---------------------------------------------------------------------------
-- LEAGUE_SETTINGS — key/value config store
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS league_settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ---------------------------------------------------------------------------
-- ROUNDS — add type column (race | testing)
-- ---------------------------------------------------------------------------
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'race';

-- ---------------------------------------------------------------------------
-- STANDINGS — cumulative championship points
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS standings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id  UUID REFERENCES characters(id) ON DELETE CASCADE,
  team_id       TEXT REFERENCES league_teams(id) ON DELETE SET NULL,
  driver_name   TEXT,
  team_name     TEXT,
  driver_points INTEGER DEFAULT 0,
  team_points   INTEGER DEFAULT 0,
  wins          INTEGER DEFAULT 0,
  podiums       INTEGER DEFAULT 0,
  dnfs          INTEGER DEFAULT 0,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS standings_character_uniq ON standings(character_id);

-- ---------------------------------------------------------------------------
-- NOTIFICATIONS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  kind         TEXT,
  payload      JSONB DEFAULT '{}',
  read         BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON notifications(recipient_id);

-- ---------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ---------------------------------------------------------------------------
ALTER TABLE league_teams     ENABLE ROW LEVEL SECURITY;
ALTER TABLE league_drivers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE league_settings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE standings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications    ENABLE ROW LEVEL SECURITY;

-- Public read policies
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='league_teams_read_public' AND tablename='league_teams') THEN
    CREATE POLICY league_teams_read_public    ON league_teams    FOR SELECT USING (TRUE);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='league_drivers_read_public' AND tablename='league_drivers') THEN
    CREATE POLICY league_drivers_read_public  ON league_drivers  FOR SELECT USING (TRUE);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='league_settings_read_public' AND tablename='league_settings') THEN
    CREATE POLICY league_settings_read_public ON league_settings FOR SELECT USING (TRUE);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='standings_read_public' AND tablename='standings') THEN
    CREATE POLICY standings_read_public       ON standings       FOR SELECT USING (TRUE);
  END IF;
END $$;

-- Authenticated write policies
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='league_teams_write_auth' AND tablename='league_teams') THEN
    CREATE POLICY league_teams_write_auth    ON league_teams    FOR ALL USING (auth.role() = 'authenticated');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='league_drivers_write_auth' AND tablename='league_drivers') THEN
    CREATE POLICY league_drivers_write_auth  ON league_drivers  FOR ALL USING (auth.role() = 'authenticated');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='league_settings_write_auth' AND tablename='league_settings') THEN
    CREATE POLICY league_settings_write_auth ON league_settings FOR ALL USING (auth.role() = 'authenticated');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='standings_write_auth' AND tablename='standings') THEN
    CREATE POLICY standings_write_auth       ON standings       FOR ALL USING (auth.role() = 'authenticated');
  END IF;
END $$;

-- Notifications: users see only their own
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='notifications_own' AND tablename='notifications') THEN
    CREATE POLICY notifications_own ON notifications FOR ALL USING (auth.uid() = recipient_id);
  END IF;
END $$;
