-- ============================================================
-- F1 SIM 2027 — Supabase Community Model Schema
-- Run this entire file in: Supabase → SQL Editor → New Query
-- ============================================================

-- ── Enable UUID extension ────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ============================================================
-- TABLE 1: race_sims
-- One row per Multi-Sim run submitted by a user.
-- This is the raw training data.
-- ============================================================
CREATE TABLE IF NOT EXISTS race_sims (
  id               uuid    DEFAULT uuid_generate_v4() PRIMARY KEY,
  created_at       timestamptz DEFAULT now(),

  -- Anonymous identity (UUID generated in browser, stored in localStorage)
  session_id       text    NOT NULL,

  -- Race context
  circuit_id       text    NOT NULL,   -- e.g. "monaco", "bahrain"
  series           text    NOT NULL DEFAULT 'f1',
  sim_accuracy     integer NOT NULL,   -- number of Monte Carlo runs (1/5/10/20)

  -- What the model predicted (top 5 only)
  -- [{ driver_id, win_pct, podium_pct, avg_pos }]
  predicted_top5   jsonb   NOT NULL DEFAULT '[]'::jsonb,

  -- Driver stats as the user had them configured at time of submission
  -- [{ id, pace, consistency, wet, overtaking, defense, experience, mental, style }]
  driver_stats     jsonb   NOT NULL DEFAULT '[]'::jsonb,

  -- Team pace ratings at time of submission
  -- [{ id, pace }]
  team_paces       jsonb   NOT NULL DEFAULT '[]'::jsonb,

  -- Actual race result (only populated when user saves to championship)
  actual_winner_id   text,
  prediction_correct boolean
);

-- Index for fast circuit lookups
CREATE INDEX IF NOT EXISTS idx_race_sims_circuit ON race_sims (circuit_id);
CREATE INDEX IF NOT EXISTS idx_race_sims_session  ON race_sims (session_id);
CREATE INDEX IF NOT EXISTS idx_race_sims_created  ON race_sims (created_at DESC);


-- ============================================================
-- TABLE 2: community_model
-- Aggregated per-circuit per-driver win rates.
-- Updated by the aggregate_community_model() function below.
-- The F1 SIM app reads from this table (not race_sims directly).
-- ============================================================
CREATE TABLE IF NOT EXISTS community_model (
  circuit_id       text    NOT NULL,
  driver_id        text    NOT NULL,
  avg_win_pct      float   NOT NULL DEFAULT 0,
  avg_podium_pct   float   NOT NULL DEFAULT 0,
  avg_position     float   NOT NULL DEFAULT 11,
  sample_count     integer NOT NULL DEFAULT 0,
  last_updated     timestamptz DEFAULT now(),
  PRIMARY KEY (circuit_id, driver_id)
);

CREATE INDEX IF NOT EXISTS idx_community_circuit ON community_model (circuit_id);


-- ============================================================
-- TABLE 3: community_global
-- Global accuracy stats across all circuits.
-- ============================================================
CREATE TABLE IF NOT EXISTS community_global (
  id               text    PRIMARY KEY DEFAULT 'global',
  total_sims       integer DEFAULT 0,
  total_with_result integer DEFAULT 0,
  win_accuracy     float   DEFAULT 0,
  podium_accuracy  float   DEFAULT 0,
  most_active_circuit text,
  last_updated     timestamptz DEFAULT now()
);

INSERT INTO community_global (id) VALUES ('global')
ON CONFLICT (id) DO NOTHING;


-- ============================================================
-- FUNCTION: aggregate_community_model()
-- Recomputes community_model from raw race_sims data.
-- Run this after each batch of new submissions (or on a cron).
-- ============================================================
CREATE OR REPLACE FUNCTION aggregate_community_model()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  circuit_rec record;
  driver_rec  record;
BEGIN
  -- For each distinct circuit in race_sims
  FOR circuit_rec IN SELECT DISTINCT circuit_id FROM race_sims LOOP

    -- For each driver that appears in predicted_top5 for this circuit
    FOR driver_rec IN
      SELECT DISTINCT (elem->>'driver_id') AS driver_id
      FROM race_sims,
           jsonb_array_elements(predicted_top5) AS elem
      WHERE circuit_id = circuit_rec.circuit_id
        AND elem->>'driver_id' IS NOT NULL
    LOOP
      INSERT INTO community_model (circuit_id, driver_id, avg_win_pct, avg_podium_pct, avg_position, sample_count, last_updated)
      SELECT
        circuit_rec.circuit_id,
        driver_rec.driver_id,
        AVG((elem->>'win_pct')::float),
        AVG((elem->>'podium_pct')::float),
        AVG((elem->>'avg_pos')::float),
        COUNT(*),
        now()
      FROM race_sims,
           jsonb_array_elements(predicted_top5) AS elem
      WHERE circuit_id   = circuit_rec.circuit_id
        AND (elem->>'driver_id') = driver_rec.driver_id
        AND sim_accuracy  >= 5       -- only include runs with meaningful accuracy
      ON CONFLICT (circuit_id, driver_id) DO UPDATE SET
        avg_win_pct    = EXCLUDED.avg_win_pct,
        avg_podium_pct = EXCLUDED.avg_podium_pct,
        avg_position   = EXCLUDED.avg_position,
        sample_count   = EXCLUDED.sample_count,
        last_updated   = now();
    END LOOP;

  END LOOP;

  -- Update global stats
  UPDATE community_global SET
    total_sims    = (SELECT COUNT(*) FROM race_sims),
    total_with_result = (SELECT COUNT(*) FROM race_sims WHERE actual_winner_id IS NOT NULL),
    win_accuracy  = (
      SELECT COALESCE(
        SUM(CASE WHEN prediction_correct THEN 1.0 ELSE 0 END)::float
        / NULLIF(COUNT(*) FILTER (WHERE actual_winner_id IS NOT NULL), 0),
        0
      ) FROM race_sims
    ),
    most_active_circuit = (
      SELECT circuit_id FROM race_sims
      GROUP BY circuit_id ORDER BY COUNT(*) DESC LIMIT 1
    ),
    last_updated  = now()
  WHERE id = 'global';

END;
$$;


-- ============================================================
-- TRIGGER: auto-aggregate after new inserts (optional)
-- Uncomment if you want real-time updates.
-- For high traffic, use a scheduled cron instead.
-- ============================================================
-- CREATE OR REPLACE FUNCTION trigger_aggregate()
-- RETURNS trigger LANGUAGE plpgsql AS $$
-- BEGIN
--   PERFORM aggregate_community_model();
--   RETURN NEW;
-- END;
-- $$;
--
-- CREATE TRIGGER on_sim_insert
-- AFTER INSERT ON race_sims
-- FOR EACH STATEMENT EXECUTE FUNCTION trigger_aggregate();


-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- Allows anyone to INSERT (submit data) with the anon key.
-- Anyone can SELECT (read community model).
-- No one can UPDATE or DELETE (prevents tampering).
-- ============================================================
ALTER TABLE race_sims       ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_model ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_global ENABLE ROW LEVEL SECURITY;

-- race_sims: public insert, no read (raw data stays private)
CREATE POLICY "allow_insert" ON race_sims FOR INSERT TO anon WITH CHECK (true);

-- community_model: public read only
CREATE POLICY "allow_read"   ON community_model  FOR SELECT TO anon USING (true);
CREATE POLICY "allow_read"   ON community_global FOR SELECT TO anon USING (true);


-- ============================================================
-- SCHEDULED AGGREGATION (Supabase pg_cron)
-- Uncomment to run aggregation every hour automatically.
-- Requires pg_cron extension enabled in Supabase dashboard.
-- ============================================================
-- SELECT cron.schedule(
--   'aggregate-community-model',
--   '0 * * * *',              -- every hour
--   $$ SELECT aggregate_community_model(); $$
-- );


-- ============================================================
-- INITIAL AGGREGATE RUN
-- Run this after creating the schema to initialise the tables.
-- ============================================================
SELECT aggregate_community_model();


-- ============================================================
-- VERIFICATION QUERIES
-- Run these to confirm everything was set up correctly.
-- ============================================================

-- Check tables exist
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('race_sims', 'community_model', 'community_global');

-- Check RLS is enabled
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('race_sims', 'community_model', 'community_global');

-- Check policies
SELECT tablename, policyname, cmd FROM pg_policies
WHERE schemaname = 'public';
