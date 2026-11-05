# Embedding Model Comparison — LR Evaluation

- **Date:** 2026-11-04
- **Test fraction:** 0.2
- **Generated:** 2026-11-04T19:08:41.230208
- **Database:** C:\Users\lafqu\workspace\01_Projects\daily_brief\daily_brief.db

## Results

| Embedding model | Tag | n_train | n_test | Prior AUC | Prior logLoss | Keyword AUC | Keyword logLoss | Fitted AUC | Fitted logLoss |
|-----------------|-----|---------|--------|-----------|---------------|-------------|-----------------|------------|----------------|
| bge-base | bge-base:fp32 | 215 | 40 | 0.6522 | 0.6459 | 0.5192 | 2.3458 | 0.6624 | 0.7608 |
| bge-micro | bge-micro:q8 | 215 | 40 | 0.6343 | 0.6542 | 0.5192 | 2.3458 | 0.6113 | 0.7458 |
| bge-small | bge-small:fp32 | 215 | 40 | 0.7008 | 0.6456 | 0.5192 | 2.3458 | 0.6675 | 0.7501 |
| leaf-mt | leaf-mt:fp32 | 215 | 40 | 0.6803 | 0.6455 | 0.5192 | 2.3458 | 0.7033 | 0.7579 |
| mpnet | mpnet:fp32 | 215 | 40 | 0.6061 | 0.7590 | 0.5192 | 2.3458 | 0.5575 | 0.8105 |

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
    "cutoff_date": "2026-11-04",
    "test_frac": 0.2,
    "n_train": 215,
    "n_test": 40,
    "prior_auc": 0.6521739130434783,
    "prior_logloss": 0.6459291649466528,
    "keyword_auc": 0.5191815856777494,
    "keyword_logloss": 2.3458184222217495,
    "fitted_auc": 0.6624040920716112,
    "fitted_logloss": 0.7607612911097523,
    "results": "{\"cut\":\"2026-11-02\",\"nTrain\":215,\"nTest\":40,\"prior\":{\"auc\":0.6521739130434783,\"logLoss\":0.6459291649466528},\"keyword\":{\"auc\":0.5191815856777494,\"logLoss\":2.3458184222217495},\"fitted\":{\"auc\":0.6624040920716112,\"logLoss\":0.7607612911097523}}",
    "created_at": "2026-11-04 11:04:39"
  },
  {
    "embedding_tag": "bge-micro:q8",
    "cutoff_date": "2026-11-04",
    "test_frac": 0.2,
    "n_train": 215,
    "n_test": 40,
    "prior_auc": 0.6342710997442456,
    "prior_logloss": 0.6542153202089553,
    "keyword_auc": 0.5191815856777494,
    "keyword_logloss": 2.3458184222217495,
    "fitted_auc": 0.6112531969309463,
    "fitted_logloss": 0.7458195237807566,
    "results": "{\"cut\":\"2026-11-02\",\"nTrain\":215,\"nTest\":40,\"prior\":{\"auc\":0.6342710997442456,\"logLoss\":0.6542153202089553},\"keyword\":{\"auc\":0.5191815856777494,\"logLoss\":2.3458184222217495},\"fitted\":{\"auc\":0.6112531969309463,\"logLoss\":0.7458195237807566}}",
    "created_at": "2026-11-04 10:58:30"
  },
  {
    "embedding_tag": "bge-small:fp32",
    "cutoff_date": "2026-11-04",
    "test_frac": 0.2,
    "n_train": 215,
    "n_test": 40,
    "prior_auc": 0.7007672634271099,
    "prior_logloss": 0.6455788618229578,
    "keyword_auc": 0.5191815856777494,
    "keyword_logloss": 2.3458184222217495,
    "fitted_auc": 0.6675191815856778,
    "fitted_logloss": 0.7501486531142925,
    "results": "{\"cut\":\"2026-11-02\",\"nTrain\":215,\"nTest\":40,\"prior\":{\"auc\":0.7007672634271099,\"logLoss\":0.6455788618229578},\"keyword\":{\"auc\":0.5191815856777494,\"logLoss\":2.3458184222217495},\"fitted\":{\"auc\":0.6675191815856778,\"logLoss\":0.7501486531142925}}",
    "created_at": "2026-11-04 11:01:05"
  },
  {
    "embedding_tag": "leaf-mt:fp32",
    "cutoff_date": "2026-11-04",
    "test_frac": 0.2,
    "n_train": 215,
    "n_test": 40,
    "prior_auc": 0.680306905370844,
    "prior_logloss": 0.645473324993181,
    "keyword_auc": 0.5191815856777494,
    "keyword_logloss": 2.3458184222217495,
    "fitted_auc": 0.7033248081841432,
    "fitted_logloss": 0.7579066514280515,
    "results": "{\"cut\":\"2026-11-02\",\"nTrain\":215,\"nTest\":40,\"prior\":{\"auc\":0.680306905370844,\"logLoss\":0.645473324993181},\"keyword\":{\"auc\":0.5191815856777494,\"logLoss\":2.3458184222217495},\"fitted\":{\"auc\":0.7033248081841432,\"logLoss\":0.7579066514280515}}",
    "created_at": "2026-11-04 10:59:21"
  },
  {
    "embedding_tag": "mpnet:fp32",
    "cutoff_date": "2026-11-04",
    "test_frac": 0.2,
    "n_train": 215,
    "n_test": 40,
    "prior_auc": 0.6061381074168798,
    "prior_logloss": 0.7589663840717662,
    "keyword_auc": 0.5191815856777494,
    "keyword_logloss": 2.3458184222217495,
    "fitted_auc": 0.5575447570332481,
    "fitted_logloss": 0.8104724870248669,
    "results": "{\"cut\":\"2026-11-02\",\"nTrain\":215,\"nTest\":40,\"prior\":{\"auc\":0.6061381074168798,\"logLoss\":0.7589663840717662},\"keyword\":{\"auc\":0.5191815856777494,\"logLoss\":2.3458184222217495},\"fitted\":{\"auc\":0.5575447570332481,\"logLoss\":0.8104724870248669}}",
    "created_at": "2026-11-04 11:08:40"
  }
]
```
