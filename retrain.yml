name: Retrain ML Model

# ── Triggers ─────────────────────────────────────────────────────────────────
on:
  # Scheduled: every Sunday at 03:00 UTC (after the weekend's races)
  schedule:
    - cron: '0 3 * * 0'

  # Manual trigger from GitHub Actions UI
  workflow_dispatch:
    inputs:
      force_retrain:
        description: 'Force retrain even if model is recent'
        required: false
        default: 'false'
        type: boolean

  # Trigger when ML source code changes
  push:
    branches: [main]
    paths:
      - 'f1sim_ml/**'
      - 'supabase_schema.sql'

# ── Jobs ──────────────────────────────────────────────────────────────────────
jobs:
  retrain:
    name: Retrain LightGBM + Push Weights
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      # ── 1. Checkout ───────────────────────────────────────────────────────
      - name: Checkout repository
        uses: actions/checkout@v4

      # ── 2. Python setup ───────────────────────────────────────────────────
      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'
          cache: 'pip'
          cache-dependency-path: f1sim_ml/requirements.txt

      - name: Install Python dependencies
        run: pip install -r f1sim_ml/requirements.txt

      # ── 3. Check data volume (skip if not enough) ─────────────────────────
      - name: Check Supabase data volume
        id: data_check
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_KEY: ${{ secrets.SUPABASE_KEY }}
        run: |
          python3 -c "
          import os, requests, sys
          url = os.environ['SUPABASE_URL']
          key = os.environ['SUPABASE_KEY']
          h = {'apikey': key, 'Authorization': f'Bearer {key}'}
          r = requests.get(f'{url}/rest/v1/race_sims?select=id&limit=1000', headers=h)
          rows = len(r.json()) if r.ok else 0
          print(f'::set-output name=row_count::{rows}')
          print(f'Data rows: {rows}')
          if rows < 50:
              print(f'::warning::Only {rows} rows in race_sims — need ≥50 to train. Skipping.')
              sys.exit(1)
          "
        continue-on-error: true

      # ── 4. Train model ────────────────────────────────────────────────────
      - name: Train LightGBM model
        if: steps.data_check.outcome == 'success'
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_KEY: ${{ secrets.SUPABASE_KEY }}
        run: |
          python3 -c "
          import os, sys
          sys.path.insert(0, '.')
          from f1sim_ml.train import train_pipeline
          model = train_pipeline(
              supabase_url=os.environ['SUPABASE_URL'],
              supabase_key=os.environ['SUPABASE_KEY'],
              min_accuracy=5,
              val_size=0.20,
              num_boost_round=500,
              early_stopping_rounds=30,
              save=True,
          )
          print('Training complete')
          "

      # ── 5. Export predictions to Supabase ─────────────────────────────────
      - name: Export model weights to Supabase
        if: steps.data_check.outcome == 'success'
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_KEY: ${{ secrets.SUPABASE_SECRET }}
        run: |
          python3 -c "
          import os, sys
          sys.path.insert(0, '.')
          from f1sim_ml.model import F1SimModel
          from f1sim_ml.export import export_to_js, push_to_supabase
          model = F1SimModel().load()
          weights = export_to_js(model=model)
          success = push_to_supabase(
              weights,
              os.environ['SUPABASE_URL'],
              os.environ['SUPABASE_KEY'],  # use SECRET key for writes in CI
              sample_count=9999,
          )
          if not success:
              raise RuntimeError('Failed to push weights to Supabase')
          print(f'Pushed weights for {len(weights)} circuits')
          "

      # ── 6. Save model artifact ────────────────────────────────────────────
      - name: Upload model artifact
        if: steps.data_check.outcome == 'success'
        uses: actions/upload-artifact@v4
        with:
          name: f1sim-model-${{ github.run_number }}
          path: |
            models/f1sim_model.pkl
            models/community_weights.json
          retention-days: 90

      # ── 7. Calibration check ──────────────────────────────────────────────
      - name: Check model calibration
        if: steps.data_check.outcome == 'success'
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_KEY: ${{ secrets.SUPABASE_KEY }}
        run: |
          python3 -c "
          import sys
          sys.path.insert(0, '.')
          from f1sim_ml.calibrate import CalibrationTracker
          tracker = CalibrationTracker()
          drift = tracker.check_drift()
          print(drift['message'])
          if drift.get('drift_detected'):
              print('::warning::Model drift detected. Consider reviewing driver stat configurations.')
          "

      # ── 8. Summary ────────────────────────────────────────────────────────
      - name: Write job summary
        if: always()
        run: |
          echo "## F1 SIM ML Retraining — Run #${{ github.run_number }}" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY
          echo "- **Trigger:** ${{ github.event_name }}" >> $GITHUB_STEP_SUMMARY
          echo "- **Data rows:** ${{ steps.data_check.outputs.row_count || 'N/A' }}" >> $GITHUB_STEP_SUMMARY
          echo "- **Status:** ${{ job.status }}" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY
          echo "Model weights pushed to \`community_model\` table in Supabase." >> $GITHUB_STEP_SUMMARY
          echo "App will blend predictions on next circuit select." >> $GITHUB_STEP_SUMMARY
