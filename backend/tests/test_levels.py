"""The five published levels, held to the rules approved for them.

Each level is played with its reference solution and the answer Jev really gave to its
reference sentence, recorded once in `fixtures/jev/<level-id>.json`. The questions, the global
Taboo and the tuning are copied here from the approved map, so a level that drifts from them
fails a test instead of shipping.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest
from pydantic import TypeAdapter

from railroad.board import build_board
from railroad.models import (
    Answer,
    Answers,
    Board,
    ChoiceAnswer,
    Level,
    NoulAnswer,
    ScoreAnswer,
    Switch,
    Tuning,
    load_levels,
    load_tuning,
)
from railroad.rules import check_sentence
from railroad.scoring import score
from railroad.simulate import simulate

FIXTURES = Path(__file__).parent / "fixtures" / "jev"

# The global Taboo, against sentences that name an exit or its place instead of the cargo
# (investigation H1). Every level carries it, digits included.
GLOBAL_TABOO = [
    "option",
    "choice",
    "choos",
    "pick",
    "select",
    "answer",
    "exit",
    "first",
    "second",
    "third",
    "last",
    "middle",
    "bottom",
    "left",
    "right",
    "yes",
    "ignor",
    "criteri",
    "true",
    "false",
    "verdad",
    "fals",
    "zero",
    "two",
    "three",
    "opç",
    "escolh",
    "selecion",
    "respond",
    "respost",
    "saída",
    "primeir",
    "segund",
    "terceir",
    "últim",
    "meio",
    "esquerd",
    "direit",
    "sim",
    "dois",
    "três",
    "tres",
    *[str(d) for d in range(10)],
]

CARGO_INSTRUCTIONS = "What does the cart carry?"
CARGO_CRITERIA = {"coal": "Coal", "gold": "Gold", "crystal": "Crystals and gemstones"}
DANGER_INSTRUCTIONS = "Is the cargo dangerous?"
DANGER_CRITERIA = {
    "true": "The cargo is hazardous: explosives, gunpowder, dynamite, toxic or volatile chemicals",
    "false": "The cargo is harmless: nothing in it can explode or hurt anyone",
}
DANGER_THRESHOLD = 0.50
URGENCY_INSTRUCTIONS = "How urgent is the delivery?"
URGENCY_CRITERIA = [
    "Calm: no hurry at all, the delivery can wait",
    "Normal: an ordinary delivery at the usual pace",
    "Rush: extremely urgent, it must arrive immediately",
]


@dataclass(frozen=True)
class Spec:
    """What the map approved for one level."""

    id: str
    name: str
    max_words: int
    taboo: list[str]
    """The level's own Taboo, before the global one is added."""
    cargo_keys: list[str] | None
    """The keys the cargo switch asks, in order, or None for a level without one."""
    path: dict[str, str]
    """The result each switch on the way to the mine takes, in the order the cart meets them."""
    stars: int
    """What the reference solution earns with the recorded answers."""


SPECS = [
    Spec("first-switch", "First Switch", 12, [], ["coal", "gold"], {"cargo": "gold"}, 3),
    Spec(
        "forbidden-words",
        "Forbidden Words",
        10,
        ["gold", "golden", "yellow", "ouro", "dourad", "amarel"],
        ["coal", "gold", "crystal"],
        {"cargo": "gold"},
        3,
    ),
    Spec(
        "the-gate",
        "The Gate",
        10,
        [
            "dynamite",
            "dinamit",
            "explosiv",
            "explos",
            "explod",
            "gunpowder",
            "pólvora",
            "powder",
            "bomb",
            "bomba",
            "tnt",
            "danger",
            "perig",
            "hazard",
            "toxic",
            "tóxic",
            "blast",
        ],
        None,
        {"danger": "yes"},
        3,
    ),
    Spec(
        "the-scale",
        "The Scale",
        10,
        [
            "urgen",
            "hurry",
            "fast",
            "quick",
            "pressa",
            "rápid",
            "rush",
            "asap",
            "now",
            "immediat",
            "imediat",
            "emergenc",
            "instant",
            "agora",
            "corre",
            "voand",
            "ontem",
            "second",
            "wait",
            "esper",
        ],
        None,
        {"urgency": "2"},
        3,
    ),
    Spec(
        "grand-junction",
        "Grand Junction",
        8,
        [
            "coal",
            "carvão",
            "black",
            "preto",
            "slow",
            "calm",
            "devagar",
            "tranquil",
            "rush",
            "hurry",
            "pressa",
            "urgen",
            "leisur",
            "whenever",
            "relax",
            "wait",
            "esper",
            "sosseg",
        ],
        ["coal", "gold", "crystal"],
        {"cargo": "coal", "danger": "no", "urgency": "0"},
        3,
    ),
]

each_level = pytest.mark.parametrize("spec", SPECS, ids=[s.id for s in SPECS])

_ANSWERS: TypeAdapter[dict[str, Answer]] = TypeAdapter(dict[str, Answer])


def level(level_id: str) -> Level:
    return load_levels()[level_id]


def recorded(level_id: str) -> Answers:
    return _ANSWERS.validate_json((FIXTURES / f"{level_id}.json").read_bytes())


def reference_board(lv: Level) -> Board:
    ref = lv.reference_solution
    assert ref is not None
    return build_board(lv, ref.rotations, ref.placements)


def answer_choosing(switch: Switch, result: str) -> Answer:
    """An answer that sends `switch` through the exit named `result`."""
    if switch.question.type == "choice":
        return ChoiceAnswer(type="choice", choice=result, confidence=1.0)
    if switch.question.type == "noul":
        return NoulAnswer(type="noul", noul=1.0 if result == "yes" else 0.0)
    return ScoreAnswer(type="score", score=float(result), confidence=1.0)


def test_the_five_levels_load_in_order() -> None:
    levels = load_levels()
    assert list(levels) == [s.id for s in SPECS]
    assert [lv.order for lv in levels.values()] == [1, 2, 3, 4, 5]
    assert [lv.name for lv in levels.values()] == [s.name for s in SPECS]


def test_the_tuning_is_the_approved_one() -> None:
    assert load_tuning() == Tuning(choice_min_confidence=0.85, noul_margin=0.25, score_margin=0.25)


@each_level
def test_every_level_holds_the_whole_global_taboo(spec: Spec) -> None:
    assert set(GLOBAL_TABOO) <= set(level(spec.id).taboo)


@each_level
def test_every_level_holds_its_own_taboo_and_word_limit(spec: Spec) -> None:
    lv = level(spec.id)
    assert set(lv.taboo) == set(spec.taboo) | set(GLOBAL_TABOO)
    assert lv.max_words == spec.max_words


@each_level
def test_every_board_fits_a_phone(spec: Spec) -> None:
    lv = level(spec.id)
    assert lv.width <= 10
    assert lv.height <= 6


@each_level
def test_the_questions_are_the_approved_ones(spec: Spec) -> None:
    switches = level(spec.id).switches
    assert [s.id for s in switches] == list(spec.path)
    for switch in switches:
        asked = switch.question.model_dump()
        if switch.id == "cargo":
            assert spec.cargo_keys is not None
            assert asked == {
                "type": "choice",
                "instructions": CARGO_INSTRUCTIONS,
                "criteria": {k: CARGO_CRITERIA[k] for k in spec.cargo_keys},
            }
        elif switch.id == "danger":
            assert asked == {
                "type": "noul",
                "instructions": DANGER_INSTRUCTIONS,
                "criteria": DANGER_CRITERIA,
            }
            assert switch.threshold == DANGER_THRESHOLD
        else:
            assert switch.id == "urgency"
            assert asked == {
                "type": "score",
                "instructions": URGENCY_INSTRUCTIONS,
                "criteria": URGENCY_CRITERIA,
            }


@each_level
def test_the_reference_sentence_keeps_the_rules(spec: Spec) -> None:
    lv = level(spec.id)
    assert lv.reference_solution is not None
    check_sentence(lv, lv.reference_solution.sentence)


@each_level
def test_the_reference_solution_arrives_with_the_recorded_answers(spec: Spec) -> None:
    lv = level(spec.id)
    board = reference_board(lv)
    sim = simulate(lv, board, recorded(spec.id))
    assert sim.outcome == "arrived"
    assert [(r.switch_id, r.result) for r in sim.readings] == list(spec.path.items())
    assert board.placed == lv.par_pieces
    assert score(lv, board, sim, load_tuning()) == spec.stars


@each_level
def test_the_level_does_not_start_solved(spec: Spec) -> None:
    lv = level(spec.id)
    sim = simulate(lv, build_board(lv, [], []), recorded(spec.id))
    assert sim.outcome != "arrived"


@each_level
def test_the_reference_solution_rotates_and_from_level_two_places(spec: Spec) -> None:
    lv = level(spec.id)
    assert lv.reference_solution is not None
    assert lv.reference_solution.rotations
    assert bool(lv.reference_solution.placements) == (lv.order >= 2)


@each_level
def test_every_other_exit_of_every_switch_ends_in_a_tunnel(spec: Spec) -> None:
    lv = level(spec.id)
    board = reference_board(lv)
    for switch in lv.switches:
        for result in switch.exits:
            if result == spec.path[switch.id]:
                continue
            answers = {**recorded(spec.id), switch.id: answer_choosing(switch, result)}
            sim = simulate(lv, board, answers)
            assert sim.outcome == "wrong_tunnel", (switch.id, result)
