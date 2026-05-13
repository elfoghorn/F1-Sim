# F1 SIM — Community Model Setup Guide

## What this does

When enabled, F1 SIM sends anonymous simulation data to a shared Supabase database.
As more users contribute, the community model learns which drivers tend to perform
well at each circuit — and blends those probabilities into your local predictions
via Bayesian averaging.

**Privacy: all data is completely anonymous. No names, no emails, no personal info.**

---

## How the model improves

Each time a user runs Multi-Sim, the predicted top-5 win/podium probabilities for
that circuit are sent to the server. After 30+ submissions for a circuit, the
community aggregate is blended into local predictions:

```
fused_win_pct = (1 - α) × local_win_pct + α × community_win_pct

α = min(0.40, total_submissions / 500)
```

- Below 30 submissions: community data ignored (not enough signal)
- At 500+ submissions: community contributes up to 40% of the prediction weight
- The 🌍 badge appears on Multi-Sim driver cards when fusion is active

---

## Step 1 — Create a Supabase Account

1. Go to [supabase.com](https://supabase.com)
2. Click **Start your project** → sign up with GitHub or email (free)
3. Click **New project**
4. Fill in: Project name `f1sim-community`, Database password (save this), Region (nearest to you)
5. Click **Create new project** — takes about 60 seconds

---

## Step 2 — Run the Schema

1. In your Supabase dashboard, click **SQL Editor** in the left sidebar
2. Click **New query**
3. Open the file `supabase_schema.sql` from this folder
4. Paste the entire contents into the SQL editor
5. Click **Run** (or press Ctrl+Enter)
6. Confirm you see the three tables created: `race_sims`, `community_model`, `community_global`

---

## Step 3 — Get Your Credentials

1. In your Supabase dashboard, click **Project Settings** (gear icon)
2. Click **API** in the settings sidebar
3. Copy:
   - **Project URL** — looks like `https://abcdefghijkl.supabase.co`
   - **Project API Keys → anon public** — a long string starting with `eyJ...`

---

## Step 4 — Update the App

Open `f1_simulator_source.jsx` and find these two lines near the top:

```javascript
const SUPABASE_URL  = "https://YOUR_PROJECT.supabase.co";
const SUPABASE_KEY  = "YOUR_ANON_KEY";
```

Replace them with your actual values:

```javascript
const SUPABASE_URL  = "https://abcdefghijkl.supabase.co";
const SUPABASE_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...";
```

Then rebuild the app (run the build pipeline), or if you're comfortable with it,
find and replace the same strings directly in `index.html`.

---

## Step 5 — Enable in the App

1. Open F1 SIM in your browser
2. Click the **⚫ OFFLINE** button in the top-right of the navigation bar
3. It will turn **🟢 LIVE**
4. Or go to **📈 STATS** → **COMMUNITY MODEL** → click **OFF — Click to enable**

The first time you run Multi-Sim with it enabled, data is sent. The ⚠️ Supabase
warning disappears once your credentials are configured correctly.

---

## Step 6 — Set Up Automatic Aggregation (Optional)

By default, you need to manually run the aggregation function to update the
community model table. For automatic hourly updates:

1. In Supabase → **Database** → **Extensions**
2. Enable **pg_cron**
3. Run this in SQL Editor:

```sql
SELECT cron.schedule(
  'aggregate-community-model',
  '0 * * * *',
  $$ SELECT aggregate_community_model(); $$
);
```

Or you can trigger it manually anytime from SQL Editor:

```sql
SELECT aggregate_community_model();
```

---

## How the ML works

### Data collection (race_sims table)

Each submission contains:
- `circuit_id` — which track was simulated
- `sim_accuracy` — how many Monte Carlo runs (only ≥5 are used for aggregation)
- `predicted_top5` — what the model thinks: `[{ driver_id, win_pct, podium_pct, avg_pos }]`
- `driver_stats` — what the user has set for each driver's stats
- `actual_winner_id` — only when saved to championship (enables accuracy tracking)
- `prediction_correct` — whether the predicted winner actually won

The raw driver stats from every user let us see:
- Which stat configurations are most common (community consensus on a driver's ability)
- Which configurations lead to better predictions (supervised signal)

### Aggregation (aggregate_community_model function)

For each (circuit, driver) pair, the function computes:
- `avg_win_pct` — mean predicted win probability across all submissions
- `avg_podium_pct` — mean predicted podium probability
- `avg_position` — mean predicted finishing position
- `sample_count` — how many submissions contributed

This is a simple mean estimator. With more submissions it converges to the
community's best estimate of driver performance at each circuit.

### Bayesian blending (fuseWithCommunity in the app)

When the app fetches community data for a circuit, it blends it with the local
Monte Carlo result:

```javascript
function fuseWithCommunity(localResults, communityRows, circuitId) {
  // Require at least 30 submissions before trusting community data
  if (!communityRows || communityRows.length < 30) return localResults;

  const totalSamples = communityRows.reduce((a, r) => a + r.sample_count, 0);
  
  // α grows from 0 → 0.40 as sample count grows from 0 → 500+
  const alpha = Math.min(0.40, totalSamples / 500);

  return localResults.map(result => {
    const community = communityData[result.driver.id];
    if (!community) return result;
    
    return {
      ...result,
      // Weighted average: local model + community prior
      winPct:    (1 - alpha) * result.winPct    + alpha * community.avg_win_pct,
      podiumPct: (1 - alpha) * result.podiumPct + alpha * community.avg_podium_pct,
      avgPos:    (1 - alpha) * result.avgPos    + alpha * community.avg_position,
      communityFused: true,  // triggers the 🌍 badge in the UI
    };
  }).sort((a, b) => a.avgPos - b.avgPos);
}
```

### What "trains" as more users contribute

The community model learns three things:

1. **Circuit-driver affinity** — at Monaco, does the community consistently predict
   Leclerc higher than the base stats suggest? That's a signal his Monaco stats
   should be higher.

2. **Stat consensus** — if most users bump Verstappen's pace to 97-98 and those
   users' simulations predict more accurately, that validates those stat choices.

3. **Prediction accuracy** — every time a user saves to championship, the actual
   winner is recorded. Over time, the prediction accuracy column in `community_global`
   converges to the true accuracy of the combined model.

---

## Advanced: Using the data for ML model updates

The `race_sims.driver_stats` column stores every user's driver configuration.
You can use this to find consensus ratings across all users:

```sql
-- Find community consensus pace rating for Verstappen
SELECT
  (driver->>'id') as driver_id,
  ROUND(AVG((driver->>'pace')::float), 1) as avg_pace,
  ROUND(AVG((driver->>'consistency')::float), 1) as avg_consistency,
  COUNT(*) as contributors
FROM race_sims,
  jsonb_array_elements(driver_stats) as driver
WHERE driver->>'id' = 'verstappen'
GROUP BY driver->>'id';

-- Compare: which driver stats configuration correlates with correct predictions?
SELECT
  (driver->>'pace')::int as pace_bucket,
  COUNT(*) as total,
  SUM(CASE WHEN prediction_correct THEN 1 ELSE 0 END) as correct
FROM race_sims,
  jsonb_array_elements(driver_stats) as driver
WHERE driver->>'id' = 'norris'
  AND actual_winner_id IS NOT NULL
GROUP BY 1
ORDER BY 1;
```

This gives you a data-driven basis for updating driver stats mid-season.

---

## Monitoring

In Supabase → **Table Editor** → `community_global`, you can see:
- Total submissions received
- Win prediction accuracy across all circuits
- Most active circuit (most simulated by users)

In `community_model`, sort by `sample_count DESC` to see which circuit+driver
combinations have the most data.

---

## Free tier limits (Supabase)

| Resource | Free limit |
|----------|-----------|
| Database size | 500 MB |
| API requests | 500K / month |
| Bandwidth | 2 GB / month |
| Concurrent connections | 60 |

For F1 SIM, this supports approximately **50,000 submissions per month** before
hitting any limits. More than enough to build a high-quality community model.

---

## Troubleshooting

**⚠️ Warning still shows after adding credentials**
→ Check there are no spaces in the URL or key. The URL should start with `https://`
  and end with `.supabase.co` (no trailing slash).

**Data not appearing in community_model table**
→ Run `SELECT aggregate_community_model();` in SQL Editor manually.

**CORS error in browser console**
→ Go to Supabase → Project Settings → API → and check that your site's URL
  is in the allowed origins list. For local testing, add `null` (file:// protocol).

**RLS blocking reads**
→ Confirm you ran the policy section of the schema. Check Supabase → 
  Authentication → Policies and verify `allow_read` exists on `community_model`.
