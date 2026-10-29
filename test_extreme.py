"""Test extreme parameters for longer tail."""
import json
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

def test_config(sampling_params, seeds=[1,2,3,4,5]):
    pool_provider = PoolProvider("daily_brief.db")
    pool = pool_provider.load("2026-10-29", 120.0, {})
    engine = LREngine(project_root=Path.cwd())
    
    with open("config.json") as f:
        base_config = json.load(f)
    
    config = {
        **base_config.get('ranker', {}),
        **base_config.get('selection', {}),
        **base_config.get('ranker', {}).get('sampling', {}),
        'date': '2026-10-29',
        'sampling': {**base_config.get('ranker', {}).get('sampling', {}), **sampling_params}
    }
    
    print(f"\nTesting: {sampling_params}")
    print("-" * 60)
    
    for desk in ['primary', 'science']:
        all_ages = []
        all_items = []
        for seed in seeds:
            config['seed'] = seed
            selections = engine.select_with_pool_merge(pool, config, seed)
            for item in selections.get(desk, []):
                if 'age_days' in item and item['age_days'] is not None:
                    all_ages.append(item['age_days'])
                    all_items.append(item)
        
        if all_ages:
            hist = compute_histogram(all_ages)
            target = KEYWORD_TARGET[desk]['hist']
            dist = hist_distance(hist, target)
            mean_age = sum(all_ages) / len(all_ages)
            target_mean = KEYWORD_TARGET[desk]['mean']
            mean_diff = abs(mean_age - target_mean) / target_mean
            
            modes = Counter(item.get('mode', 'unknown') for item in all_items)
            types = Counter(item.get('source_type', 'unknown') for item in all_items)
            
            print(f"  {desk}: n={len(all_ages)}, mean={mean_age:.2f}, target_mean={target_mean:.2f}")
            print(f"    Hist: {hist}")
            print(f"    Target: {target}")
            print(f"    Dist: {dist:.4f}, MeanDiff: {mean_diff:.4f}")
            print(f"    Modes: {dict(modes)}")
            print(f"    Types: {dict(types)}")

# Test extreme parameters
test_cases = [
    # Higher half-life
    {'epsilon': 0.8, 'halfLifeDays': 60, 'explore': {'gamma': 0.3}},
    {'epsilon': 0.8, 'halfLifeDays': 60, 'explore': {'gamma': 0.5}},
    {'epsilon': 0.8, 'halfLifeDays': 90, 'explore': {'gamma': 0.3}},
    {'epsilon': 0.8, 'halfLifeDays': 90, 'explore': {'gamma': 0.5}},
    {'epsilon': 0.8, 'halfLifeDays': 120, 'explore': {'gamma': 0.3}},
    {'epsilon': 0.8, 'halfLifeDays': 120, 'explore': {'gamma': 0.5}},
    # Higher epsilon
    {'epsilon': 1.0, 'halfLifeDays': 30, 'explore': {'gamma': 0.3}},
    {'epsilon': 1.0, 'halfLifeDays': 60, 'explore': {'gamma': 0.3}},
    {'epsilon': 1.0, 'halfLifeDays': 90, 'explore': {'gamma': 0.3}},
    # Combination
    {'epsilon': 1.0, 'halfLifeDays': 120, 'explore': {'gamma': 0.5}},
]

for params in test_cases:
    test_config(params)