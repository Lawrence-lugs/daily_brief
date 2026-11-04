// Tiny vector helpers. All embeddings are L2-normalised Float32Array(dim), so cosine = dot. dim depends on the model (embedder.js embeddingOf).
export const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
export function normalize(v) {
  const n = Math.sqrt(dot(v, v)) || 1;
  const o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) o[i] = v[i] / n;
  return o;
}
// node:sqlite gives BLOBs back as Uint8Array views that may be unaligned -> always copy.
export const toBlob = (f32) => new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
export const fromBlob = (u8) => new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
export const cosDist = (a, b) => 1 - dot(a, b);

export const DIM = 384;
// Throws unless v is a finite, unit-norm Float32Array of length dim. A wrong-shape vector would otherwise
// make dot() return 0 silently, so every cluster looks equally far away.
export function assertVec(v, dim, id) {
  if (!(v instanceof Float32Array) || v.length !== dim) {
    const got = v instanceof Float32Array ? `Float32Array(${v.length})` : typeof v;
    throw new Error(`bad vector for ${id}: expected Float32Array(${dim}), got ${got}`);
  }
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i])) throw new Error(`non-finite element ${i} in vector for ${id}`);
    s += v[i] * v[i];
  }
  const norm = Math.sqrt(s);
  if (Math.abs(norm - 1) > 1e-3) throw new Error(`vector for ${id} is not unit-norm (norm=${norm})`);
  return v;
}
