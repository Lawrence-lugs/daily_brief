"""Experiment runners for comparing engines."""
from __future__ import annotations
import json
from datetime import datetime
from typing import List, Dict, Any, Optional
from pathlib import Path

from simulate.core.engine import Engine, SelectionResult
from simulate.core.pool import PoolProvider
from simulate.core.metrics import MetricsCollector
from simulate.core.reporter import Reporter
from simulate.engines.keyword_engine import KeywordEngine
from simulate.engines.lr_engine import LREngine


def compare_engines(
    date: str,
    seeds: List[int],
    engines: List[Engine],
    pool_provider: PoolProvider,
    config: Dict | None = None,
    output_dir: str = "experiments/output",
) -> Dict[str, Any]:
    """Run comparison across multiple seeds and engines.
    
    Args:
        date: Date string YYYY-MM-DD
        seeds: List of random seeds
        engines: List of Engine instances
        pool_provider: PoolProvider instance
        config: Global config overrides
        output_dir: Output directory for results
        
    Returns:
        Aggregated results dictionary
    """
    config = config or {}
    config["date"] = date  # Ensure date is in config for LR engine
    
    # Load pool once (for keyword engine)
    pool = pool_provider.load(date, config.get("max_age_days", 120.0), config)
    print(f"Loaded pool: {len(pool)} items")
    
    # Fetch cluster metadata from LR engine if present
    cluster_metadata = None
    for engine in engines:
        if engine.name == "lr" and hasattr(engine, "get_cluster_summary"):
            try:
                cluster_metadata = engine.get_cluster_summary()
                print(f"Loaded cluster metadata: {cluster_metadata['total']} clusters "
                      f"({cluster_metadata['core_count']} core, {cluster_metadata['side_count']} side)")
            except Exception as e:
                print(f"  Warning: Could not load cluster metadata: {e}")
            break
    
    runs = []
    
    for seed in seeds:
        print(f"  Seed {seed}...")
        run = {"seed": seed, "selections": {}}
        
        for engine in engines:
            print(f"    {engine.name}...")
            try:
                if engine.name == "keyword":
                    selections = engine.select(pool, config, seed)
                elif engine.name == "lr":
                    # LR engine loads its own data but we merge with pool for metadata
                    selections = engine.select_with_pool_merge(pool, config, seed)
                else:
                    selections = engine.select(pool, config, seed)
                
                run["selections"][engine.name] = selections
            except Exception as e:
                print(f"    ERROR: {e}")
                run["selections"][engine.name] = {"error": str(e)}
        
        # Compute comparison metrics
        run["comparison"] = {}
        for desk in ["primary", "science"]:
            if all(desk in run["selections"].get(e.name, {}) for e in engines):
                engine_names = [e.name for e in engines]
                if len(engine_names) == 2:
                    run["comparison"][desk] = MetricsCollector.compare_selections(
                        run["selections"][engine_names[0]],
                        run["selections"][engine_names[1]],
                        desk=desk,
                    )
        
        runs.append(run)
    
    # Aggregate across runs
    aggregate = {}
    for desk in ["primary", "science"]:
        aggregate[desk] = MetricsCollector.aggregate_runs(runs, desk=desk)
    
    results = {
        "date": date,
        "seeds": seeds,
        "engines": [e.name for e in engines],
        "config": config,
        "pool_size": len(pool),
        "runs": runs,
        "aggregate": aggregate,
        "cluster_metadata": cluster_metadata,
        "timestamp": datetime.now().isoformat(),
    }
    
    # Save results
    reporter = Reporter(output_dir)
    json_path = reporter.write_json(results, f"comparison_{date}_{len(seeds)}seeds.json")
    print(f"Results saved to {json_path}")
    
    # Generate HTML report
    html = reporter.generate_comparison_html(results, f"Engine Comparison - {date}")
    html_path = reporter.write_html(html, f"comparison_{date}_{len(seeds)}seeds.html")
    print(f"HTML report saved to {html_path}")
    
    return results


def monte_carlo(
    engine: Engine,
    pool: List[Dict],
    n_runs: int,
    config: Dict | None = None,
    seed_start: int = 1,
    output_dir: str = "experiments/output",
) -> Dict[str, Any]:
    """Run Monte Carlo simulation for a single engine.
    
    Args:
        engine: Engine instance
        pool: Candidate pool
        n_runs: Number of runs
        config: Configuration
        seed_start: Starting seed
        output_dir: Output directory
        
    Returns:
        Simulation results with stability metrics
    """
    config = config or {}
    
    ever_picked = set()
    consecutive_jaccards = []
    prev_picks = None
    all_selections = []
    
    for i in range(n_runs):
        seed = seed_start + i
        if i % 50 == 0:
            print(f"  Run {i+1}/{n_runs}...")
        
        try:
            if engine.name == "keyword":
                selections = engine.select(pool, config, seed)
            elif engine.name == "lr":
                selections = engine.select_with_pool_merge(pool, config, seed)
            else:
                selections = engine.select(pool, config, seed)
            
            all_selections.append(selections)
            
            # All picked IDs across desks
            picks = set()
            for desk_items in selections.values():
                for item in desk_items:
                    picks.add(item.get("id"))
            
            ever_picked.update(picks)
            
            if prev_picks is not None:
                consecutive_jaccards.append(MetricsCollector.jaccard(prev_picks, picks))
            prev_picks = picks
            
        except Exception as e:
            print(f"    Run {i+1} failed: {e}")
            all_selections.append({"error": str(e)})
    
    # Per-item pick frequency
    from collections import Counter
    item_counts = Counter()
    for selections in all_selections:
        if "error" not in selections:
            for desk_items in selections.values():
                for item in desk_items:
                    item_counts[item.get("id")] += 1
    
    result = {
        "engine": engine.name,
        "runs": n_runs,
        "pool_size": len(pool),
        "ever_picked": len(ever_picked),
        "coverage": len(ever_picked) / len(pool) if pool else 0,
        "consecutive_jaccard_mean": sum(consecutive_jaccards) / len(consecutive_jaccards) if consecutive_jaccards else 0,
        "consecutive_jaccard_median": sorted(consecutive_jaccards)[len(consecutive_jaccards)//2] if consecutive_jaccards else 0,
        "top_items": item_counts.most_common(20),
        "pick_frequency": dict(item_counts),
        "timestamp": datetime.now().isoformat(),
    }
    
    # Save
    reporter = Reporter(output_dir)
    json_path = reporter.write_json(result, f"monte_carlo_{engine.name}_{n_runs}runs.json")
    print(f"Monte Carlo results saved to {json_path}")
    
    return result


def parameter_sweep(
    engine: Engine,
    pool: List[Dict],
    param_grid: Dict[str, List[Any]],
    metric: str = "jaccard_primary",
    seeds: List[int] = None,
    output_dir: str = "experiments/output",
) -> Dict[str, Any]:
    """Run parameter sweep for an engine.
    
    Args:
        engine: Engine instance
        pool: Candidate pool
        param_grid: Dict of param_name -> list of values
        metric: Metric to optimize
        seeds: Seeds to test (default: [1,2,3,4,5])
        output_dir: Output directory
        
    Returns:
        Sweep results with best parameters
    """
    seeds = seeds or [1, 2, 3, 4, 5]
    
    # Generate all parameter combinations
    import itertools
    param_names = list(param_grid.keys())
    param_values = list(param_grid.values())
    combinations = list(itertools.product(*param_values))
    
    print(f"Testing {len(combinations)} parameter combinations...")
    
    results = []
    best_score = -1
    best_params = None
    
    for combo in combinations:
        params = dict(zip(param_names, combo))
        print(f"  {params}...")
        
        # Run with multiple seeds
        scores = []
        for seed in seeds:
            config = {"seed": seed, **params}
            try:
                if engine.name == "keyword":
                    selections = engine.select(pool, config, seed)
                elif engine.name == "lr":
                    selections = engine.select_with_pool_merge(pool, config, seed)
                else:
                    selections = engine.select(pool, config, seed)
                
                # Compute metric
                if metric == "jaccard_primary":
                    # Need baseline for comparison - skip for now
                    score = 0
                elif metric == "explore_rate":
                    all_picks = []
                    for desk_items in selections.values():
                        all_picks.extend(desk_items)
                    explore = sum(1 for p in all_picks if p.get("mode") == "explore")
                    score = explore / len(all_picks) if all_picks else 0
                elif metric == "mean_age":
                    all_picks = []
                    for desk_items in selections.values():
                        all_picks.extend(desk_items)
                    ages = [p.get("age_days", 0) for p in all_picks if p.get("age_days") is not None]
                    score = -sum(ages)/len(ages) if ages else 0  # Negative because we want to minimize age
                else:
                    score = 0
                
                scores.append(score)
            except Exception as e:
                print(f"    Error: {e}")
                scores.append(float("-inf"))
        
        avg_score = sum(scores) / len(scores) if scores else float("-inf")
        results.append({"params": params, "scores": scores, "mean_score": avg_score})
        
        if avg_score > best_score:
            best_score = avg_score
            best_params = params
    
    result = {
        "engine": engine.name,
        "param_grid": param_grid,
        "metric": metric,
        "seeds": seeds,
        "results": results,
        "best_params": best_params,
        "best_score": best_score,
        "timestamp": datetime.now().isoformat(),
    }
    
    reporter = Reporter(output_dir)
    json_path = reporter.write_json(result, f"sweep_{engine.name}_{metric}.json")
    print(f"Sweep results saved to {json_path}")
    
    return result


def ablation_study(
    engine: Engine,
    pool: List[Dict],
    feature_flags: Dict[str, bool],
    seeds: List[int] = None,
    output_dir: str = "experiments/output",
) -> Dict[str, Any]:
    """Run ablation study by toggling features on/off.
    
    Args:
        engine: Engine instance
        pool: Candidate pool
        feature_flags: Dict of feature_name -> bool (True=enabled)
        seeds: Seeds to test
        output_dir: Output directory
        
    Returns:
        Ablation results
    """
    seeds = seeds or [1, 2, 3, 4, 5]
    features = list(feature_flags.keys())
    
    results = []
    
    # Test each feature disabled individually
    for feature in features:
        config = {f: v for f, v in feature_flags.items()}
        config[feature] = False  # Disable this feature
        
        print(f"  Without {feature}...")
        scores = []
        for seed in seeds:
            try:
                if engine.name == "keyword":
                    selections = engine.select(pool, config, seed)
                elif engine.name == "lr":
                    selections = engine.select_with_pool_merge(pool, config, seed)
                else:
                    selections = engine.select(pool, config, seed)
                
                # Metric: diversity of source types
                all_picks = []
                for desk_items in selections.values():
                    all_picks.extend(desk_items)
                from collections import Counter
                types = Counter(p.get("source_type") for p in all_picks)
                # Entropy as diversity metric
                import math
                total = sum(types.values())
                entropy = -sum((c/total) * math.log(c/total) for c in types.values() if c > 0)
                scores.append(entropy)
            except Exception as e:
                print(f"    Error: {e}")
                scores.append(0)
        
        results.append({
            "disabled_feature": feature,
            "scores": scores,
            "mean_score": sum(scores)/len(scores) if scores else 0,
        })
    
    # Baseline (all features enabled)
    print("  Baseline (all features)...")
    config = {f: v for f, v in feature_flags.items()}
    scores = []
    for seed in seeds:
        try:
            if engine.name == "keyword":
                selections = engine.select(pool, config, seed)
            elif engine.name == "lr":
                selections = engine.select_with_pool_merge(pool, config, seed)
            else:
                selections = engine.select(pool, config, seed)
            
            all_picks = []
            for desk_items in selections.values():
                all_picks.extend(desk_items)
            from collections import Counter
            types = Counter(p.get("source_type") for p in all_picks)
            import math
            total = sum(types.values())
            entropy = -sum((c/total) * math.log(c/total) for c in types.values() if c > 0)
            scores.append(entropy)
        except Exception as e:
            print(f"    Error: {e}")
            scores.append(0)
    
    baseline = sum(scores)/len(scores) if scores else 0
    
    result = {
        "engine": engine.name,
        "feature_flags": feature_flags,
        "baseline_score": baseline,
        "ablations": results,
        "timestamp": datetime.now().isoformat(),
    }
    
    reporter = Reporter(output_dir)
    json_path = reporter.write_json(result, f"ablation_{engine.name}.json")
    print(f"Ablation results saved to {json_path}")
    
    return result