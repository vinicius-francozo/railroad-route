"""The rules a sentence has to keep before the cart is allowed to carry it.

## What a word is

A word is a run of letters and digits, as Unicode counts them. Everything else separates words:
spaces, punctuation, hyphens, apostrophes. So `don't` is two words, `don` and `t`, and
`gold-ish` is `gold` and `ish`. The same definition counts words for `max_words` and finds them
for the Taboo, so the two rules can never disagree about what the player wrote.

Formatting characters (Unicode category `Cf`: the soft hyphen, the zero-width space, the word
joiner and the like) are removed before the sentence is split, so they can neither split a word
nor hide one from the Taboo: `go`, a zero-width space and `ld` are the one word `gold`. They
are removed for finding words only; `too_long` still counts every character the player sent.

## How the Taboo compares

Both the sentence and the level's terms are folded the same way before they meet: decomposed
(NFKD), casefolded, decomposed again, and stripped of combining marks. `OURO`, `Ouro`, `óuro`
and `OURO` written in mathematical bold letters are then one word, and `dourad` reaches
`Dourado`. A term blocks every word that *starts* with it, because a list of whole words would
be beaten by the first plural or suffix (`golden`, `ourives`).

## What a refusal says

`detail` never repeats the sentence, not even the offending word. For the Taboo it names the
level's own terms that were hit, which the player can already see on the level, so nothing
the request carried comes back in the error.
"""

from __future__ import annotations

import re
import unicodedata

from railroad.models import Level, RuleViolation

MAX_CHARACTERS = 200

# `\w` without the underscore: letters and digits in any script. Combining marks are already
# gone by the time this runs, so an accented word is not split at its accent.
_WORD = re.compile(r"[^\W_]+")


def fold(text: str) -> str:
    """`text` with case and accents taken out, so `Dourado` and `dourado` compare equal.

    The first decomposition comes before the casefold because some letters only get a lower
    case once decomposed: a mathematical bold `G` (U+1D406) has none, and NFKD turns it into
    `G`. The second one comes after it because casefolding can itself produce a combining
    mark (`İ` folds to `i` plus a dot above), which the decomposition and the strip then
    remove. Checked over every code point, the result is then stable: folding it again changes
    nothing.
    """
    decomposed = unicodedata.normalize("NFKD", unicodedata.normalize("NFKD", text).casefold())
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def words(sentence: str) -> list[str]:
    """The words of `sentence`, folded, once its formatting characters are gone."""
    visible = "".join(ch for ch in sentence if unicodedata.category(ch) != "Cf")
    return _WORD.findall(fold(visible))


def check_sentence(level: Level, sentence: str) -> None:
    """Refuse `sentence` if it breaks one of `level`'s rules.

    The checks run cheapest first, and the first one broken is the one reported.

    :raises RuleViolation: `empty_sentence`, `too_long`, `too_many_words` or `taboo`.
    """
    if not sentence.strip():
        raise RuleViolation("empty_sentence", "the sentence is empty")
    if len(sentence) > MAX_CHARACTERS:
        raise RuleViolation("too_long", f"the sentence is longer than {MAX_CHARACTERS} characters")
    found = words(sentence)
    if len(found) > level.max_words:
        raise RuleViolation(
            "too_many_words",
            f"the sentence has {len(found)} words and this level allows {level.max_words}",
        )
    hit = [term for term in level.taboo if any(w.startswith(fold(term)) for w in found)]
    if hit:
        raise RuleViolation("taboo", f"forbidden on this level: {', '.join(hit)}")
