// Tensor must be importable as a named ESM export from onnxruntime-common.
// The top-level onnxruntime-common@1.14.0 is orphaned (nothing in package.json depends on it)
// and lacks "type":"module" + an "exports" field, so ESM named imports resolve Tensor to undefined.
// The working onnxruntime-common@1.30.0 is nested under @huggingface/transformers/node_modules/;
// code importing onnxruntime-common from the project root gets the broken 1.14.0 instead.
import test from 'node:test';
import assert from 'node:assert/strict';

test('onnxruntime-common exports Tensor as a named ESM export', async () => {
  const ort = await import('onnxruntime-common');
  assert.ok(typeof ort.Tensor === 'function', 'onnxruntime-common should export Tensor as a function');
});
