"""Test specific parameter combinations in detail - with correct config structure."""
import json
from pathlib import Path
import sys
from collections import Counter
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from simulate.core.pool import PoolProvider
from simulate.engines.lr_engine import LREngine

hist_bins = [0, 1, 2, 5, 10, 20, 50, float('inf')]
hist_labels = ["0-1", "1-2", "2-5", "5-10", "10-20", "20-50", "50+"]

def compute_histogram(ages):
    counts = [0] * len(hist_labels)
    for age in ages:
        for i, (low, high) in enumerate(zip(hist_bins[:-1], hist_bins[1:])):
            if low <= age < high:
                counts[i] += 1
                break
    return dict(zip(hist_labels, counts))

def test_config(sampling_params, seeds=[1,2,3,4,5]):
    pool_provider = PoolProvider("daily_brief.db")
    pool = pool_provider.load("2026-10-29", 120.0, {})
    engine = LREngine(project_root=Path.cwd())
    
    with open("config.json") as f:
        base_config = json.load(f)
    
    # Build config with sampling params under 'sampling' key
    config = {
        **base_config.get('ranker', {}),
        **base_config.get('selection', {}),
        **base_config.get('ranker', {}).get('sampling', {}),
        'date': '2026-10-29',
        'sampling': {**base_config.get('ranker', {}).get('sampling', {}), **sampling_params}
    }
    
    print(f"\nTesting sampling params: {sampling_params}")
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
            mean_age = sum(all_ages) / len(all_ages)
            median_age = sorted(all_ages)[len(all_ages)//2]
            print(f"  {desk}: n={len(all_ages)}, mean={mean_age:.2f}, median={median_age:.2f}")
            print(f"    Hist: {hist}")
            modes = Counter(item.get('mode', 'unknown') for item in all_items)
            print(f"    Modes: {dict(modes)}")
            types = Counter(item.get('source_type', 'unknown') for item in all_items)
            print(f"    Types: {dict(types)}")

# Test cases - now using correct sampling structure
test_cases = [
    {'epsilon': 0.25, 'halfLifeDays': 7, 'explore': {'gamma': 0.5}},  # Default
    {'epsilon': 0.6, 'halfLifeDays': 3, 'explore': {'gamma': 0.3}},   # Best from sweep
    {'epsilon': 0.6, 'halfLifeDays': 7, 'explore': {'gamma': 0.5}},
    {'epsilon': 0.6, 'halfLifeDays': 14, 'explore': {'gamma': 0.5}},
    {'epsilon': 0.6, 'halfLifeDays': 30, 'explore': {'gamma': 0.5}},
    {'epsilon': 0.6, 'halfLifeDays': 60, 'explore': {'gamma': 0.5}},
    {'epsilon': 0.4, 'halfLifeDays': 60, 'explore': {'gamma': 1.0}},  # Another good one
    {'epsilon': 0.8, 'halfLifeDays': 30, 'explore': {'gamma': 0.3}},  # High epsilon, long half-life
    {'epsilon': 0.8, 'halfLifeDays': 60, 'explore': {'gamma': 0.3}},  # Very high epsilon, very long half-life
]

for params in test_cases:
    test_config(params)