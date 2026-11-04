import json

with open(r'docs/experiments/comparison_2026-11-02_10seeds_20261102_130743.json', encoding='utf-8') as f:
    nov2 = json.load(f)

with open(r'docs/experiments/comparison_2026-11-01_10seeds_20261101_225615.json', encoding='utf-8') as f:
    nov1 = json.load(f)

# Check the "High-NA's Obituary" article in both pools
print("=== HIGH-NA OBITUARY ARTICLE IN BOTH ===")
for run in nov2['runs']:
    for desk in ['primary', 'science', 'reserve']:
        for item in run['selections']['keyword'][desk]:
            if 'High-NA' in item['title'] or 'Obituary' in item['title']:
                print(f"Nov 2 seed {run['seed']} {desk}: {item['title'][:60]} rel={item['rel']} age={item['age_days']:.2f} published={item['published']}")

print()
for run in nov1['runs']:
    for desk in ['primary', 'science', 'reserve']:
        for item in run['selections']['keyword'][desk]:
            if 'High-NA' in item['title'] or 'Obituary' in item['title']:
                print(f"Nov 1 seed {run['seed']} {desk}: {item['title'][:60]} rel={item['rel']} age={item['age_days']:.2f} published={item['published']}")

# Check "Chip Industry Week In Review" in both
print("\n=== CHIP INDUSTRY WEEK IN REVIEW IN BOTH ===")
for run in nov2['runs']:
    for desk in ['primary', 'science', 'reserve']:
        for item in run['selections']['keyword'][desk]:
            if 'Chip Industry Week' in item['title']:
                print(f"Nov 2 seed {run['seed']} {desk}: rel={item['rel']} age={item['age_days']:.2f}")

print()
for run in nov1['runs']:
    for desk in ['primary', 'science', 'reserve']:
        for item in run['selections']['keyword'][desk]:
            if 'Chip Industry Week' in item['title']:
                print(f"Nov 1 seed {run['seed']} {desk}: rel={item['rel']} age={item['age_days']:.2f}")

# Check LR engine primary selections for seed 1
print("\n=== SEED 1 LR PRIMARY (top 5) ===")
print("Nov 2:")
for item in nov2['runs'][0]['selections']['lr']['primary'][:5]:
    print(f"  p={item['p']:.3f} V={item['V']:.3f} {item['title'][:50]} (cluster={item['cluster']}, rel={item['rel']})")

print("\nNov 1:")
for item in nov1['runs'][0]['selections']['lr']['primary'][:5]:
    print(f"  p={item['p']:.3f} V={item['V']:.3f} {item['title'][:50]} (cluster={item['cluster']}, rel={item['rel']})")

# Check all comparison Jaccard scores
print("\n=== ALL SEEDS JACCARD (keyword vs LR overlap) ===")
for run in nov2['runs']:
    p_jac = run['comparison']['primary']['overlap']['jaccard']
    s_jac = run['comparison']['science']['overlap']['jaccard']
    print(f"Nov 2 seed {run['seed']}: primary={p_jac:.4f}, science={s_jac:.4f}")

for run in nov1['runs']:
    p_jac = run['comparison']['primary']['overlap']['jaccard']
    s_jac = run['comparison']['science']['overlap']['jaccard']
    print(f"Nov 1 seed {run['seed']}: primary={p_jac:.4f}, science={s_jac:.4f}")