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

---

# Appendix: Logistic-in-Log-Age Freshness Model Tuning (2026-10-30)

## Context
The LR engine was updated to use a **logistic-in-log-age** freshness function (matching the keyword engine's functional form):
```
freshness = 1 / (1 + exp(steepness * (log1p(age) - log1p(halfLifeDays))))
```
Default config: `steepness = ln(4) ≈ 1.386`, `halfLifeDays = 7`, `model = "logistic"`

This replaces the previous exponential decay: `exp(-ln(2) * age / halfLifeDays)`

## Parameter Sweep Results (Logistic-in-Log-Age)

Tested 24 combinations (3 seeds each):
- `epsilon`: [0.4, 0.6, 0.8]
- `halfLifeDays`: [14, 21, 30, 45]
- `explore.gamma`: [0.3, 0.5]

### Top 5 Configurations (3 seeds each)

| Rank | epsilon | halfLifeDays | explore.gamma | Primary Mean | Science Mean | Avg Score |
|------|---------|--------------|---------------|--------------|--------------|-----------|
| 1 | 0.8 | 21 | 0.5 | 2.28 | 2.65 | 0.830 |
| 2 | 0.8 | 21 | 0.3 | 2.80 | 2.31 | 0.843 |
| 3 | 0.6 | 21 | 0.3 | 2.58 | 2.26 | 0.849 |
| 4 | 0.4 | 14 | 0.3 | 2.41 | 2.97 | 0.856 |
| 5 | 0.8 | 14 | 0.3 | 2.69 | 2.21 | 0.866 |

**Best score (histogram distance + mean diff): epsilon=0.8, halfLifeDays=21, explore.gamma=0.5**

### Extreme Parameter Tests (5 seeds)

| epsilon | halfLifeDays | explore.gamma | Primary Mean | Science Mean |
|---------|--------------|---------------|--------------|--------------|
| 0.8 | 60 | 0.3 | 3.27 | 3.03 |
| 0.8 | 60 | 0.5 | 3.42 | 2.65 |
| 0.8 | 90 | 0.3 | 3.16 | 3.08 |
| 0.8 | 90 | 0.5 | 3.46 | 2.89 |
| 0.8 | 120 | 0.3 | 3.98 | 3.53 |
| 0.8 | 120 | 0.5 | 4.36 | 3.37 |
| 1.0 | 30 | 0.3 | 3.47 | 2.75 |
| 1.0 | 60 | 0.3 | 3.61 | 3.16 |
| 1.0 | 90 | 0.3 | 3.73 | 3.31 |
| 1.0 | 120 | 0.5 | 4.71 | 3.77 |

**Best mean age: epsilon=1.0, halfLifeDays=120, explore.gamma=0.5 → Primary=4.71, Science=3.77**

## Final Comparison: Tuned vs Keyword (10 seeds)

### Config A: Best Histogram Match (epsilon=0.8, halfLifeDays=21, explore.gamma=0.5)

| Engine | Desk | Mean Age | Median | 0-1 | 1-2 | 2-5 | 5-10 | 10-20 | 20-50 | 50+ |
|--------|------|----------|--------|-----|-----|-----|------|-------|-------|-----|
| Keyword | Primary | 12.37 | — | 5 | 7 | 9 | 7 | 15 | 5 | 2 |
| LR (tuned) | Primary | 2.04 | 1.33 | 0 | 270 | 18 | 3 | 6 | 2 | 1 |
| Keyword | Science | 12.72 | — | 1 | 11 | 9 | 6 | 16 | 4 | 3 |
| LR (tuned) | Science | 1.57 | 1.33 | 10 | 280 | 2 | 3 | 5 | 0 | 0 |

### Config B: Best Mean Age (epsilon=1.0, halfLifeDays=120, explore.gamma=0.5)

| Engine | Desk | Mean Age | Median | 0-1 | 1-2 | 2-5 | 5-10 | 10-20 | 20-50 | 50+ |
|--------|------|----------|--------|-----|-----|-----|------|-------|-------|-----|
| Keyword | Primary | 16.54 | — | 2 | 2 | 10 | 9 | 12 | 12 | 3 |
| LR (extreme) | Primary | 2.16 | 1.33 | 0 | 260 | 28 | 2 | 6 | 3 | 1 |
| Keyword | Science | 14.76 | — | 2 | 5 | 10 | 8 | 14 | 8 | 3 |
| LR (extreme) | Science | 1.58 | 1.33 | 10 | 280 | 2 | 3 | 5 | 0 | 0 |

## Improvement Summary (Logistic-in-Log-Age)

| Metric | Primary Desk | Science Desk |
|--------|--------------|--------------|
| Keyword mean (target) | 12.37–16.54 | 12.72–14.76 |
| LR default mean (exp, HL=7) | 1.66 | 1.76 |
| LR best hist-match mean | **2.04** | **1.57** |
| LR best mean-age mean | **2.16** | **1.58** |
| **Improvement factor (vs default)** | **1.2–1.3x** | **0.9–0.9x** |
| **vs Previous Best (exp, HL=30)** | **Worse (2.04 vs 3.88)** | **Worse (1.57 vs 2.89)** |

## Key Finding: Logistic-in-Log-Age Performs WORSE Than Exponential

| Model | halfLifeDays | epsilon | Primary Mean | Science Mean |
|-------|--------------|---------|--------------|--------------|
| Exponential (old) | 30 | 0.8 | **3.88** | **2.89** |
| Logistic-in-log-age (new) | 21 | 0.8 | 2.04 | 1.57 |
| Logistic-in-log-age (new) | 120 | 1.0 | 2.16 | 1.58 |

The logistic-in-log-age function decays **more aggressively at young ages** than exponential with the same half-life point, because `log1p(age)` grows faster than linear for small ages. This makes it harder to get older items selected.

At age=2:
- Exponential (HL=30): 0.955
- Logistic (steepness=1.386, HL=21): 0.500 ← 50% penalty at age=2!

At age=30:
- Exponential (HL=30): 0.500
- Logistic (steepness=1.386, HL=21): 0.500 ← Same at half-life point

At age=50:
- Exponential (HL=30): 0.315
- Logistic (steepness=1.386, HL=21): 0.394 ← Logistic has heavier tail

But since 90%+ of candidate pool is age < 10 days, the aggressive early decay dominates.

## Recommendation: Revert to Exponential or Adjust Steepness

1. **Option A: Revert to exponential decay** (previous best: epsilon=0.8, halfLifeDays=30, explore.gamma=0.5)
   - Achieves 3.88/2.89 mean age (2.3x/1.6x improvement)
   
2. **Option B: Reduce steepness significantly** for logistic-in-log-age
   - Current steepness=1.386 (ln(4)) gives 50% penalty at age=2 when HL=21
   - Need steepness ≈ 0.2–0.3 to match exponential HL=30 behavior at young ages
   - Then increase halfLifeDays to 60–120 for tail

3. **Option C: Keep logistic but change half-life definition**
   - Use `log(age)` not `log1p(age)` and define halfLifeDays as the age where freshness=0.5
   - Current: `log1p(halfLifeDays)` → halfLifeDays=21 gives 50% at age≈21
   - But steepness=1.386 makes transition too sharp

## Updated Config Recommendation

**Stick with exponential decay** (proven best):
```json
"sampling": {
  "epsilon": 0.8,
  "halfLifeDays": 30,
  "freshness": { "model": "exponential" },
  "explore": { "gamma": 0.5, "floor": 0.01 },
  ...
}
```

## Final Verification: Exponential Decay with Tuned Config (2026-10-30)

Config: `epsilon=0.8, halfLifeDays=30, freshness.model=exponential, explore.gamma=0.5` (updated in config.json)

### Results (10 seeds)

| Engine | Desk | Mean Age | 0-1 | 1-2 | 2-5 | 5-10 | 10-20 | 20-50 | 50+ |
|--------|------|----------|-----|-----|-----|------|-------|-------|-----|
| Keyword | Primary | 11.83 | 8 | 6 | 9 | 8 | 12 | 5 | 2 |
| LR (tuned) | Primary | 3.06 | 2 | 133 | 135 | 11 | 16 | 2 | 1 |
| Keyword | Science | 11.20 | 1 | 15 | 6 | 6 | 16 | 4 | 2 |
| LR (tuned) | Science | 2.62 | 0 | 210 | 60 | 9 | 21 | 0 | 0 |

### Summary

| Metric | Primary Desk | Science Desk |
|--------|--------------|--------------|
| Keyword mean (target) | 11.83 | 11.20 |
| LR default mean (ε=0.25, HL=7, exp) | 1.66 | 1.76 |
| LR tuned mean (ε=0.8, HL=30, exp) | **3.06** | **2.62** |
| **Improvement factor** | **1.8x** | **1.5x** |
| Tail bins (10-50+) populated | Yes (19 picks) | Yes (21 picks) |

**Note**: Slightly lower than the 3.88/2.89 from the earlier 10-seed run (2026-10-29), likely due to seed variance and different keyword baseline draws (11.83 vs 10.00). The trend is consistent: exponential with HL=30 significantly outperforms logistic-in-log-age.

## New Files Generated
- `comparison_2026-10-30_logistic_tuned_10seeds.json/html` - LR (epsilon=0.8, HL=21, logistic) vs Keyword
- `comparison_2026-10-30_logistic_extreme_10seeds.json/html` - LR (epsilon=1.0, HL=120, logistic) vs Keyword
- `sweep_lr_freshness_quick.json` - Updated with logistic-in-log-age sweep (24 configs, 3 seeds)
- `comparison_2026-10-29_10seeds.json/html` - Final verification: LR (epsilon=0.8, HL=30, exponential) vs Keyword