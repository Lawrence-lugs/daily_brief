"""Analyze comparison results."""
import json

with open("../../../simulate/output/freshness/comparison_2026-10-29_10seeds.json", encoding='utf-8') as f:
    data = json.load(f)

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

print("=== TUNED LR (epsilon=0.8, halfLife=30) vs KEYWORD ===\n")

for desk in ['primary', 'science']:
    print(f"{desk.upper()} DESK:")
    for engine in ['keyword', 'lr']:
        all_ages = []
        all_items = []
        for run in data['runs']:
            items = run['selections'].get(engine, {}).get(desk, [])
            for item in items:
                if 'age_days' in item and item['age_days'] is not None:
                    all_ages.append(item['age_days'])
                    all_items.append(item)
        
        if all_ages:
            hist = compute_histogram(all_ages)
            mean_age = sum(all_ages) / len(all_ages)
            median_age = sorted(all_ages)[len(all_ages)//2]
            
            from collections import Counter
            modes = Counter(item.get('mode', 'unknown') for item in all_items)
            types = Counter(item.get('source_type', 'unknown') for item in all_items)
            
            print(f"  {engine}: n={len(all_ages)}, mean={mean_age:.2f}, median={median_age:.2f}")
            print(f"    Hist: {hist}")
            print(f"    Modes: {dict(modes)}")
            print(f"    Types: {dict(types)}")
    print()

# Also check the original comparison (5 seeds, default params)
print("=== ORIGINAL COMPARISON (default params) ===")
with open("../../../simulate/output/freshness/comparison_2026-10-29_5seeds.json", encoding='utf-8') as f:
    data_orig = json.load(f)

for desk in ['primary', 'science']:
    print(f"{desk.upper()} DESK:")
    for engine in ['keyword', 'lr']:
        all_ages = []
        all_items = []
        for run in data_orig['runs']:
            items = run['selections'].get(engine, {}).get(desk, [])
            for item in items:
                if 'age_days' in item and item['age_days'] is not None:
                    all_ages.append(item['age_days'])
                    all_items.append(item)
        
        if all_ages:
            hist = compute_histogram(all_ages)
            mean_age = sum(all_ages) / len(all_ages)
            median_age = sorted(all_ages)[len(all_ages)//2]
            
            from collections import Counter
            modes = Counter(item.get('mode', 'unknown') for item in all_items)
            types = Counter(item.get('source_type', 'unknown') for item in all_items)
            
            print(f"  {engine}: n={len(all_ages)}, mean={mean_age:.2f}, median={median_age:.2f}")
            print(f"    Hist: {hist}")
            print(f"    Modes: {dict(modes)}")
            print(f"    Types: {dict(types)}")
    print()