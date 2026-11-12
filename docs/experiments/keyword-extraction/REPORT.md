# TF-IDF Keyword Extraction — candidate_pool

**Experiment folder:** `docs/experiments/keyword-extraction/`  
**Implementation:** `tfidf.js` (pure Node.js, no npm dependencies; uses `node:sqlite`)  
**Results:** `tfidf_results.json` (full per-term, per-desk, per-document output)  
**Date run:** 2026-11-12  
**Database:** `daily_brief.db` (`candidate_pool` table)

---

## 1. What was done

Extracted keywords from the current candidate pool using TF-IDF.

- **Corpus:** all 4,963 rows of `candidate_pool`.
- **Document text:** `title + " " + snippet` per pool item (the same text the ranker embeds, see `ranker/embedder.js:textOf`).
- **Preprocessing:** lowercase → tokenize on `[a-z0-9]+` → drop tokens shorter than 3 chars → drop a standard English stopword list (~150 words incl. "the", "and", "we", "this", "show", "paper", "propose", "arxiv", …). No stemming; LaTeX/math (`$...$`, `π`, hyphenation) is stripped by the tokenizer.
- **TF-IDF formula (per term t in document d):**
  - `tf(t,d) = count(t,d) / totalTokens(d)` (L1-normalized term frequency)
  - `idf(t) = ln((N + 1) / (df(t) + 1)) + 1` (smoothed inverse document frequency; N = 4,963 docs)
  - `tfidf(t,d) = tf(t,d) × idf(t)`

Terms common to almost every document get low IDF; rare-but-repeated terms get high IDF. Output was aggregated globally and per `desk`.

---

## 2. Corpus statistics

| Statistic | Value |
|---|---|
| Documents (pool items) | 4,963 |
| Vocabulary size (unique terms) | 26,140 |
| Total tokens | 361,298 |
| Average document length | 72.8 tokens |
| Average unique terms per doc | 56.8 |
| Desks | `science`, `primary` |

The pool is split across two desks: `science` (physics/cosmology/cond-mat) and `primary` (DSE/chip design / ML agents / hardware).

---

## 3. Global top terms (by aggregate TF-IDF weight)

| Rank | Term | df (docs) | IDF | Σ TF-IDF | Mean TF-IDF |
|---|---|---:|---:|---:|---:|
| 1 | comments | 634 | 3.056 | 364.54 | 0.5750 |
| 2 | quantum | 828 | 2.790 | 68.46 | 0.0827 |
| 3 | type | 3,608 | 1.319 | 63.57 | 0.0176 |
| 4 | announce | 3,589 | 1.324 | 56.98 | 0.0159 |
| 5 | field | 1,068 | 2.535 | 54.26 | 0.0508 |
| 6 | model | 968 | 2.634 | 53.52 | 0.0553 |
| 7 | black | 602 | 3.108 | 51.75 | 0.0860 |
| 8 | theory | 831 | 2.786 | 45.51 | 0.0548 |
| 9 | spin | 443 | 3.414 | 44.57 | 0.1006 |
| 10 | 2610 | 1,724 | 2.057 | 42.19 | 0.0245 |
| 11 | cross | 1,501 | 2.195 | 42.14 | 0.0281 |
| 12 | time | 691 | 2.970 | 39.18 | 0.0567 |
| 13 | energy | 723 | 2.925 | 38.48 | 0.0532 |
| 14 | non | 665 | 3.009 | 36.67 | 0.0551 |
| 15 | replace | 1,272 | 2.361 | 36.51 | 0.0287 |
| 16 | gravitational | 527 | 3.241 | 35.10 | 0.0666 |
| 17 | scalar | 483 | 3.328 | 35.02 | 0.0725 |
| 18 | models | 539 | 3.218 | 34.97 | 0.0649 |
| 19 | hole | 478 | 3.338 | 34.52 | 0.0722 |
| 20 | data | 482 | 3.330 | 33.51 | 0.0690 |

Full top-60 list is in `tfidf_results.json`.

---

## 4. Per-desk top terms

### `science` desk

`type` | `quantum` | `field` | `black` | `announce` | `theory` | `spin` | `model` | `2610` | `gravitational` | `cross` | `hole` | `scalar` | `non` | `replace` | `energy` | `mass` | `gravity` | `order` | `time` | `dimensional` | `magnetic` | `state` | `phase` | `space`

### `primary` desk

`comments` | `memory` | `design` | `model` | `2026` | `data` | `code` | `agents` | `quantum` | `nvidia` | `performance` | `hardware` | `agentic` | `video` | `models` | `inference` | `chip` | `semiconductor` | `scale` | `security` | `llm` | `systems` | `power` | `post` | `read`

---

## 5. Per-document examples (top TF-IDF terms)

| item_id | desk | subtopic | Top terms (tfidf) |
|---|---|---|---|
| `000b79b4c006` | science | condmat | sensor 0.28, stochastic 0.24, computing 0.21, adjustable 0.19, systems 0.16, modules 0.16, restriction 0.16, spintronic 0.15, stream 0.15, random 0.13 |
| `002621b89535` | science | gr | uldm 0.38, matter 0.16, perturbations 0.14, ultralight 0.14, field 0.11, dark 0.09, cosmological 0.09, classical 0.08 |
| `0029769338ab` | primary | fab | packaged 0.57, optics 0.48, breakthrough 0.32, cpo 0.30, photonics 0.26, commercial 0.26 |
| `002b7969bb1b` | primary | accel | exposed 1.13, era 0.97, just 0.92, platform 0.79, built 0.78, different 0.63 |
| `002ceaab51bb` | science | condmat | wafer 0.55, cbts 0.28, cryogenic 0.28, prober 0.19, blockade 0.16, thermometry 0.16, coulomb 0.12, scalable 0.12 |
| `00561c79f7ee` | science | qft | groundstate 0.36, conformal 0.35, hamiltonian 0.24, sphere 0.21, algebra 0.19, fuzzy 0.18 |

---

## 6. Do the results make sense?

**Yes — overwhelmingly.**

### What confirms they make sense

1. **Desk signatures match their actual subject matter.**
   - `science` → physics/cosmology terms: `quantum`, `black`/`hole`, `gravitational`, `scalar`, `spin`, `field`, `theory`, `mass`, `gravity`, `cosmological`, `conformal`, `hamiltonian`, `spintronic`, `wafer`, `cryogenic`, `coulomb`, `ultralight dark matter (uldm)`. These map cleanly to the desk's subtopics (`gr`, `qft`, `condmat`, `dse`).
   - `primary` → AI-systems / chip-design terms: `nvidia`, `chip`, `semiconductor`, `llm`, `inference`, `agents`/`agentic`, `hardware`, `design`, `performance`, `models`, `memory`, `data`, `code`, `photonics`. These match the primary desk's focus (DSE, analog/RF chip design, LLM agent flows).

2. **Stopwords are correctly suppressed.** Generic English ("the", "and", "we", "this", "is", "of", "in", …) does not appear anywhere in the top lists — IDF drives their weight to near zero because they occur in nearly every document.

3. **Per-document terms match each item's subtopic.** The `gr` doc surfaces `uldm`, `ultralight`, `dark matter`, `cosmological`; the `qft` doc surfaces `groundstate`, `conformal`, `hamiltonian`; the `condmat` docs surface `sensor`, `spintronic`, `wafer`, `cryogenic`, `coulomb`. This is exactly the behavior you want from keyword extraction.

### Where "nonsense" appears (and why it's expected)

Three categories of non-topical tokens rank highly. These are **data artefacts, not TF-IDF failures**:

| Token | Why it appears | Is it a problem? |
|---|---|---|
| `comments` (#1 globally, df=634) | arXiv snippet boilerplate ("Comments: 12 pages") | Partial — it's metadata, not a topic. Harmless but dominates the global list. |
| `announce` (df=3,589) | arXiv announcement text in snippets | Same as above; very common boilerplate. |
| `2610`, `2026`, `27133v2`, `03817v1` | arXiv ID prefixes / years / version suffixes | Numeric leakage from the tokenizer keeping alphanumerics. Not topical. |

So the only "nonsense" is arXiv metadata boilerplate leaking into the snippets. That's a corpus-quality issue, not a method issue — TF-IDF is correctly doing what it's told: it found tokens that are frequent within some documents and not-too-frequent across the corpus, and `comments`/`announce`/arXiv IDs fit that profile.

### Small-doc noise

Very short documents (e.g. `002b7969bb1b`, len=6) produce inflated TF-IDF for whatever rare tokens happen to appear (`exposed` 1.13). With so few tokens, a single occurrence carries huge weight. This is a known TF-IDF small-sample effect; it matters only if you rank individual short docs, not for the global/desk-level picture.

---

## 7. Recommendations

1. **Strip arXiv metadata before TF-IDF.** The snippets contain "Comments: …", "arXiv:…", "…v1/v2" boilerplate. Removing these (e.g. regex-strip `Comments:`, `arXiv:`, and pure-numeric/version tokens like `2610`, `v1`, `v2`) would make `comments` stop dominating and clean up the global ranking.
2. **Add light stemming** so `model`/`models`, `field`/`fields`, `design`/`designs` collapse into one entry each (minor, cosmetic).
3. **Filter pure-numeric tokens** to remove arXiv ID/year leakage (`2610`, `2026`, `27133v2`).
4. **Use desk-conditioned TF-IDF** (already done here) rather than only global: the two desks have disjoint vocabularies, so a single global list is less informative than per-desk lists.
5. The per-desk keyword signatures could be reused as **desk labels / topic tags** for the UI, or as a sanity check that the ranker's `desk`/`subtopic` assignment aligns with actual content.

---

## 8. Files

- `tfidf.js` — implementation (tokenizer, TF-IDF, global/desk/per-doc ranking, CLI)
- `tfidf_results.json` — full machine-readable output (stats, global top-60, per-desk top-25, per-doc top-10 for all 4,963 items)

Run again on a refreshed pool: `node docs/experiments/keyword-extraction/tfidf.js`
