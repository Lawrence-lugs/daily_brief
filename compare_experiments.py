import json

with open(r'docs/experiments/comparison_2026-11-02_10seeds_20261102_130743.json', encoding='utf-8') as f:
    nov2 = json.load(f)

with open(r'docs/experiments/comparison_2026-11-01_10seeds_20261101_225615.json', encoding='utf-8') as f:
    nov1 = json.load(f)

print("=== CONFIG DIFFERENCES ===")
print(f"Nov 2 date: {nov2['config']['date']}")
print(f"Nov 1 date: {nov1['config']['date']}")
print(f"Nov 2 pool_size: {nov2['pool_size']}")
print(f"Nov 1 pool_size: {nov1['pool_size']}")

print(f"\nNov 2 embedding: {nov2['config'].get('embedding', 'NOT PRESENT')}")
print(f"Nov 1 embedding: {nov1['config'].get('embedding', 'NOT PRESENT')}")

print("\n=== MODEL CONFIG ===")
print("Nov 2 model keys:", list(nov2['config']['model'].keys()))
print("Nov 1 model keys:", list(nov1['config']['model'].keys()))

print("\nNov 2 prior rules:")
for r in nov2['config']['model']['prior']['rules']:
    print(f"  {r}")
print("\nNov 1 prior rules:")
for r in nov1['config']['model']['prior']['rules']:
    print(f"  {r}")

print("\n=== SEED 1 KEYWORD PRIMARY ===")
print("Nov 2:")
for i, item in enumerate(nov2['runs'][0]['selections']['keyword']['primary']):
    print(f"  {i}: {item['title'][:60]} (rel={item['rel']}, mode={item['mode']}, age={item['age_days']:.1f})")

print("\nNov 1:")
for i, item in enumerate(nov1['runs'][0]['selections']['keyword']['primary']):
    print(f"  {i}: {item['title'][:60]} (rel={item['rel']}, mode={item['mode']}, age={item['age_days']:.1f})")

print("\n=== SEED 1 COMPARISON (keyword vs LR overlap) ===")
print("Nov 2 primary Jaccard:", nov2['runs'][0]['comparison']['primary']['overlap']['jaccard'])
print("Nov 1 primary Jaccard:", nov1['runs'][0]['comparison']['primary']['overlap']['jaccard'])
print("Nov 2 science Jaccard:", nov2['runs'][0]['comparison']['science']['overlap']['jaccard'])
print("Nov 1 science Jaccard:", nov1['runs'][0]['comparison']['science']['overlap']['jaccard'])

print("\n=== ALL SEEDS KEYWORD PRIMARY COUNT ===")
for i, run in enumerate(nov2['runs']):
    k = len(run['selections']['keyword']['primary'])
    print(f"Nov 2 seed {run['seed']}: {k} primary keyword items")
for i, run in enumerate(nov1['runs']):
    k = len(run['selections']['keyword']['primary'])
    print(f"Nov 1 seed {run['seed']}: {k} primary keyword items")

# Compare keyword selections across seeds for primary desk
print("\n=== KEYWORD PRIMARY ITEMS PER SEED (titles) ===")
for run in nov2['runs']:
    titles = [item['title'][:50] for item in run['selections']['keyword']['primary']]
    print(f"Nov 2 seed {run['seed']}: {titles}")

print()
for run in nov1['runs']:
    titles = [item['title'][:50] for item in run['selections']['keyword']['primary']]
    print(f"Nov 1 seed {run['seed']}: {titles}")