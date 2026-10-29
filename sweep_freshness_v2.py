"""Quick parameter sweep for LR engine freshness (reduced grid)."""
import json
import itertools
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from simulate.core.pool import PoolProvider
from simulate.engines.lr_engine import LREngine
from collections import Counter

hist_bins = [0, 1, 2, 5, 10, 20, 50, float('inf')]
hist_labels = ["0-1", "1-2", "2-5", "5-10", "10-20", "20-50", "50+"]

KEYWORD_TARGET = {
    'primary': {'mean': 14.10, 'hist': {'0-1': 2, '1-2': 12, '2-5': 4, '5-10': 0, '10-20': 2, '20-50': 2, '50+': 3}},
    'science': {'mean': 7.37, 'hist': {'0-1': 0, '1-2': 19, '2-5': 1, '5-10': 0, '10-20': 3, '20-50': 1, '50+': 1}}
}

def compute_histogram(ages):
    counts = [0] * len(hist_labels)
    for age in ages:
        for i, (low, high) in enumerate(zip(hist_bins[:-1], hist_bins[1:])):
            if low <= age < high:
                counts[i] += 1
                break
    return dict(zip(hist_labels, counts))

def hist_distance(hist_a, hist_b):
    total_a = sum(hist_a.values())
    total_b = sum(hist_b.values())
    if total_a == 0 or total_b == 0:
        return float('inf')
    norm_a = {k: v/total_a for k, v in hist_a.items()}
    norm_b = {k: v/total_b for k, v in hist_b.items()}
    return sum(abs(norm_a.get(k, 0) - norm_b.get(k, 0)) for k in set(norm_a) | set(norm_b))

def evaluate_params(engine, pool, base_config, sampling_params, seeds):
    config = base_config.copy()
    config['sampling'] = {**base_config.get('sampling', {}), **sampling_params}
    config['date'] = '2026-10-29'
    
    results = {}
    for desk in ['primary', 'science']:
        all_ages = []
        all_items = []
        for seed in seeds:
            config['seed'] = seed
            try:
                selections = engine.select_with_pool_merge(pool, config, seed)
                for item in selections.get(desk, []):
                    if 'age_days' in item and item['age_days'] is not None:
                        all_ages.append(item['age_days'])
                        all_items.append(item)
            except Exception as e:
                return None
        
        if not all_ages:
            return None
        
        hist = compute_histogram(all_ages)
        target = KEYWORD_TARGET[desk]['hist']
        dist = hist_distance(hist, target)
        mean_age = sum(all_ages) / len(all_ages)
        target_mean = KEYWORD_TARGET[desk]['mean']
        mean_diff = abs(mean_age - target_mean) / target_mean
        
        modes = Counter(item.get('mode', 'unknown') for item in all_items)
        n_items = len(all_items)
        
        results[desk] = {
            'hist': hist,
            'dist': dist,
            'mean_age': mean_age,
            'mean_diff': mean_diff,
            'modes': dict(modes),
            'n_items': n_items,
            'score': dist + 0.5 * mean_diff
        }
    
    return results

def main():
    pool_provider = PoolProvider("daily_brief.db")
    pool = pool_provider.load("2026-10-29", 120.0, {})
    print(f"Loaded pool: {len(pool)} items")
    
    engine = LREngine(project_root=Path.cwd())
    
    with open("config.json") as f:
        base_config = json.load(f)
    
    config = {
        **base_config.get('ranker', {}),
        **base_config.get('selection', {}),
        **base_config.get('ranker', {}).get('sampling', {}),
    }
    
    # Reduced parameter grid
    param_grid = {
        'epsilon': [0.4, 0.6, 0.8],
        'halfLifeDays': [14, 21, 30, 45],
        'explore.gamma': [0.3, 0.5],
    }
    
    param_names = list(param_grid.keys())
    param_values = list(param_grid.values())
    combinations = list(itertools.product(*param_values))
    
    print(f"Testing {len(combinations)} combinations with 3 seeds each...")
    
    all_results = []
    seeds = [1, 2, 3]
    
    for combo in combinations:
        params = dict(zip(param_names, combo))
        
        sampling_params = {}
        for k, v in params.items():
            if '.' in k:
                parts = k.split('.')
                if parts[0] not in sampling_params:
                    sampling_params[parts[0]] = {}
                sampling_params[parts[0]][parts[1]] = v
            else:
                sampling_params[k] = v
        
        result = evaluate_params(engine, pool, base_config, sampling_params, seeds)
        if result:
            primary_score = result['primary']['score']
            science_score = result['science']['score']
            avg_score = (primary_score + science_score) / 2
            primary_n = result['primary']['n_items']
            science_n = result['science']['n_items']
            
            all_results.append({
                'params': params,
                'sampling_params': sampling_params,
                'primary': result['primary'],
                'science': result['science'],
                'avg_score': avg_score,
                'primary_n': primary_n,
                'science_n': science_n
            })
            
            print(f"  {params} -> avg={avg_score:.4f}, p_n={primary_n}, s_n={science_n}")
            print(f"    p: mean={result['primary']['mean_age']:.2f}, dist={result['primary']['dist']:.4f}")
            print(f"    s: mean={result['science']['mean_age']:.2f}, dist={result['science']['dist']:.4f}")
        else:
            print(f"  {params} -> FAILED")
    
    all_results.sort(key=lambda x: x['avg_score'])
    
    output_dir = Path("experiments/output/freshness")
    output_dir.mkdir(parents=True, exist_ok=True)
    
    with open(output_dir / "sweep_lr_freshness_quick.json", "w") as f:
        json.dump({
            'param_grid': param_grid,
            'seeds': seeds,
            'results': all_results,
            'best': all_results[0] if all_results else None
        }, f, indent=2)
    
    print(f"\nTop 10:")
    for i, r in enumerate(all_results[:10]):
        print(f"  {i+1}. {r['params']} -> avg={r['avg_score']:.4f}")
        print(f"      p: mean={r['primary']['mean_age']:.2f}, dist={r['primary']['dist']:.4f}, n={r['primary_n']}")
        print(f"      s: mean={r['science']['mean_age']:.2f}, dist={r['science']['dist']:.4f}, n={r['science_n']}")

if __name__ == "__main__":
    main()