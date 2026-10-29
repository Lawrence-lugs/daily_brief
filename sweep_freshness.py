"""Parameter sweep for LR engine freshness to match keyword age distribution."""
import json
import itertools
import statistics
from pathlib import Path
from collections import Counter

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from simulate.core.pool import PoolProvider
from simulate.engines.lr_engine import LREngine
from simulate.core.metrics import MetricsCollector

# Target keyword age histogram (from 5 seeds, primary desk)
KEYWORD_TARGET = {
    'primary': {
        'mean': 14.10,
        'median': 1.33,
        'hist': {'0-1': 2, '1-2': 12, '2-5': 4, '5-10': 0, '10-20': 2, '20-50': 2, '50+': 3}
    },
    'science': {
        'mean': 7.37,
        'median': 1.33,
        'hist': {'0-1': 0, '1-2': 19, '2-5': 1, '5-10': 0, '10-20': 3, '20-50': 1, '50+': 1}
    }
}

hist_bins = [0, 1, 2, 5, 10, 20, 50, float('inf')]
hist_labels = ["0-1", "1-2", "2-5", "5-10", "10-20", "20-50", "50+"]

def compute_histogram(ages):
    """Compute histogram counts for given ages."""
    counts = [0] * len(hist_labels)
    for age in ages:
        for i, (low, high) in enumerate(zip(hist_bins[:-1], hist_bins[1:])):
            if low <= age < high:
                counts[i] += 1
                break
    return dict(zip(hist_labels, counts))

def hist_distance(hist_a, hist_b):
    """Compute distance between two histograms (normalized L1 distance)."""
    total_a = sum(hist_a.values())
    total_b = sum(hist_b.values())
    if total_a == 0 or total_b == 0:
        return float('inf')
    norm_a = {k: v/total_a for k, v in hist_a.items()}
    norm_b = {k: v/total_b for k, v in hist_b.items()}
    return sum(abs(norm_a.get(k, 0) - norm_b.get(k, 0)) for k in set(norm_a) | set(norm_b))

def age_distribution_score(engine, pool, config, seeds, desk='primary'):
    """Compute how close the age distribution is to keyword target."""
    all_ages = []
    for seed in seeds:
        try:
            config['seed'] = seed
            selections = engine.select_with_pool_merge(pool, config, seed)
            for item in selections.get(desk, []):
                if 'age_days' in item and item['age_days'] is not None:
                    all_ages.append(item['age_days'])
        except Exception as e:
            print(f"    Error seed {seed}: {e}")
            return float('inf')
    
    if not all_ages:
        return float('inf')
    
    hist = compute_histogram(all_ages)
    target = KEYWORD_TARGET[desk]['hist']
    dist = hist_distance(hist, target)
    
    # Also consider mean age difference
    mean_age = sum(all_ages) / len(all_ages)
    target_mean = KEYWORD_TARGET[desk]['mean']
    mean_diff = abs(mean_age - target_mean) / target_mean
    
    # Combined score: lower is better
    return dist + 0.5 * mean_diff

def main():
    # Load pool
    pool_provider = PoolProvider("daily_brief.db")
    pool = pool_provider.load("2026-10-29", 120.0, {})
    print(f"Loaded pool: {len(pool)} items")
    
    # Initialize LR engine
    engine = LREngine(project_root=Path.cwd())
    
    # Base config
    with open("config.json") as f:
        base_config = json.load(f)
    
    config = {
        **base_config.get('ranker', {}),
        **base_config.get('selection', {}),
        **base_config.get('ranker', {}).get('sampling', {}),
        'date': '2026-10-29',
    }
    
    # Parameter grid - sweep epsilon and halfLifeDays
    param_grid = {
        'epsilon': [0.1, 0.25, 0.4, 0.6],
        'halfLifeDays': [3, 7, 14, 30, 60],
    }
    
    # Also try varying explore_gamma
    param_grid['explore.gamma'] = [0.3, 0.5, 0.7, 1.0]
    
    # Generate all combinations
    param_names = list(param_grid.keys())
    param_values = list(param_grid.values())
    combinations = list(itertools.product(*param_values))
    
    print(f"Testing {len(combinations)} parameter combinations...")
    
    seeds = [1, 2, 3, 4, 5]
    results = []
    best_score = float('inf')
    best_params = None
    
    for combo in combinations:
        params = dict(zip(param_names, combo))
        print(f"  {params}...")
        
        # Build config with these params
        test_config = config.copy()
        test_config['epsilon'] = params.get('epsilon', 0.25)
        test_config['halfLifeDays'] = params.get('halfLifeDays', 7)
        test_config['explore.gamma'] = params.get('explore.gamma', 0.5)
        
        # Score on both desks
        score_primary = age_distribution_score(engine, pool, test_config, seeds, 'primary')
        score_science = age_distribution_score(engine, pool, test_config, seeds, 'science')
        avg_score = (score_primary + score_science) / 2
        
        results.append({
            'params': params,
            'score_primary': score_primary,
            'score_science': score_science,
            'avg_score': avg_score
        })
        
        if avg_score < best_score:
            best_score = avg_score
            best_params = params
            print(f"    NEW BEST: {params} -> {avg_score:.4f}")
    
    # Sort and save results
    results.sort(key=lambda x: x['avg_score'])
    
    output = {
        'engine': 'lr',
        'param_grid': param_grid,
        'metric': 'age_histogram_distance_to_keyword',
        'seeds': seeds,
        'results': results,
        'best_params': best_params,
        'best_score': best_score,
    }
    
    output_dir = Path("experiments/output/freshness")
    output_dir.mkdir(parents=True, exist_ok=True)
    
    with open(output_dir / "sweep_lr_age_match.json", "w") as f:
        json.dump(output, f, indent=2)
    
    print(f"\nDone! Best params: {best_params} (score: {best_score:.4f})")
    
    # Print top 10
    print("\nTop 10 results:")
    for i, r in enumerate(results[:10]):
        print(f"  {i+1}. {r['params']} -> primary={r['score_primary']:.4f}, science={r['score_science']:.4f}, avg={r['avg_score']:.4f}")

if __name__ == "__main__":
    main()