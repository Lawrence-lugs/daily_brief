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

# Test different steepness values
for steepness in [0.5, 1.0, math.log(4), 2.0, 3.0]:
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
            'freshness': {'model': 'logistic', 'steepness': steepness},
            'explore': {'gamma': 0.5}
        }
    }

    selections = engine.select(pool, config, 1)
    print(f'\nSteepness={steepness:.4f}:')
    for desk in ['primary', 'science']:
        ages = [item.get('age_days') for item in selections.get(desk, []) if item.get('age_days') is not None]
        if ages:
            print(f'  {desk}: n={len(ages)}, mean={sum(ages)/len(ages):.2f}')