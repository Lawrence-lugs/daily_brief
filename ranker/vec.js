// Tiny vector helpers. All embeddings are L2-normalised Float32Array(384), so cosine = dot.
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
