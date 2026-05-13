# F1 SIM 2027 — Claude Code Project Guide

## What this project is

A Formula 1 2027 season simulator with:
- **Single-file PWA** (`index.html`) — React 19 app, 790KB, works from `file://` or GitHub Pages
- **Community ML model** (`f1sim_ml/`) — Python LightGBM trained on user simulation data
- **Supabase backend** — anonymous data collection + model weight distribution
- **Source** (`f1_simulator.jsx`) — ~4100 lines of JSX, compiled by the build pipeline

## Architecture: how the pieces connect

```
┌─────────────────────────────────────────────────────────────┐
│  Browser  (index.html)                                       │
│                                                              │
│  User runs Multi-Sim → submitSimData() → Supabase           │
│                         race_sims table                      │
│                                                              │
│  On track select → sbSelect(community_model) ──────────────┐│
│  fuseWithCommunity() blends ML predictions (up to 40%)     ││
└────────────────────────────────────────────────────────────┘│
                            ▲                                  │
                            │ Python writes predictions        │
         ┌──────────────────┴────────────────────────┐        │
         │  f1sim_ml/  (Python + LightGBM)            │        │
         │                                            │        │
         │  train.py → model.py → export.py ─────────┘        │
         │       ↑                                             │
         │  reads from race_sims (Supabase) ←─────────────────┘
         └─────────────────────────────────────────────────────┘
```

**The JS app NEVER calls Python directly.** Everything routes through Supabase REST API.

## Project structure

```
f1-sim/
├── CLAUDE.md                    ← you are here
├── index.html                   ← production app (compiled, minified)
├── f1_simulator.jsx             ← source JSX (edit this, not index.html)
├── f1_simulator_source.jsx      ← fully commented reference copy
├── .env.example                 ← environment variable template
├── Makefile                     ← all commands (build, train, deploy, test)
├── package.json                 ← Node.js tooling
│
├── f1sim_ml/                    ← Python LightGBM package
│   ├── __init__.py
│   ├── data.py                  ← Supabase loading + feature engineering
│   ├── model.py                 ← LightGBM wrapper (3 boosters)
│   ├── train.py                 ← training pipeline + CLI
│   ├── predict.py               ← race prediction from trained model
│   ├── export.py                ← push weights to Supabase
│   ├── calibrate.py             ← accuracy tracking + drift detection
│   ├── run_example.py           ← end-to-end demo
│   └── requirements.txt
│
├── models/                      ← saved model artifacts (git-ignored)
│   ├── f1sim_model.pkl          ← trained LightGBM model
│   ├── community_weights.json   ← per-circuit predictions
│   └── calibration.json         ← accuracy tracking history
│
├── scripts/
│   ├── build.js                 ← JSX compile + minify pipeline
│   ├── deploy.sh                ← GitHub Pages deployment
│   └── retrain.sh               ← cron-friendly retrain script
│
├── .github/
│   └── workflows/
│       ├── retrain.yml          ← scheduled model retraining (weekly)
│       └── deploy.yml           ← auto-deploy on push to main
│
├── supabase_schema.sql          ← database schema (run once in Supabase)
└── COMMUNITY_MODEL_SETUP.md     ← Supabase setup guide
```

## Environment variables

Copy `.env.example` to `.env` and fill in:

```bash
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_KEY=sb_publishable_XsC9JcwIvUb1ns7qeFegXw_CzsjStu2
SUPABASE_SECRET=sb_secret_AkvtANLFiXA0U7irN2mvQw_opiPpcIQ
GITHUB_TOKEN=ghp_...  # for automated deployment
```

**Never commit `.env`.** The secret key goes in GitHub Actions secrets only.

## Common tasks for Claude Code

### Rebuild the app after editing f1_simulator.jsx
```bash
make build
```

### Train the ML model on latest Supabase data
```bash
make train
```

### Export model predictions back to Supabase
```bash
make export
```

### Full pipeline: train + export + rebuild + deploy
```bash
make all
```

### Run the local dev server
```bash
make serve
```

### Check model health
```bash
make check
```

## Key files Claude Code should understand

### f1_simulator.jsx — sections
1. **Team Strategies** (line ~57) — 8 archetypes with pace/DNF mods
2. **Driving Styles** (line ~233) — 8 style modifier structs
3. **Rivalry System** (line ~300) — `getRivalry()` function
4. **Simulation Engine** (line ~310) — `calcBase()`, `runQ1Q2Q3()`, `runRace()`
5. **Aggregated Simulation** (line ~1242) — `aggQual()`, `aggRace()`
6. **Monte Carlo** (line ~1342) — `runMultiSim()`
7. **Community Model** (line ~2070) — Supabase integration
8. **Main App** (line ~2460) — `F1Sim()` component, all React state

### f1sim_ml/data.py — critical constants
- `CIRCUIT_META` — 24 circuits with alt/night/abrasive/od/drs/type
- `STYLE_FEATURES` — 8 driving style modifier dicts
- `FeatureBuilder.get_feature_columns()` — 21 features fed to LightGBM

### The build pipeline
`f1_simulator.jsx` → `scripts/build.js` (sucrase JSX compile) → `esbuild --minify` → patched into `index.html`

The build script is at `scripts/build.js`. Run with `make build` or `node scripts/build.js`.

## Coding conventions

### JavaScript (f1_simulator.jsx)
- Minified variable names in production — edit source only, never index.html directly
- Use `useState` not `React.useState` (shim is injected by build)  
- All track IDs lowercase, match `CIRCUIT_META` keys in `f1sim_ml/data.py`
- Driver IDs lowercase lastname: `"norris"`, `"verstappen"`, `"leclerc"`

### Python (f1sim_ml/)
- Type hints on all public functions
- Docstrings on all classes and public methods
- Feature columns in `FeatureBuilder.get_feature_columns()` MUST match those used in `calcBase()` JS logic
- Model hyperparams are in class constants (`WIN_PARAMS`, `PODIUM_PARAMS`)

## How the ML model improves over time

1. User enables 🟢 LIVE in the app nav
2. Every Multi-Sim run → anonymised prediction data → `race_sims` Supabase table
3. Every championship save → actual race winner → `race_sims.actual_winner_id`
4. Weekly GitHub Actions runs `make train` → LightGBM trains on accumulated data
5. `make export` pushes per-circuit win probabilities → `community_model` table
6. App reads `community_model` on track select → blends at up to 40% weight

**The model gets better with every user.** 30+ submissions per circuit unlocks blending.

## Adding a new feature

1. Edit `f1_simulator.jsx`
2. Run `make build` to compile and test
3. If the feature affects driver/track statistics, update `CIRCUIT_META` or `STYLE_FEATURES` in `f1sim_ml/data.py`
4. If the feature adds new data to submissions, update `submitSimData()` and the `race_sims` Supabase table schema

## Troubleshooting

**Build fails with JSX error** → check `scripts/build.js` sucrase path  
**Supabase not connecting** → check `SUPABASE_URL` doesn't include `/` at end  
**Model won't train** → check `race_sims` has ≥50 rows with `sim_accuracy >= 5`  
**Community data not showing** → enable 🟢 LIVE toggle, check Supabase RLS policies  
**Q times same across sessions** → was fixed in aggQual() — check build is current  
