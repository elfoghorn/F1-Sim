"""
Training pipeline. Loads from Supabase, builds features, trains LightGBM, saves model.

Usage:
    python -m f1sim_ml.train
"""

import argparse
import numpy as np
import pandas as pd
from pathlib import Path
from sklearn.model_selection import train_test_split, GroupKFold
from sklearn.metrics import mean_squared_error, roc_auc_score
from typing import Optional

from .data  import SupabaseLoader, FeatureBuilder
from .model import F1SimModel


def train_pipeline(
    supabase_url: Optional[str] = None,
    supabase_key: Optional[str] = None,
    min_accuracy: int = 5,
    val_size: float = 0.20,
    min_samples: int = 50,
    num_boost_round: int = 300,
    early_stopping_rounds: int = 30,
    save: bool = True,
) -> F1SimModel:
    """
    Complete training pipeline.

    Data split strategy: GroupKFold by session_id.
    This prevents data leakage where the same session appears in both
    train and validation (a session that submitted 5 drivers would
    contaminate the validation set if split randomly).

    Args:
        supabase_url: Supabase project URL (or set SUPABASE_URL env var)
        supabase_key: Supabase anon key (or set SUPABASE_KEY env var)
        min_accuracy: minimum Monte Carlo runs to include in training
        val_size: fraction of sessions held out for validation
        min_samples: minimum total rows required to proceed
        num_boost_round: maximum LightGBM iterations
        early_stopping_rounds: early stopping patience
        save: whether to save the trained model to disk

    Returns:
        Trained F1SimModel instance
    """

    print("Loading data from Supabase...")
    loader  = SupabaseLoader(url=supabase_url, key=supabase_key)
    raw_df  = loader.load_race_sims(min_accuracy=min_accuracy)

    if raw_df.empty:
        raise ValueError("No data returned from Supabase. Check credentials and that race_sims has rows.")

    print(f"  Raw rows: {len(raw_df)}")
    print(f"  Circuits: {raw_df['circuit_id'].unique().tolist()}")
    print(f"  Date range: {raw_df['created_at'].min()} → {raw_df['created_at'].max()}")

    print("\nBuilding feature matrix...")
    builder  = FeatureBuilder()
    feat_df  = builder.build(raw_df)

    if len(feat_df) < min_samples:
        raise ValueError(
            f"Only {len(feat_df)} feature rows (need ≥{min_samples}). "
            "Collect more simulation data before training."
        )

    print(f"  Feature rows: {len(feat_df)}")
    print(f"  With labels:  {feat_df['prediction_correct'].notna().sum()}")
    print(f"  Circuits:     {feat_df['circuit_id'].nunique()}")
    print(f"  Drivers:      {feat_df['driver_id'].nunique()}")

    # Split by session_id to prevent data leakage between train and validation sets
    unique_sessions = feat_df["submission_id"].unique()
    n_val = max(1, int(len(unique_sessions) * val_size))

    rng = np.random.default_rng(42)
    val_sessions = set(rng.choice(unique_sessions, size=n_val, replace=False))
    train_mask   = ~feat_df["submission_id"].isin(val_sessions)
    val_mask     =  feat_df["submission_id"].isin(val_sessions)

    train_df = feat_df[train_mask].reset_index(drop=True)
    val_df   = feat_df[val_mask].reset_index(drop=True)

    print(f"\nSplit: {len(train_df)} train / {len(val_df)} validation rows")
    print(f"       ({len(unique_sessions) - n_val} train sessions / {n_val} val sessions)")

    model = F1SimModel()
    meta  = model.train(
        train_df=train_df,
        val_df=val_df,
        feature_cols=builder.get_feature_columns(),
        num_boost_round=num_boost_round,
        early_stopping_rounds=early_stopping_rounds,
    )

    print("\n── Evaluation ──")
    val_preds = model.predict(val_df)

    # Win probability RMSE
    win_rmse = np.sqrt(mean_squared_error(
        val_df["predicted_win_pct"],
        val_preds["win_pct"],
    ))
    print(f"  Win probability RMSE:    {win_rmse:.4f}")

    # Podium RMSE
    pod_rmse = np.sqrt(mean_squared_error(
        val_df["predicted_podium_pct"],
        val_preds["podium_pct"],
    ))
    print(f"  Podium probability RMSE: {pod_rmse:.4f}")

    # AUC on prediction-correct if labels available
    labelled_val = val_df.dropna(subset=["prediction_correct"])
    if len(labelled_val) >= 20 and model.correct_model is not None:
        corr_preds = model.predict(labelled_val)["model_correct_prob"]
        auc = roc_auc_score(labelled_val["prediction_correct"].astype(int), corr_preds)
        print(f"  Prediction-correct AUC:  {auc:.4f}  (0.5 = random, 1.0 = perfect)")
    else:
        print(f"  Prediction-correct AUC:  N/A ({len(labelled_val)} labelled val rows)")

    # Feature importances
    print("\n── Top 10 features (win model) ──")
    imp = model.feature_importance("win").head(10)
    for _, row in imp.iterrows():
        bar = "█" * int(row["importance"] / imp["importance"].max() * 20)
        print(f"  {row['feature']:<25} {bar}")

    if save:
        model.save()

    return model


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train F1 SIM LightGBM model")
    parser.add_argument("--min-accuracy",         type=int,   default=5)
    parser.add_argument("--val-size",             type=float, default=0.20)
    parser.add_argument("--min-samples",          type=int,   default=50)
    parser.add_argument("--num-boost-round",      type=int,   default=300)
    parser.add_argument("--early-stopping-rounds",type=int,   default=30)
    parser.add_argument("--no-save",              action="store_true")
    args = parser.parse_args()

    train_pipeline(
        min_accuracy=args.min_accuracy,
        val_size=args.val_size,
        min_samples=args.min_samples,
        num_boost_round=args.num_boost_round,
        early_stopping_rounds=args.early_stopping_rounds,
        save=not args.no_save,
    )
