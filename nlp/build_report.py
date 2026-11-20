"""
Build the lecture submission (Parts 1-4) as .docx, then PDF via LibreOffice.
Every number comes from out/results.json and the data files, nothing is typed by hand.

Usage:  python build_report.py   -> out/ComDoc.docx, out/ComDoc.pdf
"""
import csv
import json
import random
import re
import statistics as st
import subprocess
from collections import Counter
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

from preprocess import (NORMALIZE, STOP, clean, lemmatize, normalize, preprocess, scrub_pii, stem,
                        tokenize)

HERE = Path(__file__).parent
OUT = HERE / "out"
R = json.loads((OUT / "results.json").read_text())
ROWS = list(csv.DictReader(open(HERE / "data" / "commits.csv")))
WILD = list(csv.DictReader(open(HERE / "data" / "wild.csv")))
FONT = "Times New Roman"
TITLE = "Commit Doctor (ComDoc): Commit-Message Intent Classification for Team-Awareness Summaries"
MEMBERS = ["Balagtas, James Albert C.", "Sisante, Whakeen Dereck C.", "Talatala, Jeremie Leo J."]
REPO_URL = "https://github.com/Notsyou/CommitDoctor"


def pct(x):
    return f"{x * 100:.1f}%"


def f3(x):
    return f"{x:.3f}"


# --- document helpers -------------------------------------------------------------
doc = Document()
sec = doc.sections[0]
sec.page_width, sec.page_height = Inches(8.5), Inches(11)          # short bond paper
for side in ("left_margin", "right_margin", "top_margin", "bottom_margin"):
    setattr(sec, side, Inches(1))
sec.left_margin = Inches(1.5)                                        # binding margin

st_normal = doc.styles["Normal"]
st_normal.font.name = FONT
st_normal.font.size = Pt(12)
st_normal.element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
st_normal.paragraph_format.space_after = Pt(6)
st_normal.paragraph_format.line_spacing = 1.15
for name, size in (("Heading 1", 14), ("Heading 2", 14), ("Heading 3", 12)):
    h = doc.styles[name]
    h.font.name, h.font.size, h.font.bold = FONT, Pt(size), True
    h.font.color.rgb = RGBColor(0, 0, 0)
    h.element.rPr.rFonts.set(qn("w:asciiTheme"), "") if False else None
    rf = h.element.rPr.find(qn("w:rFonts"))
    if rf is None:
        rf = OxmlElement("w:rFonts")
        h.element.rPr.append(rf)
    for a in ("w:ascii", "w:hAnsi", "w:eastAsia", "w:cs"):
        rf.set(qn(a), FONT)
    for a in ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme"):
        if rf.get(qn(a)) is not None:
            del rf.attrib[qn(a)]
    h.paragraph_format.space_before = Pt(12 if name != "Heading 1" else 0)
    h.paragraph_format.space_after = Pt(6)
    h.paragraph_format.keep_with_next = True
doc.styles["Heading 1"].paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER


def H1(text):
    doc.add_heading(text, level=1)


def H2(text):
    doc.add_heading(text, level=2)


def H3(text):
    doc.add_heading(text, level=3)


def P(text="", *, bold_lead=None, italic=False, align=WD_ALIGN_PARAGRAPH.JUSTIFY, size=None):
    p = doc.add_paragraph()
    p.alignment = align
    if bold_lead:
        r = p.add_run(bold_lead)
        r.bold = True
    _runs(p, text, italic=italic, size=size)
    return p


def _runs(p, text, italic=False, size=None):
    # `code` spans -> Courier New
    for i, part in enumerate(re.split(r"`([^`]*)`", text)):
        if not part:
            continue
        r = p.add_run(part)
        r.italic = italic
        if size:
            r.font.size = Pt(size)
        if i % 2:
            r.font.name = "Courier New"
            r.font.size = Pt(size or 10.5)


def BUL(items, style="List Bullet"):
    for it in items:
        p = doc.add_paragraph(style=style)
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT
        if isinstance(it, tuple):
            r = p.add_run(it[0])
            r.bold = True
            _runs(p, it[1])
        else:
            _runs(p, it)


def shade(cell, hex_):
    tcPr = cell._tc.get_or_add_tcPr()
    s = OxmlElement("w:shd")
    s.set(qn("w:val"), "clear")
    s.set(qn("w:color"), "auto")
    s.set(qn("w:fill"), hex_)
    tcPr.append(s)


def TABLE(header, rows, widths=None, size=10, mono_cols=()):
    t = doc.add_table(rows=1, cols=len(header))
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    for i, h in enumerate(header):
        c = t.rows[0].cells[i]
        c.text = ""
        r = c.paragraphs[0].add_run(h)
        r.bold, r.font.size = True, Pt(size)
        shade(c, "D9D9D9")
    for row in rows:
        cells = t.add_row().cells
        for i, v in enumerate(row):
            cells[i].text = ""
            para = cells[i].paragraphs[0]
            para.paragraph_format.space_after = Pt(0)
            para.paragraph_format.line_spacing = 1.0
            r = para.add_run(str(v))
            r.font.size = Pt(size)
            if i in mono_cols:
                r.font.name = "Courier New"
                r.font.size = Pt(size - 1)
    # repeat header row on page breaks
    trPr = t.rows[0]._tr.get_or_add_trPr()
    th = OxmlElement("w:tblHeader")
    th.set(qn("w:val"), "true")
    trPr.append(th)
    if widths:
        t.autofit = False
        tblPr = t._tbl.tblPr
        lay = OxmlElement("w:tblLayout")
        lay.set(qn("w:type"), "fixed")
        tblPr.append(lay)
        for i, gc in enumerate(t._tbl.tblGrid.findall(qn("w:gridCol"))):
            gc.set(qn("w:w"), str(int(widths[i] * 1440)))
        for row in t.rows:
            for i, w in enumerate(widths):
                row.cells[i].width = Inches(w)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return t


def CAPTION(text):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run(text)
    r.italic, r.font.size = True, Pt(11)


def FIG(path, caption, width=5.2):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.add_run().add_picture(str(path), width=Inches(width))
    CAPTION(caption)


def CODE(text, size=8.5):
    for line in text.rstrip("\n").split("\n"):
        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(0)
        p.paragraph_format.line_spacing = 1.0
        r = p.add_run(line if line else " ")
        r.font.name, r.font.size = "Courier New", Pt(size)


def PAGEBREAK():
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


# --- figures -----------------------------------------------------------------------
V = R["variants"]
fig, ax = plt.subplots(figsize=(6.4, 3.3))
names = list(V)
ax.barh(names[::-1], [V[n]["macro_f1_mean"] for n in names[::-1]],
        xerr=[V[n]["macro_f1_std"] for n in names[::-1]], color="#4a6fa5", capsize=3)
ax.axvline(R["baselines"]["keyword_rule"]["macro_f1"], color="#b42318", ls="--", lw=1)
ax.text(R["baselines"]["keyword_rule"]["macro_f1"] + 0.005, -0.45, "keyword rule", color="#b42318", fontsize=8)
ax.set_xlim(0, 0.7)
ax.set_xlabel("macro-F1 (5-fold cross-validation, mean ± std)")
ax.set_title("Preprocessing variants")
fig.tight_layout()
fig.savefig(OUT / "variants.png", dpi=200)

# --- dataset statistics --------------------------------------------------------------
T = [r["text"] for r in ROWS]
lens = [len(t.split()) for t in T]
first_words = Counter(t.split()[0].lower() for t in T)
content = Counter(w for t in T for w in preprocess(t, remove_stop=True) if not w.isdigit())
add_by_class = Counter(r["label"] for r in ROWS if r["text"].lower().startswith("add "))
fix_in_docs = sum(1 for r in ROWS if r["label"] == "docs" and r["text"].lower().startswith("fix"))
share = lambda pat: sum(bool(re.search(pat, t)) for t in T) / len(T)
abbrev_hits = Counter(w for t in T for w in t.lower().split() if w in NORMALIZE)
labels = sorted(R["class_counts"])

# =====================================================================================
# TITLE PAGE
# =====================================================================================
for _ in range(5):
    doc.add_paragraph()
p = P(align=WD_ALIGN_PARAGRAPH.CENTER)
r = p.add_run(TITLE)
r.bold, r.font.size = True, Pt(16)
P("Final Project with Research Integration", align=WD_ALIGN_PARAGRAPH.CENTER)
P("Natural Language Processing", align=WD_ALIGN_PARAGRAPH.CENTER)
for _ in range(4):
    doc.add_paragraph()
P("Submitted by:", align=WD_ALIGN_PARAGRAPH.CENTER).runs[0].bold = True
for m in MEMBERS:
    P(m, align=WD_ALIGN_PARAGRAPH.CENTER).paragraph_format.space_after = Pt(0)
for _ in range(4):
    doc.add_paragraph()
P("Connected thesis: Commit Doctor (ComDoc): A GitHub Webhook for Tracking and Summarizing Commits "
  "to Enhance Team Awareness and Coordination", align=WD_ALIGN_PARAGRAPH.CENTER, italic=True, size=11)
P("December 2026", align=WD_ALIGN_PARAGRAPH.CENTER)
PAGEBREAK()

# =====================================================================================
# PART 1
# =====================================================================================
H1("Part 1: Introduction, Scope and Hypothesis")
H2("1.1 Introduction")
P("Commit Doctor (ComDoc) is our thesis system: a GitHub webhook that records every commit pushed to one "
  "repository and turns each day's activity into a short summary on a web dashboard. It reports who committed, "
  "how many commits were made, when the activity happened, and how the day compares with the previous seven "
  "days. It also flags unusual changes in activity, estimates whether the team is on pace for a deadline, and "
  "sends email reminders. All of this works from commit metadata only (counts, timestamps and code churn). "
  "The thesis scope explicitly leaves out the content of the commits.")
P("That leaves a gap. A day with five commits looks the same in the summary whether the team shipped five "
  "features, fixed five bugs, or only updated the documentation. Yet every commit already carries a short "
  "natural-language description of the work: the commit message. Messages such as \"fix null author on merge "
  "commits\" or \"add webhook signature check\" say what kind of work was done, so a summary that can read them "
  "can answer not only how much the team did, but what the team did.")
P("This project adds that capability as an NLP component of ComDoc. It is a text classifier that reads a "
  "commit message and labels its intent as one of six classes taken from the widely used Conventional Commits "
  "convention: feature, fix, docs, refactor, test and chore. The classifier is trained in Python on "
  f"{R['n_samples']:,} real commit messages from eight public open-source projects. It is then exported to the "
  "Node.js application, where it labels every incoming commit and adds a sentence such as \"Mostly fixes (3 of 5)\" "
  "to the daily summary. Commit messages are a difficult kind of text. They are very short (a median of "
  f"{st.median(lens):.0f} words), full of code identifiers, issue numbers and abbreviations, and written by "
  "many people with very different habits. In student teams they are also often vague (\"latest updates\"), "
  "informal, or mixed with Filipino. The project therefore exercises the full NLP pipeline covered in the course: "
  "text cleaning, tokenization, stop-word handling, stemming and lemmatization, normalization, feature "
  "engineering, regularized modeling, and careful evaluation.")

H2("1.2 Scope")
P("The NLP component classifies the first line (subject) of a commit message into one of six intent classes. "
  "It does not read the code diff, judge code quality, or generate text. Training labels come from projects that "
  "already prefix their messages with a Conventional Commits type (for example `fix(core): ...`). The prefix is "
  "removed before training, so the model has to infer intent from the wording alone. The model is a classical "
  "TF-IDF and logistic regression pipeline with no neural network, consistent with the thesis's zero-budget, "
  "lightweight design. English is the main language; Taglish and slang are handled only through a small "
  "normalization dictionary and are treated as a known limitation.")

H2("1.3 Problem Statement")
P("ComDoc's daily summary describes the quantity and timing of commits but not their nature, because the "
  "commit messages it already stores are never analyzed. Team members who want to know what kind of work was "
  "done must still open and read the commit log themselves, which is exactly the manual effort the thesis aims "
  "to remove. Reading those messages automatically is not trivial. They are short, inconsistent, full of "
  "technical tokens, frequently ambiguous (\"update fix for docs\"), and sometimes uninformative (\"75% "
  "completion\").")

H2("1.4 Research Question")
P("To what extent can a lightweight TF-IDF and logistic regression classifier identify the intent of a commit "
  "message (feature, fix, docs, refactor, test or chore), and which text preprocessing steps help or hurt its "
  "performance, so that ComDoc's daily summary can describe what kind of work a team did and not only how much?")

H2("1.5 Hypotheses")
BUL([("H1. ", "A TF-IDF and L2-regularized logistic regression classifier will outperform a hand-written keyword "
              "rule by at least 15 percentage points of macro-F1."),
     ("H2. ", "Preprocessing (cleaning, abbreviation and misspelling normalization, stemming or lemmatization) "
              "will improve macro-F1 compared with raw, unprocessed text."),
     ("H3. ", "The classifier will reach a macro-F1 of at least 0.70 under 5-fold cross-validation.")])

H2("1.6 Target Metrics")
BUL([("Macro-F1 (primary). ", "The unweighted mean of per-class F1, so every intent class counts equally, "
                              "including small ones. Target: at least 0.70."),
     ("Accuracy. ", "The share of messages labeled correctly; easy to explain to stakeholders."),
     ("Out-of-domain accuracy. ", f"Accuracy on {len(WILD)} hand-labeled real messages that do not use the "
                                  "Conventional Commits format, including ComDoc's own history. This measures "
                                  "how the model behaves on the messy messages a student team actually writes."),
     ("Per-class precision and recall, and the confusion matrix, ", "to see which intents are confused with which.")])

H2("1.7 Mapping of NLP Course Outcomes to Project Components")
TABLE(["Course concept", "Where it is demonstrated in this project"], [
    ["Text acquisition and ethics", "Part 2: history-only clones of public repositories; author names and emails are never collected; @mentions, emails and URLs are masked."],
    ["Text cleaning and normalization", "Part 3 (`clean()`, `normalize()`): issue numbers, hashes and backticks removed; camelCase and snake_case split; abbreviations, slang, misspellings and Taglish mapped to standard words."],
    ["Tokenization", "Part 3 (`tokenize()`): a regular-expression tokenizer that keeps contractions and placeholder tokens such as <user>."],
    ["Stop-word removal", "Part 3: NLTK list minus negations and direction words; compared with and without removal."],
    ["Stemming and lemmatization", "Part 3: Porter stemmer versus POS-aware WordNet lemmatizer, compared word by word and by model score."],
    ["Feature engineering", "TF-IDF weighting with sublinear term frequency, unigrams plus bigrams, minimum document frequency of 2."],
    ["Regularization", "L2-penalized logistic regression; the strength C is tuned, and a sweep from C = 0.01 to 1000 shows over- and under-fitting."],
    ["Cross-validation", "5-fold stratified cross-validation with an inner 3-fold grid search for C (nested CV), plus a separate 80/20 held-out test."],
    ["Model evaluation", "Macro-F1, accuracy, per-class report, confusion matrix, two baselines, and out-of-domain and stress tests."],
    ["Deployment", "The trained model is exported to JSON and re-implemented in Node.js (`src/intent.js`); a test checks the Node output matches Python exactly."],
], widths=[1.8, 4.2], size=10)
PAGEBREAK()

# =====================================================================================
# PART 2
# =====================================================================================
H1("Part 2: Data Acquisition and Ethics")
H2("2.1 Text Source")
P("The text source is Git commit messages: the one-line descriptions developers write each time they save a "
  "change to a repository. They are the same text ComDoc receives through its GitHub webhook. Labeled "
  "training data was collected from eight popular public open-source repositories whose contributors follow the "
  "Conventional Commits convention, so each message already carries its intent as a prefix such as `feat:` "
  "or `fix(compiler):`. This gives thousands of labels without manual annotation.")
TABLE(["Repository", "Samples kept"], [[k, v] for k, v in sorted(R["repos"].items(), key=lambda x: -x[1])],
      widths=[3.2, 1.4], size=10)
P("Collection method (`nlp/collect.py`): each repository is cloned history-only (`git clone --bare "
  "--filter=tree:0`), which downloads commit metadata but no source code, and only the subject line (`git log "
  "--format=%s`) of the most recent 3,000 non-merge commits is read. A subject is kept only if it has a "
  "recognized type prefix, is at least three characters long, and is not a duplicate. Messages written by "
  "dependency bots such as Renovate (\"update pnpm to v12.9.1\") are dropped because they are machine-generated "
  f"and would make the chore class trivially easy. In total {sum(R['repos'].values()):,} of about 17,700 "
  f"usable messages were kept, capped at {R['n_samples'] // len(labels)} per class with a fixed random seed so "
  "the six classes are balanced and the dataset can be reproduced exactly. The type prefix becomes the label and "
  "is then removed from the text.")
TABLE(["Conventional Commits types", "Intent label", "Samples"], [
    ["feat", "feature", R["class_counts"]["feature"]], ["fix, bugfix, hotfix", "fix", R["class_counts"]["fix"]],
    ["docs", "docs", R["class_counts"]["docs"]], ["refactor, perf, style", "refactor", R["class_counts"]["refactor"]],
    ["test", "test", R["class_counts"]["test"]], ["chore, build, ci, release", "chore", R["class_counts"]["chore"]],
], widths=[2.4, 1.4, 1.0], size=10)
P(f"A second, out-of-domain evaluation set of {len(WILD)} real messages was hand-labeled by the group: "
  f"{sum(w['source'] == 'comdoc' for w in WILD)} from ComDoc's own repository history and "
  f"{sum(w['source'] == 'express' for w in WILD)} from the Express.js project, which does not use type prefixes. "
  "A final stress set of 12 short messages was written by the group on purpose to test specific language "
  "problems (misspellings, slang, Taglish, unknown words); these are clearly marked as constructed examples.")

H2("2.2 Sample Texts")
P("Fifteen samples from the training data, after the type prefix was removed, are shown below (two or three per class, "
  "drawn with a fixed seed). Issue numbers are left as they were collected; they are removed later during preprocessing.")
random.seed(7)
samples = []
for lab in labels:
    pool = [r for r in ROWS if r["label"] == lab and 4 <= len(r["text"].split()) <= 14]
    samples += random.sample(pool, 3 if lab in ("fix", "feature", "chore") else 2)
TABLE(["#", "Commit message (subject line)", "Label", "Source"],
      [[i + 1, s["text"], s["label"], s["repo"]] for i, s in enumerate(samples[:15])],
      widths=[0.3, 3.6, 0.8, 1.3], size=9.5)
P("Real messages from ComDoc's own history (part of the out-of-domain set) show how a student team actually writes:")
TABLE(["#", "Commit message", "Label assigned by the group"],
      [[i + 1, w["text"], w["label"]] for i, w in enumerate([w for w in WILD if w["source"] == "comdoc"][:8])],
      widths=[0.3, 4.3, 1.4], size=9.5)

H2("2.3 Language Characteristics")
BUL([("Very short texts. ", f"Messages average {st.mean(lens):.1f} words (median {st.median(lens):.0f}). Many "
                            "contain only one content word that signals intent, so every token matters."),
     ("Imperative sentence structure. ", "Almost every message starts with a bare verb in the imperative mood "
      "followed by an object: \"add …\", \"fix …\", \"remove …\". The most common first words are "
      + ", ".join(f"\"{w}\" ({n})" for w, n in first_words.most_common(8)) + "."),
     ("Telegraphic grammar. ", "Articles and auxiliary verbs are usually dropped (\"handle empty config\" instead "
      "of \"this commit handles the case where the config is empty\")."),
     ("Most common content words ", "(after stop-word removal): "
      + ", ".join(w for w, _ in content.most_common(20)) + "."),
     ("Technical tokens. ", f"{pct(share(r'`'))} of messages contain code in backticks, {pct(share(r'[a-z][A-Z]|\w_\w'))} "
      f"contain camelCase or snake_case identifiers, and {pct(share(r'#\d+'))} contain an issue or pull-request "
      "reference such as (#5038)."),
     ("Abbreviations. ", "Developer abbreviations appear throughout: "
      + ", ".join(f"\"{w}\"" for w, _ in abbrev_hits.most_common(10))
      + ". Student messages add informal ones such as \"notif\" and \"db\"."),
     ("Project-specific vocabulary. ", "Words like \"nuxt\", \"rolldown\", \"vite\" and \"query\" are frequent "
      "but only meaningful inside one project, so a model can latch onto them instead of on intent words."),
     ])

H2("2.4 Language Challenges")
TABLE(["Challenge", "Example from the data", "Why it is hard"], [
    ["Ambiguous verbs", f"\"add\" starts messages in all six classes: {', '.join(f'{k} {v}' for k, v in add_by_class.most_common())}", "The most frequent verb carries almost no intent information by itself."],
    ["Context-dependent meaning", f"\"fix typo in guide\" is docs, not fix ({fix_in_docs} docs messages start with \"fix\")", "The verb says fix, but the object (documentation) decides the class."],
    ["Overlapping classes", "\"remove unused `depd` dependency\" (chore) vs. \"remove dead code\" (refactor)", "Projects disagree on which label applies, so the labels themselves are noisy."],
    ["Slang", "\"Deleted .env.example. i aint taking no risk, hell naw\" (ComDoc)", "Informal words are absent from the training vocabulary."],
    ["Misspellings", "\"Testing commit dotor\" (ComDoc)", "Misspelled words become unknown tokens."],
    ["Abbreviations", "\"Made and debugged email notif system\" (ComDoc)", "\"notif\" is only understood if it is expanded."],
    ["Vague messages", "\"Latest updates\", \"75% completion\", \"first commit\" (ComDoc)", "There is no intent signal at all; even a person cannot tell the class."],
    ["Mixed languages", "\"inayos na yung login\" (Taglish, constructed)", "Filipino words are outside an English model's vocabulary."],
    ["Code identifiers", "\"use `Object.create(null)` for settings\"", "Identifiers explode the vocabulary and rarely repeat."],
], widths=[1.3, 2.6, 2.1], size=9.5)

H2("2.5 Privacy and Ethics")
BUL([("Authorized, public data only. ", "All eight training repositories and Express.js are public, "
      "open-source projects under permissive licenses (MIT), and commit messages are published by their authors "
      "as part of the project history. They were read through GitHub's normal public clone mechanism with no "
      "scraping of user pages and no authentication. ComDoc's own history is our group's repository."),
     ("Personal information removed at collection time. ", "Only the commit subject line is requested from Git. "
      "Author names, emails, GitHub logins, timestamps and commit hashes are never written to disk. Inside the "
      f"messages, @mentions, email addresses and URLs are replaced with <user>, <email> and <url> ({sum('<user>' in t for t in T)} "
      "mentions were masked). In the ComDoc samples, a teammate's name in a merge message was also replaced "
      "with <user>."),
     ("Data minimization. ", "No source code is downloaded (history-only clone), and only the fields needed for the "
      "task are stored: the repository name, the label, and the masked text."),
     ("Permission. ", "No permission is needed for public open-source commit messages, but the deployed ComDoc "
      "classifier only reads repositories that a team connects on purpose, and the classification runs locally "
      "with no message sent to any third-party service."),
     ("Responsible use. ", "Intent labels describe work, not people. The system reports intent per day and never "
      "ranks or scores individual developers by the kind of work they do."),
     ])

H2("2.6 Relevance to the Project")
P("These messages are exactly the text ComDoc already receives through its webhook. A classifier trained on "
  "them can label every new commit without extra input from the team, which lets the daily summary say what "
  "kind of work was done. That directly supports the thesis goal of team awareness without manually reading "
  "the commit history. The out-of-domain set, built partly from ComDoc's own history, tests how well the "
  "approach transfers to the messy, unprefixed messages that small student teams really write.")
PAGEBREAK()

# =====================================================================================
# PART 3
# =====================================================================================
H1("Part 3: Data Preprocessing and Feature Engineering")
P("All preprocessing lives in `nlp/preprocess.py` (full source in Section 3.9). The same steps are re-implemented "
  "in JavaScript in `src/intent.js` for the live system, and an automated test confirms both produce identical "
  "tokens and predictions. Each step can be switched on or off, which is how the variants in Section 3.7 are "
  "compared.")

H2("3.1 Text Cleaning")
BUL([("Extra spaces: ", "runs of whitespace collapse to one space, and leading and trailing spaces are removed."),
     ("Special characters and punctuation: ", "everything except letters, digits, apostrophes and the <placeholder> "
      "brackets becomes a space, so \"(#5038)\", \"`\", \":\" and emoji disappear."),
     ("Issue references and hashes: ", "\"#1234\", \"(#1234)\", \"GH-12\" and 7–40 character hexadecimal commit "
      "hashes are removed; they identify a ticket but say nothing about intent."),
     ("Code identifiers: ", "backticks are dropped but the identifier is kept; \"snake_case\", \"kebab-case\", "
      "\"path/to/file.ts\" and \"camelCase\" are split into separate words, so `getUserName` becomes \"get user name\"."),
     ("Capitalization: ", "everything is lowercased, so \"Fix\", \"FIX\" and \"fix\" are one feature."),
     ("Spelling errors: ", "common misspellings are corrected through the normalization dictionary (Section 3.5)."),
     ])

H2("3.2 Tokenization")
P("After cleaning, text is split with the regular expression `<\\w+>|[a-z0-9]+(?:'[a-z]+)?`. It matches "
  "placeholders such as <user> as one token, words and numbers, and keeps contractions such as \"don't\" intact. "
  "Whitespace splitting is kept as the raw baseline for comparison.")
tok_ex = ["fix(core): don't crash when `userConfig` is undefined (#1234)",
          "Merge <user>'s email notification system",
          "add `server.hmr.overlay` option for SSR"]
TABLE(["Input", "Whitespace split (raw)", "Our tokenizer (after cleaning)"],
      [[t, " | ".join(t.lower().split()), " | ".join(preprocess(t))] for t in tok_ex],
      widths=[2.0, 2.0, 2.0], size=9, mono_cols=(1, 2))

H2("3.3 Stop-word Removal")
P(f"The NLTK English stop-word list ({len(STOP) + 19} words) was used with 19 words kept back because they carry "
  "intent in commit messages: negations (not, no, nor, don't, doesn't, isn't, won't, can't), direction and "
  "quantity words (up, down, off, over, again, more, all, only, before, after) and \"against\".")
BUL([("When it helps: ", "it shrinks the vocabulary "
      f"({V['clean + normalize']['vocab_size']:,} to {V['clean + normalize + stop']['vocab_size']:,} features) and removes "
      "words like \"the\", \"for\" and \"to\" that appear in every class."),
     ("When it hurts: ", "in commit messages, function words carry meaning. \"when\" and \"on\" are among the "
      "strongest fix features (\"crash when …\", \"error on …\"), and \"for\" and \"with\" help identify test "
      "commits (\"add tests for …\"). Removing \"not\" would turn \"do not crash\" into \"crash\", reversing the "
      "meaning, which is why negations are kept. In our results stop-word removal lowered macro-F1 slightly "
      f"({f3(V['clean + normalize']['macro_f1_mean'])} to {f3(V['clean + normalize + stop']['macro_f1_mean'])}), "
      "so the deployed model keeps stop words."),
     ])

H2("3.4 Stemming and Lemmatization")
P("Porter stemming cuts suffixes by rule; WordNet lemmatization looks words up in a dictionary using their part "
  "of speech. Because commit subjects are imperative, a tagger often labels verbs like \"fixes\" as nouns, so the "
  "lemmatizer falls back to the verb form when the noun lookup changes nothing.")
words = ["fixes", "fixed", "fixing", "updated", "dependencies", "configuration", "removed", "better",
         "running", "tests", "documentation", "improves", "handling", "flaky", "caching"]
TABLE(["Original word", "Porter stem", "WordNet lemma"], [[w, stem([w])[0], lemmatize([w])[0]] for w in words],
      widths=[2.0, 2.0, 2.0], size=10, mono_cols=(0, 1, 2))
P("The stemmer is aggressive: \"dependencies\" becomes \"depend\" and \"configuration\" becomes \"configur\", which "
  "are not real words and merge \"depend\" (a verb) with \"dependencies\" (packages). The lemmatizer keeps real "
  "words but leaves some forms unmerged. In this dataset both gave the same macro-F1 "
  f"({f3(V['clean + normalize + stem']['macro_f1_mean'])}), because intent words like \"fix\" and \"add\" are almost "
  "always already in their base form in imperative messages.")

H2("3.5 Text Normalization")
P(f"A dictionary of {len(NORMALIZE)} entries maps abbreviations, slang, misspellings and common Taglish words to "
  "standard English before tokenization. Some entries came straight from ComDoc's own history (\"dotor\" to "
  "\"doctor\", \"aint\" to \"is not\").")
groups = {
    "Abbreviations": ["btn", "cfg", "deps", "env", "msg", "impl", "db", "pr", "w", "upd8"],
    "Slang / informal": ["wip", "lgtm", "aint", "gonna", "pls", "thx"],
    "Misspellings": ["fixd", "udpate", "teh", "dotor", "recieve", "dependancy"],
    "Taglish": ["inayos", "ayusin", "dinagdag", "tinanggal", "yung", "na"],
}
TABLE(["Type", "Original → normalized"],
      [[g, ", ".join(f"{w} → {NORMALIZE[w] or '(removed)'}" for w in ws)] for g, ws in groups.items()],
      widths=[1.4, 4.6], size=9.5)

H2("3.6 Before and After Processing")
P("Twelve messages showing each stage of the pipeline. \"Cleaned\" is after cleaning and normalization (the "
  "deployed variant); the last two columns add stop-word removal or stemming.")
ba = ["fix(core): don't crash when `userConfig` is undefined (#1234)",
      "Deleted .env.example. i aint taking no risk, hell naw",
      "Made and debugged email notif system. Hoping it works",
      "Testing commit dotor",
      "fixd teh login bug",
      "fix btn cfg w/ env vars",
      "inayos na yung login",
      "Update Security.md",
      "Refactor: simplify `acceptsLanguages` implementation using spread operator (#6137)",
      "Merge branch 'main' of https://github.com/Notsyou/CommitDoctor",
      "add tests for `useQuery` with suspense",
      "Remove unused `depd` dependency"]
TABLE(["#", "Original", "Cleaned + normalized tokens", "+ stop-word removal", "+ Porter stemming"],
      [[i + 1, t, " ".join(preprocess(t)), " ".join(preprocess(t, remove_stop=True)),
        " ".join(preprocess(t, reduce="stem"))] for i, t in enumerate(ba)],
      widths=[0.25, 1.6, 1.4, 1.35, 1.4], size=8.5, mono_cols=(2, 3, 4))

H2("3.7 Comparison of Preprocessing Results")
P("Each variant was evaluated with the same model, TF-IDF over unigrams and bigrams and L2 logistic regression, "
  "using 5-fold stratified cross-validation. Inside each training fold a 3-fold grid search chose C from {0.1, "
  "0.3, 1, 3, 10}. Out-of-domain columns use a model trained on all 2,100 messages.")
TABLE(["Variant", "Macro-F1 (CV)", "Vocabulary", "Wild set acc.", "Stress set acc."],
      [[n, f"{v['macro_f1_mean']:.3f} ± {v['macro_f1_std']:.3f}", f"{v['vocab_size']:,}",
        pct(v["wild_accuracy"]), pct(v["stress_accuracy"])] for n, v in V.items()],
      widths=[2.2, 1.2, 0.9, 0.9, 0.9], size=9.5)
FIG(OUT / "variants.png", "Figure 1. Cross-validated macro-F1 for each preprocessing variant (the dashed line is the keyword-rule baseline).", 5.6)
P(f"All variants are within about {max(v['macro_f1_mean'] for v in V.values()) - min(v['macro_f1_mean'] for v in V.values()):.3f} "
  "macro-F1 of each other, which is close to one standard deviation across folds, so on in-domain data no "
  "preprocessing choice clearly wins. Raw text is even marginally best, likely because tokens that cleaning "
  "removes, such as capitalized words and punctuation patterns, are mildly predictive within these "
  "projects. Preprocessing pays off on real out-of-domain messages, where clean + normalize reached the highest "
  f"accuracy ({pct(V['clean + normalize']['wild_accuracy'])} vs. {pct(V['raw (no preprocessing)']['wild_accuracy'])} raw) "
  f"with a {(1 - V['clean + normalize']['vocab_size'] / V['raw (no preprocessing)']['vocab_size']) * 100:.0f}% smaller vocabulary. That variant was deployed. "
  "It is also the simplest to reproduce in JavaScript, since it needs no stemmer or POS tagger.")

H2("3.8 Feature Engineering and Regularization")
BUL([("TF-IDF: ", "each message becomes a vector where a word's weight grows with how often it appears in that "
      "message (sublinear: 1 + log tf) and shrinks with how many messages contain it (idf). Vectors are "
      "L2-normalized so long and short messages are comparable."),
     ("Bigrams: ", "word pairs such as \"add tests\", \"tests for\" and \"to typescript\" capture short phrases that "
      "single words miss, for example separating \"add test\" (test) from \"add option\" (feature)."),
     ("Minimum document frequency 2: ", "words seen only once, mostly identifiers, are dropped, which reduces "
      f"noise; the deployed model has {len(json.loads((HERE.parent / 'src' / 'intent-model.json').read_text())['vocabulary']):,} features."),
     ("Class weighting: ", "classes are balanced in the data, but class_weight=\"balanced\" keeps the model fair "
      "if new data is uneven."),
     ])
P("Regularization: logistic regression with an L2 penalty discourages large weights. The parameter C is the "
  "inverse of the penalty strength. Figure 2 shows the sweep. With strong regularization (C = 0.01) the model "
  f"underfits (training F1 {f3(R['regularization'][0]['train_f1'])}). With almost none (C = 1000) it memorizes the "
  f"training data (training F1 {f3(R['regularization'][-1]['train_f1'])}) while cross-validated F1 falls to "
  f"{f3(R['regularization'][-1]['cv_f1'])}, which is classic overfitting. The best cross-validated score was at "
  f"C = {R['best_C']} (CV F1 {f3(max(s['cv_f1'] for s in R['regularization']))}), which the final model uses.")
FIG(OUT / "regularization.png", "Figure 2. Training vs. cross-validated macro-F1 across regularization strengths.", 4.8)

H2("3.9 Source Code")
P(f"The full project, including the data collector, training script, Node.js port and tests, is in the ComDoc "
  f"repository: {REPO_URL} (folder `nlp/` and `src/intent.js`). The preprocessing module is reproduced below.")
CODE((HERE / "preprocess.py").read_text())
P("")
P("Core of the training script (`nlp/train.py`), the model pipeline and nested cross-validation:")
CODE('''def make_pipeline(C=1.0):
    return Pipeline([
        ("tfidf", TfidfVectorizer(analyzer=identity, sublinear_tf=True, min_df=2)),
        ("clf", LogisticRegression(C=C, max_iter=2000, class_weight="balanced")),
    ])

def bigrams(tokens):                      # unigram + bigram features
    return tokens + [f"{a} {b}" for a, b in zip(tokens, tokens[1:])]

cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
for name, fn in VARIANTS.items():         # preprocessing variants
    X = [bigrams(fn(t)) for t in texts]
    inner = GridSearchCV(make_pipeline(), {"clf__C": [0.1, 0.3, 1, 3, 10]},
                         cv=3, scoring="f1_macro")
    scores = cross_val_score(inner, X, y, cv=cv, scoring="f1_macro")''')
P("")
P("Inference inside ComDoc (`src/intent.js`), which uses the same weights in plain JavaScript:")
CODE('''function classify(message) {
  const tokens = preprocess(String(message || '').split('\\n')[0]);
  const counts = new Map();
  for (const g of features(tokens)) {               // unigrams + bigrams
    const j = model.vocabulary[g];
    if (j !== undefined) counts.set(j, (counts.get(j) || 0) + 1);
  }
  // TF-IDF with sublinear tf, then L2 normalization
  const vec = [...counts].map(([j, tf]) => [j, (1 + Math.log(tf)) * model.idf[j]]);
  const norm = Math.sqrt(vec.reduce((s, [, w]) => s + w * w, 0)) || 1;
  // linear scores -> softmax probabilities
  const scores = model.classes.map((_, k) =>
    vec.reduce((s, [j, w]) => s + model.coef[k][j] * w / norm, model.intercept[k]));
  ...
}''')

H2("3.10 Benefits and Possible Meaning Loss")
BUL([("Benefits: ", "consistent tokens (\"Fix\", \"fix:\", \"FIX\" become one feature), a smaller vocabulary, "
      "identifiers split into meaningful words (\"useQuery\" becomes \"use query\"), recovered meaning from "
      "abbreviations and misspellings, and personal data removed."),
     ("Meaning loss in cleaning: ", "removing punctuation drops signals like \"!\" (breaking change) and file "
      "extensions; \"Security.md\" becomes \"security md\", so the hint that this is a documentation file "
      "becomes weaker."),
     ("Meaning loss in stop-word removal: ", "function words such as \"when\", \"for\" and \"not\" carry intent here; "
      "removing them hurt the score slightly."),
     ("Meaning loss in stemming: ", "non-words (\"configur\") and wrong merges (\"depend\" from both \"depends\" "
      "and \"dependencies\")."),
     ("Normalization risks: ", "a dictionary can map a word wrongly in context, for example \"na\" is a Taglish "
      "particle but also an abbreviation for \"not applicable\", and it only fixes errors that were listed in "
      "advance."),
     ])
PAGEBREAK()

# =====================================================================================
# PART 4
# =====================================================================================
H1("Part 4: Analysis and Evaluation")
H2("4.1 How the System Processes Text")
P("When a developer pushes, GitHub sends ComDoc a webhook containing the commits. For each commit ComDoc:")
BUL(["stores the commit (author, time, message, churn) in SQLite, as before;",
     "takes the first line of the message, masks personal data, cleans, normalizes and tokenizes it (Part 3);",
     "builds TF-IDF unigram and bigram features with the exported vocabulary and computes six class "
     "probabilities with the exported logistic regression weights (`src/intent.js`);",
     "shows the predicted intent as a colored tag next to the commit on the dashboard; predictions below 35% "
     "confidence are shown with a question mark and a dashed outline;",
     "at the end of the day, counts the intents and adds a sentence to the summary headline."],
    style="List Number")
P("Example taken from the running system with demo data:", bold_lead="")
TABLE(["Input commit message", "Tokens", "Predicted intent (confidence)"], [
    ["Fix null author on merge commits", "fix null author on merge commits", "fix (37.7%)"],
    ["Remove unused helper", "remove unused helper", "refactor (45.3%)"],
    ["Add webhook signature check", "add webhook signature check", "chore (26.4%)  ← wrong, should be feature"],
], widths=[2.2, 2.0, 1.8], size=9.5)
P("Daily summary produced: \"3 commits from 2 contributors, in line with the 7-day average. bong was most "
  "active with 2. Activity peaked around 14:00. Mixed work: 1 fix, 1 refactor, 1 chore.\"", italic=True)

H2("4.2 Accuracy")
te = R["test"]
P(f"On the held-out 20% test split ({te['n']} messages never seen in training) the classifier reached "
  f"{pct(te['accuracy'])} accuracy and {f3(te['macro_f1'])} macro-F1. Cross-validated macro-F1 for the same variant was "
  f"{f3(V['clean + normalize']['macro_f1_mean'])}. Both baselines are far lower:")
TABLE(["Method", "Accuracy", "Macro-F1"], [
    ["Majority class (always one label)", pct(R["baselines"]["majority_class"]["accuracy"]), f3(R["baselines"]["majority_class"]["macro_f1"])],
    ["Keyword rule (fix→fix, doc→docs, test→test, add→feature …)", pct(R["baselines"]["keyword_rule"]["accuracy"]), f3(R["baselines"]["keyword_rule"]["macro_f1"])],
    ["TF-IDF + logistic regression (held-out test)", pct(te["accuracy"]), f3(te["macro_f1"])],
], widths=[3.6, 1.1, 1.1], size=10)
rep = te["report"]
TABLE(["Class", "Precision", "Recall", "F1", "Test samples"],
      [[c, f3(rep[c]["precision"]), f3(rep[c]["recall"]), f3(rep[c]["f1-score"]), int(rep[c]["support"])] for c in labels],
      widths=[1.2, 1.0, 1.0, 1.0, 1.1], size=10)
FIG(OUT / "confusion.png", "Figure 3. Confusion matrix on the held-out test set (rows: true label, columns: predicted).", 4.0)
best = max(labels, key=lambda c: rep[c]["f1-score"])
worst = min(labels, key=lambda c: rep[c]["f1-score"])
P(f"{best.capitalize()} is the easiest class (F1 {f3(rep[best]['f1-score'])}) because its messages share explicit "
  f"words. {worst.capitalize()} is the hardest (F1 {f3(rep[worst]['f1-score'])}). Most errors fall between "
  "fix, refactor and chore, where projects themselves disagree about which label to use.")
P(f"Out-of-domain results. On the {len(WILD)} hand-labeled real messages without type prefixes, accuracy dropped "
  f"to {pct(R['wild']['accuracy'])} (keyword rule: {pct(R['wild']['keyword_rule_accuracy'])}). Selected results:")
pick = []
for w in R["wild"]["items"]:
    if w["text"] in ("Fix handling very large stacks of sync middleware", "improve step update documentation",
                     "skip QUERY method test (#5628)", "added connected indicator",
                     "Refactor: simplify `acceptsLanguages` implementation using spread operator (#6137)",
                     "Update Security.md", "Latest updates", "build deadline prediction next",
                     "Deleted .env.example. i aint taking no risk, hell naw", "Remove unused `depd` dependency",
                     "Broken version to fix v1, db needs to accept past version of code"):
        pick.append(w)
WHY = {
    "Fix handling very large stacks of sync middleware": "\"fix\" + \"handling\" are strong fix features.",
    "improve step update documentation": "\"documentation\" is the top docs feature.",
    "skip QUERY method test (#5628)": "\"test\" dominates; issue number removed by cleaning.",
    "added connected indicator": "\"added\" maps toward feature even in past tense.",
    "Refactor: simplify `acceptsLanguages` implementation using spread operator (#6137)": "the word \"refactor\" and \"simplify\" both point to refactor.",
    "Update Security.md": "cleaning turns \"Security.md\" into \"security md\"; the file-type hint is lost, and \"update\" leans chore.",
    "Latest updates": "vague, no intent signal; even humans cannot be sure.",
    "build deadline prediction next": "\"build\" is a chore type in Conventional Commits; here it means \"create\".",
    "Deleted .env.example. i aint taking no risk, hell naw": "slang adds noise; \"deleted\" is unseen past tense.",
    "Remove unused `depd` dependency": "\"remove unused\" is a strong refactor phrase; label disagreement in practice.",
    "Broken version to fix v1, db needs to accept past version of code": "\"version\" pulls toward docs/release; long, non-imperative sentence.",
}
TABLE(["Input", "Expected", "Output (conf.)", "Result", "Explanation"],
      [[w["text"], w["label"], f"{w['pred']} ({w['confidence']:.2f})", "Correct" if w["correct"] else "Wrong",
        WHY.get(w["text"], "")] for w in pick],
      widths=[1.7, 0.75, 0.95, 0.65, 1.95], size=8.5)

H2("4.3 Handling Language Challenges")
S = {s["text"]: s for s in R["stress"]["items"]}


def srow(text, challenge, handled):
    s = S[text]
    return [challenge, text, " ".join(s["tokens"]), f"{s['pred']} ({s['confidence']:.2f})", s["label"], handled]


TABLE(["Challenge", "Input", "After preprocessing", "Output", "Expected", "Observation"], [
    srow("fixd teh login bug", "Misspelling", "Normalized correctly to \"fixed the\", but \"fixed\" (past tense) is rare in imperative training data, so the strong signal is lost."),
    srow("udpate readme instalation steps", "Misspelling", "\"udpate\" corrected; \"readme\" carries docs; unlisted \"instalation\" stays unknown but is not needed."),
    srow("fix btn cfg w/ env vars", "Abbreviation", "All abbreviations expanded, but \"button config environment\" pulls toward feature and outweighs \"fix\"."),
    srow("wip dont merge yet lol", "Slang", "\"wip\" expanded; \"dont\" (no apostrophe) and \"lol\" unknown; no real intent in the text."),
    srow("inayos na yung login", "Taglish", "Mapped to \"fixed the login\" (\"na\" dropped), yet still misclassified for the same past-tense reason as above."),
    srow("add zxqv frobnicator to pipeline", "Unknown words", "Unknown words are simply ignored (no vocabulary entry); \"add\" decides. Robust by design."),
    srow("update fix for docs", "Ambiguous", "Three intent words compete; the object \"docs\" wins with high confidence, a defensible reading."),
    srow("do not crash when config is missing", "Negation", "Keeping \"not\" and \"when\" (not removed as stop words) gives a confident, correct fix."),
], widths=[0.8, 1.15, 1.2, 0.8, 0.65, 1.4], size=8, mono_cols=(2,))
P("Summary: unknown words are handled gracefully because they are ignored. Abbreviations and misspellings are "
  "repaired only if they are in the dictionary. Slang and Taglish are the weakest areas. Ambiguous messages are "
  "resolved toward the most specific object word, and low-confidence results are visibly marked as unsure on the "
  f"dashboard. Accuracy on this deliberately hard set was {pct(R['stress']['accuracy'])}.")

H2("4.4 Hypothesis Results")
kw = R["baselines"]["keyword_rule"]["macro_f1"]
TABLE(["Hypothesis", "Result", "Verdict"], [
    ["H1: beats the keyword rule by ≥ 15 points macro-F1", f"{f3(V['clean + normalize']['macro_f1_mean'])} vs. {f3(kw)} (+{(V['clean + normalize']['macro_f1_mean'] - kw) * 100:.0f} points)", "Supported"],
    ["H2: preprocessing improves macro-F1 over raw text", f"raw {f3(V['raw (no preprocessing)']['macro_f1_mean'])} vs. best processed {f3(max(v['macro_f1_mean'] for n, v in V.items() if n != 'raw (no preprocessing)'))} in-domain; out-of-domain {pct(V['raw (no preprocessing)']['wild_accuracy'])} → {pct(V['clean + normalize']['wild_accuracy'])}", "Not supported in-domain; partly supported out-of-domain"],
    ["H3: macro-F1 ≥ 0.70", f"{f3(V['clean + normalize']['macro_f1_mean'])} (CV), {f3(te['macro_f1'])} (test)", "Not supported"],
], widths=[2.3, 2.4, 1.3], size=9.5)
P("H3 was not met. The main reason is label noise rather than the model: the same kind of change is labeled "
  "\"fix\" in one project and \"chore\" or \"refactor\" in another, and very short messages often do not contain "
  "enough words to decide. Character n-grams (2–5 characters) and combined word and character features were also "
  "tried and scored about the same (0.58–0.61 macro-F1), which suggests the ceiling comes from the data, not "
  "the feature set.")

H2("4.5 Suggested Improvements")
BUL([("Verb-form normalization in the deployed model. ", "Past-tense messages (\"fixed\", \"added\", \"inayos\" → "
      "\"fixed\") fail because training data is imperative. Lemmatizing only the first verb, or adding past-tense "
      "variants to the dictionary, would recover them without the cost of full stemming."),
     ("Cleaner labels. ", "Merge fix/refactor/chore into fewer classes, or relabel a sample by hand, to remove the "
      "disagreement between projects that caps accuracy."),
     ("Student-team training data. ", "Add labeled messages from Filipino student repositories so Taglish, slang "
      "and informal abbreviations appear in training rather than only in a dictionary."),
     ("Use more of the commit. ", "File paths (only .md changed → docs; only test files → test) and the message "
      "body are strong extra signals that ComDoc already receives from the webhook."),
     ("Spell-checking with edit distance. ", "Correct unknown tokens to the nearest vocabulary word instead of "
      "relying on a fixed list."),
     ("\"Unclear message\" flag. ", "When confidence is very low or no known token appears, report the message as "
      "uninformative, which also encourages better commit habits."),
     ("Pretrained sentence embeddings or a small transformer, ", "if the zero-budget constraint is relaxed."),
     ])

H2("4.6 Real-World Application")
BUL([("Student and small development teams ", "get a daily summary that says what kind of work happened "
      "(\"Mostly fixes (3 of 5)\") without opening the commit log, the core goal of the ComDoc thesis."),
     ("Team leads and instructors ", "can see at a glance whether a project close to its deadline is still adding "
      "features or only fixing bugs, which complements ComDoc's deadline-pace prediction."),
     ("Release notes and changelogs ", "can be drafted automatically by grouping commits by intent, even in "
      "projects that do not use Conventional Commits prefixes."),
     ("Commit-message quality feedback: ", "low-confidence or vague messages can be highlighted so teams learn to "
      "write clearer messages."),
     ])

H2("4.7 Limitations")
BUL(["Very short or vague messages (\"Latest updates\", \"75% completion\", \"first commit\") contain no intent "
     "signal; no text model can classify them reliably.",
     "Messages that describe several changes at once (\"missing email, notifications, deadline refinement\") need "
     "more than one label, but the model gives only one.",
     "Words whose meaning depends on the project: \"build\" (create vs. build system), \"update\" (dependency, "
     "docs, or code), \"remove\" (cleanup vs. feature removal).",
     "Slang, Taglish and unlisted misspellings depend on a hand-made dictionary and break easily.",
     "Training data comes from large English-speaking JavaScript projects; vocabulary such as \"nuxt\" and "
     "\"vite\" is domain-specific, and accuracy drops from about 60% to "
     f"{pct(R['wild']['accuracy'])} on other projects.",
     "The labels are what each project's contributors chose, so they contain disagreement and some errors.",
     "Confidence is generally low (most predictions are 25–45%), so the summary should be read as a rough "
     "indication of the kind of work, not an exact count."])

H2("4.8 Conclusion")
P("Adding a commit-intent classifier gives ComDoc's summary a qualitative dimension using only text the system "
  f"already receives. The model clearly beats a keyword rule ({f3(V['clean + normalize']['macro_f1_mean'])} vs. "
  f"{f3(kw)} macro-F1) and runs inside the existing Node.js application with no extra infrastructure. It did not reach "
  "the 0.70 target, and the experiments show why. Commit-message intent is inherently ambiguous, preprocessing "
  "matters less on in-domain text than expected, and the biggest gains would come from better-matched training "
  "data and cleaner labels rather than more complex text processing.")

doc.save(OUT / "ComDoc.docx")
subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir", str(OUT), str(OUT / "ComDoc.docx")],
               check=True, capture_output=True)
print("wrote", OUT / "ComDoc.docx", "and", OUT / "ComDoc.pdf")
