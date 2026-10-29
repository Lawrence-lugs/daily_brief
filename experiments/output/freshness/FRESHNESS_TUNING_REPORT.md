# Freshness Parameter Tuning Report

## Objective
Tune LR engine freshness parameters (epsilon, halfLifeDays, explore.gamma) to match the keyword baseline's article age distribution, which has a "long tail toward old bins" (significant picks in 10-20, 20-50, 50+ day bins).

## Baseline Comparison (Default Parameters)

### Default Config
- `epsilon`: 0.25
- `halfLifeDays`: 7
- `explore.gamma`: 0.5

### Age Histograms (5 seeds)

| Engine | Desk | Mean Age | Median | 0-1 | 1-2 | 2-5 | 5-10 | 10-20 | 20-50 | 50+ |
|--------|------|----------|--------|-----|-----|-----|------|-------|-------|-----|
| Keyword | Primary | 14.10 | 1.33 | 2 | 12 | 4 | 0 | 2 | 2 | 3 |
| LR | Primary | 1.66 | 1.33 | 6 | **141** | 0 | 1 | 0 | 2 | 0 |
| Keyword | Science | 7.37 | 1.33 | 0 | 19 | 1 | 0 | 3 | 1 | 1 |
| LR | Science | 1.76 | 1.33 | 1 | **143** | 0 | 3 | 2 | 1 | 0 |

**Key Finding**: LR engine is extremely concentrated in the 1-2 day bin (94-95% of picks), while keyword has a meaningful long tail.

## Parameter Sweep Results

Tested 24 combinations across:
- `epsilon`: [0.4, 0.6, 0.8]
- `halfLifeDays`: [14, 21, 30, 45]
- `explore.gamma`: [0.3, 0.5]

### Top 5 Configurations (3 seeds each)

| Rank | epsilon | halfLifeDays | explore.gamma | Primary Mean | Science Mean | Avg Score |
|------|---------|--------------|---------------|--------------|--------------|-----------|
| 1 | 0.8 | 30 | 0.5 | 4.29 | 3.44 | 0.809 |
| 2 | 0.8 | 14 | 0.3 | 4.13 | 3.63 | 0.817 |
| 3 | 0.8 | 21 | 0.5 | 4.35 | 2.57 | 0.838 |
| 4 | 0.8 | 14 | 0.5 | 4.31 | 2.28 | 0.860 |
| 5 | 0.8 | 45 | 0.3 | 4.44 | 2.67 | 0.866 |

### Extreme Parameter Tests (5 seeds)

| epsilon | halfLifeDays | explore.gamma | Primary Mean | Science Mean |
|---------|--------------|---------------|--------------|--------------|
| 0.8 | 60 | 0.3 | 4.26 | 2.55 |
| 0.8 | 90 | 0.3 | 4.29 | 2.76 |
| 0.8 | 120 | 0.3 | 4.66 | 3.02 |
| 1.0 | 30 | 0.3 | 4.96 | 2.60 |
| 1.0 | 60 | 0.3 | 4.64 | 2.91 |
| 1.0 | 90 | 0.3 | 4.69 | 3.18 |
| 1.0 | 120 | 0.5 | 4.91 | 3.22 |

**Best achieved**: Primary mean=4.96 (epsilon=1.0, halfLife=30), Science mean=3.63 (epsilon=0.8, halfLife=14)

## Final Comparison: Tuned vs Keyword (10 seeds)

### Tuned Config
- `epsilon`: 0.8
- `halfLifeDays`: 30
- `explore.gamma`: 0.5

### Results (10 seeds)

| Engine | Desk | Mean Age | Median | 0-1 | 1-2 | 2-5 | 5-10 | 10-20 | 20-50 | 50+ |
|--------|------|----------|--------|-----|-----|-----|------|-------|-------|-----|
| Keyword | Primary | 10.00 | 1.33 | 6 | 22 | 9 | 1 | 6 | 2 | 4 |
| LR (tuned) | Primary | 3.88 | 2.33 | 0 | 112 | 158 | 5 | 12 | 12 | 1 |
| Keyword | Science | 5.66 | 1.33 | 0 | 34 | 5 | 1 | 8 | 1 | 1 |
| LR (tuned) | Science | 2.89 | 1.33 | 10 | 252 | 9 | 8 | 17 | 2 | 2 |

## Improvement Summary

| Metric | Primary Desk | Science Desk |
|--------|--------------|--------------|
| Keyword mean (target) | 10.00 | 5.66 |
| LR default mean | 1.66 | 1.76 |
| LR tuned mean | **3.88** | **2.89** |
| **Improvement factor** | **2.3x** | **1.6x** |
| Gap closed | 24% | 28% |
| Tail bins (10-20+) now populated | Yes (25 picks) | Yes (21 picks) |

## Why Can't We Fully Match?

### Architectural Differences

1. **Cluster Round-Robin (Primary Desk)**: LR engine guarantees one pick per core cluster per day. Core clusters are built from user interests (perfect samples + liked items), which naturally contain recent, relevant items. This forces fresh picks regardless of freshness parameters.

2. **Exponential vs Logistic-in-Log-Age Decay**:
   - LR: `V = p × exp(-λ × age)` where `λ = ln(2) / halfLifeDays`
   - Keyword: `f(age) = sigmoid((ln(a50) - ln(age)) / slope)` with `a50=7, slope=1`
   
   The logistic-in-log-age has a heavier tail at very old ages relative to its half-life point. At age=50:
   - LR (halfLife=30): freshness = 0.31
   - Keyword (a50=7): freshness = 0.12
   
   But LR's model score `p` correlates with recency for user interests, amplifying the fresh bias.

3. **Model Scores Favor Recency**: The Bayesian LR model is trained on recent user feedback (maxLikedDays=100), so `p` scores are higher for items matching current interests, which tend to be recent.

4. **Reserve Pool Dominance**: 25 reserves per desk (83% of picks) are selected by pure V-score ranking, not cluster diversity. With long half-lives, older items can appear in reserves, but core cluster items still dominate.

## Recommendations

### If exact keyword distribution match is required:
1. **Modify LR freshness function** to use logistic-in-log-age (match keyword engine)
2. **Relax cluster round-robin** for primary desk to allow side cluster picks
3. **Add explicit age diversity constraint** in sampler

### If parameter tuning is sufficient:
- Use **epsilon=0.8, halfLifeDays=30, explore.gamma=0.5** as tuned config
- This provides 2.3x improvement on primary, 1.6x on science
- Tail bins (10-50+ days) now have meaningful representation

### Config Update (config.json)
```json
"sampling": {
  "epsilon": 0.8,
  "halfLifeDays": 30,
  "explore": { "gamma": 0.5, "floor": 0.01 },
  ...
}
```

## Files Generated
- `comparison_2026-10-29_10seeds.json/html` - Tuned LR (epsilon=0.8, halfLife=30) vs Keyword (10 seeds)
- `comparison_2026-10-29_5seeds.json/html` - Default LR vs Keyword (5 seeds)
- `sweep_lr_freshness_quick.json` - Quick sweep results (24 configs, 3 seeds)
- `sweep_lr_age_match.json` - Initial sweep (80 configs, 5 seeds, but had CLI bug)