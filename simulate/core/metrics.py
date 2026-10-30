"""Metrics collector - computes comparison metrics between engine runs."""
from __future__ import annotations
from collections import Counter
from typing import List, Dict, Any, Set, Tuple
import statistics


class MetricsCollector:
    """Static methods for computing various metrics on selections."""
    
    @staticmethod
    def jaccard(set_a: Set, set_b: Set) -> float:
        """Jaccard similarity coefficient."""
        union = set_a | set_b
        if not union:
            return 0.0
        return len(set_a & set_b) / len(union)
    
    @staticmethod
    def overlap(set_a: Set, set_b: Set) -> Dict[str, Any]:
        """Detailed overlap analysis."""
        intersection = set_a & set_b
        union = set_a | set_b
        only_a = set_a - set_b
        only_b = set_b - set_a
        return {
            "jaccard": MetricsCollector.jaccard(set_a, set_b),
            "intersection": len(intersection),
            "union": len(union),
            "only_a": len(only_a),
            "only_b": len(only_b),
            "intersection_ids": list(intersection),
            "only_a_ids": list(only_a),
            "only_b_ids": list(only_b),
        }
    
    @staticmethod
    def diversity(items: List[Dict], key: str) -> Dict[str, int]:
        """Count distribution of a categorical key."""
        return dict(Counter(i.get(key) for i in items if i.get(key) is not None))
    
    @staticmethod
    def freshness(items: List[Dict]) -> Dict[str, float]:
        """Age statistics (mean, median, min, max)."""
        ages = [i.get("age_days", 0) for i in items if i.get("age_days") is not None]
        if not ages:
            return {"mean": 0, "median": 0, "min": 0, "max": 0, "count": 0}
        return {
            "mean": statistics.mean(ages),
            "median": statistics.median(ages),
            "min": min(ages),
            "max": max(ages),
            "count": len(ages),
        }
    
    @staticmethod
    def coverage(all_items: List[Dict], picked_items: List[Dict]) -> float:
        """Fraction of pool ever picked."""
        all_ids = {i["id"] for i in all_items}
        picked_ids = {i["id"] for i in picked_items}
        return len(picked_ids) / len(all_ids) if all_ids else 0.0
    
    @staticmethod
    def mode_distribution(items: List[Dict]) -> Dict[str, int]:
        """Count of selection modes (greedy/explore/reserve)."""
        return dict(Counter(i.get("mode", "unknown") for i in items))
    
    @staticmethod
    def freshness_curve(age_days: float, cfg: Dict) -> float:
        """Compute freshness value at a given age using the same formula as the keyword engine.
        
        f(a) = sigmoid((ln(a50) - ln(a)) / slope)
        """
        import math
        a50 = cfg.get("a50_days", 7.0)
        slope = cfg.get("slope", 1.0)
        age_floor = cfg.get("age_floor_days", 0.25)
        a = max(age_days, age_floor)
        z = (math.log(a50) - math.log(a)) / slope
        return 1.0 / (1.0 + math.exp(-z))

    @staticmethod
    def lr_freshness_curve(age_days: float, cfg: Dict) -> float:
        """Compute LR freshness value at a given age using the sampler.js formula.
        
        Logistic-in-log-age: 1 / (1 + exp(steepness * (log1p(age) - log1p(halfLifeDays))))
        Exponential: exp(-ln(2) * age / halfLifeDays)
        """
        import math
        age = max(0.0, age_days)
        half_life = cfg.get("halfLifeDays", 7)
        freshness_cfg = cfg.get("freshness", {})
        model = freshness_cfg.get("model", "logistic")
        steepness = freshness_cfg.get("steepness", math.log(4))  # ~1.386
        
        if model == "exponential":
            return math.exp(-math.log(2) * age / half_life)
        else:
            # logistic-in-log-age (default)
            return 1.0 / (1.0 + math.exp(
                steepness * (math.log1p(age) - math.log1p(half_life))
            ))

    @staticmethod
    def freshness_config_summary(config: Dict) -> Dict[str, Any]:
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
                    str(a): round(MetricsCollector.lr_freshness_curve(a, sampling), 4)
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
                    str(a): round(MetricsCollector.freshness_curve(a, selection), 4)
                    for a in ref_ages
                },
            },
        }

    @staticmethod
    def desk_stats(selections: Dict[str, List[Dict]]) -> Dict[str, Dict]:
        """Per-desk statistics."""
        stats = {}
        for desk, items in selections.items():
            stats[desk] = {
                "count": len(items),
                "source_types": MetricsCollector.diversity(items, "source_type"),
                "modes": MetricsCollector.mode_distribution(items),
                "freshness": MetricsCollector.freshness(items),
            }
        return stats
    
    @staticmethod
    def compare_selections(
        sel_a: Dict[str, List[Dict]], 
        sel_b: Dict[str, List[Dict]],
        desk: str = "primary"
    ) -> Dict[str, Any]:
        """Compare two engine selections for a specific desk."""
        ids_a = {i["id"] for i in sel_a.get(desk, [])}
        ids_b = {i["id"] for i in sel_b.get(desk, [])}
        
        overlap = MetricsCollector.overlap(ids_a, ids_b)
        
        # Source type distribution
        types_a = MetricsCollector.diversity(sel_a.get(desk, []), "source_type")
        types_b = MetricsCollector.diversity(sel_b.get(desk, []), "source_type")
        
        # Freshness
        fresh_a = MetricsCollector.freshness(sel_a.get(desk, []))
        fresh_b = MetricsCollector.freshness(sel_b.get(desk, []))
        
        # Modes
        modes_a = MetricsCollector.mode_distribution(sel_a.get(desk, []))
        modes_b = MetricsCollector.mode_distribution(sel_b.get(desk, []))
        
        return {
            "desk": desk,
            "overlap": overlap,
            "source_types": {"a": types_a, "b": types_b},
            "freshness": {"a": fresh_a, "b": fresh_b},
            "modes": {"a": modes_a, "b": modes_b},
        }
    
    @staticmethod
    def aggregate_runs(runs: List[Dict], desk: str = "primary") -> Dict[str, Any]:
        """Aggregate metrics across multiple runs."""
        if not runs:
            return {}
        
        # Collect all picked items per engine
        engine_picks = {}  # engine -> [run_picked_ids]
        for run in runs:
            for engine, selections in run.get("selections", {}).items():
                if engine not in engine_picks:
                    engine_picks[engine] = []
                picked = {i["id"] for i in selections.get(desk, [])}
                engine_picks[engine].append(picked)
        
        result = {}
        for engine, pick_sets in engine_picks.items():
            # Ever-picked items
            ever_picked = set()
            for s in pick_sets:
                ever_picked.update(s)
            
            # Consecutive Jaccard (stability)
            consecutive_jaccards = []
            for i in range(1, len(pick_sets)):
                consecutive_jaccards.append(
                    MetricsCollector.jaccard(pick_sets[i-1], pick_sets[i])
                )
            
            # Per-item pick frequency
            item_counts = Counter()
            for s in pick_sets:
                item_counts.update(s)
            
            result[engine] = {
                "runs": len(pick_sets),
                "ever_picked": len(ever_picked),
                "consecutive_jaccard_mean": statistics.mean(consecutive_jaccards) if consecutive_jaccards else 0,
                "consecutive_jaccard_median": statistics.median(consecutive_jaccards) if consecutive_jaccards else 0,
                "top_items": item_counts.most_common(10),
                "pick_frequency": dict(item_counts),
            }
        
        return result