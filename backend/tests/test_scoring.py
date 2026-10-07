from __future__ import annotations

from collections.abc import Callable

import pytest

from railroad.models import Board, Cell, Level, Outcome, Reading, Simulation, Tuning
from railroad.scoring import is_clean, score


def choice(confidence: float) -> Reading:
    return Reading(
        switch_id="cargo",
        type="choice",
        result="gold",
        confidence=confidence,
        margin=confidence,
    )


def noul(margin: float) -> Reading:
    return Reading(switch_id="danger", type="noul", result="no", margin=margin)


def scored(margin: float) -> Reading:
    return Reading(switch_id="urgency", type="score", result="2", margin=margin)


@pytest.mark.parametrize(
    ("reading", "clean"),
    [
        (choice(0.8), True),  # at the limit is clean
        (choice(0.799), False),
        (choice(1.0), True),
        (noul(0.15), True),
        (noul(0.149), False),
        (noul(0.5), True),
        (scored(0.25), True),
        (scored(0.249), False),
        (scored(0.0), False),
    ],
)
def test_is_clean_at_each_margins_edge(reading: Reading, clean: bool, tuning: Tuning) -> None:
    assert is_clean(reading, tuning) is clean


def test_each_type_is_held_to_its_own_margin(tuning: Tuning) -> None:
    # 0.2 clears the noul margin (0.15) and misses the choice (0.8) and score (0.25) ones.
    assert is_clean(noul(0.2), tuning)
    assert not is_clean(choice(0.2), tuning)
    assert not is_clean(scored(0.2), tuning)


@pytest.fixture
def level(make_level: Callable[..., Level]) -> Level:
    return make_level(
        [Cell(x=0, y=0, kind="start"), Cell(x=1, y=0, kind="mine")],
        par_pieces=2,
    )


def stars(level: Level, tuning: Tuning, sim: Simulation, placed: int = 0) -> int:
    return score(level, Board(cells={}, placed=placed), sim, tuning)


@pytest.mark.parametrize("outcome", ["derailed", "wrong_tunnel", "loop"])
def test_no_star_without_arriving(level: Level, tuning: Tuning, outcome: Outcome) -> None:
    assert stars(level, tuning, Simulation(outcome=outcome, path=[], readings=[choice(1.0)])) == 0


def test_no_star_for_a_run_waiting_on_jev(level: Level, tuning: Tuning) -> None:
    assert stars(level, tuning, Simulation(outcome=None, path=[], needs_jev=True)) == 0


def test_one_star_when_a_switch_decided_by_a_hair(level: Level, tuning: Tuning) -> None:
    sim = Simulation(outcome="arrived", path=[], readings=[choice(0.95), noul(0.149)])
    assert stars(level, tuning, sim) == 1


def test_two_stars_over_par(level: Level, tuning: Tuning) -> None:
    sim = Simulation(outcome="arrived", path=[], readings=[choice(0.8), scored(0.25)])
    assert stars(level, tuning, sim, placed=3) == 2


@pytest.mark.parametrize("placed", [0, 2])
def test_three_stars_at_or_under_par(level: Level, tuning: Tuning, placed: int) -> None:
    sim = Simulation(outcome="arrived", path=[], readings=[choice(0.8), noul(0.15)])
    assert stars(level, tuning, sim, placed=placed) == 3


def test_no_switch_on_the_path_counts_as_clean(level: Level, tuning: Tuning) -> None:
    assert stars(level, tuning, Simulation(outcome="arrived", path=[])) == 3
    assert stars(level, tuning, Simulation(outcome="arrived", path=[]), placed=3) == 2


def test_the_clean_flag_on_a_reading_is_not_trusted(level: Level, tuning: Tuning) -> None:
    # The app sets `clean` from `is_clean`; the stars are worked out from the margin again.
    hair = noul(0.01).model_copy(update={"clean": True})
    assert stars(level, tuning, Simulation(outcome="arrived", path=[], readings=[hair])) == 1
