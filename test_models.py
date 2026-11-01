"""Quick test of exponential vs logistic with larger halfLifeDays."""
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

# Test exponential with large halfLifeDays
for halfLife in [30, 45, 60, 90, 120]:
    config = base_config.copy()
    config['sampling'] = {
        **base_config.get('ranker', {}).get('sampling', {}),
        'epsilon': 0.8,
        'halfLifeDays': halfLife,
        'freshness': {'model': 'exponential'},
        'explore': {'gamma': 0.5}
    }
    config['date'] = '2026-10-29'
    config['seed'] = 1
    
    selections = engine.select(pool, config, 1)
    print(f'\nExponential, halfLifeDays={halfLife}:')
    for desk in ['primary', 'science']:
        ages = [item.get('age_days') for item in selections.get(desk, []) if item.get('age_days') is not None]
        if ages:
            print(f'  {desk}: n={len(ages)}, mean={sum(ages)/len(ages):.2f}')

# Test logistic with large halfLifeDays and various steepness
for steepness in [0.5, 1.0, math.log(4), 2.0]:
    for halfLife in [30, 45, 60]:
        config = base_config.copy()
        config['sampling'] = {
            **base_config.get('ranker', {}).get('sampling', {}),
            'epsilon': 0.8,
            'halfLifeDays': halfLife,
            'freshness': {'model': 'logistic', 'steepness': steepness},
            'explore': {'gamma': 0.5}
        }
        config['date'] = '2026-10-29'
        config['seed'] = 1
        
        selections = engine.select(pool, config, 1)
        print(f'\nLogistic, halfLifeDays={halfLife}, steepness={steepness:.3f}:')
        for desk in ['primary', 'science']:
            ages = [item.get('age_days') for item in selections.get(desk, []) if item.get('age_days') is not None]
            if ages:
                print(f'  {desk}: n={len(ages)}, mean={sum(ages)/len(ages):.2f}')