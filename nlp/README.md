# Commit-intent NLP (NLP final project)

Labels commit messages as feature / fix / docs / refactor / test / chore. Trained here in Python,
served in the app by `src/intent.js` (no Python at runtime).

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -c "import nltk; [nltk.download(x) for x in ['stopwords','wordnet','omw-1.4','averaged_perceptron_tagger_eng']]"
.venv/bin/python collect.py       # data/commits.csv (history-only clones of 8 public repos)
.venv/bin/python train.py         # out/results.json, figures, ../src/intent-model.json (~4 min)
.venv/bin/python build_report.py  # out/ComDoc.docx + out/ComDoc.pdf (needs LibreOffice)
```

`data/wild.csv` (real unprefixed messages) and `data/stress.csv` (constructed hard cases) are hand-labeled.
`npm test` checks the Node port reproduces the Python predictions exactly.
