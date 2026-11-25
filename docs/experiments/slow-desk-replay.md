# RF and analog desk replay

The merged November 25 snapshot contains 11,318 candidates and 1,925 story placements across 158 briefs. The 89 OpenAlex circuit-journal rows span four venues. The snapshot's perfect-sample vectors match all 36 MicroLab anchors by text hash and none of the desktop default anchors. The replay therefore evaluates MicroLab's five desks. It cannot reconstruct the desktop primary/science selector faithfully.

## Where the selector failed

The old sampler removes candidates below the global mean **p**, then calculates **V** with age and repeat penalties, then gives each cluster a turn. There is no minimum V at that stage. One previous appearance multiplies V by 0.05 before the recency penalty. On November 24 the deployed RF desk gave an on-device MoE routing paper a greedy slot at p ≈ 0.40. The deployed analog desk printed an author-information page on November 24 and 25. Both score magnitude and venue can give false reassurance.

## Model evaluation

At the start of each window, fit the production Bayesian model and cross-fitted interests using earlier MicroLab exposures and only feedback dated before the window. Estimate numeric scaling from earlier available pool rows. Evaluate on distinct newly exposed items, using likes/saves recorded by the end of the window. Noninteraction is a weak negative. Feedback on never-selected articles is unknown.

November 20–22 has 246 training examples and 138 new scored exposures, including 19 positives. This is the journal-arrival window and was used to select hyperparameters.

| Prior on shared circuit-journal coefficient | AUC | Log loss |
|---|---:|---:|
| Original features | .757 | .392 |
| Mean 0, precision 1 | .782 | .388 |
| Mean 1, precision 1 | .851 | .388 |
| Mean 1, precision 4 | .851 | .389 |
| Mean 2, precision 1 | .862 | .418 |

Selected a shared log-odds prior of +1 with precision 1. A zero-centered venue-specific adjustment with precision 4 allows JSSC, TCAS-I, JETCAS and TCASAI to diverge as feedback accumulates. OpenAlex and RSS aliases share the same feature. Journal notices, editorial introductions and correction notices are excluded from selection when journal features are enabled. The underlying candidate rows remain available. Sweeping the nearest-medoid coefficient's prior precision from 0.25 to 4 made little difference in this window. The earlier November 16–19 window had only two positives. The November 23–25 window had zero positives among 72 new scored exposures, so it cannot validate future like-prediction AUC.

Within the November 20 window, analog AUC rose from .754 to .842 (6 positives in 25), RF from .593 to .710 (5 in 34). ML hardware stayed at .805 (7 in 29). MEMS had one positive and microfluidics zero. These counts do not support retuning either of those desks separately.

## What appeared during depletion

Each seed generated one five-slot edition per desk per day using the existing embeddings, recorded first-seen and publication times, 120-day pruning and feed cadence. Fits are frozen within each window. Historical exposures initialize the repeat state, then each simulated edition updates its own history. No feeds, encoder, editor or synthetic likes are called. The front page can differ after real editor decisions.

For November 23–25, I reviewed greedy selections against the desk descriptions, consulting snippets for ambiguous titles. An RF front-end block, receiver, synthesizer or physical radio implementation counts as a direct fit. Wireless networking theory alone does not. For analog, a converter, gate driver, phase interpolator or measured mixed-signal macro counts. The primary 3D NAND CIM paper describes its oscillator ADCs. Secondary coverage that only links the paper did not meet the same bar. These are editorial judgments made while tuning, not independent reader labels.

| Policy (8 seeds × 3 editions) | Analog direct / greedy | RF direct / greedy | All slow-desk slots filled / 240 |
|---|---:|---:|---:|
| Original selector | 31/105 | 0/94 | 240 |
| Journal features and notice filter | 53/105 | 15/94 | 240 |
| Same, restrict each slow desk to top 10% by p | 55/103 | 15/94 | 240 |
| Same, restrict each slow desk to top 100 by p | 54/103 | 19/103 | 240 |
| Journal features, desk evidence and rolling picks | 106/106 | 71/71 | 215 |

The last row represents **six distinct analog papers and three RF papers** in greedy slots. The remaining 38 filled slots were epsilon draws. The strict audit counts story appearances, including repeats. For reproduction, the direct-fit IDs in the compared selections were analog `39a880f590e7 40ffd2fb07ab 7645b71de684 bd7187f3639c d2f69cf04705 d40e72870226 de19ed1208ee` and RF `26679981b0c2 4fd76b0820c0 6a02ef737099 81a3efb65a6c 8c1978ab7166`. Sum the corresponding entries in each result's `greedyExposures`.

The selected policy requires V ≥ .12 and configured circuit terms for greedy and reserve slots. Analog searches titles and snippets to recover descriptions of circuit blocks. RF uses titles because abstracts frequently mention receivers in algorithm-only work. The sampler compares eligible items across clusters, caps the count penalty at one showing (weight .8), and lets yesterday's greedy picks compete again at discounted value. New selections appear first, followed by retained picks in their prior order. Epsilon draws retain broad eligibility and cannot roll forward as incumbents. Unfilled slots are possible. Other desks continue their configured cluster sampling. All three other MicroLab desks filled 120/120 slots in the late replay.

The sweep compared V floors .06/.12/.18, repeat weights .05/.5/.8, title versus snippet evidence, and carry versus normal cooldown. Allowing snippet matches on RF filled every slot in the late replay but only 67/94 greedy appearances passed the direct-fit audit. Lowering the floor makes uncertain matches easier to admit. Restricting analog to titles filled 61/120 slots in the arrival window versus 95/120 with snippet evidence. One remaining early-window mistake was an interview with an Analog Bits executive. A phrase match still misses relevant papers with unfamiliar vocabulary.

### One simulated November 25 edition

Seed 1's four analog greedy stories covered a current-mode phase interpolator, low-noise bandgap references, gate-voltage slope sensing, and an all-NMOS active gate driver. Its epsilon draw was an open-string theory paper. RF carried a 6.2–38 GHz image-reject receiver, a 410 MHz variable-gain feedback amplifier, and an edge-combining mixer-first receiver. Its two exploration slots went to multimodal place recognition and reinforcement learning for graph games. The production setting retains epsilon = .2, so even a well-filtered greedy desk can still show unrelated exploration.

### Fourteen days with no arrivals

Freezing the entire merged pool after November 25 is a supply interruption stress test. Eight seeds provide 560 possible slots per desk. Analog filled 506, including 414 previously shown placements. RF filled 485, including 349 previously shown placements. This measures how the selector behaves under prolonged repetition. It does not estimate how often a journal issue arrives.

## Reproduce and enable

From the repository root, run:

```sh
node simulate/experiments/slow_desk_replay.js /path/to/unified-dbs.db > replay.json
```

The report uses the tracked MicroLab profile and the cadence definitions in `user/defaults/sources.json`. The optional third positional input after the database and profile directory selects a different sources file. The Sacred CLI equivalent is `python -m simulate.cli slow-desk-replay --db /path/to/unified-dbs.db`. Input database SHA-256 was `e62a0f8fcaa71e91b69efc7894556cd3bbe7147e75c95556f92553274b1cc7d6`.

The two deployments share a merged, survivor-only candidate pool. First-seen is the earlier deployment timestamp, descriptions can be the newer version and some first-seen times precede availability on the actual web instance. Feedback is item-level across sessions. Treat these as comparisons under the same reconstructed supply. The fixed anchors, journal terms, editorial audit and thresholds were examined on this snapshot. A later issue with fresh reader feedback is needed for an independent quality estimate.

The MicroLab settings in `user/ulab_settings/config.json` contain the tuned values. For an existing persisted MicroLab configuration, add `journal` to `ranker.features`, merge the two new rules (`circuitJournal` and `journal:`) into `ranker.model.prior.rules` and copy `ranker.sampling.slowDesks`. Keep the deployment's sources and perfect samples. The settings loader seeds missing files only. Updating repository code alone does not apply these three edits to a running installation.
