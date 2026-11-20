'use strict';
/**
 * Commit-intent classifier (the NLP component).
 *
 * Labels each commit message as feature / fix / docs / refactor / test / chore.
 * The model is trained in Python (nlp/train.py: TF-IDF unigrams + bigrams,
 * L2-regularized logistic regression) and exported to src/intent-model.json;
 * this file re-implements only the inference side, so the app needs no Python.
 *
 * The preprocessing below must stay identical to nlp/preprocess.py
 * (variant "clean + normalize"). test/intent.test.js checks that it does.
 */
const model = require('./intent-model.json');

// --- 1. privacy -------------------------------------------------------------
const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const URL_RE = /https?:\/\/\S+/g;
const MENTION = /(?<![\w@])@[A-Za-z0-9-]{1,39}\b(?!\/)/g;

function scrubPii(text) {
  return text.replace(EMAIL, '<email>').replace(URL_RE, '<url>').replace(MENTION, '<user>');
}

// --- 2. cleaning --------------------------------------------------------------
function clean(text) {
  return text
    .replace(/`([^`]*)`/g, ' $1 ')
    .replace(/\(?#\d+\)?|\b(gh|GH)-\d+\b/g, ' ')
    .replace(/\b[0-9a-f]{7,40}\b/g, ' ')
    .replace(/[_./-]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- 3. normalization -----------------------------------------------------------
function normalize(text) {
  const out = [];
  for (const tok of text.toLowerCase().split(/\s+/)) {
    if (!tok) continue;
    const rep = Object.prototype.hasOwnProperty.call(model.normalize, tok) ? model.normalize[tok] : tok;
    if (rep) out.push(rep);
  }
  return out.join(' ');
}

// --- 4. tokenization ------------------------------------------------------------
function tokenize(text) {
  return text.replace(/[^a-z0-9\s'<>]/g, ' ').match(/<\w+>|[a-z0-9]+(?:'[a-z]+)?/g) || [];
}

function preprocess(text) {
  return tokenize(normalize(clean(scrubPii(String(text)))));
}

function features(tokens) {
  const grams = tokens.slice();
  for (let i = 0; i + 1 < tokens.length; i++) grams.push(`${tokens[i]} ${tokens[i + 1]}`);
  return grams;
}

/** TF-IDF (sublinear tf, l2-normalized) -> softmax over class scores. */
function classify(message) {
  const subject = String(message || '').split('\n')[0];
  const tokens = preprocess(subject);
  const counts = new Map();
  for (const g of features(tokens)) {
    const j = model.vocabulary[g];
    if (j !== undefined) counts.set(j, (counts.get(j) || 0) + 1);
  }
  const vec = [];
  let norm = 0;
  for (const [j, tf] of counts) {
    const w = (1 + Math.log(tf)) * model.idf[j];
    vec.push([j, w]);
    norm += w * w;
  }
  norm = Math.sqrt(norm) || 1;

  const scores = model.classes.map((_, k) => {
    let s = model.intercept[k];
    for (const [j, w] of vec) s += model.coef[k][j] * (w / norm);
    return s;
  });
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp(s - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  const proba = exps.map((e) => e / sum);
  const best = proba.indexOf(Math.max(...proba));

  return {
    intent: model.classes[best],
    confidence: Math.round(proba[best] * 1000) / 1000,
    tokens,
    known_tokens: tokens.filter((t) => model.vocabulary[t] !== undefined).length,
    proba: Object.fromEntries(model.classes.map((c, k) => [c, Math.round(proba[k] * 10000) / 10000])),
  };
}

/** Below this the label is shown as uncertain rather than asserted. */
const CONFIDENT = 0.35;

module.exports = { classify, preprocess, CONFIDENT, classes: model.classes };
