import json
import math
from pathlib import Path
from simulate.core.pool import PoolProvider
from simulate.engines.lr_engine import LREngine

pool_provider = PoolProvider('daily_brief.db')
pool = pool_provider.load('2026-10-29', 120.0, {})
print(f'Loaded pool: {len(pool)} items')

engine = LREngine(project_root=Path.cwd())

with open('config.json') as f:
    base_config = json.load(f)

# Replicate exactly what the sweep does for multiple seeds
steepness = 0.5
epsilon = 0.8
halfLifeDays = 7
explore_gamma = 0.5

sampling_params = {
    'epsilon': epsilon,
    'halfLifeDays': halfLifeDays,
    'freshness': {'model': 'logistic', 'steepness': steepness},
    'explore': {'gamma': explore_gamma}
}

all_ages_primary = []
all_ages_science = []

for seed in [1, 2, 3]:
    config = base_config.copy()
    config['sampling'] = {**base_config.get('sampling', {}), **sampling_params}
    config['date'] = '2026-10-29'
    config['seed'] = seed

    selections = engine.select(pool, config, seed)
    
    ages_p = [item.get('age_days') for item in selections.get('primary', []) if item.get('age_days') is not None]
    ages_s = [item.get('age_days') for item in selections.get('science', []) if item.get('age_days') is not None]
    
    mean_p = sum(ages_p)/len(ages_p) if ages_p else "N/A"
    mean_s = sum(ages_s)/len(ages_s) if ages_s else "N/A"
    print(f'Seed {seed}: primary n={len(ages_p)}, mean={mean_p}; science n={len(ages_s)}, mean={mean_s}')
    
    all_ages_primary.extend(ages_p)
    all_ages_science.extend(ages_s)

print(f'\nCombined: primary n={len(all_ages_primary)}, mean={sum(all_ages_primary)/len(all_ages_primary):.2f}')
print(f'Combined: science n={len(all_ages_science)}, mean={sum(all_ages_science)/len(all_ages_science):.2f}')