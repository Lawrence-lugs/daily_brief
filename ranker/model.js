// Replaceable scoring model. Contract (all a replacement has to implement):
//   fit(examples, {scaleSample})      examples: [{keys:string[], vals:number[], y:0|1, weight?:number}]
//   predict(keys, vals) -> {p, mu, var}
//   toJSON() / static fromJSON(obj, cfg)
// SparseBayesLogReg: logistic regression with an independent Gaussian prior N(mean_j, 1/prec_j) per feature,
// MAP via cyclic coordinate Newton with a per-coordinate trust region (Genkin/Lewis/Madigan "BBR"),
// diagonal Laplace posterior, probit-approximated predictive mean.
// Cost per sweep is O(nnz), so thousands of one-hot author features are fine (a dense Hessian would not be).

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const isNum = (k) => k.startsWith('n:');

/** Later rules override earlier ones. match = exact key, or a prefix when it ends with ':' */
export function priorFor(key, prior) {
  let out = prior.default;
  for (const r of prior.rules ?? []) {
    if (key === r.match || (r.match.endsWith(':') && key.startsWith(r.match))) out = { ...prior.default, ...r };
  }
  return { prec: out.prec, mean: out.mean ?? 0 };
}

export class SparseBayesLogReg {
  constructor(cfg) {
    this.cfg = { maxSweeps: 60, tol: 1e-4, numDefault: { mean: 0, std: 1 }, ...cfg };
    this.index = new Map(); this.w = new Float64Array(0); this.prec = new Float64Array(0); this.stats = {};
  }

  _z(keys, vals) {
    return vals.map((v, t) => {
      if (!isNum(keys[t])) return v;
      const s = this.stats[keys[t]] ?? this.cfg.numDefault;
      return (v - s.mean) / s.std;
    });
  }

  /** @param {{scaleSample?: {keys:string[],vals:number[]}[]}} o  rows used for z-score stats (default: examples).
   *  Pass the *candidate pool* here: the scale of "distance to a medoid" should describe what we will score. */
  fit(examples, { scaleSample } = {}) {
    const acc = {};
    for (const ex of scaleSample ?? examples) ex.keys.forEach((k, t) => {
      if (!isNum(k)) return;
      const a = (acc[k] ??= { n: 0, s: 0, q: 0 }); a.n++; a.s += ex.vals[t]; a.q += ex.vals[t] ** 2;
    });
    this.stats = {};
    for (const [k, a] of Object.entries(acc)) {
      const mean = a.s / a.n;
      this.stats[k] = { mean, std: Math.sqrt(Math.max(a.q / a.n - mean * mean, 1e-6)) };
    }
    const keys = new Set(); for (const ex of examples) for (const k of ex.keys) keys.add(k);
    this.index = new Map([...keys].map((k, j) => [k, j]));
    const J = keys.size, N = examples.length;
    const lam = new Float64Array(J), mu = new Float64Array(J);
    for (const [k, j] of this.index) { const p = priorFor(k, this.cfg.prior); lam[j] = p.prec; mu[j] = p.mean; }

    const colR = Array.from({ length: J }, () => []), colX = Array.from({ length: J }, () => []);
    const y = new Float64Array(N), wt = new Float64Array(N);
    examples.forEach((ex, i) => {
      y[i] = ex.y; wt[i] = ex.weight ?? 1;
      const xs = this._z(ex.keys, ex.vals);
      ex.keys.forEach((k, t) => { const j = this.index.get(k); colR[j].push(i); colX[j].push(xs[t]); });
    });

    const w = Float64Array.from(mu), z = new Float64Array(N), trust = new Float64Array(J).fill(1);
    for (let j = 0; j < J; j++) for (let t = 0; t < colR[j].length; t++) z[colR[j][t]] += w[j] * colX[j][t];

    for (let sweep = 0; sweep < this.cfg.maxSweeps; sweep++) {
      let maxStep = 0;
      for (let j = 0; j < J; j++) {
        let g = lam[j] * (w[j] - mu[j]), h = lam[j];
        const R = colR[j], Xj = colX[j];
        for (let t = 0; t < R.length; t++) {
          const i = R[t], x = Xj[t], p = sigmoid(z[i]);
          g += wt[i] * x * (p - y[i]);
          h += wt[i] * x * x * Math.max(p * (1 - p), 1e-6);
        }
        let step = -g / h;
        step = Math.max(-trust[j], Math.min(trust[j], step));
        if (step !== 0) { for (let t = 0; t < R.length; t++) z[R[t]] += step * Xj[t]; w[j] += step; }
        trust[j] = Math.max(2 * Math.abs(step), trust[j] / 2);
        maxStep = Math.max(maxStep, Math.abs(step));
      }
      if (maxStep < this.cfg.tol) break;
    }
    // diagonal Laplace posterior precision at the MAP
    const prec = Float64Array.from(lam);
    for (let j = 0; j < J; j++) for (let t = 0; t < colR[j].length; t++) {
      const i = colR[j][t], p = sigmoid(z[i]);
      prec[j] += wt[i] * colX[j][t] ** 2 * Math.max(p * (1 - p), 1e-6);
    }
    this.w = w; this.prec = prec;
    return this;
  }

  /** Unknown keys (unseen author, cold start) fall back to their prior: mean weight, prior variance. */
  predict(keys, vals) {
    const xs = this._z(keys, vals);
    let m = 0, v = 0;
    keys.forEach((k, t) => {
      const j = this.index.get(k);
      let wj, pr;
      if (j === undefined) { const p = priorFor(k, this.cfg.prior); wj = p.mean; pr = p.prec; }
      else { wj = this.w[j]; pr = this.prec[j]; }
      m += wj * xs[t]; v += (xs[t] * xs[t]) / pr;
    });
    return { mu: m, var: v, p: sigmoid(m / Math.sqrt(1 + (Math.PI * v) / 8)) };
  }

  weights() { return [...this.index].map(([k, j]) => ({ key: k, w: this.w[j], sd: 1 / Math.sqrt(this.prec[j]) })); }

  toJSON() {
    const keys = [...this.index.keys()];
    return { stats: this.stats, keys, w: keys.map((k) => this.w[this.index.get(k)]), prec: keys.map((k) => this.prec[this.index.get(k)]) };
  }
  static fromJSON(o, cfg) {
    const m = new SparseBayesLogReg(cfg);
    m.stats = o.stats; m.index = new Map(o.keys.map((k, j) => [k, j]));
    m.w = Float64Array.from(o.w); m.prec = Float64Array.from(o.prec);
    return m;
  }
}
export const MODELS = { bayes_lr: SparseBayesLogReg };

/** Mann-Whitney AUC with tie handling. */
export function auc(scores, labels) {
  const idx = [...scores.keys()].sort((a, b) => scores[a] - scores[b]);
  let rankSum = 0, nPos = 0, i = 0;
  while (i < idx.length) {
    let j = i; while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (labels[idx[k]]) { rankSum += avg; nPos++; }
    i = j + 1;
  }
  const nNeg = idx.length - nPos;
  return nPos && nNeg ? (rankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg) : NaN;
}
export function logLoss(ps, ys) {
  let s = 0; ps.forEach((p, i) => { p = Math.min(1 - 1e-9, Math.max(1e-9, p)); s -= ys[i] ? Math.log(p) : Math.log(1 - p); });
  return s / ps.length;
}
