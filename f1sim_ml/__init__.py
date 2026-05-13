"""
f1sim_ml — F1 SIM LightGBM Prediction Model
=============================================
Trains on community race_sims data from Supabase.
Predicts driver win/podium probability per circuit.
Outputs calibrated weights for the JS simulator.

Usage:
    python -m f1sim_ml.train            # train on latest data
    python -m f1sim_ml.predict --circuit monaco
    python -m f1sim_ml.export           # export weights for JS
"""

from .model     import F1SimModel
from .data      import SupabaseLoader, FeatureBuilder
from .train     import train_pipeline
from .predict   import predict_race
from .export    import export_to_js
from .calibrate import CalibrationTracker

__version__ = "1.0.0"
__all__ = [
    "F1SimModel", "SupabaseLoader", "FeatureBuilder",
    "train_pipeline", "predict_race", "export_to_js", "CalibrationTracker",
]
