"""
openf1.py — OpenF1 API client and stat calibration pipeline
============================================================
Fetches real F1 data from openf1.org and uses it to:
  1. Build accurate training features for LightGBM
  2. Auto-calibrate driver Pace/Consistency/Wet stats
  3. Generate per-circuit performance vectors
  4. Produce calibrated team carPace ratings

OpenF1 is a free, community-run real-time F1 API.
No authentication required. Rate limit: ~60 req/min.

Usage:
    python -m f1sim_ml.openf1 --year 2024 --export
    python -m f1sim_ml.openf1 --session latest --calibrate
"""

import os
import time
import json
import math
import requests
import numpy as np
import pandas as pd
from pathlib import Path
from typing import Optional, List, Dict, Tuple
from datetime import datetime, timezone


# ── API base URL ──────────────────────────────────────────────────────────────
OPENF1_BASE = "https://api.openf1.org/v1"

# Cache directory — avoid re-fetching same data
CACHE_DIR = Path(__file__).parent.parent / "data" / "openf1_cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)


# ── Driver number → F1 SIM driver ID mapping ─────────────────────────────────
# Maps OpenF1 driver numbers to the internal IDs used in f1_simulator.jsx
# Update this as the 2027 grid is confirmed
DRIVER_NUMBER_MAP = {
    # 2024 grid (use as proxy until 2027 data available)
    1:  "verstappen",
    4:  "norris",
    81: "piastri",
    44: "hamilton",
    63: "russell",
    16: "leclerc",
    55: "sainz",
    11: "perez",
    14: "alonso",
    18: "stroll",
    10: "gasly",
    31: "ocon",
    77: "bottas",
    24: "zhou",
    23: "albon",
    2:  "sargeant",
    20: "magnussen",
    27: "hulkenberg",
    22: "tsunoda",
    3:  "ricciardo",
    # 2025+ rookies
    87: "bearman",
    72: "antonelli",
    30: "lawson",
    7:  "hadjar",
    12: "bortoleto",
    43: "colapinto",
    5:  "lindblad",
}

# Team name → F1 SIM team ID mapping
TEAM_NAME_MAP = {
    "Red Bull Racing": "redbull",
    "McLaren":         "mclaren",
    "Ferrari":         "ferrari",
    "Mercedes":        "mercedes",
    "Aston Martin":    "aston",
    "Alpine":          "alpine",
    "Williams":        "williams",
    "Racing Bulls":    "racingbulls",
    "Haas F1 Team":    "haas",
    "Sauber":          "audi",
    "Kick Sauber":     "audi",
    "Audi":            "audi",
    "Cadillac":        "cadillac",
}


# ── HTTP helpers ──────────────────────────────────────────────────────────────

class OpenF1Client:
    """
    HTTP client for the OpenF1 API with caching and rate limiting.

    All responses are cached to disk so that re-runs don't hit the API.
    Cache is keyed by URL — to refresh, delete the cache file.
    """

    def __init__(self, cache_ttl_hours: int = 24):
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "F1SIM-ML/2027.1"})
        self.cache_ttl = cache_ttl_hours * 3600
        self._last_request = 0
        self._rate_limit_delay = 0.5   # 500ms between requests → ~120/min, well under limit

    def _cache_path(self, url: str) -> Path:
        safe = url.replace("https://api.openf1.org/v1/", "").replace("/", "_").replace("?", "__").replace("&", "_").replace("=", "-")
        return CACHE_DIR / f"{safe[:120]}.json"

    def get(self, endpoint: str, params: dict = None, force_refresh: bool = False) -> Optional[list]:
        """
        Fetch from OpenF1, using disk cache when available.

        Args:
            endpoint: e.g. "meetings", "laps"
            params: query parameters dict
            force_refresh: bypass cache

        Returns:
            List of result dicts, or None on error
        """
        url = f"{OPENF1_BASE}/{endpoint}"
        param_str = "&".join(f"{k}={v}" for k, v in (params or {}).items())
        cache_key = f"{url}?{param_str}" if param_str else url
        cache_file = self._cache_path(cache_key)

        # Check cache
        if not force_refresh and cache_file.exists():
            age = time.time() - cache_file.stat().st_mtime
            if age < self.cache_ttl:
                with open(cache_file) as f:
                    data = json.load(f)
                print(f"  [cache] {endpoint} ({len(data)} rows)")
                return data

        # Rate limit
        elapsed = time.time() - self._last_request
        if elapsed < self._rate_limit_delay:
            time.sleep(self._rate_limit_delay - elapsed)

        # Fetch
        try:
            r = self.session.get(url, params=params, timeout=30)
            self._last_request = time.time()
            r.raise_for_status()
            data = r.json()
            if isinstance(data, list):
                # Cache result
                with open(cache_file, "w") as f:
                    json.dump(data, f)
                print(f"  [api]   {endpoint} ({len(data)} rows)")
                return data
            else:
                print(f"  [warn]  {endpoint} returned non-list: {type(data)}")
                return None
        except requests.RequestException as e:
            print(f"  [error] {endpoint}: {e}")
            return None


# ── Data fetching ─────────────────────────────────────────────────────────────

class OpenF1Fetcher:
    """
    High-level fetcher that pulls complete race weekend data.

    Fetches in the correct order (meetings → sessions → per-session data)
    and assembles a structured WeekendData object for each race.
    """

    def __init__(self, client: Optional[OpenF1Client] = None):
        self.client = client or OpenF1Client()

    def get_season(self, year: int) -> List[dict]:
        """Fetch all race meetings for a season."""
        return self.client.get("meetings", {"year": year}) or []

    def get_sessions(self, meeting_key: int) -> List[dict]:
        """Fetch all sessions for a meeting (Practice, Qualifying, Race, Sprint)."""
        return self.client.get("sessions", {"meeting_key": meeting_key}) or []

    def get_latest_session(self, session_type: str = "Race") -> Optional[dict]:
        """Get the most recent session of a given type."""
        sessions = self.client.get("sessions", {"session_type": session_type})
        if not sessions:
            return None
        return max(sessions, key=lambda s: s.get("date_start", ""))

    def get_drivers(self, session_key: int) -> List[dict]:
        """Get driver list for a session."""
        return self.client.get("drivers", {"session_key": session_key}) or []

    def get_laps(self, session_key: int, driver_number: Optional[int] = None) -> List[dict]:
        """Get all lap times for a session, optionally filtered by driver."""
        params = {"session_key": session_key}
        if driver_number:
            params["driver_number"] = driver_number
        return self.client.get("laps", params) or []

    def get_position(self, session_key: int) -> List[dict]:
        """Get position data for a session."""
        return self.client.get("position", {"session_key": session_key}) or []

    def get_pit_stops(self, session_key: int) -> List[dict]:
        """Get pit stop data."""
        return self.client.get("pit", {"session_key": session_key}) or []

    def get_stints(self, session_key: int) -> List[dict]:
        """Get stint/tyre data."""
        return self.client.get("stints", {"session_key": session_key}) or []

    def get_weather(self, session_key: int) -> List[dict]:
        """Get weather snapshots during a session."""
        return self.client.get("weather", {"session_key": session_key}) or []

    def get_race_control(self, session_key: int) -> List[dict]:
        """Get safety car, VSC, red flag events."""
        return self.client.get("race_control", {"session_key": session_key}) or []

    def get_intervals(self, session_key: int) -> List[dict]:
        """Get gap-to-leader data during a session."""
        return self.client.get("intervals", {"session_key": session_key}) or []

    def fetch_full_weekend(self, meeting_key: int) -> dict:
        """
        Fetch all data for a complete race weekend.

        Returns a dict with keys:
            meeting, sessions, qualifying, race, sprint (if applicable)
            Each session includes: laps, positions, weather, stints, pit_stops
        """
        print(f"\nFetching weekend {meeting_key}...")
        sessions = self.get_sessions(meeting_key)
        if not sessions:
            return {}

        def build_session_data(session: dict) -> dict:
            sk = session["session_key"]
            name = session.get("session_type", "")
            print(f"  Loading {name} (key={sk})...")
            return {
                **session,
                "laps":        self.get_laps(sk),
                "positions":   self.get_position(sk),
                "stints":      self.get_stints(sk),
                "pit_stops":   self.get_pit_stops(sk),
                "weather":     self.get_weather(sk),
                "race_control":self.get_race_control(sk),
            }

        session_types = {s["session_type"]: s for s in sessions}

        return {
            "meeting_key":  meeting_key,
            "qualifying":   build_session_data(session_types["Qualifying"]) if "Qualifying" in session_types else None,
            "race":         build_session_data(session_types["Race"]) if "Race" in session_types else None,
            "sprint_quali": build_session_data(session_types["Sprint Shootout"]) if "Sprint Shootout" in session_types else None,
            "sprint":       build_session_data(session_types["Sprint"]) if "Sprint" in session_types else None,
        }


# ── Stat calibration ──────────────────────────────────────────────────────────

class StatCalibrator:
    """
    Derives driver and team stat updates from real OpenF1 data.

    Core methodology:
        - Pace rating: based on qualifying gap to team-mate and fastest driver
        - Consistency: based on lap time standard deviation over a race
        - Wet rating: boost/penalty based on wet-race vs dry-race delta
        - Team carPace: based on car's absolute performance vs field
        - Experience: slow-moving metric, updated only after season completion

    All outputs are delta adjustments (e.g. +2, -1) not absolute values.
    The caller decides whether to apply them.
    """

    def __init__(self, fetcher: OpenF1Fetcher):
        self.fetcher = fetcher
        self.results: List[dict] = []   # accumulates per-weekend results

    # ── Qualifying analysis ──────────────────────────────────────────────────

    def analyse_qualifying(self, session_data: dict, meeting_name: str = "") -> pd.DataFrame:
        """
        Extract qualifying performance from lap data.

        For each driver, finds their best qualifying lap (Q3 preferred, then Q2, Q1).
        Computes:
            - gap_to_pole: absolute gap in seconds
            - gap_to_teammate: signed gap vs team-mate's best lap
            - pace_rating: 97 - (gap_to_pole / max_gap) * 25
            - quali_rank: position 1-20

        Returns DataFrame with one row per driver.
        """
        laps = pd.DataFrame(session_data.get("laps", []))
        if laps.empty or "lap_duration" not in laps.columns:
            return pd.DataFrame()

        # Only count valid laps (not pit-out laps, no missing duration)
        valid = laps[
            (laps["lap_duration"].notna()) &
            (laps["is_pit_out_lap"] == False) &
            (laps["lap_duration"] > 0)
        ].copy()

        if valid.empty:
            return pd.DataFrame()

        # Best lap per driver
        best = (
            valid.groupby("driver_number")["lap_duration"]
            .min()
            .reset_index()
            .rename(columns={"lap_duration": "best_lap"})
        )

        pole_time = best["best_lap"].min()
        max_gap = best["best_lap"].max() - pole_time

        best["gap_to_pole"] = best["best_lap"] - pole_time
        best["quali_rank"] = best["best_lap"].rank().astype(int)
        best["driver_id"] = best["driver_number"].map(DRIVER_NUMBER_MAP)
        best["meeting"] = meeting_name

        # Pace rating: scale 72-97 based on gap to pole
        # A 1.5s gap at the back of a typical grid → ~72, pole → 97
        ref_max_gap = max(max_gap, 1.5)
        best["pace_rating"] = 97 - (best["gap_to_pole"] / ref_max_gap) * 25
        best["pace_rating"] = best["pace_rating"].clip(72, 99).round(1)

        return best.sort_values("quali_rank")

    # ── Race consistency analysis ────────────────────────────────────────────

    def analyse_race_consistency(self, session_data: dict) -> pd.DataFrame:
        """
        Compute consistency score from race lap time standard deviation.

        Method:
            1. For each driver, take race laps (exclude pit-out laps, first lap, safety car laps)
            2. Compute coefficient of variation (σ/μ) as a normalised consistency measure
            3. Scale to 50-95 rating (lower CV = higher consistency)

        Returns DataFrame with driver_id, consistency_rating, laps_counted.
        """
        laps = pd.DataFrame(session_data.get("laps", []))
        rc = pd.DataFrame(session_data.get("race_control", []))

        if laps.empty or "lap_duration" not in laps.columns:
            return pd.DataFrame()

        # Find safety car laps from race control
        sc_laps = set()
        if not rc.empty and "lap_number" in rc.columns:
            sc_events = rc[rc["category"].isin(["SafetyCar", "VirtualSafetyCar"])]
            sc_laps = set(sc_events["lap_number"].dropna().astype(int).tolist())

        results = []
        for drv_num, grp in laps.groupby("driver_number"):
            # Filter: valid laps, skip first lap, skip SC laps
            clean = grp[
                (grp["lap_duration"].notna()) &
                (grp["lap_duration"] > 0) &
                (grp["is_pit_out_lap"] == False) &
                (grp["lap_number"] > 1) &
                (~grp["lap_number"].isin(sc_laps))
            ]["lap_duration"]

            if len(clean) < 5:
                continue

            # Remove outliers (>107% of median → slow laps due to traffic/incidents)
            median = clean.median()
            clean = clean[clean <= median * 1.07]

            if len(clean) < 5:
                continue

            cv = clean.std() / clean.mean()   # coefficient of variation
            # CV typical range: 0.003 (very consistent) to 0.020 (inconsistent)
            # Map to 50-95 rating
            consistency = max(50, min(95, 95 - (cv / 0.020) * 45))

            results.append({
                "driver_number":      drv_num,
                "driver_id":          DRIVER_NUMBER_MAP.get(drv_num),
                "consistency_rating": round(consistency, 1),
                "laps_counted":       len(clean),
                "lap_cv":             round(cv * 100, 3),   # as percentage
            })

        return pd.DataFrame(results).sort_values("consistency_rating", ascending=False)

    # ── Team car pace analysis ───────────────────────────────────────────────

    def analyse_team_pace(self, quali_df: pd.DataFrame, race_df: pd.DataFrame) -> pd.DataFrame:
        """
        Estimate team car pace from average of both drivers' performance.

        Uses qualifying pace (60% weight) + race consistency (40%) to
        estimate a composite car performance rating.

        Returns DataFrame with team_id, car_pace_rating.
        """
        if quali_df.empty:
            return pd.DataFrame()

        # Get driver→team mapping from driver numbers
        driver_teams = {}
        for num, did in DRIVER_NUMBER_MAP.items():
            # This is a placeholder — in production, fetch from /drivers endpoint
            driver_teams[did] = "unknown"

        # Average qualifying pace per team (using driver_id team grouping)
        # Since we don't have team in quali_df, use rank-based approach
        quali_df = quali_df.copy()
        quali_df["car_pace_proxy"] = quali_df["pace_rating"]

        # Team pace = average of both drivers' best pace
        # We'd need the team mapping — for now return per-driver ratings
        return quali_df[["driver_id", "pace_rating", "quali_rank"]].dropna()

    # ── Wet weather analysis ─────────────────────────────────────────────────

    def analyse_wet_performance(self, dry_session: dict, wet_session: dict) -> pd.DataFrame:
        """
        Compare a driver's performance delta between dry and wet sessions.

        Wet weather rating adjustment:
            If a driver performs BETTER in wet relative to field → wet rating +3
            If a driver performs WORSE in wet relative to field → wet rating -2

        Returns DataFrame with driver_id, wet_delta, wet_adjustment.
        """
        dry_df = self.analyse_qualifying(dry_session, "dry")
        wet_df = self.analyse_qualifying(wet_session, "wet")

        if dry_df.empty or wet_df.empty:
            return pd.DataFrame()

        dry_df = dry_df[["driver_id","gap_to_pole"]].rename(columns={"gap_to_pole":"dry_gap"})
        wet_df = wet_df[["driver_id","gap_to_pole"]].rename(columns={"gap_to_pole":"wet_gap"})

        merged = dry_df.merge(wet_df, on="driver_id", how="inner")
        merged["wet_delta"] = merged["wet_gap"] - merged["dry_gap"]
        # Positive = worse in wet, negative = better in wet
        field_avg = merged["wet_delta"].mean()
        merged["wet_vs_field"] = merged["wet_delta"] - field_avg

        def wet_adj(d):
            if d < -0.3:   return +3    # significantly better in wet
            elif d < -0.1: return +2
            elif d < 0.1:  return 0
            elif d < 0.3:  return -1
            else:          return -2    # significantly worse in wet

        merged["wet_adjustment"] = merged["wet_vs_field"].apply(wet_adj)
        return merged.sort_values("wet_adjustment", ascending=False)

    # ── Season-wide calibration ──────────────────────────────────────────────

    def calibrate_full_season(
        self,
        year: int,
        current_ratings: dict,
        max_rounds: int = 24,
    ) -> dict:
        """
        Process an entire season of OpenF1 data and produce updated driver ratings.

        Args:
            year: season year (e.g. 2024 for proxy data)
            current_ratings: dict of {driver_id: {pace, consistency, wet, experience}}
            max_rounds: how many rounds to process (most recent first)

        Returns:
            dict of {driver_id: {pace, consistency, wet, pace_delta, cons_delta}}
        """
        print(f"\n{'='*60}")
        print(f"  CALIBRATING FROM OPENF1 — {year} SEASON")
        print(f"{'='*60}")

        meetings = self.fetcher.get_season(year)
        if not meetings:
            print("  No meetings found — check network connection to openf1.org")
            return {}

        print(f"  Found {len(meetings)} meetings")

        # Sort by most recent first, take last N completed
        meetings = sorted(meetings, key=lambda m: m.get("date_start",""), reverse=True)
        meetings = meetings[:max_rounds]

        # Accumulate per-driver data across rounds
        pace_ratings    = {}   # driver_id → [pace_rating, ...]
        consistency_ratings = {}   # driver_id → [consistency, ...]
        rounds_counted  = {}   # driver_id → count

        for meeting in meetings:
            mk = meeting.get("meeting_key")
            mn = meeting.get("meeting_name", "")
            print(f"\n  Round: {mn} (key={mk})")

            sessions = self.fetcher.get_sessions(mk)
            session_map = {s["session_type"]: s for s in sessions}

            # Qualifying pace
            if "Qualifying" in session_map:
                qsess = {**session_map["Qualifying"],
                         "laps": self.fetcher.get_laps(session_map["Qualifying"]["session_key"])}
                qdf = self.analyse_qualifying(qsess, mn)
                for _, row in qdf.iterrows():
                    did = row.get("driver_id")
                    if not did: continue
                    pace_ratings.setdefault(did, []).append(row["pace_rating"])
                    rounds_counted[did] = rounds_counted.get(did, 0) + 1

            # Race consistency
            if "Race" in session_map:
                rsess = {
                    **session_map["Race"],
                    "laps": self.fetcher.get_laps(session_map["Race"]["session_key"]),
                    "race_control": self.fetcher.get_race_control(session_map["Race"]["session_key"]),
                }
                cdf = self.analyse_race_consistency(rsess)
                for _, row in cdf.iterrows():
                    did = row.get("driver_id")
                    if not did: continue
                    consistency_ratings.setdefault(did, []).append(row["consistency_rating"])

        # Build final ratings with EMA weighting (recent rounds weighted more)
        result = {}
        for did in set(list(pace_ratings.keys()) + list(consistency_ratings.keys())):
            pace_list = pace_ratings.get(did, [])
            cons_list = consistency_ratings.get(did, [])
            current = current_ratings.get(did, {})

            # Exponential weighting: most recent = 2× weight
            def ema(values, alpha=0.3):
                if not values: return None
                result = values[0]
                for v in values[1:]:
                    result = alpha * v + (1 - alpha) * result
                return round(result, 1)

            new_pace = ema(pace_list)
            new_cons = ema(cons_list)

            # Blend with existing: 70% data-driven, 30% existing rating
            # This prevents wild swings from small sample sizes
            def blend(new_val, current_val, alpha=0.7):
                if new_val is None: return current_val
                if current_val is None: return new_val
                return round(alpha * new_val + (1 - alpha) * current_val, 1)

            result[did] = {
                "pace":        blend(new_pace, current.get("pace")),
                "consistency": blend(new_cons, current.get("consistency")),
                "rounds":      rounds_counted.get(did, 0),
                "pace_delta":  round((blend(new_pace, current.get("pace")) or 0) - (current.get("pace") or 0), 1),
                "cons_delta":  round((blend(new_cons, current.get("consistency")) or 0) - (current.get("consistency") or 0), 1),
            }

        print(f"\n  Calibrated {len(result)} drivers across {len(meetings)} rounds")
        return result


# ── Feature engineering for LightGBM ─────────────────────────────────────────

class OpenF1FeatureBuilder:
    """
    Builds LightGBM-ready features from OpenF1 race data.

    These features are richer than the user-submission features in data.py:
        - Actual qualifying lap times (not just predicted scores)
        - Real tyre compounds and stint lengths
        - Pit stop deltas
        - Gap evolution through the race
        - Safety car impact
        - Weather effects

    Merges with the FeatureBuilder from data.py for combined training.
    """

    def __init__(self, fetcher: OpenF1Fetcher):
        self.fetcher = fetcher

    def build_qualifying_features(self, session_data: dict, circuit_id: str) -> pd.DataFrame:
        """
        Build features from a qualifying session.

        Returns one row per driver with:
            gap_to_pole, sector_1/2/3 gaps, consistency, team mate delta,
            circuit_id, session type indicators
        """
        laps = pd.DataFrame(session_data.get("laps", []))
        if laps.empty:
            return pd.DataFrame()

        valid = laps[
            laps["lap_duration"].notna() &
            (laps["lap_duration"] > 0) &
            (laps["is_pit_out_lap"] == False)
        ].copy()

        if valid.empty:
            return pd.DataFrame()

        # Best lap and sector times per driver
        agg = valid.groupby("driver_number").agg(
            best_lap        = ("lap_duration", "min"),
            best_s1         = ("duration_sector_1", "min"),
            best_s2         = ("duration_sector_2", "min"),
            best_s3         = ("duration_sector_3", "min"),
            lap_count       = ("lap_number", "count"),
        ).reset_index()

        pole = agg["best_lap"].min()
        agg["gap_to_pole"]  = (agg["best_lap"] - pole).round(3)
        agg["driver_id"]    = agg["driver_number"].map(DRIVER_NUMBER_MAP)
        agg["circuit_id"]   = circuit_id
        agg["data_source"]  = "openf1_qualifying"

        # Sector balance (helps model understand circuit-specific strengths)
        best_s1 = agg["best_s1"].min()
        best_s2 = agg["best_s2"].min()
        best_s3 = agg["best_s3"].min()
        agg["s1_gap"] = (agg["best_s1"] - best_s1).round(3)
        agg["s2_gap"] = (agg["best_s2"] - best_s2).round(3)
        agg["s3_gap"] = (agg["best_s3"] - best_s3).round(3)

        return agg.dropna(subset=["driver_id"])

    def build_race_features(self, session_data: dict, circuit_id: str) -> pd.DataFrame:
        """
        Build features from a race session.

        Returns one row per driver with:
            final_position, laps_completed, pit_count, avg_stint_length,
            consistency (lap time std), gap_to_winner, tyre_compounds_used,
            was_wet, safety_car_laps
        """
        laps     = pd.DataFrame(session_data.get("laps", []))
        pits     = pd.DataFrame(session_data.get("pit_stops", []))
        stints   = pd.DataFrame(session_data.get("stints", []))
        weather  = pd.DataFrame(session_data.get("weather", []))
        rc       = pd.DataFrame(session_data.get("race_control", []))
        positions= pd.DataFrame(session_data.get("positions", []))

        if laps.empty:
            return pd.DataFrame()

        # Was it wet?
        was_wet = False
        if not weather.empty and "rainfall" in weather.columns:
            was_wet = bool(weather["rainfall"].any())

        # Safety car lap count
        sc_laps = 0
        if not rc.empty and "category" in rc.columns:
            sc_events = rc[rc["category"].isin(["SafetyCar", "VirtualSafetyCar"])]
            sc_laps = sc_events["lap_number"].nunique() if "lap_number" in sc_events.columns else 0

        results = []
        for drv_num, grp in laps.groupby("driver_number"):
            valid = grp[grp["lap_duration"].notna() & (grp["lap_duration"] > 0) & ~grp["is_pit_out_lap"]]

            # Consistency
            clean = valid[valid["lap_duration"] <= valid["lap_duration"].median() * 1.07]["lap_duration"]
            consistency = None
            if len(clean) > 5:
                cv = clean.std() / clean.mean()
                consistency = round(max(50, min(95, 95 - (cv / 0.020) * 45)), 1)

            # Pit stops for this driver
            drv_pits = pits[pits["driver_number"] == drv_num] if not pits.empty else pd.DataFrame()
            pit_count = len(drv_pits)
            avg_pit_delta = drv_pits["pit_duration"].mean() if not drv_pits.empty and "pit_duration" in drv_pits.columns else None

            # Tyre compounds
            drv_stints = stints[stints["driver_number"] == drv_num] if not stints.empty else pd.DataFrame()
            compounds = drv_stints["compound"].unique().tolist() if not drv_stints.empty and "compound" in drv_stints.columns else []

            results.append({
                "driver_number":    drv_num,
                "driver_id":        DRIVER_NUMBER_MAP.get(drv_num),
                "circuit_id":       circuit_id,
                "laps_completed":   len(grp),
                "consistency":      consistency,
                "pit_count":        pit_count,
                "avg_pit_delta":    round(avg_pit_delta, 2) if avg_pit_delta else None,
                "compounds_used":   len(set(compounds)),
                "used_soft":        int("SOFT" in compounds),
                "used_medium":      int("MEDIUM" in compounds),
                "used_hard":        int("HARD" in compounds),
                "used_inter":       int("INTERMEDIATE" in compounds),
                "used_wet":         int("WET" in compounds),
                "was_wet":          int(was_wet),
                "safety_car_laps":  sc_laps,
                "data_source":      "openf1_race",
            })

        return pd.DataFrame(results).dropna(subset=["driver_id"])


# ── Export calibrated stats ───────────────────────────────────────────────────

def format_stat_updates(calibrated: dict, current_js_drivers: list) -> dict:
    """
    Format calibrated stats as a diff that can be applied to the JS driver array.

    Args:
        calibrated: output of StatCalibrator.calibrate_full_season()
        current_js_drivers: list of driver dicts from f1_simulator.jsx

    Returns:
        dict of { driver_id: { stat: new_value, delta: change } }
        Only includes drivers where the change is ≥ 1 point (meaningful update)
    """
    updates = {}
    for drv in current_js_drivers:
        did = drv.get("id")
        if did not in calibrated:
            continue
        cal = calibrated[did]

        drv_updates = {}

        if cal.get("pace") and abs(cal.get("pace_delta", 0)) >= 1:
            drv_updates["pace"] = {
                "old": drv.get("pace", 0),
                "new": int(round(cal["pace"])),
                "delta": cal["pace_delta"]
            }

        if cal.get("consistency") and abs(cal.get("cons_delta", 0)) >= 1:
            drv_updates["consistency"] = {
                "old": drv.get("consistency", 0),
                "new": int(round(cal["consistency"])),
                "delta": cal["cons_delta"]
            }

        if drv_updates:
            updates[did] = {
                "name":   drv.get("name", did),
                "rounds": cal.get("rounds", 0),
                **drv_updates
            }

    return updates


def save_calibration(updates: dict, output_path: Optional[Path] = None) -> Path:
    """Save calibrated stat updates to JSON for use by the app."""
    output_path = output_path or Path(__file__).parent.parent / "models" / "stat_calibration.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "driver_count": len(updates),
        "updates": updates,
    }
    with open(output_path, "w") as f:
        json.dump(payload, f, indent=2)
    print(f"\n✅ Calibration saved to {output_path}")
    return output_path


# ── CLI entry point ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="OpenF1 data fetcher and stat calibrator")
    parser.add_argument("--year", type=int, default=2024, help="Season year")
    parser.add_argument("--calibrate", action="store_true", help="Run stat calibration")
    parser.add_argument("--export", action="store_true", help="Export calibrated stats to JSON")
    parser.add_argument("--meeting", type=int, help="Fetch a specific meeting key")
    parser.add_argument("--rounds", type=int, default=10, help="Max rounds to calibrate from")
    args = parser.parse_args()

    client  = OpenF1Client()
    fetcher = OpenF1Fetcher(client)

    if args.meeting:
        data = fetcher.fetch_full_weekend(args.meeting)
        print(json.dumps({k: v for k, v in data.items() if k != "laps"}, indent=2, default=str))

    elif args.calibrate or args.export:
        # Use 2024 data as proxy (2027 won't exist until 2027)
        from f1sim_ml.export import DEFAULT_DRIVERS
        current_ratings = {d["id"]: d for d in DEFAULT_DRIVERS}

        calibrator = StatCalibrator(fetcher)
        calibrated = calibrator.calibrate_full_season(
            year=args.year,
            current_ratings=current_ratings,
            max_rounds=args.rounds,
        )

        updates = format_stat_updates(calibrated, DEFAULT_DRIVERS)
        print("\n── Stat updates (≥1 point change) ──")
        for did, upd in sorted(updates.items()):
            print(f"\n  {upd['name']} ({upd['rounds']} rounds):")
            for stat, vals in upd.items():
                if stat in ("name","rounds"): continue
                arrow = "↑" if vals["delta"] > 0 else "↓"
                print(f"    {stat:<15} {vals['old']:>3} → {vals['new']:>3}  ({arrow}{abs(vals['delta'])})")

        if args.export:
            save_calibration(updates)
            print("\nImport these into F1 SIM:")
            print("  Stats tab → STATS → 'Update Stats from OpenF1' button")

    else:
        # Show season overview
        meetings = fetcher.get_season(args.year)
        print(f"\n{args.year} Season — {len(meetings)} meetings:")
        for m in meetings:
            print(f"  [{m.get('meeting_key')}] {m.get('meeting_name'):<35} {m.get('date_start','')[:10]}")
