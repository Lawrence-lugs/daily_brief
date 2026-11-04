// Replaceable scoring models.
//
// Contract (all a replacement has to implement):
//   fit(examples, {scaleSample, onSweep})
//       examples: [{keys: string[], vals: number[], y: 0|1, weight?: number}]
//   predict(keys, vals) -> {p, mu, var}
//       p    probability that y = 1
//       mu   linear score (log-odds)
//       var  variance of that linear score (0 for point-estimate models)
//   toJSON() / static fromJSON(obj, cfg)
//
// Feature conventions (shared by every model in this file):
//   - An example is a sparse vector: parallel arrays `keys` and `vals`.
//     One-hot features (e.g. an author id) simply use val = 1.
//   - Keys that start with "n:" are numeric. They are z-scored before use, with the mean/std
//     estimated from `scaleSample` (default: the training examples). Unknown numeric keys at
//     predict time fall back to cfg.numDefault. All other keys are used as given.
//
// Models:
//   SparseBayesLogReg  Bayesian logistic regression: independent Gaussian prior per feature,
//                      MAP point estimate + diagonal Laplace posterior (gives predictive variance).
//   SparseLogReg       Non-Bayesian logistic regression: L2-penalised maximum likelihood.
//                      Point estimate only, no uncertainty (var is always 0).
//
// Both are fitted by the same solver: cyclic coordinate Newton with a per-coordinate trust region
// (Genkin/Lewis/Madigan "BBR"). Cost per sweep is O(nnz), so thousands of one-hot author features
// are fine (a dense Hessian would not be).

const sigmoid = (logit) => 1 / (1 + Math.exp(-logit));
const isNumericKey = (key) => key.startsWith('n:');

/** Floor on the logistic curvature p(1-p), so a saturated example cannot collapse a Newton denominator. */
const MIN_CURVATURE = 1e-6;
/** Floor on a numeric feature's variance, so a (near-)constant column does not blow up when z-scored. */
const MIN_FEATURE_VARIANCE = 1e-6;
/** Largest allowed first step (in weight units) for every coordinate. */
const INITIAL_TRUST_RADIUS = 1;
/** Probabilities are clipped to [EPS, 1 - EPS] before taking logs in logLoss. */
const PROBABILITY_EPS = 1e-9;

/** True if `key` equals `pattern`, or `pattern` ends with ':' and `key` starts with it (prefix match). */
function keyMatches(key, pattern) {
  return key === pattern || (pattern.endsWith(':') && key.startsWith(pattern));
}

/**
 * Resolve the Gaussian prior for one feature. Later rules override earlier ones.
 * @param {string} key
 * @param {{default: {prec: number, mean?: number}, rules?: {match: string, prec?: number, mean?: number}[]}} prior
 *   `match` is an exact key, or a prefix when it ends with ':' (e.g. "author:").
 * @returns {{prec: number, mean: number}} prior precision (1 / variance) and prior mean of the weight
 */
export function priorFor(key, prior) {
  let resolved = prior.default;
  for (const rule of prior.rules ?? []) {
    if (keyMatches(key, rule.match)) resolved = { ...prior.default, ...rule };
  }
  return { prec: resolved.prec, mean: resolved.mean ?? 0 };
}

/**
 * Mean and standard deviation of every numeric ("n:") feature over a set of rows.
 * @param {{keys: string[], vals: number[]}[]} rows
 * @returns {Object<string, {mean: number, std: number}>}
 */
function computeNumericScaling(rows) {
  const running = {};
  for (const row of rows) {
    row.keys.forEach((key, t) => {
      if (!isNumericKey(key)) return;
      const acc = (running[key] ??= { count: 0, sum: 0, sumSquares: 0 });
      acc.count++;
      acc.sum += row.vals[t];
      acc.sumSquares += row.vals[t] ** 2;
    });
  }
  const scaling = {};
  for (const [key, acc] of Object.entries(running)) {
    const mean = acc.sum / acc.count;
    const variance = Math.max(acc.sumSquares / acc.count - mean * mean, MIN_FEATURE_VARIANCE);
    scaling[key] = { mean, std: Math.sqrt(variance) };
  }
  return scaling;
}

/** Throws unless each named field of a serialised model is an array of `json.keys.length` finite numbers. */
function assertFiniteNumberArrays(json, fieldNames) {
  for (const name of fieldNames) {
    const values = json[name];
    const valid = Array.isArray(values)
      && values.length === json.keys.length
      && values.every((x) => typeof x === 'number' && Number.isFinite(x));
    if (!valid) throw new Error(`model JSON: ${name} must be ${json.keys.length} finite numbers`);
  }
}

/**
 * Machinery shared by the logistic regression models: feature standardisation, sparse design
 * construction and the coordinate Newton solver. Subclasses decide how weights are penalised
 * (`fit`) and how predictions are formed (`predict`).
 */
class SparseLogRegBase {
  /**
   * @param {object} cfg
   * @param {number} [cfg.maxSweeps=60]  maximum passes over all features
   * @param {number} [cfg.tol=1e-4]      stop when the largest weight change in a sweep is below this
   * @param {{mean: number, std: number}} [cfg.numDefault]  scaling used for numeric keys unseen in training
   */
  constructor(cfg) {
    this.cfg = { maxSweeps: 60, tol: 1e-4, numDefault: { mean: 0, std: 1 }, ...cfg };
    /** feature key -> position in `coef` */
    this.featureIndex = new Map();
    /** fitted weight per feature (on the standardised scale) */
    this.coef = new Float64Array(0);
    /** per numeric key: {mean, std} used for z-scoring */
    this.numericScaling = {};
    /** convergence / size diagnostics from the last fit */
    this.diag = null;
  }

  /** Z-score numeric features; pass everything else through unchanged. */
  _standardize(keys, vals) {
    return vals.map((val, t) => {
      if (!isNumericKey(keys[t])) return val;
      const scaling = this.numericScaling[keys[t]] ?? this.cfg.numDefault;
      return (val - scaling.mean) / scaling.std;
    });
  }

  /**
   * Index the features, estimate numeric scaling, and lay the data out column-wise (one list of
   * (example, value) pairs per feature) so a coordinate update only touches the examples that use it.
   * Sets `this.numericScaling` and `this.featureIndex`.
   */
  _buildDesign(examples, scaleSample) {
    this.numericScaling = computeNumericScaling(scaleSample ?? examples);

    const uniqueKeys = new Set();
    for (const example of examples) for (const key of example.keys) uniqueKeys.add(key);
    this.featureIndex = new Map([...uniqueKeys].map((key, j) => [key, j]));

    const nFeatures = uniqueKeys.size;
    const nExamples = examples.length;
    const columnExamples = Array.from({ length: nFeatures }, () => []); // example ids using feature j
    const columnValues = Array.from({ length: nFeatures }, () => []);   // standardised value in each of them
    const labels = new Float64Array(nExamples);
    const exampleWeights = new Float64Array(nExamples);

    examples.forEach((example, i) => {
      labels[i] = example.y;
      exampleWeights[i] = example.weight ?? 1;
      const standardized = this._standardize(example.keys, example.vals);
      example.keys.forEach((key, t) => {
        const j = this.featureIndex.get(key);
        columnExamples[j].push(i);
        columnValues[j].push(standardized[t]);
      });
    });

    let nonzeros = 0;
    for (const column of columnExamples) nonzeros += column.length;
    return { nFeatures, nExamples, columnExamples, columnValues, labels, exampleWeights, nonzeros };
  }

  /**
   * Minimise   sum_i weight_i * logloss_i  +  sum_j (penaltyPrecision_j / 2) * (coef_j - penaltyMean_j)^2
   * by cyclic coordinate Newton. Each coordinate takes a 1-D Newton step, clipped to a trust radius
   * that adapts to the size of that coordinate's recent steps.
   *
   * @param {object} design              output of `_buildDesign`
   * @param {Float64Array} penaltyPrecision  per-feature quadratic penalty strength (0 = unpenalised)
   * @param {Float64Array} penaltyMean       per-feature value the penalty pulls towards (also the start point)
   * @param {(info: {sweep: number, maxStep: number, trustHits: number}) => void} [onSweep]
   * @returns {{coef: Float64Array, logits: Float64Array,
   *            summary: {sweeps: number, converged: boolean, lastMaxStep: number, trustHits: number}}}
   *          `logits` holds each training example's final linear score.
   */
  _coordinateNewton(design, penaltyPrecision, penaltyMean, onSweep) {
    const { nFeatures, nExamples, columnExamples, columnValues, labels, exampleWeights } = design;
    const coef = Float64Array.from(penaltyMean);
    const logits = new Float64Array(nExamples);
    const trustRadius = new Float64Array(nFeatures).fill(INITIAL_TRUST_RADIUS);

    for (let j = 0; j < nFeatures; j++) {
      for (let t = 0; t < columnExamples[j].length; t++) logits[columnExamples[j][t]] += coef[j] * columnValues[j][t];
    }

    let sweeps = 0, totalTrustHits = 0, lastMaxStep = 0, converged = false;
    for (let sweep = 0; sweep < this.cfg.maxSweeps; sweep++) {
      let maxStep = 0, trustHitsThisSweep = 0;
      for (let j = 0; j < nFeatures; j++) {
        // First and second derivative of the penalised objective along coordinate j.
        let gradient = penaltyPrecision[j] * (coef[j] - penaltyMean[j]);
        let curvature = penaltyPrecision[j];
        const rows = columnExamples[j], values = columnValues[j];
        for (let t = 0; t < rows.length; t++) {
          const i = rows[t], x = values[t], prob = sigmoid(logits[i]);
          gradient += exampleWeights[i] * x * (prob - labels[i]);
          curvature += exampleWeights[i] * x * x * Math.max(prob * (1 - prob), MIN_CURVATURE);
        }

        // curvature can only be 0 for an unpenalised feature that is zero in every example: nothing to update.
        const newtonStep = curvature > 0 ? -gradient / curvature : 0;
        if (Math.abs(newtonStep) > trustRadius[j]) trustHitsThisSweep++;
        const step = Math.max(-trustRadius[j], Math.min(trustRadius[j], newtonStep));

        if (step !== 0) {
          for (let t = 0; t < rows.length; t++) logits[rows[t]] += step * values[t];
          coef[j] += step;
        }
        trustRadius[j] = Math.max(2 * Math.abs(step), trustRadius[j] / 2);
        maxStep = Math.max(maxStep, Math.abs(step));
      }
      sweeps = sweep + 1;
      totalTrustHits += trustHitsThisSweep;
      lastMaxStep = maxStep;
      onSweep?.({ sweep, maxStep, trustHits: trustHitsThisSweep });
      if (maxStep < this.cfg.tol) { converged = true; break; }
    }
    return { coef, logits, summary: { sweeps, converged, lastMaxStep, trustHits: totalTrustHits } };
  }

  /** Weight used for a feature that was not seen in training. Subclasses define it. */
  _unseenCoef(_key) { throw new Error('not implemented'); }

  /** Restore state shared by all models from their serialised form. */
  _restore(json) {
    this.numericScaling = json.stats;
    this.featureIndex = new Map(json.keys.map((key, j) => [key, j]));
    this.coef = Float64Array.from(json.w);
  }

  /** Per-feature contributions to the linear score (diagnostics only). */
  explain(keys, vals) {
    const standardized = this._standardize(keys, vals);
    return keys.map((key, t) => {
      const j = this.featureIndex.get(key);
      const coef = j === undefined ? this._unseenCoef(key) : this.coef[j];
      return { key, x: standardized[t], w: coef, c: coef * standardized[t] };
    });
  }

  /** Throws if any weight is NaN or infinite, so a broken fit is never persisted. */
  assertFinite() {
    const keys = [...this.featureIndex.keys()];
    for (let j = 0; j < this.coef.length; j++) {
      if (!Number.isFinite(this.coef[j])) throw new Error(`non-finite model parameter for ${keys[j]}: w=${this.coef[j]}`);
    }
    return this;
  }

  /** @deprecated Use `featureIndex` instead. Backward compatibility for tests. */
  get index() { return this.featureIndex; }

  /** @deprecated Use `coef` instead. Backward compatibility for tests. */
  get w() { return this.coef; }

  /** @deprecated Use `posteriorPrecision` instead. Backward compatibility for tests. */
  get prec() { return this.posteriorPrecision ?? new Float64Array(this.coef.length); }
}

/**
 * Bayesian logistic regression.
 *
 * Each weight has an independent Gaussian prior N(mean_j, 1 / prec_j) (see `priorFor`). We take the MAP
 * estimate, then approximate the posterior by a diagonal Gaussian (Laplace approximation). Predictions
 * integrate over that posterior with the probit approximation, so uncertain scores are shrunk towards 0.5.
 *
 * cfg.prior: {default: {prec, mean?}, rules?: [{match, prec?, mean?}]}   (required)
 */
export class SparseBayesLogReg extends SparseLogRegBase {
  constructor(cfg) {
    super(cfg);
    /** diagonal of the Laplace posterior precision, one entry per feature */
    this.posteriorPrecision = new Float64Array(0);
  }

  /**
   * @param {{keys: string[], vals: number[], y: 0|1, weight?: number}[]} examples
   * @param {object} [options]
   * @param {{keys: string[], vals: number[]}[]} [options.scaleSample]  rows used for z-score statistics
   *   (default: examples). Pass the *candidate pool* here: the scale of "distance to a medoid" should
   *   describe what we will score.
   * @param {Function} [options.onSweep]  called after every sweep with {sweep, maxStep, trustHits}
   */
  fit(examples, { scaleSample, onSweep } = {}) {
    const design = this._buildDesign(examples, scaleSample);

    const priorPrecision = new Float64Array(design.nFeatures);
    const priorMean = new Float64Array(design.nFeatures);
    for (const [key, j] of this.featureIndex) {
      const prior = priorFor(key, this.cfg.prior);
      priorPrecision[j] = prior.prec;
      priorMean[j] = prior.mean;
    }

    const { coef, logits, summary } = this._coordinateNewton(design, priorPrecision, priorMean, onSweep);

    // Diagonal Laplace posterior precision at the MAP: prior precision + data curvature.
    const posteriorPrecision = Float64Array.from(priorPrecision);
    for (let j = 0; j < design.nFeatures; j++) {
      for (let t = 0; t < design.columnExamples[j].length; t++) {
        const i = design.columnExamples[j][t], prob = sigmoid(logits[i]);
        posteriorPrecision[j] += design.exampleWeights[i] * design.columnValues[j][t] ** 2 * Math.max(prob * (1 - prob), MIN_CURVATURE);
      }
    }

    this.coef = coef;
    this.posteriorPrecision = posteriorPrecision;
    const nFeatures = design.nFeatures;
    this.diag = {
      ...summary,
      nnz: design.nonzeros,
      features: nFeatures,
      examples: design.nExamples,
      precMin: nFeatures ? posteriorPrecision.reduce((a, b) => Math.min(a, b), Infinity) : null,
      precMax: nFeatures ? posteriorPrecision.reduce((a, b) => Math.max(a, b), -Infinity) : null,
    };
    return this;
  }

  /** Unknown keys (unseen author, cold start) fall back to their prior: mean weight, prior variance. */
  _unseenCoef(key) { return priorFor(key, this.cfg.prior).mean; }

  /** @returns {{p: number, mu: number, var: number}} probability, linear-score mean, linear-score variance */
  predict(keys, vals) {
    const standardized = this._standardize(keys, vals);
    let scoreMean = 0, scoreVariance = 0;
    keys.forEach((key, t) => {
      const j = this.featureIndex.get(key);
      let coef, precision;
      if (j === undefined) {
        const prior = priorFor(key, this.cfg.prior);
        coef = prior.mean; precision = prior.prec;
      } else {
        coef = this.coef[j]; precision = this.posteriorPrecision[j];
      }
      scoreMean += coef * standardized[t];
      scoreVariance += (standardized[t] * standardized[t]) / precision;
    });
    // Probit approximation to E[sigmoid(score)] when score ~ N(scoreMean, scoreVariance).
    const p = sigmoid(scoreMean / Math.sqrt(1 + (Math.PI * scoreVariance) / 8));
    return { mu: scoreMean, var: scoreVariance, p };
  }

  /** Throws if any weight or posterior precision is NaN or infinite, so a broken fit is never persisted. */
  assertFinite() {
    const keys = [...this.featureIndex.keys()];
    for (let j = 0; j < this.coef.length; j++) {
      if (!Number.isFinite(this.coef[j]) || !Number.isFinite(this.posteriorPrecision[j])) {
        throw new Error(`non-finite model parameter for ${keys[j]}: w=${this.coef[j]} prec=${this.posteriorPrecision[j]}`);
      }
    }
    return this;
  }

  /** @returns {{key: string, w: number, sd: number}[]} posterior mean and standard deviation per weight */
  weights() {
    return [...this.featureIndex].map(([key, j]) => ({ key, w: this.coef[j], sd: 1 / Math.sqrt(this.posteriorPrecision[j]) }));
  }

  // Serialised field names (stats, keys, w, prec) are kept as-is so previously saved models still load.
  toJSON() {
    const keys = [...this.featureIndex.keys()];
    return {
      stats: this.numericScaling,
      keys,
      w: keys.map((key) => this.coef[this.featureIndex.get(key)]),
      prec: keys.map((key) => this.posteriorPrecision[this.featureIndex.get(key)]),
    };
  }

  static fromJSON(json, cfg) {
    assertFiniteNumberArrays(json, ['w', 'prec']);
    const model = new SparseBayesLogReg(cfg);
    model._restore(json);
    model.posteriorPrecision = Float64Array.from(json.prec);
    return model;
  }
}

/**
 * Non-Bayesian logistic regression: L2-penalised maximum likelihood.
 *
 * Minimises   sum_i weight_i * logloss_i  +  (l2Strength / 2) * sum_j coef_j^2
 * and keeps just the minimiser: a single weight vector with no posterior, so there is no uncertainty
 * estimate (predict() returns var = 0 and p = sigmoid(mu)). Features whose key matches `unpenalizedKeys`
 * (e.g. an intercept) skip the penalty.
 *
 * Why penalise at all? With thousands of one-hot features, unpenalised maximum likelihood is ill-posed:
 * any author whose examples are all positive (or all negative) has an infinite optimal weight. A small
 * l2Strength keeps the solution finite while staying close to plain maximum likelihood. Setting
 * l2Strength = 0 gives plain maximum likelihood, which will not converge on such data (it stops at maxSweeps).
 *
 * cfg.l2Strength       {number}   penalty strength, >= 0 (default 0.01)
 * cfg.unpenalizedKeys  {string[]} exact keys, or prefixes ending in ':', exempt from the penalty (default [])
 */
export class SparseLogReg extends SparseLogRegBase {
  constructor(cfg) {
    super({ l2Strength: 0.01, unpenalizedKeys: [], ...cfg });
  }

  /**
   * @param {{keys: string[], vals: number[], y: 0|1, weight?: number}[]} examples
   * @param {object} [options]
   * @param {{keys: string[], vals: number[]}[]} [options.scaleSample]  rows used for z-score statistics (default: examples)
   * @param {Function} [options.onSweep]  called after every sweep with {sweep, maxStep, trustHits}
   */
  fit(examples, { scaleSample, onSweep } = {}) {
    const design = this._buildDesign(examples, scaleSample);

    const penaltyPrecision = new Float64Array(design.nFeatures);
    const penaltyMean = new Float64Array(design.nFeatures); // zeros: shrink towards no effect
    for (const [key, j] of this.featureIndex) {
      const exempt = this.cfg.unpenalizedKeys.some((pattern) => keyMatches(key, pattern));
      penaltyPrecision[j] = exempt ? 0 : this.cfg.l2Strength;
    }

    const { coef, summary } = this._coordinateNewton(design, penaltyPrecision, penaltyMean, onSweep);
    this.coef = coef;
    this.diag = { ...summary, nnz: design.nonzeros, features: design.nFeatures, examples: design.nExamples };
    return this;
  }

  /** A feature never seen in training contributes nothing. */
  _unseenCoef(_key) { return 0; }

  /** @returns {{p: number, mu: number, var: number}} var is always 0: a point estimate has no uncertainty */
  predict(keys, vals) {
    const standardized = this._standardize(keys, vals);
    let logOdds = 0;
    keys.forEach((key, t) => {
      const j = this.featureIndex.get(key);
      logOdds += (j === undefined ? this._unseenCoef(key) : this.coef[j]) * standardized[t];
    });
    return { mu: logOdds, var: 0, p: sigmoid(logOdds) };
  }

  /** @returns {{key: string, w: number, sd: number}[]} sd is always 0 (same shape as SparseBayesLogReg) */
  weights() {
    return [...this.featureIndex].map(([key, j]) => ({ key, w: this.coef[j], sd: 0 }));
  }

  toJSON() {
    const keys = [...this.featureIndex.keys()];
    return {
      stats: this.numericScaling,
      keys,
      w: keys.map((key) => this.coef[this.featureIndex.get(key)]),
    };
  }

  static fromJSON(json, cfg) {
    assertFiniteNumberArrays(json, ['w']);
    const model = new SparseLogReg(cfg);
    model._restore(json);
    return model;
  }
}

/**
 * Keyword baseline model.
 *
 * Uses the 'rel' (relevance) score from the candidate pool directly as the probability.
 * No fitting required - it's a static baseline. The 'rel' feature must be present in the
 * feature vector (enabled via cfg.features including "keyword" or similar).
 *
 * cfg: { relKey?: string }  -- feature key to use as rel score (default: "rel")
 */
export class KeywordModel {
  constructor(cfg = {}) {
    this.cfg = { relKey: 'rel', ...cfg };
    this.featureIndex = new Map();
    this.coef = new Float64Array(0);
    this.numericScaling = {};
    this.diag = { sweeps: 0, converged: true, features: 0, examples: 0, nnz: 0 };
  }

  /** No-op: keyword model has no learnable parameters. */
  fit(_examples, _options = {}) {
    // No training needed; rel score comes from candidate_pool.rel
    return this;
  }

  /**
   * Predict using the rel feature as probability.
   * @returns {{p: number, mu: number, var: number}} p = rel (clipped), mu = logit(p), var = 0
   */
  predict(keys, vals) {
    // Find the rel feature
    let rel = 0.5; // default neutral
    for (let t = 0; t < keys.length; t++) {
      if (keys[t] === this.cfg.relKey) {
        rel = vals[t];
        break;
      }
    }
    // Clip to valid probability range
    const p = Math.min(1 - PROBABILITY_EPS, Math.max(PROBABILITY_EPS, rel));
    const mu = Math.log(p / (1 - p)); // logit
    return { mu, var: 0, p };
  }

  /** Always returns empty - no weights to inspect. */
  weights() { return []; }

  /** Explain contributions - only the rel feature matters. */
  explain(keys, vals) {
    return keys.map((key, t) => {
      if (key === this.cfg.relKey) {
        const p = Math.min(1 - PROBABILITY_EPS, Math.max(PROBABILITY_EPS, vals[t]));
        const mu = Math.log(p / (1 - p));
        return { key, x: vals[t], w: 1, c: mu };
      }
      return { key, x: vals[t], w: 0, c: 0 };
    });
  }

  assertFinite() { return this; }

  /** @deprecated Use `featureIndex` instead. Backward compatibility. */
  get index() { return this.featureIndex; }

  /** @deprecated Use `coef` instead. Backward compatibility. */
  get w() { return this.coef; }

  /** @deprecated Backward compatibility. */
  get prec() { return new Float64Array(this.coef.length); }

  toJSON() {
    return { type: 'keyword', relKey: this.cfg.relKey };
  }

  static fromJSON(json, cfg) {
    return new KeywordModel({ ...cfg, relKey: json.relKey });
  }
}

export const MODELS = {
  bayes_lr: SparseBayesLogReg,
  lr: SparseLogReg,
  keyword: KeywordModel,
};

/**
 * Area under the ROC curve via the Mann-Whitney rank-sum statistic, with tied scores sharing their average rank.
 * @param {number[]} scores  higher = more likely positive
 * @param {(0|1)[]} labels
 * @returns {number} AUC in [0, 1], or NaN if only one class is present
 */
export function auc(scores, labels) {
  const order = [...scores.keys()].sort((a, b) => scores[a] - scores[b]); // example ids, lowest score first
  let positiveRankSum = 0, positiveCount = 0, tieStart = 0;
  while (tieStart < order.length) {
    let tieEnd = tieStart;
    while (tieEnd + 1 < order.length && scores[order[tieEnd + 1]] === scores[order[tieStart]]) tieEnd++;
    const averageRank = (tieStart + tieEnd) / 2 + 1; // ranks are 1-based
    for (let k = tieStart; k <= tieEnd; k++) {
      if (labels[order[k]]) { positiveRankSum += averageRank; positiveCount++; }
    }
    tieStart = tieEnd + 1;
  }
  const negativeCount = order.length - positiveCount;
  if (!positiveCount || !negativeCount) return NaN;
  return (positiveRankSum - (positiveCount * (positiveCount + 1)) / 2) / (positiveCount * negativeCount);
}

/** Mean negative log-likelihood of binary labels under predicted probabilities (clipped away from 0 and 1). */
export function logLoss(probabilities, labels) {
  let totalLoss = 0;
  probabilities.forEach((prob, i) => {
    const clipped = Math.min(1 - PROBABILITY_EPS, Math.max(PROBABILITY_EPS, prob));
    totalLoss -= labels[i] ? Math.log(clipped) : Math.log(1 - clipped);
  });
  return totalLoss / probabilities.length;
}