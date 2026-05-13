"""
calibrate.py — Model calibration and hyperparameter optimisation
================================================================
Two utilities:
  1. CalibrationTracker — monitors prediction accuracy over time,
     detects model drift, triggers retraining when accuracy drops.
  2. tune_hyperparameters() — Optuna-based hyperparameter search
     for LightGBM params when enough data is available.
"""

import json
import warnings
import numpy as np
import pandas as pd
from pathlib import Path
from typing import Optional, Dict, List
from sklearn.metrics import mean_squared_error, roc_auc_score
from sklearn.calibration import CalibratedClassifierCV

warnings.filterwarnings("ignore", category=UserWarning)


class CalibrationTracker:
    """
    Tracks model accuracy over time and detects drift.

    Stores per-circuit accuracy metrics to a JSON file.
    Call record() after each real F1 race. Call check_drift()
    to see if retraining is recommended.

    Usage:
        tracker = CalibrationTracker()
        tracker.record(circuit_id="bahrain", predicted_winner="norris",
                       actual_winner="verstappen", predicted_win_pct=0.28)
        drift = tracker.check_drift()
        if drift["retrain_recommended"]:
            train_pipeline()
    """

    CALIBRATION_PATH = Path(__file__).parent.parent / "models" / "calibration.json"

    def __init__(self, path: Optional[Path] = None):
        self.path = path or self.CALIBRATION_PATH
        self.data = self._load()

    def _load(self) -> dict:
        if self.path.exists():
            with open(self.path) as f:
                return json.load(f)
        return {"rounds": [], "circuit_accuracy": {}, "overall_accuracy": None}

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path, "w") as f:
            json.dump(self.data, f, indent=2, default=str)

    def record(
        self,
        circuit_id: str,
        predicted_winner: str,
        actual_winner: str,
        predicted_win_pct: float,
        predicted_podium: Optional[List[str]] = None,
        actual_podium: Optional[List[str]] = None,
    ) -> dict:
        """
        Record the outcome of a real F1 race.

        Args:
            circuit_id: e.g. "bahrain"
            predicted_winner: driver_id of model's predicted winner
            actual_winner: driver_id of actual race winner
            predicted_win_pct: model's predicted win probability for predicted_winner
            predicted_podium: top-3 driver_ids predicted
            actual_podium: top-3 driver_ids actual

        Returns:
            dict with win_correct, podium_hits fields
        """
        win_correct = predicted_winner == actual_winner
        podium_hits = 0
        if predicted_podium and actual_podium:
            podium_hits = len(set(predicted_podium) & set(actual_podium))

        record = {
            "circuit_id":        circuit_id,
            "predicted_winner":  predicted_winner,
            "actual_winner":     actual_winner,
            "predicted_win_pct": predicted_win_pct,
            "win_correct":       win_correct,
            "podium_hits":       podium_hits,
            "timestamp":         pd.Timestamp.now().isoformat(),
        }
        self.data["rounds"].append(record)

        # Update per-circuit accuracy
        circ = self.data["circuit_accuracy"].setdefault(circuit_id, {
            "rounds": 0, "correct": 0, "accuracy": None,
        })
        circ["rounds"] += 1
        if win_correct:
            circ["correct"] += 1
        circ["accuracy"] = circ["correct"] / circ["rounds"]

        # Update overall
        all_rounds = self.data["rounds"]
        self.data["overall_accuracy"] = sum(r["win_correct"] for r in all_rounds) / len(all_rounds)

        self._save()
        print(f"  Recorded: {circuit_id} — {'✅' if win_correct else '❌'} "
              f"({'correct' if win_correct else 'wrong'}). "
              f"Overall accuracy: {self.data['overall_accuracy']*100:.0f}%")
        return record

    def check_drift(
        self,
        window: int = 10,
        accuracy_threshold: float = 0.30,
    ) -> dict:
        """
        Check if model accuracy has drifted below acceptable threshold.

        Drift is detected by comparing accuracy over the last `window`
        races vs the overall historical accuracy. If the recent window
        is significantly worse, retraining is recommended.

        Args:
            window: number of recent races to use for drift detection
            accuracy_threshold: minimum acceptable accuracy (30% is ~3× random
                                 for a 10-driver field)

        Returns:
            dict with: recent_accuracy, overall_accuracy, drift_detected,
                       retrain_recommended, rounds_available
        """
        rounds = self.data["rounds"]
        overall = self.data["overall_accuracy"] or 0

        recent_acc = None
        drift = False
        retrain = False

        if len(rounds) >= window:
            recent = rounds[-window:]
            recent_acc = sum(r["win_correct"] for r in recent) / window
            # Drift: recent accuracy ≥ 15% worse than overall, or below threshold
            drift = recent_acc < overall - 0.15 or recent_acc < accuracy_threshold
            retrain = drift and len(rounds) >= 20  # need enough data to retrain meaningfully

        return {
            "rounds_available":   len(rounds),
            "overall_accuracy":   overall,
            "recent_accuracy":    recent_acc,
            "drift_detected":     drift,
            "retrain_recommended":retrain,
            "message": (
                f"Retraining recommended — recent accuracy {recent_acc*100:.0f}% "
                f"vs overall {overall*100:.0f}%"
            ) if retrain else (
                f"Model healthy — {len(rounds)} rounds, "
                f"{overall*100:.0f}% overall accuracy"
            ),
        }

    def summary(self) -> pd.DataFrame:
        """Return a DataFrame of all recorded rounds."""
        return pd.DataFrame(self.data["rounds"])

    def calibration_curve(self) -> pd.DataFrame:
        """
        Check if predicted win probabilities are well-calibrated.
        A win predicted at 35% should occur ~35% of the time.

        Returns:
            DataFrame with columns: predicted_bucket, actual_rate, count
        """
        rounds = pd.DataFrame(self.data["rounds"])
        if rounds.empty:
            return pd.DataFrame()

        rounds["bucket"] = (rounds["predicted_win_pct"] * 10).astype(int) * 10

        return (
            rounds.groupby("bucket").agg(
                actual_rate=("win_correct", "mean"),
                count=("win_correct", "count"),
            )
            .reset_index()
            .rename(columns={"bucket": "predicted_bucket"})
        )


def tune_hyperparameters(
    train_df: pd.DataFrame,
    val_df: pd.DataFrame,
    feature_cols: List[str],
    n_trials: int = 50,
    target: str = "win",
) -> Dict:
    """
    Optuna-based hyperparameter search for LightGBM.

    Searches over:
        - num_leaves (16-255)
        - learning_rate (0.01-0.3)
        - min_child_samples (5-50)
        - feature_fraction (0.5-1.0)
        - bagging_fraction (0.5-1.0)
        - lambda_l1, lambda_l2 (0-2.0)

    Args:
        train_df, val_df: feature DataFrames from FeatureBuilder
        feature_cols: list of feature column names
        n_trials: number of Optuna trials
        target: "win" or "podium"

    Returns:
        Best hyperparameter dict
    """
    try:
        import optuna
        import lightgbm as lgb
        optuna.logging.set_verbosity(optuna.logging.WARNING)
    except ImportError:
        raise ImportError("Install optuna and lightgbm: pip install optuna lightgbm")

    target_col = "predicted_win_pct" if target == "win" else "predicted_podium_pct"
    train_clean = train_df.dropna(subset=[target_col])
    val_clean   = val_df.dropna(subset=[target_col])

    dtrain = lgb.Dataset(train_clean[feature_cols], label=train_clean[target_col], free_raw_data=False)
    dval   = lgb.Dataset(val_clean[feature_cols],   label=val_clean[target_col])

    def objective(trial):
        params = {
            "objective":         "regression",
            "metric":            "rmse",
            "verbosity":        -1,
            "num_leaves":        trial.suggest_int("num_leaves", 16, 255),
            "learning_rate":     trial.suggest_float("learning_rate", 0.01, 0.3, log=True),
            "min_child_samples": trial.suggest_int("min_child_samples", 5, 50),
            "feature_fraction":  trial.suggest_float("feature_fraction", 0.5, 1.0),
            "bagging_fraction":  trial.suggest_float("bagging_fraction", 0.5, 1.0),
            "bagging_freq":      trial.suggest_int("bagging_freq", 1, 10),
            "lambda_l1":         trial.suggest_float("lambda_l1", 0, 2.0),
            "lambda_l2":         trial.suggest_float("lambda_l2", 0, 2.0),
        }
        result = lgb.cv(
            params, dtrain, nfold=5, num_boost_round=300,
            callbacks=[lgb.early_stopping(30), lgb.log_evaluation(False)],
        )
        return min(result["valid rmse-mean"])

    study = optuna.create_study(direction="minimize")
    study.optimize(objective, n_trials=n_trials, show_progress_bar=True)

    print(f"\nBest {target} RMSE: {study.best_value:.5f}")
    print(f"Best params: {study.best_params}")
    return study.best_params
