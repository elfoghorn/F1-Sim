"""
Data loading and feature engineering for F1 SIM community model.
Loads race_sims from Supabase, expands JSONB columns, builds feature matrix.
"""

import os
import json
import requests
import pandas as pd
import numpy as np
from typing import Optional, List, Dict


class SupabaseLoader:
    """
    Loads race simulation data from the Supabase community database.

    Tables used:
        race_sims       — raw per-user simulation submissions
        community_model — aggregated circuit+driver win rates
        community_global — overall accuracy stats
    """

    def __init__(
        self,
        url: Optional[str] = None,
        key: Optional[str] = None,
    ):
        self.url = url or os.environ.get("SUPABASE_URL", "")
        self.key = key or os.environ.get("SUPABASE_KEY", "")
        if not self.url or not self.key:
            raise ValueError(
                "Supabase credentials required. Set SUPABASE_URL and SUPABASE_KEY "
                "environment variables, or pass url= and key= arguments."
            )

        self.headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
        }

    def _get(self, table: str, params: str = "", limit: int = 10_000) -> List[dict]:
        """Fetch rows from a Supabase table."""
        resp = requests.get(
            f"{self.url}/rest/v1/{table}?select=*{params}&limit={limit}",
            headers=self.headers,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def load_race_sims(
        self,
        min_accuracy: int = 5,
        circuit_id: Optional[str] = None,
        limit: int = 10_000,
    ) -> pd.DataFrame:
        """
        Load raw race simulation submissions.

        Args:
            min_accuracy: minimum sim_accuracy (Monte Carlo runs) to include.
                          Rows with sim_accuracy < 5 are too noisy.
            circuit_id: filter to a specific circuit, or None for all.
            limit: max rows to fetch.

        Returns:
            DataFrame with columns: id, session_id, circuit_id, sim_accuracy,
            predicted_top5, driver_stats, team_paces, actual_winner_id,
            prediction_correct, created_at
        """
        params = f"&sim_accuracy=gte.{min_accuracy}"
        if circuit_id:
            params += f"&circuit_id=eq.{circuit_id}"
        rows = self._get("race_sims", params, limit)
        if not rows:
            return pd.DataFrame()
        df = pd.DataFrame(rows)
        df["created_at"] = pd.to_datetime(df["created_at"])
        return df

    def load_community_model(self, circuit_id: Optional[str] = None) -> pd.DataFrame:
        """Load aggregated community model data (pre-computed by SQL function)."""
        params = f"&circuit_id=eq.{circuit_id}" if circuit_id else ""
        rows = self._get("community_model", params)
        return pd.DataFrame(rows) if rows else pd.DataFrame()

    def load_global_stats(self) -> dict:
        """Load global accuracy stats."""
        rows = self._get("community_global")
        return rows[0] if rows else {}


# Circuit metadata — matches JS TRACKS array
CIRCUIT_META = {
    "australia":   {"type": "street",    "alt": 0,    "night": False, "abrasive": 4, "od": 50, "drs": 4},
    "china":       {"type": "technical", "alt": 0,    "night": False, "abrasive": 5, "od": 55, "drs": 3},
    "japan":       {"type": "high-speed","alt": 0,    "night": False, "abrasive": 4, "od": 40, "drs": 2},
    "bahrain":     {"type": "technical", "alt": 0,    "night": True,  "abrasive": 7, "od": 55, "drs": 3},
    "saudi":       {"type": "street",    "alt": 0,    "night": True,  "abrasive": 3, "od": 45, "drs": 3},
    "miami":       {"type": "street",    "alt": 0,    "night": False, "abrasive": 5, "od": 52, "drs": 3},
    "spain":       {"type": "technical", "alt": 650,  "night": False, "abrasive": 6, "od": 42, "drs": 2},
    "monaco":      {"type": "street",    "alt": 0,    "night": False, "abrasive": 3, "od": 22, "drs": 1},
    "canada":      {"type": "semi-st",   "alt": 0,    "night": False, "abrasive": 5, "od": 60, "drs": 3},
    "madrid":      {"type": "street",    "alt": 650,  "night": False, "abrasive": 5, "od": 48, "drs": 3},
    "austria":     {"type": "high-speed","alt": 660,  "night": False, "abrasive": 5, "od": 65, "drs": 3},
    "britain":     {"type": "high-speed","alt": 0,    "night": False, "abrasive": 6, "od": 55, "drs": 2},
    "hungary":     {"type": "technical", "alt": 0,    "night": False, "abrasive": 5, "od": 32, "drs": 2},
    "belgium":     {"type": "high-speed","alt": 0,    "night": False, "abrasive": 5, "od": 58, "drs": 3},
    "netherlands": {"type": "technical", "alt": 0,    "night": False, "abrasive": 6, "od": 38, "drs": 2},
    "italy":       {"type": "high-speed","alt": 0,    "night": False, "abrasive": 4, "od": 75, "drs": 4},
    "azerbaijan":  {"type": "street",    "alt": 0,    "night": False, "abrasive": 4, "od": 58, "drs": 2},
    "singapore":   {"type": "street",    "alt": 0,    "night": True,  "abrasive": 4, "od": 28, "drs": 3},
    "usa":         {"type": "technical", "alt": 0,    "night": False, "abrasive": 6, "od": 58, "drs": 3},
    "mexico":      {"type": "technical", "alt": 2285, "night": False, "abrasive": 4, "od": 50, "drs": 3},
    "brazil":      {"type": "technical", "alt": 800,  "night": False, "abrasive": 6, "od": 58, "drs": 3},
    "lasvegas":    {"type": "street",    "alt": 600,  "night": True,  "abrasive": 3, "od": 68, "drs": 4},
    "qatar":       {"type": "high-speed","alt": 0,    "night": True,  "abrasive": 8, "od": 50, "drs": 3},
    "abudhabi":    {"type": "technical", "alt": 0,    "night": True,  "abrasive": 3, "od": 42, "drs": 3},
}

STYLE_FEATURES = {
    "aggressive":  {"pace":  2, "consistency": -4, "overtaking":  6, "defense": -4, "dnf_risk": 0.12},
    "smooth":      {"pace": -2, "consistency":  6, "overtaking": -2, "defense":  2, "dnf_risk":-0.15},
    "qualifier":   {"pace":  0, "consistency": -4, "overtaking":  1, "defense":  0, "dnf_risk": 0.04},
    "defender":    {"pace": -2, "consistency":  3, "overtaking": -6, "defense":  8, "dnf_risk":-0.08},
    "charger":     {"pace":  1, "consistency": -3, "overtaking":  8, "defense": -3, "dnf_risk": 0.06},
    "strategist":  {"pace": -1, "consistency":  4, "overtaking":  0, "defense":  2, "dnf_risk":-0.10},
    "technical":   {"pace": -1, "consistency":  3, "overtaking":  0, "defense":  1, "dnf_risk":-0.05},
    "ironman":     {"pace": -3, "consistency":  7, "overtaking": -3, "defense":  3, "dnf_risk":-0.30},
}


class FeatureBuilder:
    """
    Converts raw Supabase rows into a flat feature matrix for LightGBM.

    Each row in the output DataFrame represents ONE driver prediction from
    ONE simulation submission. Features include:
        - Driver stats (pace, consistency, etc.)
        - Style modifiers (effective stats after style applied)
        - Team car pace
        - Circuit characteristics
        - Sim accuracy (as a reliability weight)

    Target columns:
        - predicted_win_pct   (regression target)
        - predicted_podium_pct (regression target)
        - prediction_correct   (classification target)
    """

    def build(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Expand JSONB columns and build feature matrix.

        Args:
            df: raw DataFrame from SupabaseLoader.load_race_sims()

        Returns:
            Flat feature DataFrame, one row per (submission, driver) pair.
        """
        rows = []

        for _, sim in df.iterrows():
            circuit = sim["circuit_id"]
            circuit_meta = CIRCUIT_META.get(circuit, {})

            # Parse JSONB columns
            try:
                top5 = sim["predicted_top5"] if isinstance(sim["predicted_top5"], list) else json.loads(sim["predicted_top5"])
                driver_stats = sim["driver_stats"] if isinstance(sim["driver_stats"], list) else json.loads(sim["driver_stats"])
                team_paces = sim["team_paces"] if isinstance(sim["team_paces"], list) else json.loads(sim["team_paces"])
            except (json.JSONDecodeError, TypeError):
                continue

            # Build a lookup of driver stats by id
            drv_map = {d["id"]: d for d in driver_stats if isinstance(d, dict)}
            team_map = {t["id"]: t.get("pace", 85) for t in team_paces if isinstance(t, dict)}

            for pred in top5:
                if not isinstance(pred, dict):
                    continue
                driver_id = pred.get("driver_id", "")
                drv = drv_map.get(driver_id, {})
                if not drv:
                    continue

                style = drv.get("style", "smooth")
                style_mods = STYLE_FEATURES.get(style, {})

                # Effective stats after style application
                eff_pace        = drv.get("pace", 85)        + style_mods.get("pace", 0)
                eff_consistency = drv.get("consistency", 80) + style_mods.get("consistency", 0)
                eff_overtaking  = drv.get("overtaking", 80)  + style_mods.get("overtaking", 0)
                eff_defense     = drv.get("defense", 80)     + style_mods.get("defense", 0)

                # Assume driver belongs to a team — find car pace
                # (team_id not in driver_stats, so estimate from pace rank)
                car_pace = team_map.get("mclaren", 91)  # fallback — will improve with join

                # Circuit interaction features
                alt = circuit_meta.get("alt", 0)
                experience = drv.get("experience", 75)
                alt_penalty = ((alt - 500) / 2000) * ((100 - experience) * 0.04) if alt > 500 else 0

                night_bonus = experience * 0.025 if circuit_meta.get("night") else 0
                abrasive = circuit_meta.get("abrasive", 5)
                abrasion_pen = ((abrasive - 5) * 0.3) * ((100 - eff_consistency) / 40) if abrasive > 5 else 0

                # Base score (mirrors JS calcBase logic exactly)
                circuit_type = circuit_meta.get("type", "technical")
                if circuit_type == "high-speed":
                    type_bonus = eff_pace * 0.06
                elif circuit_type == "technical":
                    type_bonus = eff_consistency * 0.06
                elif circuit_type == "street":
                    type_bonus = experience * 0.03 + eff_defense * 0.02
                else:
                    type_bonus = 0

                base_score = (
                    car_pace * 0.55
                    + eff_pace * 0.45
                    + type_bonus
                    - alt_penalty
                    + night_bonus
                    - abrasion_pen
                    + (drv.get("mental", 7) - 5) * 0.45
                )

                rows.append({
                                        "submission_id":     sim["id"],
                    "driver_id":         driver_id,
                    "circuit_id":        circuit,
                    "sim_accuracy":      int(sim.get("sim_accuracy", 10)),

                                        "pace":              eff_pace,
                    "consistency":       eff_consistency,
                    "wet":               drv.get("wet", 80)         + style_mods.get("wet", 0),
                    "overtaking":        eff_overtaking,
                    "defense":           eff_defense,
                    "experience":        experience,
                    "mental":            drv.get("mental", 7),

                                        "style":             style,
                    "style_dnf_risk":    style_mods.get("dnf_risk", 0),

                                        "circuit_alt":       alt,
                    "circuit_night":     int(circuit_meta.get("night", False)),
                    "circuit_abrasive":  abrasive,
                    "circuit_od":        circuit_meta.get("od", 50),   # overtaking difficulty
                    "circuit_drs":       circuit_meta.get("drs", 3),
                    "circuit_type_hs":   int(circuit_type == "high-speed"),
                    "circuit_type_tech": int(circuit_type == "technical"),
                    "circuit_type_st":   int(circuit_type in ("street", "semi-st")),

                                        "base_score":        base_score,
                    "alt_penalty":       alt_penalty,
                    "abrasion_penalty":  abrasion_pen,
                    "night_bonus":       night_bonus,

                                        "predicted_win_pct":    float(pred.get("win_pct", 0)),
                    "predicted_podium_pct": float(pred.get("podium_pct", 0)),
                    "predicted_avg_pos":    float(pred.get("avg_pos", 11)),
                    "prediction_correct":   sim.get("prediction_correct"),  # None if no result yet
                })

        if not rows:
            return pd.DataFrame()

        return pd.DataFrame(rows)

    def get_feature_columns(self) -> List[str]:
        """Return the list of feature columns used by the model."""
        return [
            "pace", "consistency", "wet", "overtaking", "defense", "experience", "mental",
            "style_dnf_risk",
            "circuit_alt", "circuit_night", "circuit_abrasive", "circuit_od", "circuit_drs",
            "circuit_type_hs", "circuit_type_tech", "circuit_type_st",
            "base_score", "alt_penalty", "abrasion_penalty", "night_bonus",
            "sim_accuracy",
        ]
