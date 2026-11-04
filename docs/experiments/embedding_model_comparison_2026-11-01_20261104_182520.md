# Embedding Model Comparison — LR Evaluation

- **Date:** 2026-11-01
- **Test fraction:** 0.2
- **Generated:** 2026-11-04T18:25:20.242835
- **Database:** C:\Users\lafqu\workspace\01_Projects\daily_brief\daily_brief.db

## Results

| Embedding model | Tag | n_train | n_test | Prior AUC | Prior logLoss | Keyword AUC | Keyword logLoss | Fitted AUC | Fitted logLoss |
|-----------------|-----|---------|--------|-----------|---------------|-------------|-----------------|------------|----------------|
| bge-base | bge-base:fp32 | 165 | 50 | 0.7276 | 0.5137 | 0.8804 | 1.0367 | 0.5548 | 0.4301 |
| bge-micro | bge-micro:q8 | 165 | 50 | 0.7874 | 0.4950 | 0.8804 | 1.0367 | 0.6844 | 0.3933 |
| bge-small | bge-small:fp32 | 165 | 50 | 0.7641 | 0.5338 | 0.8804 | 1.0367 | 0.6445 | 0.3945 |
| leaf-mt | leaf-mt:fp32 | 165 | 50 | 0.7442 | 0.5253 | 0.8804 | 1.0367 | 0.6977 | 0.3801 |
| mpnet | mpnet:fp32 | 165 | 50 | 0.5714 | 0.4101 | 0.8804 | 1.0367 | 0.6445 | 0.3873 |

## Notes

- Each model run re-embeds the full pool (embeddings are purged on model switch).
- The `fitted` column is the Bayesian LR model trained on the training split.
- The `keyword` column uses the `rel` score from `candidate_pool` as the baseline.
- Test set is small (n ≈ 50 with test_frac=0.2), so AUC differences may not be significant.

## Full results (JSON)

```json
[
  {
    "embedding_tag": "bge-base:fp32",
    "cutoff_date": "2026-11-01",
    "test_frac": 0.2,
    "n_train": 165,
    "n_test": 50,
    "prior_auc": 0.7275747508305648,
    "prior_logloss": 0.5136927520996254,
    "keyword_auc": 0.8803986710963455,
    "keyword_logloss": 1.0366698433979127,
    "fitted_auc": 0.5548172757475083,
    "fitted_logloss": 0.4301409225110804,
    "results": "{\"cut\":\"2026-10-31\",\"nTrain\":165,\"nTest\":50,\"prior\":{\"auc\":0.7275747508305648,\"logLoss\":0.5136927520996254},\"keyword\":{\"auc\":0.8803986710963455,\"logLoss\":1.0366698433979127},\"fitted\":{\"auc\":0.5548172757475083,\"logLoss\":0.4301409225110804}}",
    "created_at": "2026-11-04 10:21:42"
  },
  {
    "embedding_tag": "bge-micro:q8",
    "cutoff_date": "2026-11-01",
    "test_frac": 0.2,
    "n_train": 165,
    "n_test": 50,
    "prior_auc": 0.7873754152823921,
    "prior_logloss": 0.49497447998105537,
    "keyword_auc": 0.8803986710963455,
    "keyword_logloss": 1.0366698433979127,
    "fitted_auc": 0.6843853820598007,
    "fitted_logloss": 0.39331276922884917,
    "results": "{\"cut\":\"2026-10-31\",\"nTrain\":165,\"nTest\":50,\"prior\":{\"auc\":0.7873754152823921,\"logLoss\":0.49497447998105537},\"keyword\":{\"auc\":0.8803986710963455,\"logLoss\":1.0366698433979127},\"fitted\":{\"auc\":0.6843853820598007,\"logLoss\":0.39331276922884917}}",
    "created_at": "2026-11-04 10:16:09"
  },
  {
    "embedding_tag": "bge-small:fp32",
    "cutoff_date": "2026-11-01",
    "test_frac": 0.2,
    "n_train": 165,
    "n_test": 50,
    "prior_auc": 0.7641196013289037,
    "prior_logloss": 0.5337853136853686,
    "keyword_auc": 0.8803986710963455,
    "keyword_logloss": 1.0366698433979127,
    "fitted_auc": 0.6445182724252492,
    "fitted_logloss": 0.3944944656200415,
    "results": "{\"cut\":\"2026-10-31\",\"nTrain\":165,\"nTest\":50,\"prior\":{\"auc\":0.7641196013289037,\"logLoss\":0.5337853136853686},\"keyword\":{\"auc\":0.8803986710963455,\"logLoss\":1.0366698433979127},\"fitted\":{\"auc\":0.6445182724252492,\"logLoss\":0.3944944656200415}}",
    "created_at": "2026-11-04 10:18:31"
  },
  {
    "embedding_tag": "leaf-mt:fp32",
    "cutoff_date": "2026-11-01",
    "test_frac": 0.2,
    "n_train": 165,
    "n_test": 50,
    "prior_auc": 0.7441860465116279,
    "prior_logloss": 0.5253369979861436,
    "keyword_auc": 0.8803986710963455,
    "keyword_logloss": 1.0366698433979127,
    "fitted_auc": 0.6976744186046512,
    "fitted_logloss": 0.3801061928850226,
    "results": "{\"cut\":\"2026-10-31\",\"nTrain\":165,\"nTest\":50,\"prior\":{\"auc\":0.7441860465116279,\"logLoss\":0.5253369979861436},\"keyword\":{\"auc\":0.8803986710963455,\"logLoss\":1.0366698433979127},\"fitted\":{\"auc\":0.6976744186046512,\"logLoss\":0.3801061928850226}}",
    "created_at": "2026-11-04 10:17:00"
  },
  {
    "embedding_tag": "mpnet:fp32",
    "cutoff_date": "2026-11-01",
    "test_frac": 0.2,
    "n_train": 165,
    "n_test": 50,
    "prior_auc": 0.5714285714285714,
    "prior_logloss": 0.4100683648811638,
    "keyword_auc": 0.8803986710963455,
    "keyword_logloss": 1.0366698433979127,
    "fitted_auc": 0.6445182724252492,
    "fitted_logloss": 0.3872958125090799,
    "results": "{\"cut\":\"2026-10-31\",\"nTrain\":165,\"nTest\":50,\"prior\":{\"auc\":0.5714285714285714,\"logLoss\":0.4100683648811638},\"keyword\":{\"auc\":0.8803986710963455,\"logLoss\":1.0366698433979127},\"fitted\":{\"auc\":0.6445182724252492,\"logLoss\":0.3872958125090799}}",
    "created_at": "2026-11-04 10:25:19"
  }
]
```
