from __future__ import annotations

from collections.abc import Callable

import pytest

from railroad.models import Cell, Level, RuleViolation
from railroad.rules import check_sentence, words


@pytest.fixture
def level(make_level: Callable[..., Level]) -> Level:
    return make_level(
        [Cell(x=0, y=0, kind="start"), Cell(x=1, y=0, kind="mine")],
        taboo=["gold", "our", "dourad", "carvão"],
        max_words=5,
    )


def violation(level: Level, sentence: str) -> RuleViolation:
    with pytest.raises(RuleViolation) as caught:
        check_sentence(level, sentence)
    return caught.value


@pytest.mark.parametrize(
    "sentence",
    [
        "the cart carries coal",
        "Five words is the limit",
        "a" * 200,  # one word of exactly 200 characters
        "marigold",  # a term blocks words that start with it, not words that contain it
        "golpe",  # `gol` is not `gold`
    ],
)
def test_accepts(level: Level, sentence: str) -> None:
    check_sentence(level, sentence)


@pytest.mark.parametrize("sentence", ["", "   ", "\t\n "])
def test_refuses_an_empty_sentence(level: Level, sentence: str) -> None:
    assert violation(level, sentence).kind == "empty_sentence"


def test_refuses_more_than_200_characters(level: Level) -> None:
    assert violation(level, "a" * 201).kind == "too_long"


def test_the_length_counts_formatting_characters(level: Level) -> None:
    # Removed for finding words, but still part of what the player sent.
    assert violation(level, "a" * 200 + "\u200b").kind == "too_long"


def test_refuses_more_words_than_the_level_allows(level: Level) -> None:
    v = violation(level, "one two three four five six")
    assert v.kind == "too_many_words"
    assert "6" in v.detail and "5" in v.detail


@pytest.mark.parametrize(
    ("sentence", "expected"),
    [
        ("don't stop", ["don", "t", "stop"]),
        ("rock-solid, heavy!", ["rock", "solid", "heavy"]),
        ("snake_case", ["snake", "case"]),
        ("CARVÃO 42", ["carvao", "42"]),
        ("  ", []),
        ("go\u200bld", ["gold"]),  # a formatting character does not split a word
        ("ou\u00adro", ["ouro"]),
    ],
)
def test_a_word_is_a_run_of_letters_and_digits(sentence: str, expected: list[str]) -> None:
    assert words(sentence) == expected


def test_punctuation_counts_no_words(level: Level) -> None:
    # Five words once punctuation and the hyphen split them: at the limit, not over it.
    check_sentence(level, "one-two, three... four; five!")
    assert violation(level, "one-two, three... four; five! six").kind == "too_many_words"


def test_formatting_characters_count_no_words(level: Level) -> None:
    # A zero-width space inside `five` and a word joiner inside `four`: still five words.
    check_sentence(level, "one two three fo\u2060ur fi\u200bve")


@pytest.mark.parametrize(
    ("sentence", "term"),
    [
        ("a bag of gold", "gold"),
        ("GOLD", "gold"),
        ("Golden hour", "gold"),
        ("o ouro da mina", "our"),
        ("um ourives", "our"),
        ("o Dourado", "dourad"),
        ("DOURADÍSSIMO", "dourad"),
        ("gold!", "gold"),
        ("(ouro)", "our"),
        ("pure,gold", "gold"),
        ("góld", "gold"),  # an accent in the sentence does not hide the word
        ("carvao", "carvão"),  # nor does leaving one out of a term that has it
        ("CARVÃO", "carvão"),
        # Styled letters: mathematical bold capitals have no lower case until decomposed.
        ("\U0001d406\U0001d40e\U0001d40b\U0001d403 bars", "gold"),
        ("\U0001d40e\U0001d414\U0001d411\U0001d40e", "our"),
        ("\U0001d420\U0001d428\U0001d425\U0001d41d", "gold"),  # mathematical bold small
        ("\uff27\uff2f\uff2c\uff24", "gold"),  # fullwidth
        # Formatting characters do not split a word away from the Taboo.
        ("go\u200bld", "gold"),  # zero-width space
        ("ou\u00adro", "our"),  # soft hyphen
        ("g\u2060old", "gold"),  # word joiner
    ],
)
def test_refuses_a_taboo_word(level: Level, sentence: str, term: str) -> None:
    v = violation(level, sentence)
    assert v.kind == "taboo"
    assert v.detail == f"forbidden on this level: {term}"


def test_taboo_lists_every_term_hit_as_the_level_writes_it(level: Level) -> None:
    v = violation(level, "golden carvaozinho and ouro")
    assert v.kind == "taboo"
    assert v.detail == "forbidden on this level: gold, our, carvão"


@pytest.mark.parametrize(
    ("sentence", "kind"),
    [
        ("x" * 150 + " Zanzibar " + "y" * 50, "too_long"),
        ("Zanzibar one two three four five", "too_many_words"),
        ("Zanzibar golden", "taboo"),
        ("Zanzibar Ourives", "taboo"),
    ],
)
def test_the_detail_never_echoes_the_sentence(level: Level, sentence: str, kind: str) -> None:
    v = violation(level, sentence)
    assert v.kind == kind
    assert "zanzibar" not in v.detail.casefold()
    # Not the offending word either: the detail names the level's term.
    assert "golden" not in v.detail.casefold()
    assert "ourives" not in v.detail.casefold()
    assert str(v) == v.detail
