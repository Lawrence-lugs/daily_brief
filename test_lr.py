import json
from pathlib import Path
from simulate.core.pool import PoolProvider
from simulate.engines.lr_engine import LREngine

pool_provider = PoolProvider('daily_brief.db')
pool = pool_provider.load('2026-10-29', 120.0, {})
print(f'Loaded pool: {len(pool)} items')

engine = LREngine(project_root=Path.cwd())

with open('config.json') as f:
    base_config = json.load(f)

config = {
    **base_config.get('ranker', {}),
    **base_config.get('selection', {}),
    **base_config.get('ranker', {}).get('sampling', {}),
    'date': '2026-10-29',
    'seed': 1,
    'sampling': {
        **base_config.get('ranker', {}).get('sampling', {}),
        'epsilon': 0.8,
        'halfLifeDays': 30,
        'freshness': {'model': 'logistic', 'steepness': 1.3862943611198906},
        'explore': {'gamma': 0.5}
    }
}

selections = engine.select(pool, config, 1)
print(f'Primary: {len(selections.get("primary", []))} items')
print(f'Science: {len(selections.get("science", []))} items')

# Check ages
for desk in ['primary', 'science']:
    ages = [item.get('age_days') for item in selections.get(desk, []) if item.get('age_days') is not None]
    if ages:
        print(f'{desk}: n={len(ages)}, mean={sum(ages)/len(ages):.2f}, min={min(ages):.2f}, max={max(ages):.2f}')