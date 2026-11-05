import json
with open('../../../simulate/output/freshness/comparison_2026-10-29_5seeds.json', encoding='utf-8') as f:
    data = json.load(f)

# Compute age histograms from runs
hist_bins = [0, 1, 2, 5, 10, 20, 50, float('inf')]
hist_labels = ["0-1", "1-2", "2-5", "5-10", "10-20", "20-50", "50+"]

for desk in ['primary', 'science']:
    print(f"\n{desk.upper()} DESK:")
    for engine in ['keyword', 'lr']:
        all_ages = []
        for run in data['runs']:
            items = run['selections'].get(engine, {}).get(desk, [])
            for item in items:
                if 'age_days' in item and item['age_days'] is not None:
                    all_ages.append(item['age_days'])
        
        if all_ages:
            counts = [0] * len(hist_labels)
            for age in all_ages:
                for i, (low, high) in enumerate(zip(hist_bins[:-1], hist_bins[1:])):
                    if low <= age < high:
                        counts[i] += 1
                        break
            mean_age = sum(all_ages) / len(all_ages)
            median_age = sorted(all_ages)[len(all_ages)//2]
            print(f'  {engine}: mean={mean_age:.2f}, median={median_age:.2f}, n={len(all_ages)}')
            print(f'    Histogram: {dict(zip(hist_labels, counts))}')