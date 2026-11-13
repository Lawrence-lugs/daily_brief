// Multi-model embedder. Default (bge-micro, q8) matches the old bge-embedding/embed.js vectors.
// `@huggingface/transformers` (which transitively pulls the `sharp` native binding) is loaded
// lazily inside `load()` so that importing this module does not load sharp at process startup.
// sharp's prebuilt native binding is compiled for the host Node ABI and does not load under
// Electron on Linux (ABI mismatch); deferring the import keeps the packed app launchable there.
import { createHash } from 'node:crypto';

const BGE_Q = 'Represent this sentence for searching relevant passages: ';

// leaf-mt: the ONNX encoder emits 384-d; its sentence-transformers Dense head (384 -> 1024, no bias) is applied after mean pooling.
export const MODELS = {
  'bge-micro': { id: 'TaylorAI/bge-micro-v2',                  dim: 384,  pooling: 'mean', maxTokens: 512, loader: 'pipeline', dtype: 'q8' },
  'leaf-mt':   { id: 'MongoDB/mdbr-leaf-mt',                   dim: 1024, pooling: 'mean', maxTokens: 512, loader: 'automodel', dtype: 'fp32', dense: '2_Dense/model.safetensors' },
  'bge-small': { id: 'onnx-community/bge-small-en-v1.5-ONNX', dim: 384,  pooling: 'cls',  maxTokens: 512, loader: 'pipeline', dtype: 'fp32', queryPrefix: BGE_Q },
  'bge-base':  { id: 'onnx-community/bge-base-en-v1.5-ONNX',  dim: 768,  pooling: 'cls',  maxTokens: 512, loader: 'pipeline', dtype: 'fp32', queryPrefix: BGE_Q },
  'mpnet':     { id: 'Xenova/all-mpnet-base-v2',               dim: 768,  pooling: 'mean', maxTokens: 384, loader: 'pipeline', dtype: 'fp32' },
};
export const DEFAULT_MODEL = 'bge-micro';

const keyById = new Map(Object.entries(MODELS).map(([k, v]) => [v.id, k]));

/** Accepts a registry key, a registry HF id, or any other HF id (dim auto-detected, mean pooling). */
export function resolveModel(nameOrId = DEFAULT_MODEL) {
  const key = MODELS[nameOrId] ? nameOrId : keyById.get(nameOrId);
  if (key) return { key, queryPrefix: '', ...MODELS[key] };
  return { key: nameOrId, id: nameOrId, dim: null, pooling: 'mean', maxTokens: 512,
           loader: 'pipeline', dtype: 'q8', queryPrefix: '' };
}
export const dimOf = (model) => resolveModel(model).dim;
export const DIM = dimOf(DEFAULT_MODEL); // legacy export; prefer embeddingOf(cfg).dim
export const modelTag = ({ model = DEFAULT_MODEL, dtype } = {}) => {
  const s = resolveModel(model);
  return `${s.key}:${dtype ?? s.dtype}`;
};

/**
 * Resolved settings for config.ranker = { embedding?: { model?, dtype?, dim? } }.
 * `dim` in config is only needed for HF ids outside the registry.
 * `tag` is stored in embeddings.model so vectors from different models are never mixed.
 */
export function embeddingOf(cfg = {}) {
  const e = cfg.embedding ?? {};
  const model = e.model ?? DEFAULT_MODEL;
  const dim = resolveModel(model).dim ?? e.dim;
  if (!dim) throw new Error(`embedding model ${model}: dimension unknown, set ranker.embedding.dim`);
  const dtype = e.dtype ?? resolveModel(model).dtype;
  return { model, dtype, dim, tag: modelTag({ model, dtype }) };
}

// ---- loading (cached per model+dtype+device; failed loads are evicted) ----
const loaded = new Map();
async function load(spec, dtype, device) {
  // Lazy import: `@huggingface/transformers` pulls the `sharp` native binding, which
  // only needs to be present when embeddings are actually computed (not at startup).
  const { pipeline, AutoTokenizer, AutoModel } = await import('@huggingface/transformers');
  const k = `${spec.id}|${dtype}|${device ?? ''}`;
  if (!loaded.has(k)) {
    const opts = { dtype, ...(device && { device }) };
    const p = spec.loader === 'automodel'
      ? Promise.all([AutoTokenizer.from_pretrained(spec.id), AutoModel.from_pretrained(spec.id, opts), spec.dense ? loadDense(spec) : null])
          .then(([tokenizer, model, dense]) => ({ tokenizer, model, dense }))
      : pipeline('feature-extraction', spec.id, opts);
    loaded.set(k, p.catch((e) => { loaded.delete(k); throw e; }));
  }
  return loaded.get(k);
}

// Reads the single F32 [out, in] matrix of a safetensors file from the Hub (the Dense layer has no bias).
async function loadDense(spec) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let buf;
  try {
    const res = await fetch(`https://huggingface.co/${spec.id}/resolve/main/${spec.dense}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`fetch ${spec.dense} for ${spec.id}: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
  return parseDense(buf, spec);
}

// Parses the safetensors buffer into { W, rows, cols }.
function parseDense(buf, spec) {
  const headerLen = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.subarray(8, 8 + headerLen).toString('utf8'));
  const name = Object.keys(header).find((k) => k !== '__metadata__');
  const { dtype, shape, data_offsets: [start, end] } = header[name];
  if (dtype !== 'F32' || shape.length !== 2) throw new Error(`${spec.id}: unexpected dense tensor ${name} (${dtype} [${shape}])`);
  const base = 8 + headerLen;
  const W = new Float32Array(buf.buffer.slice(buf.byteOffset + base + start, buf.byteOffset + base + end));
  return { W, rows: shape[0], cols: shape[1] };
}

// ---- helpers ----
function l2(v) {
  let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1; for (let i = 0; i < v.length; i++) v[i] /= s;
  return v;
}

function project({ W, rows, cols }, x) {
  const y = new Float32Array(rows);
  for (let i = 0; i < rows; i++) {
    let s = 0; const off = i * cols;
    for (let j = 0; j < cols; j++) s += W[off + j] * x[j];
    y[i] = s;
  }
  return y;
}

async function embedBatchAuto(h, spec, slice) {
  const inputs = h.tokenizer(slice, { padding: true, truncation: true, max_length: spec.maxTokens });
  const { last_hidden_state: hidden } = await h.model(inputs);
  if (!hidden || !hidden.dims) throw new Error(`${spec.key}: AutoModel output missing last_hidden_state.dims`);
  const [B, T, H] = hidden.dims;
  const hs = hidden.data, mask = inputs.attention_mask.data;
  return Array.from({ length: B }, (_, b) => {
    const acc = new Float32Array(H);
    if (spec.pooling === 'cls') acc.set(hs.subarray(b * T * H, b * T * H + H));
    else {
      let n = 0;
      for (let t = 0; t < T; t++) {
        if (Number(mask[b * T + t]) === 0) continue;
        n++; const off = (b * T + t) * H;
        for (let i = 0; i < H; i++) acc[i] += hs[off + i];
      }
      for (let i = 0; i < H; i++) acc[i] /= n || 1;
    }
    return l2(h.dense ? project(h.dense, acc) : acc);
  });
}

async function embedBatch(h, spec, slice) {
  if (spec.loader === 'automodel') return embedBatchAuto(h, spec, slice);
  const t = await h(slice, { pooling: spec.pooling, normalize: true });
  const dim = t.dims.at(-1);
  return slice.map((_, j) => Float32Array.from(t.data.subarray(j * dim, (j + 1) * dim)));
}

/**
 * @param {string[]} texts
 * @param {number | {model?: string, dtype?: string, device?: string, batch?: number, kind?: 'doc'|'query'}} opts
 *        (a bare number is treated as batch size, as in the old signature)
 * @returns {Promise<Float32Array[]>} unit-norm vectors, same order as `texts`
 */
export async function embedTexts(texts, opts = {}) {
  if (typeof opts === 'number') opts = { batch: opts };
  const { model = DEFAULT_MODEL, batch = 16, kind = 'doc', device } = opts;
  const spec = resolveModel(model);
  const dtype = opts.dtype ?? spec.dtype;
  const h = await load(spec, dtype, device);
  const pre = kind === 'query' ? spec.queryPrefix : '';
  const out = [];
  for (let i = 0; i < texts.length; i += batch) {
    const slice = texts.slice(i, i + batch).map((t) => pre + t);
    const vecs = await embedBatch(h, spec, slice);
    if (spec.dim && vecs[0].length !== spec.dim)
      throw new Error(`${spec.key}: got dim ${vecs[0].length}, expected ${spec.dim} (wrong output head/pooling?)`);
    out.push(...vecs);
  }
  return out;
}

export const textOf = (title, snippet) => `${title ?? ''} ${snippet ?? ''}`.trim() || '(no text)';
/** Pass modelTag(opts) as `tag` to keep caches from mixing models; omitted → identical to old hashes. */
export const textHash = (s, tag = '') =>
  createHash('sha1').update(tag ? `${tag}\u0000${s}` : s).digest('hex').slice(0, 12);
