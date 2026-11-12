"""Synthetic test for simulate/experiments/pca_clusters.compute.

3 well-separated blobs of 10 points each, with clusterOf and medoid ids given.
Assert k == 3, one medoid per cluster, and the UMAP projection covers every item.
"""

import numpy as np
import pytest

from simulate.experiments.pca_clusters import compute


def _make_blobs():
    rng = np.random.default_rng(42)
    blobs = []
    for center in ([3.0, 0.0, 0.0], [0.0, 3.0, 0.0], [-3.0, -3.0, 0.0]):
        blobs.append(rng.normal(loc=center, scale=0.1, size=(10, 3)))
    X = np.vstack(blobs)
    norms = np.linalg.norm(X, axis=1, keepdims=True)
    X = X / norms
    ids = [f"item-{i}" for i in range(len(X))]
    titles = [f"Title {i}" for i in range(len(X))]
    groups = ["pool"] * len(X)
    cluster_of = [i // 10 for i in range(len(X))]
    medoid_ids = [ids[0], ids[10], ids[20]]
    return X, ids, titles, groups, cluster_of, medoid_ids


def test_compute_returns_one_medoid_per_cluster():
    X, ids, titles, groups, cluster_of, medoid_ids = _make_blobs()
    result = compute(X.tolist(), ids, titles, groups, cluster_of, medoid_ids)
    assert result["k"] == 3
    assert [m["id"] for m in result["medoids"]] == medoid_ids
    assert [m["size"] for m in result["medoids"]] == [10, 10, 10]
    assert len(result["points"]) == len(ids)
    assert all(p["cluster"] == cluster_of[i] for i, p in enumerate(result["points"]))


def test_compute_rejects_too_few_items():
    with pytest.raises(ValueError):
        compute([[1.0, 0.0], [0.0, 1.0]], ["a", "b"], ["a", "b"], ["pool", "pool"], [0, 1], ["a", "b"])
