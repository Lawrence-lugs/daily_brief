# Run a desk-filling experiment

From the repository root, use Node 22.13 or newer. Pass a SQLite snapshot and the deployment's config. The runner opens one read-only SQLite transaction, uses cached embeddings and writes the result to a **new** output file.

```sh
npm run experiment:desk-fill -- --db /data/daily_brief.db --config /data/config.json --out first-run.json
```

By default the runner loads `sources.json` beside the config. The LR engine also reads the configured perfect-samples path relative to the config. Override either with `--sources FILE` or `--samples FILE`. An LR run requires matching cached model tags, dimensions and anchor text hashes. The output counts pool rows lacking compatible vectors. A keyword deployment uses its own selector and needs no vectors or anchors. The snapshot must use the project's current SQLite schema.

## What a default run compares

The end date is the latest first-seen or matching desk exposure date. Two consecutive three-day evaluation windows end there, followed by a seven-day no-arrival stress test. Four paired seeds generate one noon UTC edition per day. Each historical window fits once using earlier exposures and feedback, then updates its own selection history. The drought starts from the observed pre-cutoff history and excludes later arrivals, publications and feedback, even if they exist in the file. Each variant starts from the same state. An empty snapshot with no explicit dates returns an empty window list.

For LR, compare the configured policy, cluster round-robin, per-desk top 10% and top 100 by probability, rolling selection and a feed-feature ablation. The rolling and shortlist variants target configured slow desks, or all desks when none are marked slow. Configured policies participate unchanged, so some controls can coincide. The optional `feed` feature learns a separate weight per stored feed name with source as the fallback. This handles new providers and venues without extending the IEEE alias table. Feed aliases have distinct coefficients unless the underlying stored names agree. The configured model's other features and priors still apply. For the legacy keyword engine the defaults compare configured selection against a lighter repeat penalty.

## Run a sweep

Pass a JSON file with `--spec sweep.json`. Omit dates to track the most recent snapshot. `start` and `end` are inclusive UTC dates. An explicit start takes precedence over `windows`; `windowDays` still partitions the interval. Set `droughtDays` to zero to omit the stress test.

```json
{
  "windowDays": 5,
  "windows": 3,
  "droughtDays": 14,
  "seeds": [11, 29, 37],
  "variants": [
    { "name": "production" },
    {
      "name": "rolling RF",
      "sampling": {
        "slowDesks": {
          "rf_wireless": { "rollover": true, "minValue": 0.12, "repeatWeight": 0.8 }
        }
      },
      "grid": {
        "sampling.slowDesks.rf_wireless.minValue": [0.08, 0.12, 0.16],
        "sampling.slowDesks.rf_wireless.repeatWeight": [0.5, 0.8]
      }
    },
    {
      "name": "learn feed preferences",
      "features": ["bias", "type", "author", "medoid", "feed"],
      "priorRules": [{ "match": "feed:", "mean": 0, "prec": 4 }]
    }
  ]
}
```

This expands to eight paired variants. Substitute your desk IDs. Nested model, sampling and keyword `selection` objects merge with the profile. Arrays replace the inherited array. Bayesian `priorRules` append to inherited rules. Use `topK` or `topFraction` with optional `targetDesks` for a shortlist variant. Grid axes form a Cartesian product. For a feed-supply ablation, set top-level `feeds` to the stored feed names to retain. A new sources file supplies cadence for existing rows. It cannot supply papers absent from the snapshot. Previously fetched rows remain available unless excluded explicitly.

## Inspect quality and score judgments

Each window contains per-variant, per-desk slot counts, distinct selected items, repeats, greedy/explore counts, greedy V summaries, source mix, and the first seed's full raw editions. The validation block scores historically exposed items that were unseen at the training cutoff. AUC requires both classes. A freeze has no held-out validation block. The unjudged direct-fit rate is null.

The top-level `review` array is the union of selected desk/item pairs, sorted independently of variant rank. Set `relevant` to true or false after reading the title or article. Keep null for uncertain or unread items. Pass either the edited report or just the array back in:

```sh
npm run experiment:desk-fill -- --db /data/daily_brief.db --config /data/config.json --spec sweep.json --judgments reviewed.json --out judged-run.json
```

Compare **relevantGreedy / judgedGreedy**, **judgedGreedy / greedy**, **filled / slots**, distinct items and repeats together. Each repeated placement contributes to appearance-weighted quality. The distinct count covers both greedy and exploration picks across all seeds. A desk can score high by recycling very few papers. Choose settings on earlier windows, then verify them on a later window or later snapshot with independently reviewed items. Likes are observed only for historical exposures. The merged pool can have newer descriptions and earlier first-seen dates than either individual deployment. The simulation uses today's profile and surviving rows, and omits editor decisions and hypothetical feedback.

For tracked Sacred runs use `python -m simulate.cli desk-fill --db FILE --config FILE` with the same optional input flags. It records the database file SHA-256, input JSON resources and the report artifact. The historical November MicroLab experiment remains available under `slow-desk-replay`.
