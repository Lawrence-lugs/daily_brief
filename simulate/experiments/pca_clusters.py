"""UMAP projection for the statistics page's PCA clusters card.

Reads {ids, titles, groups, vectors, cluster_of, medoid_ids} from stdin,
prints the card payload to stdout. Clustering is done by the ranker
(ranker/interests.js); this only projects the vectors to 2D for display.
cluster_of[i] is the cluster index of item i; medoid_ids[c] is the item id
of cluster c's medoid.
"""

import json
import sys

import numpy as np
import umap


def compute(embeddings, ids, titles, groups, cluster_of, medoid_ids):
    """Return the pca_clusters card payload dict (UMAP projection)."""
    n = len(ids)
    if n < 3:
        raise ValueError(f"need at least 3 embedded items for UMAP projection, got {n}")

    X = np.asarray(embeddings, dtype=float)
    reducer = umap.UMAP(n_components=2, random_state=42, compatibility_layout=True)
    Z = reducer.fit_transform(X)

    index_of = {item_id: i for i, item_id in enumerate(ids)}
    medoids = []
    for c, medoid_id in enumerate(medoid_ids):
        i = index_of[medoid_id]
        medoids.append({
            "cluster": c,
            "id": medoid_id,
            "title": titles[i],
            "x": float(Z[i, 0]),
            "y": float(Z[i, 1]),
            "size": int(sum(1 for k in cluster_of if k == c)),
        })

    points = []
    for i in range(n):
        points.append({
            "id": ids[i],
            "title": titles[i],
            "group": groups[i],
            "cluster": int(cluster_of[i]),
            "x": float(Z[i, 0]),
            "y": float(Z[i, 1]),
        })

    return {
        "points": points,
        "medoids": medoids,
        "k": len(medoid_ids),
        "explainedVariance": None,  # UMAP has no explained-variance ratio
    }


if __name__ == "__main__":
    payload_in = json.load(sys.stdin)
    result = compute(
        payload_in["vectors"],
        payload_in["ids"],
        payload_in["titles"],
        payload_in["groups"],
        payload_in["clusterOf"],
        payload_in["medoidIds"],
    )
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")
