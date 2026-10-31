"""Configuration utilities for the simulation framework."""
from __future__ import annotations
from typing import Dict, Any, Optional
import json
from pathlib import Path


def load_config(config_path: str) -> Dict[str, Any]:
    """Load configuration from a JSON file."""
    with open(config_path, encoding="utf-8") as f:
        return json.load(f)


def merge_config(raw: Dict[str, Any], date: Optional[str] = None) -> Dict[str, Any]:
    """Merge ranker, selection, and sampling config sections into one flat config.

    The freshness hook and its hyperparameters live in:
      - ranker.sampling.*          (LR engine: epsilon, halfLifeDays,
                                    freshness.model/steepness, dedupe.*,
                                    explore.*, slots.*)
      - selection.*                (Keyword engine: a50_days, slope,
                                    age_floor_days, explore_gamma, etc.)

    Args:
        raw: Raw config dict from config.json
        date: Optional date override

    Returns:
        Flattened config dict with all relevant parameters at top level.
    """
    ranker = raw.get("ranker", {}) or {}
    selection = raw.get("selection", {}) or {}
    sampling = ranker.get("sampling", {}) or {}

    # Merge order: ranker base -> selection -> sampling (sampling wins for conflicts)
    merged = {**ranker, **selection, **sampling}

    # Support both nested and flattened config layouts for backward compat
    # Fall back to top-level keys for flattened configs
    def _get(*keys, default=None):
        for k in keys:
            if k in merged and merged[k] is not None:
                return merged[k]
            if k in raw and raw[k] is not None:
                return raw[k]
        return default

    # Ensure date is present
    merged["date"] = date or merged.get("date", raw.get("date", "2026-10-29"))

    return merged


def freshness_config_summary(config: Dict[str, Any]) -> Dict[str, Any]:
    """Extract and document the freshness calculation hook and hyperparameters from config.

    Returns a flat dict describing which freshness function is active and its parameters,
    plus freshness values at reference ages for both engines.

    Handles both nested config (config["ranker"]["sampling"]...) and flattened config
    (config["epsilon"], config["halfLifeDays"]...).
    """
    import math

    # Support both nested and flattened config layouts
    sampling = config.get("sampling", {}) or {}
    if not isinstance(sampling, dict):
        sampling = {}
    selection = config.get("selection", {}) or {}
    if not isinstance(selection, dict):
        selection = {}

    # Fall back to top-level keys for flattened configs
    def _get(*keys, default=None):
        for k in keys:
            if k in config and config[k] is not None:
                return config[k]
        return default

    # LR freshness params
    lr_freshness_cfg = sampling.get("freshness", {}) or {}
    lr_model = lr_freshness_cfg.get("model", "logistic")
    lr_half_life = sampling.get("halfLifeDays", _get("halfLifeDays", default=7))
    lr_steepness = lr_freshness_cfg.get("steepness", math.log(4))
    lr_epsilon = sampling.get("epsilon", _get("epsilon", default=0.25))
    lr_explore_cfg = sampling.get("explore", {}) or {}
    lr_explore_gamma = lr_explore_cfg.get("gamma", _get("explore.gamma", default=0.5))
    lr_explore_floor = lr_explore_cfg.get("floor", _get("explore.floor", default=0.01))
    lr_dedupe_cfg = sampling.get("dedupe", {}) or {}
    lr_dedupe_t0 = lr_dedupe_cfg.get("t0", _get("dedupe.t0", default=7))
    lr_dedupe_scale = lr_dedupe_cfg.get("scale", _get("dedupe.scale", default=2))
    lr_hard_window = lr_dedupe_cfg.get("hardWindowDays", _get("dedupe.hardWindowDays", default=2))
    lr_slots = sampling.get("slots", {}) or {}

    # Keyword freshness params
    kw_a50 = selection.get("a50_days", _get("a50_days", default=7.0))
    kw_slope = selection.get("slope", _get("slope", default=1.0))
    kw_age_floor = selection.get("age_floor_days", _get("age_floor_days", default=0.25))
    kw_epsilon = selection.get("epsilon", _get("epsilon", default=0.25))
    kw_explore_gamma = selection.get("explore_gamma", _get("explore_gamma", default=0.3))
    kw_shown_decay = selection.get("shown_decay", _get("shown_decay", default=0.05))
    kw_rejected_decay = selection.get("rejected_decay", _get("rejected_decay", default=0.3))

    # Reference ages for curve values
    ref_ages = [0, 1, 7, 30, 50, 120]

    def lr_freshness_curve(age_days: float, cfg: Dict) -> float:
        """Compute LR freshness value at a given age using the sampler.js formula."""
        age = max(0.0, age_days)
        half_life = cfg.get("halfLifeDays", 7)
        freshness_cfg = cfg.get("freshness", {})
        model = freshness_cfg.get("model", "logistic")
        steepness = freshness_cfg.get("steepness", math.log(4))

        if model == "exponential":
            return math.exp(-math.log(2) * age / half_life)
        else:
            # logistic-in-log-age (default)
            return 1.0 / (1.0 + math.exp(
                steepness * (math.log1p(age) - math.log1p(half_life))
            ))

    def kw_freshness_curve(age_days: float, cfg: Dict) -> float:
        """Compute keyword freshness value at a given age."""
        a = max(age_days, cfg.get("age_floor_days", 0.25))
        z = (math.log(cfg.get("a50_days", 7.0)) - math.log(a)) / cfg.get("slope", 1.0)
        return 1.0 / (1.0 + math.exp(-z))

    return {
        "lr_freshness": {
            "model": lr_model,
            "halfLifeDays": lr_half_life,
            "steepness": lr_steepness,
            "epsilon": lr_epsilon,
            "explore": {"gamma": lr_explore_gamma, "floor": lr_explore_floor},
            "dedupe": {"t0": lr_dedupe_t0, "scale": lr_dedupe_scale, "hardWindowDays": lr_hard_window},
            "slots": lr_slots,
            "freshness_at_ages": {
                str(a): round(lr_freshness_curve(a, sampling), 4)
                for a in ref_ages
            },
        },
        "keyword_freshness": {
            "model": "logistic_in_log_age",
            "a50_days": kw_a50,
            "slope": kw_slope,
            "age_floor_days": kw_age_floor,
            "epsilon": kw_epsilon,
            "explore_gamma": kw_explore_gamma,
            "shown_decay": kw_shown_decay,
            "rejected_decay": kw_rejected_decay,
            "freshness_at_ages": {
                str(a): round(kw_freshness_curve(a, selection), 4)
                for a in ref_ages
            },
        },
    }