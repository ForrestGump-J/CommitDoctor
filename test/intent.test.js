'use strict';
const test = require('node:test');
const assert = require('node:assert');
const model = require('../src/intent-model.json');
const { classify, preprocess } = require('../src/intent');

test('Node preprocessing matches the Python pipeline on every parity case', () => {
  for (const c of model.parity) assert.deepStrictEqual(preprocess(c.text), c.tokens, c.text);
});

test('Node classifier reproduces Python predictions and probabilities', () => {
  for (const c of model.parity) {
    const r = classify(c.text);
    assert.strictEqual(r.intent, c.pred, c.text);
    model.classes.forEach((cls, k) => assert.ok(Math.abs(r.proba[cls] - c.proba[k]) < 1e-3, `${c.text} ${cls}`));
  }
});

test('only the subject line is classified, and empty input is safe', () => {
  assert.strictEqual(classify('add tests for parser\n\nlong body about docs docs docs').intent, classify('add tests for parser').intent);
  assert.ok(classify('').intent);
  assert.ok(classify(null).intent);
});
