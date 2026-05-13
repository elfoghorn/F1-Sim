"""
predict.py — Race prediction using trained LightGBM model
===========================================================
Given a circuit and a set of driver/team stats, generates
win and podium probability predictions from the trained model.
"""

import json
import numpy as np
import pandas as pd
from typing import List, Dict, Optional
from .data  import FeatureBuilder, CIRCUIT_META, STYLE_FEATURES
from .model import F1SimModel


def predict_race(
    circuit_id: str,
    drivers: List[Dict],
    teams: List[Dict],
    model: Optional[F1SimModel] = None,
    model_path: Optional[str] = None,
) -> List[Dict]:
    """
    Predict race outcome probabilities for a set of drivers.

    Args:
        circuit_id: e.g. "monaco", "bahrain"
        drivers: list of driver dicts matching JS schema:
                 [{ "id", "pace", "consistency", "wet", "overtaking",
                    "defense", "experience", "mental", "style", "teamId" }]
        teams:   list of team dicts: [{ "id", "carPace" }]
        model:   pre-loaded F1SimModel (loaded if not provided)
        model_path: path to saved model file

    Returns:
        List of driver dicts sorted by predicted win probability:
        [{ "driver_id", "win_pct", "podium_pct", "avg_pos_estimate" }]
    """
    if model is None:
        model = F1SimModel().load(model_path)

    circuit_meta = CIRCUIT_META.get(circuit_id, {})
    team_pace_map = {t["id"]: t.get("carPace", 85) for t in teams}

    builder = FeatureBuilder()
    rows = []

    for drv in drivers:
        style = drv.get("style", "smooth")
        style_mods = STYLE_FEATURES.get(style, {})
        car_pace = team_pace_map.get(drv.get("teamId", ""), 85)

        eff_pace = drv.get("pace", 85) + style_mods.get("pace", 0)
        eff_cons = drv.get("consistency", 80) + style_mods.get("consistency", 0)
        eff_ovt  = drv.get("overtaking", 80) + style_mods.get("overtaking", 0)
        eff_def  = drv.get("defense", 80) + style_mods.get("defense", 0)
        exp      = drv.get("experience", 75)
        alt      = circuit_meta.get("alt", 0)
        abrasive = circuit_meta.get("abrasive", 5)
        night    = circuit_meta.get("night", False)
        ctype    = circuit_meta.get("type", "technical")

        alt_pen   = ((alt - 500) / 2000) * ((100 - exp) * 0.04) if alt > 500 else 0
        night_bon = exp * 0.025 if night else 0
        abr_pen   = ((abrasive - 5) * 0.3) * ((100 - eff_cons) / 40) if abrasive > 5 else 0

        if ctype == "high-speed":  type_bonus = eff_pace * 0.06
        elif ctype == "technical": type_bonus = eff_cons * 0.06
        elif ctype in ("street","semi-st"): type_bonus = exp * 0.03 + eff_def * 0.02
        else: type_bonus = 0

        base = car_pace * 0.55 + eff_pace * 0.45 + type_bonus - alt_pen + night_bon - abr_pen + (drv.get("mental", 7) - 5) * 0.45

        rows.append({
            "submission_id": "predict",
            "driver_id":     drv["id"],
            "circuit_id":    circuit_id,
            "sim_accuracy":  20,
            "pace":          eff_pace,
            "consistency":   eff_cons,
            "wet":           drv.get("wet", 80) + style_mods.get("wet", 0),
            "overtaking":    eff_ovt,
            "defense":       eff_def,
            "experience":    exp,
            "mental":        drv.get("mental", 7),
            "style_dnf_risk":style_mods.get("dnf_risk", 0),
            "circuit_alt":   alt,
            "circuit_night": int(night),
            "circuit_abrasive": abrasive,
            "circuit_od":    circuit_meta.get("od", 50),
            "circuit_drs":   circuit_meta.get("drs", 3),
            "circuit_type_hs":  int(ctype == "high-speed"),
            "circuit_type_tech":int(ctype == "technical"),
            "circuit_type_st":  int(ctype in ("street","semi-st")),
            "base_score":    base,
            "alt_penalty":   alt_pen,
            "abrasion_penalty": abr_pen,
            "night_bonus":   night_bon,
            "predicted_win_pct": 0,     # placeholder
            "predicted_podium_pct": 0,
            "prediction_correct": None,
        })

    feat_df = pd.DataFrame(rows)
    preds   = model.predict(feat_df)

    # Normalise win probabilities to sum to 1
    total_win = preds["win_pct"].sum()
    if total_win > 0:
        preds["win_pct"] /= total_win

    # Estimate average finishing position from win/podium probability
    # Using rank-order approximation: P(win) -> ~P1, P(podium) -> ~P2-3
    preds["avg_pos_estimate"] = (
        preds["win_pct"] * 1 + (preds["podium_pct"] - preds["win_pct"]) * 2.5 +
        (1 - preds["podium_pct"]) * 11
    )

    result = []
    for i, (_, drv_row) in enumerate(feat_df.iterrows()):
        result.append({
            "driver_id":      drv_row["driver_id"],
            "win_pct":        float(preds.loc[i, "win_pct"]),
            "podium_pct":     float(preds.loc[i, "podium_pct"]),
            "avg_pos_estimate": float(preds.loc[i, "avg_pos_estimate"]),
        })

    return sorted(result, key=lambda x: -x["win_pct"])
