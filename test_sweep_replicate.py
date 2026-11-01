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

# Replicate exactly what the sweep does
# base_config is the full config.json
# sampling_params is what the sweep builds

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

print("sampling_params:", json.dumps(sampling_params, indent=2))

# This is what evaluate_params does
config = base_config.copy()
config['sampling'] = {**base_config.get('sampling', {}), **sampling_params}
config['date'] = '2026-10-29'
config['seed'] = 1

print("\nconfig['sampling']:", json.dumps(config['sampling'], indent=2))
print("config.get('desks'):", config.get('desks'))

selections = engine.select(pool, config, 1)
print(f'\nResults:')
for desk in ['primary', 'science']:
    ages = [item.get('age_days') for item in selections.get(desk, []) if item.get('age_days') is not None]
    if ages:
        print(f'  {desk}: n={len(ages)}, mean={sum(ages)/len(ages):.2f}')