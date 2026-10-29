// Same model + settings as bge-embedding/embed.js, so vectors are interchangeable with embeddings.json.
import { pipeline } from '@xenova/transformers';
import { createHash } from 'node:crypto';

export const MODEL = 'TaylorAI/bge-micro-v2';
export const DIM = 384;
let extractor;

/** @returns {Promise<Float32Array[]>} unit-norm vectors, same order as `texts` */
export async function embedTexts(texts, batch = 16) {
  extractor ??= await pipeline('feature-extraction', MODEL);
  const out = [];
  for (let i = 0; i < texts.length; i += batch) {
    const slice = texts.slice(i, i + batch);
    const t = await extractor(slice, { pooling: 'mean', normalize: true });
    for (let j = 0; j < slice.length; j++) out.push(Float32Array.from(t.data.subarray(j * DIM, (j + 1) * DIM)));
  }
  return out;
}
export const textOf = (title, snippet) => `${title ?? ''} ${snippet ?? ''}`.trim() || '(no text)';
export const textHash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
