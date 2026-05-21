"""
LightGBM wrapper for F1 race outcome prediction.
Three boosters: win probability, podium probability, prediction-correct classification.
"""

import os
import json
import pickle
import numpy as np
import pandas as pd
import lightgbm as lgb
from pathlib import Path
from typing import Optional, Dict, Tuple


MODEL_DIR = Path(__file__).parent.parent / "models"
MODEL_DIR.mkdir(exist_ok=True)


class F1SimModel:
    """
    Multi-target LightGBM wrapper for F1 race outcome prediction.

    Architecture:
        Three separate LightGBM boosters, each specialised for its target.
        Win probability uses fewer iterations (high variance target).
        Podium probability uses more iterations (more signal available).
        Prediction-correct uses binary cross-entropy with Platt scaling.
    """

    # Good defaults for 1k–50k rows. Re-tune with Optuna (see calibrate.py) at >10k labelled examples.
    WIN_PARAMS = {
        "objective":        "regression",
        "metric":           "rmse",
        "learning_rate":    0.05,
        "num_leaves":       31,        # shallow trees to prevent overfitting on small datasets
        "min_child_samples":10,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.8,
        "bagging_freq":     5,
        "lambda_l1":        0.1,
        "lambda_l2":        0.1,
        "verbose":         -1,
    }

    PODIUM_PARAMS = {
        **WIN_PARAMS,
        "num_leaves":   63,            # podium target has more signal; deeper trees are warranted
        "learning_rate": 0.04,
    }

    CORRECT_PARAMS = {
        **WIN_PARAMS,
        "objective":   "binary",
        "metric":      "binary_logloss",
        "num_leaves":  31,
    }

    def __init__(self):
        self.win_model:     Optional[lgb.Booster] = None
        self.podium_model:  Optional[lgb.Booster] = None
        self.correct_model: Optional[lgb.Booster] = None
        self.feature_cols:  Optional[list]        = None
        self.is_trained:    bool                  = False
        self.meta:          dict                  = {}

    
    def train(
        self,
        train_df: pd.DataFrame,
        val_df:   Optional[pd.DataFrame] = None,
        feature_cols: Optional[list] = None,
        num_boost_round: int = 300,
        early_stopping_rounds: int = 30,
        verbose_eval: int = 50,
    ) -> Dict[str, float]:
        """
        Train all three models on the flat feature matrix.

        Args:
            train_df: output of FeatureBuilder.build()
            val_df:   validation set (optional, enables early stopping)
            feature_cols: which columns to use as features
            num_boost_round: max boosting iterations
            early_stopping_rounds: stop if val metric doesn't improve
            verbose_eval: print metrics every N rounds

        Returns:
            dict of final train/val metrics
        """
        from .data import FeatureBuilder
        if feature_cols is None:
            feature_cols = FeatureBuilder().get_feature_columns()
        self.feature_cols = feature_cols

        print(f"Training on {len(train_df)} rows, {len(feature_cols)} features")

        print("\n── Training win model ──")
        win_train = train_df.dropna(subset=["predicted_win_pct"])
        win_val   = val_df.dropna(subset=["predicted_win_pct"]) if val_df is not None else None

        dtrain_win = lgb.Dataset(
            win_train[feature_cols],
            label=win_train["predicted_win_pct"],
            categorical_feature=["circuit_night", "circuit_type_hs", "circuit_type_tech", "circuit_type_st"],
            free_raw_data=False,
        )
        callbacks = [lgb.log_evaluation(period=verbose_eval)]
        valid_sets = [dtrain_win]
        if win_val is not None:
            dval_win = lgb.Dataset(win_val[feature_cols], label=win_val["predicted_win_pct"])
            valid_sets.append(dval_win)
            callbacks.append(lgb.early_stopping(stopping_rounds=early_stopping_rounds))

        self.win_model = lgb.train(
            self.WIN_PARAMS, dtrain_win,
            num_boost_round=num_boost_round,
            valid_sets=valid_sets,
            callbacks=callbacks,
        )

        print("\n── Training podium model ──")
        pod_train = train_df.dropna(subset=["predicted_podium_pct"])

        dtrain_pod = lgb.Dataset(pod_train[feature_cols], label=pod_train["predicted_podium_pct"], free_raw_data=False)
        valid_sets_pod = [dtrain_pod]
        callbacks_pod = [lgb.log_evaluation(period=verbose_eval)]
        if val_df is not None:
            pod_val = val_df.dropna(subset=["predicted_podium_pct"])
            dval_pod = lgb.Dataset(pod_val[feature_cols], label=pod_val["predicted_podium_pct"])
            valid_sets_pod.append(dval_pod)
            callbacks_pod.append(lgb.early_stopping(stopping_rounds=early_stopping_rounds))

        self.podium_model = lgb.train(
            self.PODIUM_PARAMS, dtrain_pod,
            num_boost_round=num_boost_round,
            valid_sets=valid_sets_pod,
            callbacks=callbacks_pod,
        )

        print("\n── Training prediction-correct model ──")
        correct_df = train_df.dropna(subset=["prediction_correct"])
        if len(correct_df) >= 50:  # need labelled data
            dtrain_corr = lgb.Dataset(
                correct_df[feature_cols],
                label=correct_df["prediction_correct"].astype(float),
                free_raw_data=False,
            )
            callbacks_c = [lgb.log_evaluation(period=verbose_eval)]
            if val_df is not None:
                correct_val = val_df.dropna(subset=["prediction_correct"])
                if len(correct_val) >= 10:
                    dval_c = lgb.Dataset(correct_val[feature_cols], label=correct_val["prediction_correct"].astype(float))
                    callbacks_c.append(lgb.early_stopping(stopping_rounds=early_stopping_rounds))
                    self.correct_model = lgb.train(
                        self.CORRECT_PARAMS, dtrain_corr,
                        num_boost_round=num_boost_round,
                        valid_sets=[dtrain_corr, dval_c],
                        callbacks=callbacks_c,
                    )
                else:
                    self.correct_model = lgb.train(self.CORRECT_PARAMS, dtrain_corr, num_boost_round=100)
            else:
                self.correct_model = lgb.train(self.CORRECT_PARAMS, dtrain_corr, num_boost_round=100)
            print(f"  Correct model trained on {len(correct_df)} labelled examples")
        else:
            print(f"  Skipping correct model — only {len(correct_df)} labelled examples (need ≥50)")

        self.is_trained = True
        self.meta = {
            "train_rows":   len(train_df),
            "labelled_rows":len(correct_df) if "correct_df" in dir() else 0,
            "feature_cols": feature_cols,
            "win_trees":    self.win_model.num_trees(),
            "podium_trees": self.podium_model.num_trees(),
        }
        print(f"\n✅ Training complete: {self.meta}")
        return self.meta

    
    def predict(self, feature_df: pd.DataFrame) -> pd.DataFrame:
        """
        Generate win/podium probability predictions.

        Args:
            feature_df: DataFrame with same columns as feature_cols

        Returns:
            DataFrame with columns: win_pct, podium_pct, model_correct_prob
        """
        if not self.is_trained:
            raise RuntimeError("Model not trained. Call .train() or .load() first.")

        X = feature_df[self.feature_cols].fillna(0)

        out = pd.DataFrame(index=feature_df.index)
        out["win_pct"]    = np.clip(self.win_model.predict(X), 0, 1)
        out["podium_pct"] = np.clip(self.podium_model.predict(X), 0, 1)

        # Ensure win_pct <= podium_pct (logical constraint)
        out["win_pct"] = np.minimum(out["win_pct"], out["podium_pct"])

        if self.correct_model is not None:
            out["model_correct_prob"] = self.correct_model.predict(X)
        else:
            out["model_correct_prob"] = np.nan

        return out

    
    def feature_importance(self, model: str = "win") -> pd.DataFrame:
        """
        Return feature importances for interpretability.

        Args:
            model: "win", "podium", or "correct"

        Returns:
            DataFrame sorted by importance descending.
        """
        m = {"win": self.win_model, "podium": self.podium_model, "correct": self.correct_model}[model]
        if m is None:
            raise RuntimeError(f"{model} model not trained")
        imp = pd.DataFrame({
            "feature":    self.feature_cols,
            "importance": m.feature_importance(importance_type="gain"),
        }).sort_values("importance", ascending=False)
        return imp

    
    def save(self, path: Optional[Path] = None) -> Path:
        """Save model to disk."""
        path = path or MODEL_DIR / "f1sim_model.pkl"
        with open(path, "wb") as f:
            pickle.dump({
                "win_model":     self.win_model,
                "podium_model":  self.podium_model,
                "correct_model": self.correct_model,
                "feature_cols":  self.feature_cols,
                "meta":          self.meta,
            }, f)
        print(f"Model saved to {path}")
        return path

    def load(self, path: Optional[Path] = None) -> "F1SimModel":
        """Load model from disk."""
        path = path or MODEL_DIR / "f1sim_model.pkl"
        if not Path(path).exists():
            raise FileNotFoundError(f"No model found at {path}. Run train.py first.")
        with open(path, "rb") as f:
            d = pickle.load(f)
        self.win_model     = d["win_model"]
        self.podium_model  = d["podium_model"]
        self.correct_model = d["correct_model"]
        self.feature_cols  = d["feature_cols"]
        self.meta          = d.get("meta", {})
        self.is_trained    = True
        print(f"Model loaded from {path} ({self.meta.get('train_rows','?')} training rows)")
        return self
