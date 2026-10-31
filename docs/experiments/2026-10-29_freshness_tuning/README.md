# Freshness Tuning Experiment (2026-10-29)

## Objective
Tune LR engine freshness parameters (`epsilon`, `halfLifeDays`, `explore.gamma`) to match the keyword engine's age distribution.

## Background
The keyword engine uses logistic-in-log-age freshness: `f(a) = sigmoid((ln(a50) - ln(a)) / slope)` with `a50_days=7`, `slope=1.0`.

The LR engine uses logistic-in-log-age: `1 / (1 + exp(steepness * (log1p(age) - log1p(halfLifeDays))))` with default `halfLifeDays=7`, `steepness=ln(4)`.

Initial comparisons showed LR picks fresher items (mean age ~3 days) vs keyword (~6 days).

## Scripts

| Script | Purpose |
|--------|---------|
| `sweep_freshness.py` | Full parameter sweep over epsilon, halfLifeDays, explore.gamma |
| `sweep_freshness_v2.py` | Reduced grid, quick evaluation |
| `compare_tuned.py` | Compare keyword vs LR with best tuned params |
| `analyze_results.py` | Analyze age histograms from comparison results |
| `check_freshness.py` | Quick histogram check |

## Key Findings

Best parameters found:
- `epsilon=0.8` (higher exploration)
- `halfLifeDays=30` (slower decay)
- `explore.gamma=0.5` (default)

These bring LR mean age closer to keyword (~14 days primary, ~7 days science) but at the cost of:
- Lower researchlike percentage
- Higher exploration rate
- Less stable selections (lower consecutive Jaccard)

## Results

Raw results in `simulate/output/freshness/`:
- `sweep_lr_age_match.json` - Full sweep results
- `sweep_lr_freshness_quick.json` - Reduced grid results
- `comparison_tuned_lr_2026-10-29_10seeds.html` - Tuned comparison report
- `comparison_2026-10-29_10seeds.json` - 10-seed comparison (default params)
- `comparison_2026-10-29_5seeds.json` - 5-seed comparison (default params)

## Conclusion

The LR engine's value function `V = p * exp(-lambda * age) * dedupe(days_since_shown)` fundamentally differs from keyword's `score = rel * freshness * penalty`. Matching age distributions requires significantly different parameters that may degrade other metrics (relevance, stability, source type balance).