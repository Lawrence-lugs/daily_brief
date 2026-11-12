"""PCA projection for the statistics page's PCA clusters card.

Reads {ids, titles, groups, vectors, clusterOf, medoidIds} from stdin, prints the card payload to stdout.
Clustering is done by the ranker (ranker/interests.js); this only projects the vectors to 2D for display.
clusterOf[i] is the cluster index of item i; medoidIds[c] is the item id of cluster c's medoid.
"""

import json
import sys

import numpy as np
from sklearn.decomposition import PCA


def compute(embeddings, ids, titles, groups, cluster_of, medoid_ids):
    """Return the pca_clusters card payload dict."""
    n = len(ids)
    if n < 3:
        raise ValueError(f"need at least 3 embedded items for PCA projection, got {n}")

    X = np.asarray(embeddings, dtype=float)
    pca = PCA(n_components=2).fit(X)
    Z = pca.transform(X)

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
        "pcaExplainedVariance": [float(v) for v in pca.explained_variance_ratio_],
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
