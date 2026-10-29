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