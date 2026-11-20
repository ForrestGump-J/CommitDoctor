"""
Preprocessing pipeline for commit messages (Part 3).

Steps, in order (each can be switched off to compare variants):
  1. scrub_pii      - mask emails, @mentions, URLs (ethics)
  2. clean          - drop issue refs (#123), hashes, emoji/special chars, extra spaces
  3. normalize      - lowercase, expand dev abbreviations/slang, fix common misspellings
  4. tokenize       - split into word tokens
  5. stop words     - optional; KEEPS negations and dev-meaningful words
  6. stem / lemma   - optional; Porter stemmer or WordNet lemmatizer (POS-aware)
"""
import re

from nltk.corpus import stopwords, wordnet
from nltk.stem import PorterStemmer, WordNetLemmatizer
from nltk import pos_tag

# --- 1. privacy --------------------------------------------------------------
EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
MENTION = re.compile(r"(?<![\w@])@[A-Za-z0-9-]{1,39}\b(?!/)")  # not @scope/pkg
URL = re.compile(r"https?://\S+")


def scrub_pii(text):
    text = EMAIL.sub("<email>", text)
    text = URL.sub("<url>", text)
    return MENTION.sub("<user>", text)


# --- 2. cleaning -------------------------------------------------------------
ISSUE_REF = re.compile(r"\(?#\d+\)?|\b(gh|GH)-\d+\b")
SHA = re.compile(r"\b[0-9a-f]{7,40}\b")
CODE_TICKS = re.compile(r"`([^`]*)`")
NON_WORD = re.compile(r"[^a-z0-9\s'<>]")
SPACES = re.compile(r"\s+")


def clean(text):
    text = CODE_TICKS.sub(r" \1 ", text)        # keep identifiers, drop backticks
    text = ISSUE_REF.sub(" ", text)
    text = SHA.sub(" ", text)
    text = re.sub(r"[_./-]", " ", text)         # snake_case, paths, kebab-case -> words
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", text)  # camelCase -> camel Case
    return SPACES.sub(" ", text).strip()


# --- 3. normalization ----------------------------------------------------------
# Abbreviations, dev slang and misspellings seen in real commit messages
# (several taken straight from the ComDoc repo's own history).
NORMALIZE = {
    # abbreviations
    "btn": "button", "cfg": "config", "conf": "config", "deps": "dependencies",
    "dep": "dependency", "env": "environment", "msg": "message", "msgs": "messages",
    "func": "function", "fn": "function", "impl": "implement", "init": "initial",
    "auth": "authentication", "db": "database", "repo": "repository", "pr": "pull request",
    "ui": "interface", "docs": "documentation", "doc": "documentation", "readme": "readme",
    "w": "with", "wo": "without", "b4": "before", "upd": "update", "upd8": "update",
    "add'l": "additional", "perf": "performance", "ts": "typescript", "js": "javascript",
    # slang / informal
    "wip": "work in progress", "lgtm": "looks good", "nvm": "never mind",
    "aint": "is not", "ain't": "is not", "gonna": "going to", "wanna": "want to",
    "pls": "please", "plz": "please", "thx": "thanks", "idk": "i do not know",
    # misspellings
    "fixd": "fixed", "fxied": "fixed", "fiexd": "fixed", "udpate": "update", "upate": "update",
    "dotor": "doctor", "teh": "the", "recieve": "receive", "seperate": "separate",
    "dependancy": "dependency", "funtion": "function", "lenght": "length",
    # Taglish (common in Filipino student repos)
    "ayos": "fixed", "inayos": "fixed", "ayusin": "fix", "dagdag": "add", "dinagdag": "added",
    "tinanggal": "removed", "tanggal": "remove", "bago": "new", "na": "", "yung": "the", "ung": "the",
}


def normalize(text):
    text = text.lower()
    out = []
    for tok in text.split():
        rep = NORMALIZE.get(tok, tok)
        if rep:
            out.append(rep)
    return " ".join(out)


# --- 4. tokenization -------------------------------------------------------------
TOKEN = re.compile(r"<\w+>|[a-z0-9]+(?:'[a-z]+)?")


def tokenize(text):
    return TOKEN.findall(NON_WORD.sub(" ", text))


# --- 5. stop words -----------------------------------------------------------------
# NLTK's English list, minus words that carry intent in commit messages.
KEEP = {"not", "no", "nor", "don't", "doesn't", "isn't", "won't", "can't", "against",
        "before", "after", "up", "down", "off", "over", "again", "more", "all", "only"}
STOP = set(stopwords.words("english")) - KEEP

# --- 6. stemming / lemmatization ------------------------------------------------------
_stem = PorterStemmer()
_lem = WordNetLemmatizer()
_POS = {"J": wordnet.ADJ, "V": wordnet.VERB, "N": wordnet.NOUN, "R": wordnet.ADV}


def stem(tokens):
    return [_stem.stem(t) for t in tokens]


def lemmatize(tokens):
    # Commit subjects are imperative ("fix", "add"), which taggers often call
    # nouns; a verb-first fallback keeps "fixes/fixed/fixing" -> "fix".
    out = []
    for tok, tag in pos_tag(tokens):
        pos = _POS.get(tag[0], wordnet.NOUN)
        lem = _lem.lemmatize(tok, pos)
        if lem == tok and pos == wordnet.NOUN:
            lem = _lem.lemmatize(tok, wordnet.VERB)
        out.append(lem)
    return out


def preprocess(text, *, do_clean=True, do_normalize=True, remove_stop=False, reduce=None):
    """Full pipeline. reduce = None | 'stem' | 'lemma'. Returns a token list."""
    text = scrub_pii(text)
    if do_clean:
        text = clean(text)
    text = normalize(text) if do_normalize else text.lower()
    tokens = tokenize(text)
    if remove_stop:
        tokens = [t for t in tokens if t not in STOP]
    if reduce == "stem":
        tokens = stem(tokens)
    elif reduce == "lemma":
        tokens = lemmatize(tokens)
    return tokens


def raw_tokens(text):
    """Baseline: whitespace split only, no cleaning at all."""
    return text.split()
