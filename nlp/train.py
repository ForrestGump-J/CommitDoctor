"""
Train and evaluate the commit-intent classifier (Parts 3 and 4).

  1. Compare preprocessing variants with 5-fold stratified cross-validation,
     tuning the L2 regularization strength C inside each fold (nested CV).
  2. Compare against two baselines: majority class and a keyword rule.
  3. Fit the chosen pipeline on 80% of the data, report on the held-out 20%.
  4. Evaluate on the out-of-domain "wild" set (real, non-prefixed messages)
     and the synthetic stress set.
  5. Export the model as JSON so the Node.js app can classify without Python.

Usage:  python train.py          -> out/results.json, out/*.png, ../src/intent-model.json
"""
import csv
import json
from collections import Counter
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (accuracy_score, classification_report, confusion_matrix,
                             ConfusionMatrixDisplay, f1_score)
from sklearn.model_selection import GridSearchCV, StratifiedKFold, cross_val_score, train_test_split
from sklearn.pipeline import Pipeline

from preprocess import NORMALIZE, preprocess, raw_tokens

HERE = Path(__file__).parent
OUT = HERE / "out"
OUT.mkdir(exist_ok=True)
SEED = 42

VARIANTS = {
    "raw (no preprocessing)":      lambda t: raw_tokens(t.lower()),
    "clean + normalize":           lambda t: preprocess(t),
    "clean + normalize + stop":    lambda t: preprocess(t, remove_stop=True),
    "clean + normalize + stem":    lambda t: preprocess(t, reduce="stem"),
    "clean + normalize + lemma":   lambda t: preprocess(t, reduce="lemma"),
    "clean + norm + stop + stem":  lambda t: preprocess(t, remove_stop=True, reduce="stem"),
}
CHOSEN = "clean + normalize"   # within CV noise of the best, best on real out-of-domain text,
                               # and needs no stemmer in the Node.js port (src/intent.js)

# Hand-written rule baseline: what a developer might do without NLP.
KEYWORDS = [("fix", "fix"), ("bug", "fix"), ("doc", "docs"), ("readme", "docs"), ("test", "test"),
            ("spec", "test"), ("refactor", "refactor"), ("rename", "refactor"), ("add", "feature"),
            ("support", "feature"), ("new", "feature")]


def keyword_rule(text):
    low = text.lower()
    for kw, lab in KEYWORDS:
        if kw in low:
            return lab
    return "chore"


def load(name):
    with open(HERE / "data" / name) as f:
        return list(csv.DictReader(f))


def identity(x):
    return x


def make_pipeline(C=1.0):
    return Pipeline([
        ("tfidf", TfidfVectorizer(analyzer=identity, ngram_range=(1, 1), sublinear_tf=True, min_df=2)),
        ("clf", LogisticRegression(C=C, max_iter=2000, class_weight="balanced")),
    ])


def bigrams(tokens):
    return tokens + [f"{a} {b}" for a, b in zip(tokens, tokens[1:])]


def main():
    rows = load("commits.csv")
    texts = [r["text"] for r in rows]
    y = np.array([r["label"] for r in rows])
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=SEED)
    results = {"n_samples": len(rows), "class_counts": dict(Counter(y)),
               "repos": dict(Counter(r["repo"] for r in rows))}

    # --- 1. preprocessing variants, nested CV over C -------------------------------
    grid = {"clf__C": [0.1, 0.3, 1, 3, 10]}
    variants = {}
    for name, fn in VARIANTS.items():
        X = [bigrams(fn(t)) for t in texts]
        inner = GridSearchCV(make_pipeline(), grid, cv=3, scoring="f1_macro")
        scores = cross_val_score(inner, X, y, cv=cv, scoring="f1_macro")
        vocab = len({tok for doc in X for tok in doc})
        fitted = make_pipeline(1).fit(X, y)
        ood = {}
        for f in ("wild.csv", "stress.csv"):
            w = load(f)
            p = fitted.predict([bigrams(fn(r["text"])) for r in w])
            ood[f.split(".")[0] + "_accuracy"] = round(float(np.mean(p == np.array([r["label"] for r in w]))), 4)
        variants[name] = {"macro_f1_mean": round(scores.mean(), 4), "macro_f1_std": round(scores.std(), 4),
                          "vocab_size": vocab, **ood}
        print(f"{name:30s} F1 {scores.mean():.3f} ± {scores.std():.3f}  vocab {vocab}")
    results["variants"] = variants

    # --- 2. baselines --------------------------------------------------------------
    maj = Counter(y).most_common(1)[0][0]
    kw_pred = [keyword_rule(t) for t in texts]
    results["baselines"] = {
        "majority_class": {"accuracy": round(float(np.mean(y == maj)), 4),
                           "macro_f1": round(f1_score(y, [maj] * len(y), average="macro"), 4)},
        "keyword_rule": {"accuracy": round(accuracy_score(y, kw_pred), 4),
                         "macro_f1": round(f1_score(y, kw_pred, average="macro"), 4)},
    }
    print("baselines", results["baselines"])

    # --- 3. regularization sweep (chosen variant) ----------------------------------
    fn = VARIANTS[CHOSEN]
    X = [bigrams(fn(t)) for t in texts]
    sweep = []
    for C in [0.01, 0.1, 0.3, 1, 3, 10, 100, 1000]:
        pipe = make_pipeline(C)
        cv_f1 = cross_val_score(pipe, X, y, cv=cv, scoring="f1_macro").mean()
        train_f1 = f1_score(y, pipe.fit(X, y).predict(X), average="macro")
        sweep.append({"C": C, "train_f1": round(train_f1, 4), "cv_f1": round(cv_f1, 4)})
    results["regularization"] = sweep
    best_C = max(sweep, key=lambda s: s["cv_f1"])["C"]
    results["best_C"] = best_C

    fig, ax = plt.subplots(figsize=(6, 3.6))
    ax.semilogx([s["C"] for s in sweep], [s["train_f1"] for s in sweep], "o-", label="training")
    ax.semilogx([s["C"] for s in sweep], [s["cv_f1"] for s in sweep], "s-", label="5-fold CV")
    ax.set_xlabel("C (inverse regularization strength)")
    ax.set_ylabel("macro-F1")
    ax.set_title("Effect of L2 regularization")
    ax.legend()
    ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(OUT / "regularization.png", dpi=200)

    # --- 4. held-out test --------------------------------------------------------------
    idx = np.arange(len(texts))
    tr, te = train_test_split(idx, test_size=0.2, stratify=y, random_state=SEED)
    model = make_pipeline(best_C).fit([X[i] for i in tr], y[tr])
    pred = model.predict([X[i] for i in te])
    results["test"] = {
        "n": len(te),
        "accuracy": round(accuracy_score(y[te], pred), 4),
        "macro_f1": round(f1_score(y[te], pred, average="macro"), 4),
        "report": classification_report(y[te], pred, output_dict=True, zero_division=0),
    }
    labels = sorted(set(y))
    cm = confusion_matrix(y[te], pred, labels=labels)
    results["test"]["confusion"] = {"labels": labels, "matrix": cm.tolist()}
    fig, ax = plt.subplots(figsize=(5.2, 4.6))
    ConfusionMatrixDisplay(cm, display_labels=labels).plot(ax=ax, cmap="Blues", colorbar=False)
    ax.set_title("Held-out test set (20%)")
    plt.setp(ax.get_xticklabels(), rotation=30)
    fig.tight_layout()
    fig.savefig(OUT / "confusion.png", dpi=200)

    probs = model.predict_proba([X[i] for i in te])
    results["test"]["examples"] = [
        {"text": texts[i], "true": y[i], "pred": p, "confidence": round(float(pr.max()), 3)}
        for i, p, pr in zip(te, pred, probs)
    ]
    print("test", results["test"]["accuracy"], results["test"]["macro_f1"])

    # --- 5. final model on all data + out-of-domain sets -----------------------------
    final = make_pipeline(best_C).fit(X, y)

    def run(rows_, key):
        out = []
        for r in rows_:
            toks = bigrams(fn(r["text"]))
            pr = final.predict_proba([toks])[0]
            pred_ = final.classes_[pr.argmax()]
            out.append({**r, "tokens": fn(r["text"]), "pred": pred_, "confidence": round(float(pr.max()), 3),
                        "correct": pred_ == r["label"],
                        "known_tokens": sum(t in final.named_steps["tfidf"].vocabulary_ for t in fn(r["text"]))})
        acc = np.mean([o["correct"] for o in out])
        results[key] = {"accuracy": round(float(acc), 4), "items": out}
        print(key, round(float(acc), 3))

    wild = load("wild.csv")
    run(wild, "wild")
    results["wild"]["keyword_rule_accuracy"] = round(float(np.mean([keyword_rule(r["text"]) == r["label"] for r in wild])), 4)
    results["wild"]["macro_f1"] = round(f1_score([o["label"] for o in results["wild"]["items"]],
                                                 [o["pred"] for o in results["wild"]["items"]], average="macro"), 4)
    run(load("stress.csv"), "stress")

    # top features per class (interpretability)
    vocab = final.named_steps["tfidf"].get_feature_names_out()
    coef = final.named_steps["clf"].coef_
    results["top_features"] = {c: [vocab[j] for j in np.argsort(coef[k])[::-1][:10]]
                               for k, c in enumerate(final.classes_)}

    (OUT / "results.json").write_text(json.dumps(results, indent=2, default=str))

    # --- 6. export for Node.js ----------------------------------------------------------
    tfidf, clf = final.named_steps["tfidf"], final.named_steps["clf"]
    export = {
        "version": 1, "variant": CHOSEN, "C": best_C, "trained_on": len(texts),
        "classes": clf.classes_.tolist(),
        "vocabulary": {t: int(i) for t, i in tfidf.vocabulary_.items()},
        "idf": [round(v, 6) for v in tfidf.idf_],
        "coef": [[round(v, 6) for v in row] for row in clf.coef_],
        "intercept": [round(v, 6) for v in clf.intercept_],
        # Single source of truth for the abbreviation/slang/misspelling table.
        "normalize": NORMALIZE,
        # Parity cases: the Node.js port must reproduce these exactly (test/intent.test.js).
        "parity": [{"text": r["text"], "tokens": fn(r["text"]), "pred": final.predict([bigrams(fn(r["text"]))])[0],
                    "proba": [round(float(v), 4) for v in final.predict_proba([bigrams(fn(r["text"]))])[0]]}
                   for r in load("wild.csv") + load("stress.csv")],
    }
    (HERE.parent / "src" / "intent-model.json").write_text(json.dumps(export))
    print("exported model:", len(export["vocabulary"]), "features")


if __name__ == "__main__":
    main()
