"""
run_example.py — Complete end-to-end demo
==========================================
Run this after setting up Supabase and collecting some data.

Usage:
    export SUPABASE_URL="https://YOUR_PROJECT.supabase.co"
    export SUPABASE_KEY="YOUR_SUPABASE_ANON_KEY"
    python run_example.py
"""

import os
import sys
sys.path.insert(0, os.path.dirname(__file__))

from f1sim_ml import (
    SupabaseLoader, FeatureBuilder,
    train_pipeline, predict_race, export_to_js,
    CalibrationTracker, F1SimModel,
)
from f1sim_ml.export import push_to_supabase, DEFAULT_DRIVERS, DEFAULT_TEAMS

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "YOUR_SUPABASE_ANON_KEY")

def demo_data_exploration():
    """Explore what data we have before training."""
    print("\n" + "="*60)
    print("STEP 1: DATA EXPLORATION")
    print("="*60)

    loader  = SupabaseLoader(url=SUPABASE_URL, key=SUPABASE_KEY)
    raw_df  = loader.load_race_sims(min_accuracy=5)

    print(f"Total submissions: {len(raw_df)}")
    print(f"Circuits covered:  {raw_df['circuit_id'].nunique()}")
    print(f"Sessions (users):  {raw_df['session_id'].nunique()}")
    print(f"With real results: {raw_df['prediction_correct'].notna().sum()}")

    print("\nSubmissions by circuit:")
    print(raw_df.groupby('circuit_id').size().sort_values(ascending=False).to_string())

    print("\nSim accuracy distribution:")
    print(raw_df['sim_accuracy'].value_counts().sort_index().to_string())

    return raw_df


def demo_feature_engineering(raw_df):
    """Build and inspect the feature matrix."""
    print("\n" + "="*60)
    print("STEP 2: FEATURE ENGINEERING")
    print("="*60)

    builder = FeatureBuilder()
    feat_df = builder.build(raw_df)

    print(f"Feature matrix: {feat_df.shape}")
    print(f"\nFeature columns: {builder.get_feature_columns()}")

    print("\nSample row (Verstappen at Bahrain):")
    sample = feat_df[(feat_df["driver_id"]=="verstappen") & (feat_df["circuit_id"]=="bahrain")]
    if not sample.empty:
        print(sample[builder.get_feature_columns()].iloc[0].to_string())
    else:
        print("  No Verstappen/Bahrain data yet — run some Multi-Sim first!")

    return feat_df


def demo_training(feat_df):
    """Train the LightGBM models."""
    print("\n" + "="*60)
    print("STEP 3: MODEL TRAINING")
    print("="*60)

    if len(feat_df) < 50:
        print(f"Only {len(feat_df)} rows available. Need ≥50 to train.")
        print("→ Run Multi-Sim in F1 SIM with Community Mode ON, then come back.")
        return None

    model = train_pipeline(
        supabase_url=SUPABASE_URL,
        supabase_key=SUPABASE_KEY,
        min_accuracy=5,
        val_size=0.20,
        num_boost_round=200,
        save=True,
    )
    return model


def demo_predictions(model=None):
    """Generate predictions for a specific circuit."""
    print("\n" + "="*60)
    print("STEP 4: RACE PREDICTION — MONACO")
    print("="*60)

    if model is None:
        try:
            model = F1SimModel().load()
        except FileNotFoundError:
            print("No trained model found. Run training first.")
            return

    preds = predict_race(
        circuit_id="monaco",
        drivers=DEFAULT_DRIVERS,
        teams=DEFAULT_TEAMS,
        model=model,
    )

    print(f"\n{'Pos':<5} {'Driver':<15} {'Win%':<8} {'Podium%':<10} {'Avg Pos'}")
    print("-"*50)
    for i, p in enumerate(preds[:10], 1):
        win_bar   = "█" * int(p["win_pct"] * 30)
        podium_bar= "░" * int(p["podium_pct"] * 30)
        print(f"P{i:<4} {p['driver_id']:<15} {p['win_pct']*100:>5.1f}%  {p['podium_pct']*100:>6.1f}%   {p['avg_pos_estimate']:.1f}")

    return preds


def demo_export(model=None):
    """Export predictions for all circuits."""
    print("\n" + "="*60)
    print("STEP 5: EXPORT TO JS / SUPABASE")
    print("="*60)

    if model is None:
        try:
            model = F1SimModel().load()
        except FileNotFoundError:
            print("No trained model found. Run training first.")
            return

    weights = export_to_js(model=model)
    print(f"Exported {len(weights)} circuits")

    if SUPABASE_URL and not SUPABASE_URL.startswith("https://YOUR"):
        print("\nPushing to Supabase community_model table...")
        success = push_to_supabase(weights, SUPABASE_URL, SUPABASE_KEY, sample_count=9999)
        if success:
            print("✅ F1 SIM app will now use these model predictions for community blending")
    else:
        print("\nSet SUPABASE_URL to push predictions to the live app.")


def demo_calibration():
    """Track real-world prediction accuracy."""
    print("\n" + "="*60)
    print("STEP 6: CALIBRATION TRACKING")
    print("="*60)

    tracker = CalibrationTracker()

    # Example: record real F1 2027 results as season progresses
    # tracker.record(
    #     circuit_id="bahrain",
    #     predicted_winner="norris",
    #     actual_winner="verstappen",
    #     predicted_win_pct=0.24,
    #     predicted_podium=["norris", "leclerc", "piastri"],
    #     actual_podium=["verstappen", "norris", "leclerc"],
    # )

    drift_check = tracker.check_drift()
    print(f"\nModel status: {drift_check['message']}")
    print(f"Rounds tracked: {drift_check['rounds_available']}")

    if drift_check["rounds_available"] > 0:
        cal_curve = tracker.calibration_curve()
        print("\nCalibration curve:")
        print(cal_curve.to_string(index=False))


if __name__ == "__main__":
    print("F1 SIM ML — LightGBM Demo Pipeline")
    print("="*60)

    if not SUPABASE_URL or SUPABASE_URL.startswith("https://YOUR"):
        print("⚠️  SUPABASE_URL not set. Using dummy mode.")
        print("   Set the SUPABASE_URL environment variable to use real data.")
        print("\n   For now, demonstrating with synthetic data...")

        # Synthetic demo without Supabase
        import numpy as np
        import pandas as pd
        from f1sim_ml.data import FeatureBuilder, CIRCUIT_META, STYLE_FEATURES

        # Create 500 synthetic training rows
        np.random.seed(42)
        n = 500
        circuits = list(CIRCUIT_META.keys())
        driver_ids = [d["id"] for d in DEFAULT_DRIVERS]
        styles = list(STYLE_FEATURES.keys())

        raw_rows = []
        for i in range(n):
            drv = np.random.choice(DEFAULT_DRIVERS)
            team_pace = np.random.randint(76, 93)
            raw_rows.append({
                "id": f"synth_{i}",
                "session_id": f"session_{i//5}",
                "circuit_id": np.random.choice(circuits),
                "sim_accuracy": np.random.choice([5, 10, 10, 20]),
                "predicted_top5": [{"driver_id": drv["id"], "win_pct": np.random.beta(2,8), "podium_pct": np.random.beta(3,5), "avg_pos": np.random.uniform(1,11)}],
                "driver_stats": [{**drv, "pace": drv["pace"] + np.random.randint(-3,3)}],
                "team_paces": [{"id": drv["teamId"], "pace": team_pace}],
                "actual_winner_id": np.random.choice(driver_ids) if np.random.random()<0.3 else None,
                "prediction_correct": bool(np.random.random()>0.65) if np.random.random()<0.3 else None,
                "created_at": pd.Timestamp("2027-01-01") + pd.Timedelta(days=i),
            })

        raw_df = pd.DataFrame(raw_rows)
        builder = FeatureBuilder()
        feat_df = builder.build(raw_df)
        print(f"\n✅ Synthetic data: {feat_df.shape} rows")

        from sklearn.model_selection import train_test_split
        train_df, val_df = train_test_split(feat_df, test_size=0.2, random_state=42)

        model = F1SimModel()
        model.train(train_df, val_df, feature_cols=builder.get_feature_columns(), num_boost_round=100, verbose_eval=50)
        model.save()

        demo_predictions(model)
        demo_calibration()
        print("\n✅ Demo complete! Set SUPABASE_URL to use real community data.")

    else:
        raw_df  = demo_data_exploration()
        feat_df = demo_feature_engineering(raw_df)
        model   = demo_training(feat_df)
        preds   = demo_predictions(model)
        demo_export(model)
        demo_calibration()
