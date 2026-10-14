


## Attempt at embedding

We've used the embeddings created by Smart Connections (using TaylorAI/BGE-micro-v2).

It somewhat works but:

- Tends to make only around 2 large clusters
- Large clusters contain heavily varying notes and include outliers

Hypothesis on clustering problems:

- Could be caused by prevalence of metadata in the text (does smart connections snip the metadata?)
- Irrelevant but similar sections (for example, todos, figures, equations and such) may be causing relations between not really well-related notes.

Possible action:

- Should check how smart connections calculates the distance score per note shown in the UI.
- Entertain the idea of outliers, which steps a bit away from clustering. There's a minimum "connectedness" per note should be reached to join a cluster.
    - Hdbscan, hierarchical thresholded similarity clustering, dp-means clustering are all candidates for this.
    - Thresholded similarity might be best, since we get to keep the smaller clusters.


## Performance and Framework

We should probably move to something like node so that we can call without python. 


## Distributed recommendation

Currently slots are reserved preferring 1 item per subtopic set. 

We can instead entertain slot allocation by interest strength once we have the feedback loop. 
Initially aim for:

- 2 from strongest interest.
- 3 from lower scoring interests slotted to 1 each.
