# F1 SIM 2027

A Formula 1 season simulator for the 2027 calendar. Runs fully in the browser as a single HTML file — no install, no build step, no backend required for basic use.

**Live features:** Q1/Q2/Q3 qualifying, 6 sprint weekends, championship tracker, driver/team editing, Croft & Brundle style AI commentary, multi-sim statistical analysis, and a pre-season testing mode.

---

## Running the app

**Easiest — open locally:**  
Double-click `index.html`. No server needed.

**Deploy to GitHub Pages:**
1. Push `index.html` to any public GitHub repository
2. Go to **Settings → Pages → Deploy from branch** and select `main / (root)`
3. Your app is live at `https://YOUR_USERNAME.github.io/REPO_NAME/` within ~2 minutes

The app is also installable as a PWA — look for the install icon in Chrome/Edge/Opera when served over HTTPS.

---

## Access PIN

The app opens behind a 4-digit PIN gate.

**Default PIN: `2027`**

To change it, find this constant near the top of the `<script>` block in `index.html` and replace the encoded value:

```js
const F1_PIN_ENC = '70727075'; // XOR(0x42) of "2027"
```

Encode a new PIN in the browser console:

```js
'1234'.split('').map(c => (c.charCodeAt(0) ^ 0x42).toString(16).padStart(2, '0')).join('')
```

---

## AI Commentary

Race and qualifying sessions generate lap-by-lap Croft & Brundle style commentary using the Anthropic API.

1. Get an API key from [console.anthropic.com](https://console.anthropic.com) (starts with `sk-ant-...`)
2. In the app, go to **Commentary** and paste the key into the field
3. Click **Save Key** — it is stored in `localStorage` only, never transmitted anywhere except `api.anthropic.com`

---

## Community Model (optional)

The simulator optionally blends its built-in Monte Carlo probabilities with a community-trained LightGBM model. When enabled, anonymised simulation results are submitted to a Supabase backend and the model's predicted win/podium weights are pulled down and blended into the next simulation.

Setup instructions are in [COMMUNITY_MODEL_SETUP.md](COMMUNITY_MODEL_SETUP.md).

---

## Development

The source for the entire app is [`f1_simulator.jsx`](f1_simulator.jsx). The compiled, minified output is `index.html`. You only need to touch `f1_simulator.jsx` — the build pipeline handles everything else.

**Prerequisites:** Node.js 18+, `npm install` once.

```bash
make build       # compile JSX → minify → patch into index.html
make serve       # build + serve locally at http://localhost:8080
make watch       # rebuild automatically when f1_simulator.jsx changes
```

---

## ML Pipeline

The `f1sim_ml/` Python package trains a three-booster LightGBM model on community simulation data. It predicts win probability, podium probability, and whether the simulator's top-1 pick was correct, per driver per circuit.

**Prerequisites:** Python 3.10+, `make install` once.

```bash
make install     # pip install f1sim_ml/requirements.txt
make train       # load from Supabase → feature engineering → train → save model
make export      # run inference across all 24 circuits → push weights to Supabase
make check       # print calibration status and drift report
make all         # train → export → build → deploy (full pipeline)
```

You can also use the package directly:

```python
from f1sim_ml import train_pipeline, predict_race, export_to_js

model = train_pipeline()                          # train and save
preds = predict_race(circuit_id="monaco")         # predict for one circuit
export_to_js(model)                               # push all predictions to Supabase
```

Run `python -m f1sim_ml.run_example` for a self-contained demo using synthetic data (no Supabase credentials required).

---

## Environment variables

Copy `.env.example` to `.env` and fill in your values. For CI, add these as GitHub Actions secrets under **Settings → Secrets and variables → Actions**.

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | Community model | Your Supabase project URL |
| `SUPABASE_KEY` | Community model | Anon (publishable) key — safe in browser |
| `SUPABASE_SECRET` | CI/retrain only | Service role key — never expose client-side |
| `GITHUB_TOKEN` | Auto-deploy | PAT with `repo` + `pages` scope |

---

## CI/CD

| Workflow | Trigger | What it does |
|---|---|---|
| `deploy.yml` | Push to `main` | Publishes `index.html` to GitHub Pages |
| `retrain.yml` | Weekly (Sunday 03:00 UTC), or manually, or on changes to `f1sim_ml/` | Runs the full ML pipeline and pushes updated weights to Supabase |

---

## Project structure

```
f1_simulator.jsx          Source — edit this
index.html                Compiled single-file PWA
scripts/
  build.js                JSX → esbuild → patch into index.html
  deploy.sh               Git-push index.html to gh-pages branch
f1sim_ml/
  model.py                LightGBM wrapper (win, podium, correct boosters)
  data.py                 Supabase loader + feature engineering
  train.py                Training pipeline with GroupKFold validation
  predict.py              Per-circuit race prediction
  export.py               Batch inference → push to Supabase
  calibrate.py            Accuracy tracking + drift detection
  openf1.py               OpenF1 API client for real-season calibration
  run_example.py          End-to-end demo (synthetic data, no credentials)
supabase_schema.sql       Database schema for the three community tables
Makefile                  Unified entry point for all build/train/deploy tasks
.env.example              Environment variable template
```

---

## Tech

| Layer | Technology |
|---|---|
| UI | React 19 (CDN), Babel Standalone (in-browser JSX transpilation) |
| Commentary | Anthropic API — claude-sonnet-4 |
| Community backend | Supabase (PostgreSQL + REST API) |
| ML model | LightGBM, scikit-learn, pandas |
| Real F1 data | OpenF1 API (for driver stat calibration) |
| Build | esbuild (minify + mangle), Node.js |
| Hosting | GitHub Pages |
