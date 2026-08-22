---
fileName: search-relevance-tuning.md
url: https://wiki.example.com/search-relevance
---

# Search Relevance Tuning

Relevance is tuned by blending cosine similarity from the embedding model
with a BM25 lexical score, weighted 65/35. Query expansion adds simple
synonym and plural variants before scoring. Regressions are caught with a
labeled query set checked into the eval harness.
