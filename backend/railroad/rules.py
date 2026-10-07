"""The rules a sentence has to keep before the cart is allowed to carry it.

## What a word is

A word is a run of letters and digits, as Unicode counts them. Everything else separates words:
spaces, punctuation, hyphens, apostrophes. So `don't` is two words, `don` and `t`, and
`gold-ish` is `gold` and `ish`. The same definition counts words for `max_words` and finds them
for the Taboo, so the two rules can never disagree about what the player wrote.

Invisible characters are removed before the sentence is split: every formatting character
(Unicode category `Cf`: the soft hyphen, the zero-width space, the word joiner and the like) and
every other code point Unicode marks Default_Ignorable_Code_Point (variation selectors, the
combining grapheme joiner, the Hangul fillers and the like). So they can neither split a word
nor hide one from the Taboo: `go`, a zero-width space or a variation selector, and `ld` are the
one word `gold`. Marks of every kind (category `M`) go too, when the sentence is folded below.
All of this is for finding words only; `too_long` still counts every character the player sent.

## How the Taboo compares

Both the sentence and the level's terms are folded the same way before they meet: decomposed
(NFKD), casefolded, decomposed again, and stripped of every mark (category `M`). `OURO`,
`Ouro`, `óuro` and `OURO` written in mathematical bold letters are then one word, and `dourad`
reaches `Dourado`. A term blocks every word that *starts* with it, because a list of whole
words would be beaten by the first plural or suffix (`golden`, `ourives`).

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

# `\w` without the underscore: letters and digits in any script. Marks and invisible characters
# are already gone by the time this runs, so a word is not split at an accent or at a variation
# selector.
_WORD = re.compile(r"[^\W_]+")

# The code points with the Default_Ignorable_Code_Point property, one pair per line of
# DerivedCoreProperties-15.0.0.txt (https://www.unicode.org/Public/15.0.0/ucd/
# DerivedCoreProperties.txt, dated 2022-08-05), the Unicode version of Python 3.12's
# `unicodedata`. `unicodedata` does not expose the property, hence the table.
DEFAULT_IGNORABLE_VERSION = "15.0.0"
DEFAULT_IGNORABLE: tuple[tuple[int, int], ...] = (
    (0x00AD, 0x00AD),  # Cf SOFT HYPHEN
    (0x034F, 0x034F),  # Mn COMBINING GRAPHEME JOINER
    (0x061C, 0x061C),  # Cf ARABIC LETTER MARK
    (0x115F, 0x1160),  # Lo HANGUL CHOSEONG FILLER..HANGUL JUNGSEONG FILLER
    (0x17B4, 0x17B5),  # Mn KHMER VOWEL INHERENT AQ..KHMER VOWEL INHERENT AA
    (0x180B, 0x180D),  # Mn MONGOLIAN FREE VARIATION SELECTOR ONE..THREE
    (0x180E, 0x180E),  # Cf MONGOLIAN VOWEL SEPARATOR
    (0x180F, 0x180F),  # Mn MONGOLIAN FREE VARIATION SELECTOR FOUR
    (0x200B, 0x200F),  # Cf ZERO WIDTH SPACE..RIGHT-TO-LEFT MARK
    (0x202A, 0x202E),  # Cf LEFT-TO-RIGHT EMBEDDING..RIGHT-TO-LEFT OVERRIDE
    (0x2060, 0x2064),  # Cf WORD JOINER..INVISIBLE PLUS
    (0x2065, 0x2065),  # Cn <reserved-2065>
    (0x2066, 0x206F),  # Cf LEFT-TO-RIGHT ISOLATE..NOMINAL DIGIT SHAPES
    (0x3164, 0x3164),  # Lo HANGUL FILLER
    (0xFE00, 0xFE0F),  # Mn VARIATION SELECTOR-1..VARIATION SELECTOR-16
    (0xFEFF, 0xFEFF),  # Cf ZERO WIDTH NO-BREAK SPACE
    (0xFFA0, 0xFFA0),  # Lo HALFWIDTH HANGUL FILLER
    (0xFFF0, 0xFFF8),  # Cn <reserved-FFF0>..<reserved-FFF8>
    (0x1BCA0, 0x1BCA3),  # Cf SHORTHAND FORMAT LETTER OVERLAP..SHORTHAND FORMAT UP STEP
    (0x1D173, 0x1D17A),  # Cf MUSICAL SYMBOL BEGIN BEAM..MUSICAL SYMBOL END PHRASE
    (0xE0000, 0xE0000),  # Cn <reserved-E0000>
    (0xE0001, 0xE0001),  # Cf LANGUAGE TAG
    (0xE0002, 0xE001F),  # Cn <reserved-E0002>..<reserved-E001F>
    (0xE0020, 0xE007F),  # Cf TAG SPACE..CANCEL TAG
    (0xE0080, 0xE00FF),  # Cn <reserved-E0080>..<reserved-E00FF>
    (0xE0100, 0xE01EF),  # Mn VARIATION SELECTOR-17..VARIATION SELECTOR-256
    (0xE01F0, 0xE0FFF),  # Cn <reserved-E01F0>..<reserved-E0FFF>
)
_IGNORABLE = re.compile(
    "[" + "".join(f"{re.escape(chr(a))}-{re.escape(chr(b))}" for a, b in DEFAULT_IGNORABLE) + "]"
)


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
    return "".join(ch for ch in decomposed if not unicodedata.category(ch).startswith("M"))


def words(sentence: str) -> list[str]:
    """The words of `sentence`, folded, once its invisible characters are gone."""
    visible = "".join(ch for ch in sentence if unicodedata.category(ch) != "Cf")
    return _WORD.findall(fold(_IGNORABLE.sub("", visible)))


def check_sentence(level: Level, sentence: str) -> None:
    """Refuse `sentence` if it breaks one of `level`'s rules.

    The checks run in a fixed order, and the first one broken is the one reported: empty, too
    long, too many words, Taboo. A sentence is empty when it has no word at all, so blanks,
    punctuation or emoji alone are `empty_sentence`, and that is checked before the length: 300
    `!` are `empty_sentence`, not `too_long`. The length is counted on the sentence as sent,
    formatting characters included.

    :raises RuleViolation: `empty_sentence`, `too_long`, `too_many_words` or `taboo`.
    """
    found = words(sentence)
    if not found:
        raise RuleViolation("empty_sentence", "the sentence has no words")
    if len(sentence) > MAX_CHARACTERS:
        raise RuleViolation("too_long", f"the sentence is longer than {MAX_CHARACTERS} characters")
    if len(found) > level.max_words:
        raise RuleViolation(
            "too_many_words",
            f"the sentence has {len(found)} words and this level allows {level.max_words}",
        )
    hit = [term for term in level.taboo if any(w.startswith(fold(term)) for w in found)]
    if hit:
        raise RuleViolation("taboo", f"forbidden on this level: {', '.join(hit)}")
