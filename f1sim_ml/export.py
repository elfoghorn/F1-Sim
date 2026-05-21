"""
export.py — Export LightGBM predictions as JavaScript weights
==============================================================
Runs the trained model over all 24 circuits × 22 drivers and
produces a JSON file that the F1 SIM app can import to update
the community_model table or use directly in the JS engine.
"""

import json
import numpy as np
import pandas as pd
from pathlib import Path
from typing import Optional, List, Dict
from .model   import F1SimModel
from .predict import predict_race
from .data    import CIRCUIT_META


# Default 2027 roster — mirrors the JS DRIVERS constant
DEFAULT_DRIVERS = [
    {"id":"norris",     "pace":94,"consistency":90,"wet":88,"overtaking":91,"defense":87,"experience":82,"mental":8, "style":"charger",   "teamId":"mclaren"},
    {"id":"piastri",    "pace":90,"consistency":88,"wet":85,"overtaking":87,"defense":83,"experience":76,"mental":7, "style":"technical",  "teamId":"mclaren"},
    {"id":"russell",    "pace":90,"consistency":88,"wet":87,"overtaking":84,"defense":86,"experience":84,"mental":8, "style":"strategist", "teamId":"mercedes"},
    {"id":"antonelli",  "pace":87,"consistency":83,"wet":81,"overtaking":82,"defense":80,"experience":62,"mental":6, "style":"qualifier",  "teamId":"mercedes"},
    {"id":"verstappen", "pace":96,"consistency":93,"wet":91,"overtaking":92,"defense":91,"experience":90,"mental":9, "style":"aggressive", "teamId":"redbull"},
    {"id":"hadjar",     "pace":83,"consistency":79,"wet":77,"overtaking":80,"defense":76,"experience":58,"mental":5, "style":"charger",    "teamId":"redbull"},
    {"id":"leclerc",    "pace":93,"consistency":87,"wet":90,"overtaking":88,"defense":85,"experience":86,"mental":8, "style":"qualifier",  "teamId":"ferrari"},
    {"id":"hamilton",   "pace":90,"consistency":89,"wet":92,"overtaking":89,"defense":87,"experience":95,"mental":9, "style":"smooth",     "teamId":"ferrari"},
    {"id":"sainz",      "pace":88,"consistency":87,"wet":87,"overtaking":85,"defense":84,"experience":88,"mental":8, "style":"strategist", "teamId":"williams"},
    {"id":"albon",      "pace":84,"consistency":83,"wet":84,"overtaking":82,"defense":81,"experience":80,"mental":7, "style":"smooth",     "teamId":"williams"},
    {"id":"lawson",     "pace":84,"consistency":80,"wet":78,"overtaking":82,"defense":78,"experience":64,"mental":6, "style":"aggressive", "teamId":"racingbulls"},
    {"id":"lindblad",   "pace":80,"consistency":76,"wet":73,"overtaking":78,"defense":73,"experience":52,"mental":5, "style":"charger",    "teamId":"racingbulls"},
    {"id":"alonso",     "pace":86,"consistency":88,"wet":88,"overtaking":85,"defense":88,"experience":96,"mental":9, "style":"strategist", "teamId":"aston"},
    {"id":"stroll",     "pace":78,"consistency":76,"wet":76,"overtaking":74,"defense":75,"experience":76,"mental":6, "style":"defender",   "teamId":"aston"},
    {"id":"bearman",    "pace":83,"consistency":79,"wet":77,"overtaking":80,"defense":76,"experience":62,"mental":6, "style":"aggressive", "teamId":"haas"},
    {"id":"ocon",       "pace":80,"consistency":80,"wet":81,"overtaking":78,"defense":79,"experience":82,"mental":7, "style":"smooth",     "teamId":"haas"},
    {"id":"hulkenberg",  "pace":81,"consistency":83,"wet":82,"overtaking":78,"defense":80,"experience":88,"mental":7, "style":"ironman",   "teamId":"audi"},
    {"id":"bortoleto",  "pace":84,"consistency":80,"wet":78,"overtaking":83,"defense":77,"experience":60,"mental":6, "style":"charger",    "teamId":"audi"},
    {"id":"gasly",      "pace":82,"consistency":82,"wet":83,"overtaking":80,"defense":79,"experience":84,"mental":7, "style":"technical",  "teamId":"alpine"},
    {"id":"colapinto",  "pace":82,"consistency":79,"wet":77,"overtaking":81,"defense":76,"experience":62,"mental":6, "style":"aggressive", "teamId":"alpine"},
    {"id":"perez",      "pace":82,"consistency":82,"wet":80,"overtaking":79,"defense":79,"experience":87,"mental":7, "style":"strategist", "teamId":"cadillac"},
    {"id":"bottas",     "pace":80,"consistency":81,"wet":82,"overtaking":76,"defense":77,"experience":90,"mental":7, "style":"smooth",     "teamId":"cadillac"},
]

DEFAULT_TEAMS = [
    {"id":"mclaren",    "carPace":92},
    {"id":"mercedes",   "carPace":88},
    {"id":"redbull",    "carPace":90},
    {"id":"ferrari",    "carPace":91},
    {"id":"williams",   "carPace":80},
    {"id":"racingbulls","carPace":82},
    {"id":"aston",      "carPace":83},
    {"id":"haas",       "carPace":78},
    {"id":"audi",       "carPace":79},
    {"id":"alpine",     "carPace":79},
    {"id":"cadillac",   "carPace":76},
]


def export_to_js(
    model: Optional[F1SimModel] = None,
    drivers: Optional[List[Dict]] = None,
    teams:   Optional[List[Dict]] = None,
    output_path: Optional[Path]   = None,
) -> dict:
    """
    Run model across all circuits and export as JSON for the JS app.

    The output can be:
    1. Uploaded to community_model via Supabase REST API
    2. Used directly in the JS engine to override local predictions

    Args:
        model: trained F1SimModel (loads from disk if not provided)
        drivers: driver list (uses 2027 defaults if not provided)
        teams: team list (uses 2027 defaults if not provided)
        output_path: where to save the JSON (models/community_weights.json)

    Returns:
        dict of { circuit_id: [{ driver_id, win_pct, podium_pct }] }
    """
    if model is None:
        model = F1SimModel().load()

    drivers = drivers or DEFAULT_DRIVERS
    teams   = teams   or DEFAULT_TEAMS
    output_path = output_path or Path(__file__).parent.parent / "models" / "community_weights.json"

    print(f"Exporting predictions for {len(CIRCUIT_META)} circuits × {len(drivers)} drivers...")

    all_weights = {}
    for circuit_id in CIRCUIT_META:
        preds = predict_race(circuit_id=circuit_id, drivers=drivers, teams=teams, model=model)
        all_weights[circuit_id] = preds
        print(f"  {circuit_id:<15} → P1: {preds[0]['driver_id']:<15} ({preds[0]['win_pct']*100:.0f}% win)")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(all_weights, f, indent=2)
    print(f"\n✅ Weights saved to {output_path}")

    # Also generate a JS const snippet for direct embedding
    js_snippet = "// F1 SIM — LightGBM Community Weights\n"
    js_snippet += "// Auto-generated by f1sim_ml.export — do not edit manually\n"
    js_snippet += "const ML_WEIGHTS = " + json.dumps(all_weights, separators=(",",":")) + ";\n"

    js_path = output_path.with_suffix(".js")
    with open(js_path, "w") as f:
        f.write(js_snippet)
    print(f"✅ JS snippet saved to {js_path}")

    return all_weights


def push_to_supabase(
    weights: dict,
    supabase_url: str,
    supabase_key: str,
    sample_count: int = 999,
) -> bool:
    """
    Push ML model weights to Supabase community_model table.
    This overwrites the SQL-aggregated values with model predictions.

    Args:
        weights: output of export_to_js()
        supabase_url: Supabase project URL
        supabase_key: Supabase anon or service key
        sample_count: artificial sample_count to assign (controls blend weight in JS)

    Returns:
        True if successful
    """
    import requests
    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
    }

    rows = []
    for circuit_id, preds in weights.items():
        for pred in preds:
            rows.append({
                "circuit_id":      circuit_id,
                "driver_id":       pred["driver_id"],
                "avg_win_pct":     pred["win_pct"],
                "avg_podium_pct":  pred["podium_pct"],
                "avg_position":    pred.get("avg_pos_estimate", 11.0),
                "sample_count":    sample_count,
            })

    # Supabase has a max body size — batch in groups of 200
    batch_size = 200
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i+batch_size]
        resp = requests.post(
            f"{supabase_url}/rest/v1/community_model",
            headers=headers,
            json=batch,
        )
        if not resp.ok:
            print(f"❌ Supabase push failed: {resp.status_code} {resp.text}")
            return False
        print(f"  Pushed batch {i//batch_size + 1} ({len(batch)} rows)")

    print(f"✅ Pushed {len(rows)} model predictions to Supabase")
    return True


if __name__ == "__main__":
    weights = export_to_js()
    print("\nTo push to Supabase:")
    print("  from f1sim_ml.export import push_to_supabase")
    print("  push_to_supabase(weights, SUPABASE_URL, SUPABASE_KEY)")
