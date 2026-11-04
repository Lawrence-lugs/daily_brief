# Embedding Model Comparison — LR Evaluation

- **Date:** 11-04-2026
- **Test fraction:** 0.2
- **Generated:** 2026-11-04T18:57:33.612943
- **Database:** C:\Users\lafqu\workspace\01_Projects\daily_brief\daily_brief.db

## Results

| Embedding model | Tag | n_train | n_test | Prior AUC | Prior logLoss | Keyword AUC | Keyword logLoss | Fitted AUC | Fitted logLoss |
|-----------------|-----|---------|--------|-----------|---------------|-------------|-----------------|------------|----------------|
| bge-base | bge-base:fp32 | 0 | 0 | N/A | N/A | N/A | N/A | N/A | N/A |
| bge-micro | bge-micro:q8 | 0 | 0 | N/A | N/A | N/A | N/A | N/A | N/A |
| bge-small | bge-small:fp32 | 0 | 0 | N/A | N/A | N/A | N/A | N/A | N/A |
| leaf-mt | leaf-mt:fp32 | 0 | 0 | N/A | N/A | N/A | N/A | N/A | N/A |
| mpnet | mpnet:fp32 | 0 | 0 | N/A | N/A | N/A | N/A | N/A | N/A |

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
    "cutoff_date": "11-04-2026",
    "test_frac": 0.2,
    "n_train": 0,
    "n_test": 0,
    "prior_auc": null,
    "prior_logloss": null,
    "keyword_auc": null,
    "keyword_logloss": null,
    "fitted_auc": null,
    "fitted_logloss": null,
    "results": "{\"nTrain\":0,\"nTest\":0,\"prior\":{\"auc\":null,\"logLoss\":null},\"keyword\":{\"auc\":null,\"logLoss\":null},\"fitted\":{\"auc\":null,\"logLoss\":null}}",
    "created_at": "2026-11-04 10:51:28"
  },
  {
    "embedding_tag": "bge-micro:q8",
    "cutoff_date": "11-04-2026",
    "test_frac": 0.2,
    "n_train": 0,
    "n_test": 0,
    "prior_auc": null,
    "prior_logloss": null,
    "keyword_auc": null,
    "keyword_logloss": null,
    "fitted_auc": null,
    "fitted_logloss": null,
    "results": "{\"nTrain\":0,\"nTest\":0,\"prior\":{\"auc\":null,\"logLoss\":null},\"keyword\":{\"auc\":null,\"logLoss\":null},\"fitted\":{\"auc\":null,\"logLoss\":null}}",
    "created_at": "2026-11-04 10:44:43"
  },
  {
    "embedding_tag": "bge-small:fp32",
    "cutoff_date": "11-04-2026",
    "test_frac": 0.2,
    "n_train": 0,
    "n_test": 0,
    "prior_auc": null,
    "prior_logloss": null,
    "keyword_auc": null,
    "keyword_logloss": null,
    "fitted_auc": null,
    "fitted_logloss": null,
    "results": "{\"nTrain\":0,\"nTest\":0,\"prior\":{\"auc\":null,\"logLoss\":null},\"keyword\":{\"auc\":null,\"logLoss\":null},\"fitted\":{\"auc\":null,\"logLoss\":null}}",
    "created_at": "2026-11-04 10:47:40"
  },
  {
    "embedding_tag": "leaf-mt:fp32",
    "cutoff_date": "11-04-2026",
    "test_frac": 0.2,
    "n_train": 0,
    "n_test": 0,
    "prior_auc": null,
    "prior_logloss": null,
    "keyword_auc": null,
    "keyword_logloss": null,
    "fitted_auc": null,
    "fitted_logloss": null,
    "results": "{\"nTrain\":0,\"nTest\":0,\"prior\":{\"auc\":null,\"logLoss\":null},\"keyword\":{\"auc\":null,\"logLoss\":null},\"fitted\":{\"auc\":null,\"logLoss\":null}}",
    "created_at": "2026-11-04 10:45:44"
  },
  {
    "embedding_tag": "mpnet:fp32",
    "cutoff_date": "11-04-2026",
    "test_frac": 0.2,
    "n_train": 0,
    "n_test": 0,
    "prior_auc": null,
    "prior_logloss": null,
    "keyword_auc": null,
    "keyword_logloss": null,
    "fitted_auc": null,
    "fitted_logloss": null,
    "results": "{\"nTrain\":0,\"nTest\":0,\"prior\":{\"auc\":null,\"logLoss\":null},\"keyword\":{\"auc\":null,\"logLoss\":null},\"fitted\":{\"auc\":null,\"logLoss\":null}}",
    "created_at": "2026-11-04 10:55:27"
  }
]
```
