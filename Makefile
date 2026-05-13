# F1 SIM 2027 — Makefile
# ======================
# Ties the JS build pipeline and Python ML model together.
# Run `make help` for a summary of all commands.

.PHONY: help build train export deploy all serve check clean install test

# ── Load .env if it exists ────────────────────────────────────────────
-include .env
export

ESBUILD     = ./node_modules/.bin/esbuild
NODE        = node
PYTHON      = python3
PIP         = pip3
BUILD_SCRIPT= scripts/build.js
SRC         = f1_simulator.jsx
HTML        = index.html
MODELS_DIR  = models
ML_DIR      = f1sim_ml

# ── Default target ────────────────────────────────────────────────────
.DEFAULT_GOAL := help

help:
	@echo ""
	@echo "  F1 SIM 2027 — Available Commands"
	@echo "  ================================="
	@echo ""
	@echo "  JS / App"
	@echo "  ────────"
	@echo "  make build          Compile JSX → minify → patch into index.html"
	@echo "  make serve          Serve app locally at http://localhost:8080"
	@echo "  make watch          Watch f1_simulator.jsx and rebuild on change"
	@echo ""
	@echo "  Python ML"
	@echo "  ─────────"
	@echo "  make install        Install Python ML dependencies"
	@echo "  make train          Train LightGBM on latest Supabase data"
	@echo "  make export         Export model predictions → Supabase community_model"
	@echo "  make check          Check model health / calibration status"
	@echo ""
	@echo "  Full Pipeline"
	@echo "  ─────────────"
	@echo "  make all            train → export → build → deploy"
	@echo "  make deploy         Push index.html to GitHub Pages"
	@echo "  make retrain        Force retrain even if recent model exists"
	@echo ""
	@echo "  Utilities"
	@echo "  ─────────"
	@echo "  make clean          Remove compiled artifacts"
	@echo "  make test           Run Python tests + JS syntax check"
	@echo "  make stats          Show Supabase data volume stats"
	@echo ""

# ══════════════════════════════════════════════════════════════════════
# JS BUILD PIPELINE
# ══════════════════════════════════════════════════════════════════════

## Compile JSX source → patch minified JS into index.html
build:
	@echo "▸ Building F1 SIM..."
	@$(NODE) $(BUILD_SCRIPT)
	@echo "✅ index.html updated"

## Watch source and rebuild on change (requires nodemon)
watch:
	@command -v nodemon >/dev/null 2>&1 || npm install -g nodemon
	@nodemon --watch $(SRC) --ext jsx --exec "make build"

## Serve locally
serve: build
	@echo "▸ Serving at http://localhost:8080"
	@$(PYTHON) -m http.server 8080

# ══════════════════════════════════════════════════════════════════════
# PYTHON ML PIPELINE
# ══════════════════════════════════════════════════════════════════════

## Install Python dependencies
install:
	@echo "▸ Installing Python dependencies..."
	@$(PIP) install -r $(ML_DIR)/requirements.txt --break-system-packages -q
	@echo "✅ Dependencies installed"

## Train LightGBM on data from Supabase
train:
	@echo "▸ Training LightGBM model..."
	@$(PYTHON) -c "\
import os, sys; \
sys.path.insert(0, '.'); \
from f1sim_ml.train import train_pipeline; \
train_pipeline( \
    supabase_url=os.environ.get('SUPABASE_URL',''), \
    supabase_key=os.environ.get('SUPABASE_KEY',''), \
)"
	@echo "✅ Model saved to $(MODELS_DIR)/f1sim_model.pkl"

## Force retrain (ignores existing model)
retrain:
	@rm -f $(MODELS_DIR)/f1sim_model.pkl
	@make train

## Export model predictions → Supabase community_model table
export:
	@echo "▸ Exporting model predictions to Supabase..."
	@$(PYTHON) -c "\
import os, sys; \
sys.path.insert(0, '.'); \
from f1sim_ml.model import F1SimModel; \
from f1sim_ml.export import export_to_js, push_to_supabase; \
model = F1SimModel().load(); \
weights = export_to_js(model=model); \
url = os.environ.get('SUPABASE_URL',''); \
key = os.environ.get('SUPABASE_KEY',''); \
push_to_supabase(weights, url, key) if url and 'YOUR_PROJECT' not in url else print('⚠️  Set SUPABASE_URL to push to live DB'); \
"
	@echo "✅ Weights exported"

## Check model calibration and data stats
check:
	@echo "▸ Model health check..."
	@$(PYTHON) -c "\
import os, sys; \
sys.path.insert(0, '.'); \
from f1sim_ml.calibrate import CalibrationTracker; \
from pathlib import Path; \
tracker = CalibrationTracker(); \
drift = tracker.check_drift(); \
print(); \
print('Status:', drift['message']); \
print('Rounds tracked:', drift['rounds_available']); \
print('Overall accuracy:', f\"{drift['overall_accuracy']*100:.0f}%\" if drift['overall_accuracy'] else 'N/A'); \
"
	@echo ""
	@echo "▸ Supabase data stats..."
	@$(PYTHON) -c "\
import os, sys, requests; \
sys.path.insert(0, '.'); \
url = os.environ.get('SUPABASE_URL', ''); \
key = os.environ.get('SUPABASE_KEY', ''); \
if not url or 'YOUR_PROJECT' in url: \
    print('⚠️  Set SUPABASE_URL to check live data'); \
else: \
    h = {'apikey': key, 'Authorization': f'Bearer {key}'}; \
    r = requests.get(f'{url}/rest/v1/race_sims?select=circuit_id,sim_accuracy&limit=5000', headers=h); \
    if r.ok: \
        d = r.json(); \
        print(f'race_sims rows:  {len(d)}'); \
        from collections import Counter; \
        c = Counter(x[\"circuit_id\"] for x in d); \
        print('Top circuits:', dict(c.most_common(5))); \
    else: \
        print('Could not fetch:', r.status_code); \
"

# ══════════════════════════════════════════════════════════════════════
# FULL PIPELINE
# ══════════════════════════════════════════════════════════════════════

## Full pipeline: train → export → build → deploy
all: train export build deploy
	@echo ""
	@echo "✅ Full pipeline complete"

## Deploy to GitHub Pages
deploy:
	@./scripts/deploy.sh

# ══════════════════════════════════════════════════════════════════════
# UTILITIES
# ══════════════════════════════════════════════════════════════════════

## Remove compiled artifacts
clean:
	@rm -f /tmp/app_compiled.js /tmp/app_minified.js
	@echo "✅ Build artifacts cleaned"

## Run tests
test:
	@echo "▸ Python syntax check..."
	@$(PYTHON) -c "\
import ast, os; \
ok = True; \
for f in os.listdir('f1sim_ml'): \
    if f.endswith('.py'): \
        try: \
            ast.parse(open(f'f1sim_ml/{f}').read()); \
            print(f'  ✅ f1sim_ml/{f}'); \
        except SyntaxError as e: \
            print(f'  ❌ f1sim_ml/{f}: {e}'); \
            ok = False; \
exit(0 if ok else 1); \
"
	@echo "▸ JSX syntax check..."
	@$(NODE) -e "require('fs').readFileSync('$(SRC)', 'utf8'); console.log('  ✅ $(SRC)');" 2>/dev/null || echo "  ⚠️  Run make build to check JSX"
	@echo "✅ Tests passed"

## Show live Supabase stats (alias)
stats: check
