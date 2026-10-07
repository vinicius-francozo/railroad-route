from __future__ import annotations

from collections.abc import Callable

import pytest

from railroad import simulate as sim_module
from railroad.board import build_board
from railroad.models import (
    Answer,
    Answers,
    Cell,
    ChoiceAnswer,
    ChoiceQuestion,
    Level,
    NoulAnswer,
    NoulQuestion,
    PieceKind,
    Reading,
    ScoreAnswer,
    ScoreQuestion,
    Side,
    Simulation,
    Switch,
)
from railroad.simulate import opens, simulate

MakeLevel = Callable[..., Level]
Step = tuple[int, int, Side | None, Side | None]


def run(level: Level, answers: Answers | None = None) -> Simulation:
    return simulate(level, build_board(level, [], []), answers)


def steps(sim: Simulation) -> list[Step]:
    return [(s.x, s.y, s.from_side, s.to_side) for s in sim.path]


def cargo(x: int, y: int, exits: dict[str, Side], entry: Side = "W") -> Switch:
    return Switch(
        id="cargo",
        x=x,
        y=y,
        entry=entry,
        question=ChoiceQuestion(
            type="choice", instructions="?", criteria={k: k for k in sorted(exits)}
        ),
        exits=exits,
    )


def danger(x: int, y: int, exits: dict[str, Side], threshold: float = 0.5) -> Switch:
    return Switch(
        id="danger",
        x=x,
        y=y,
        entry="W",
        question=NoulQuestion(
            type="noul", instructions="?", criteria={"true": "yes", "false": "no"}
        ),
        exits=exits,
        threshold=threshold,
    )


def urgency(x: int, y: int, exits: dict[str, Side]) -> Switch:
    return Switch(
        id="urgency",
        x=x,
        y=y,
        entry="W",
        question=ScoreQuestion(type="score", instructions="?", criteria=["calm", "normal", "rush"]),
        exits=exits,
    )


def choice(value: str, confidence: float = 0.9) -> ChoiceAnswer:
    return ChoiceAnswer(type="choice", choice=value, confidence=confidence)


def noul(value: float) -> NoulAnswer:
    return NoulAnswer(type="noul", noul=value)


def score(value: float) -> ScoreAnswer:
    return ScoreAnswer(type="score", score=value, confidence=0.9)


# --- Geometry ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("kind", "at_zero"),
    [
        ("straight", "NS"),
        ("curve", "NE"),
        ("cross", "NESW"),
        ("start", "E"),
        ("mine", "W"),
        ("tunnel", "W"),
        ("rock", ""),
    ],
)
def test_each_kind_opens_as_the_contract_says_and_turns_clockwise(
    kind: PieceKind, at_zero: str
) -> None:
    clockwise = {"N": "E", "E": "S", "S": "W", "W": "N"}
    expected = set(at_zero)
    for rotation in range(4):
        assert opens(kind, rotation) == expected, rotation
        expected = {clockwise[s] for s in expected}


# --- The four endings -------------------------------------------------------------------------


def test_arrives_through_a_rotated_straight(make_level: MakeLevel) -> None:
    level = make_level(
        [
            Cell(x=0, y=0, kind="start"),
            Cell(x=1, y=0, kind="straight", rotation=1),
            Cell(x=2, y=0, kind="mine"),
        ]
    )
    sim = run(level)
    assert sim.outcome == "arrived"
    assert not sim.needs_jev
    assert steps(sim) == [(0, 0, None, "E"), (1, 0, "W", "E"), (2, 0, "W", None)]


def test_every_kind_works_turned(make_level: MakeLevel) -> None:
    # A start facing south, a turned cross, curves at rotations 0, 2 and 3, and a mine facing
    # east. Rotation 1 of a curve is in the cross test below.
    #
    #   x:  0                 1                  2
    # y 0   start (opens S)   .                  .
    # y 1   curve0 (N, E)     cross              curve2 (S, W)
    # y 2   .                 mine (opens E)     curve3 (W, N)
    level = make_level(
        [
            Cell(x=0, y=0, kind="start", rotation=1),
            Cell(x=0, y=1, kind="curve", rotation=0),
            Cell(x=1, y=1, kind="cross", rotation=1),
            Cell(x=2, y=1, kind="curve", rotation=2),
            Cell(x=2, y=2, kind="curve", rotation=3),
            Cell(x=1, y=2, kind="mine", rotation=2),
        ],
        width=3,
    )
    sim = run(level)
    assert sim.outcome == "arrived"
    assert steps(sim) == [
        (0, 0, None, "S"),
        (0, 1, "N", "E"),
        (1, 1, "W", "E"),
        (2, 1, "W", "S"),
        (2, 2, "N", "W"),
        (1, 2, "E", None),
    ]


def test_wrong_tunnel(make_level: MakeLevel) -> None:
    level = make_level(
        [
            Cell(x=0, y=0, kind="start"),
            Cell(x=1, y=0, kind="tunnel"),
            Cell(x=3, y=2, kind="mine"),
        ]
    )
    sim = run(level)
    assert sim.outcome == "wrong_tunnel"
    assert steps(sim) == [(0, 0, None, "E"), (1, 0, "W", None)]


@pytest.mark.parametrize(
    ("ahead", "why"),
    [
        (None, "an empty cell"),
        (Cell(x=1, y=1, kind="rock"), "rock"),
        (Cell(x=1, y=1, kind="straight"), "a straight across the way"),
        (Cell(x=1, y=1, kind="curve", rotation=0), "a curve open N and E"),
        (Cell(x=1, y=1, kind="mine", rotation=2), "the mine's back"),
        (Cell(x=1, y=1, kind="tunnel", rotation=1), "a tunnel's side"),
    ],
)
def test_derails_short_of_the_cell_ahead(
    make_level: MakeLevel, ahead: Cell | None, why: str
) -> None:
    cells = [Cell(x=0, y=1, kind="start")]
    if ahead is not None:
        cells.append(ahead)
    if ahead is None or ahead.kind != "mine":
        cells.append(Cell(x=3, y=0, kind="mine"))
    sim = run(make_level(cells))
    assert sim.outcome == "derailed", why
    # The path ends on the last cell the cart was on, `to_side` the way it went off the rails.
    assert steps(sim) == [(0, 1, None, "E")]


def test_derails_off_the_grid_after_a_curve(make_level: MakeLevel) -> None:
    level = make_level(
        [
            Cell(x=0, y=0, kind="start"),
            Cell(x=1, y=0, kind="curve", rotation=3),  # W, N
            Cell(x=3, y=2, kind="mine"),
        ]
    )
    sim = run(level)
    assert sim.outcome == "derailed"
    assert steps(sim) == [(0, 0, None, "E"), (1, 0, "W", "N")]


def test_derails_when_the_start_faces_the_edge(make_level: MakeLevel) -> None:
    level = make_level([Cell(x=0, y=0, kind="start", rotation=2), Cell(x=3, y=2, kind="mine")])
    sim = run(level)
    assert sim.outcome == "derailed"
    assert steps(sim) == [(0, 0, None, "W")]


def test_a_cross_crossed_on_both_axes_is_not_a_loop(make_level: MakeLevel) -> None:
    #   x:  0       1        2
    # y 0   .       curve1   curve2
    # y 1   start   cross    curve3
    # y 2   .       mine1    .
    level = make_level(
        [
            Cell(x=0, y=1, kind="start"),
            Cell(x=1, y=1, kind="cross"),
            Cell(x=2, y=1, kind="curve", rotation=3),
            Cell(x=2, y=0, kind="curve", rotation=2),
            Cell(x=1, y=0, kind="curve", rotation=1),
            Cell(x=1, y=2, kind="mine", rotation=1),
        ],
        width=3,
    )
    sim = run(level)
    assert sim.outcome == "arrived"
    assert steps(sim) == [
        (0, 1, None, "E"),
        (1, 1, "W", "E"),
        (2, 1, "W", "N"),
        (2, 0, "S", "W"),
        (1, 0, "E", "S"),
        (1, 1, "N", "S"),
        (1, 2, "N", None),
    ]


@pytest.fixture
def junction(monkeypatch: pytest.MonkeyPatch) -> Callable[[PieceKind, int, Side, Side], None]:
    """Make one piece also open on `extra`, leading out through `out`.

    No level can reach a loop or the start with today's pieces (the module docstring of
    `simulate` says why), so the two guards that end those runs are reached by standing in a
    passive junction, the piece v1 leaves out, for one kind and rotation.
    """

    def install(kind: PieceKind, rotation: int, extra: Side, out: Side) -> None:
        real_opens = sim_module.opens
        real_through = sim_module._through

        def opens_(k: PieceKind, r: int) -> set[Side]:
            return real_opens(k, r) | ({extra} if (k, r) == (kind, rotation) else set())

        def through(k: PieceKind, r: int, entry: Side) -> Side:
            if (k, r) != (kind, rotation):
                return real_through(k, r, entry)
            if entry == extra:
                return out
            (other,) = real_opens(k, r) - {entry}
            return other

        monkeypatch.setattr(sim_module, "opens", opens_)
        monkeypatch.setattr(sim_module, "_through", through)

    return install


def test_loop_when_the_cart_enters_a_cell_through_the_same_side_twice(
    make_level: MakeLevel, junction: Callable[[PieceKind, int, Side, Side], None]
) -> None:
    #   x:  0       1                  2
    # y 0   start   curve2 (+E -> S)   curve2
    # y 1   .       curve0             curve3
    junction("curve", 2, "E", "S")
    level = make_level(
        [
            Cell(x=0, y=0, kind="start"),
            Cell(x=1, y=0, kind="curve", rotation=2),
            Cell(x=1, y=1, kind="curve", rotation=0),
            Cell(x=2, y=1, kind="curve", rotation=3),
            Cell(x=2, y=0, kind="curve", rotation=2),
            Cell(x=0, y=2, kind="mine"),
        ],
        width=3,
    )
    sim = run(level)
    assert sim.outcome == "loop"
    # The last step points back into (1, 1), which the cart already entered from the north.
    assert steps(sim) == [
        (0, 0, None, "E"),
        (1, 0, "W", "S"),
        (1, 1, "N", "E"),
        (2, 1, "W", "N"),
        (2, 0, "S", "W"),
        (1, 0, "E", "S"),
    ]


def test_entering_the_start_derails(
    make_level: MakeLevel, junction: Callable[[PieceKind, int, Side, Side], None]
) -> None:
    #   x:  0       1                    2
    # y 0   start   straight1 (+S -> W)  curve2
    # y 1   .       curve0               curve3
    junction("straight", 1, "S", "W")
    level = make_level(
        [
            Cell(x=0, y=0, kind="start"),
            Cell(x=1, y=0, kind="straight", rotation=1),
            Cell(x=2, y=0, kind="curve", rotation=2),
            Cell(x=2, y=1, kind="curve", rotation=3),
            Cell(x=1, y=1, kind="curve", rotation=0),
            Cell(x=0, y=2, kind="mine"),
        ],
        width=3,
    )
    sim = run(level)
    assert sim.outcome == "derailed"
    assert steps(sim)[-1] == (1, 0, "S", "W")


# --- Switches ---------------------------------------------------------------------------------


@pytest.fixture
def forked(make_level: MakeLevel) -> Level:
    #   x:  0       1                 2
    # y 0   .       tunnel (opens S)  .
    # y 1   start   cargo             mine
    return make_level(
        [
            Cell(x=0, y=1, kind="start"),
            Cell(x=1, y=0, kind="tunnel", rotation=3),
            Cell(x=2, y=1, kind="mine"),
        ],
        [cargo(1, 1, {"gold": "E", "coal": "N"})],
    )


def test_without_answers_the_run_stops_on_the_switch(forked: Level) -> None:
    sim = run(forked)
    assert sim.needs_jev
    assert sim.outcome is None
    assert sim.readings == []
    assert steps(sim) == [(0, 1, None, "E"), (1, 1, "W", None)]


def test_a_derail_before_the_switch_does_not_need_jev(make_level: MakeLevel) -> None:
    level = make_level(
        [Cell(x=0, y=1, kind="start", rotation=3), Cell(x=2, y=1, kind="mine")],
        [cargo(1, 1, {"gold": "E", "coal": "N"})],
    )
    sim = run(level)
    assert sim.outcome == "derailed"
    assert not sim.needs_jev


def test_a_switch_entered_from_the_wrong_side_derails(make_level: MakeLevel) -> None:
    level = make_level(
        [Cell(x=0, y=1, kind="start"), Cell(x=3, y=1, kind="mine")],
        [cargo(1, 1, {"gold": "E", "coal": "N"}, entry="S")],
    )
    sim = run(level)
    assert sim.outcome == "derailed"
    assert not sim.needs_jev
    assert steps(sim) == [(0, 1, None, "E")]


@pytest.mark.parametrize(
    ("answer", "outcome", "out"),
    [(choice("gold", 0.93), "arrived", "E"), (choice("coal", 0.6), "wrong_tunnel", "N")],
)
def test_choice_takes_the_exit_of_the_answer(
    forked: Level, answer: ChoiceAnswer, outcome: str, out: Side
) -> None:
    sim = run(forked, {"cargo": answer})
    assert sim.outcome == outcome
    assert steps(sim)[1] == (1, 1, "W", out)
    assert sim.readings == [
        Reading(
            switch_id="cargo",
            type="choice",
            result=answer.choice,
            confidence=answer.confidence,
            margin=answer.confidence,
        )
    ]


@pytest.fixture
def gate(make_level: MakeLevel) -> Level:
    return make_level(
        [
            Cell(x=0, y=1, kind="start"),
            Cell(x=1, y=2, kind="tunnel", rotation=1),
            Cell(x=2, y=1, kind="mine"),
        ],
        [danger(1, 1, {"no": "E", "yes": "S"}, threshold=0.5)],
    )


@pytest.mark.parametrize(
    ("value", "result", "outcome", "margin"),
    [
        (0.2, "no", "arrived", 0.3),
        (0.65, "yes", "wrong_tunnel", 0.15),
        (0.5, "yes", "wrong_tunnel", 0.0),  # at the threshold is yes
        (0.499, "no", "arrived", 0.001),
    ],
)
def test_noul_is_yes_from_the_threshold_up(
    gate: Level, value: float, result: str, outcome: str, margin: float
) -> None:
    sim = run(gate, {"danger": noul(value)})
    assert sim.outcome == outcome
    (reading,) = sim.readings
    assert (reading.result, reading.noul, reading.threshold) == (result, value, 0.5)
    assert reading.margin == margin


def test_noul_margin_lands_on_the_decimal_it_stands_for(make_level: MakeLevel) -> None:
    # 0.35 - 0.2 is 0.14999999999999997 in floats; the margin is 0.15, and so clean at 0.15.
    level = make_level(
        [Cell(x=0, y=1, kind="start"), Cell(x=2, y=1, kind="mine")],
        [danger(1, 1, {"no": "E", "yes": "S"}, threshold=0.2)],
    )
    (reading,) = run(level, {"danger": noul(0.35)}).readings
    assert reading.margin == 0.15


@pytest.fixture
def scale(make_level: MakeLevel) -> Level:
    #   x:  0       1                   2
    # y 0   .       tunnel (opens S)    .
    # y 1   start   urgency             mine
    # y 2   .       tunnel (opens N)    .
    return make_level(
        [
            Cell(x=0, y=1, kind="start"),
            Cell(x=1, y=0, kind="tunnel", rotation=3),
            Cell(x=1, y=2, kind="tunnel", rotation=1),
            Cell(x=2, y=1, kind="mine"),
        ],
        [urgency(1, 1, {"0": "N", "1": "S", "2": "E"})],
    )


@pytest.mark.parametrize(
    ("value", "result", "margin"),
    [
        (0.0, "0", 0.5),
        (0.25, "0", 0.25),
        (0.5, "1", 0.0),  # a half goes up, where Python's `round` would go to the even 0
        (1.0, "1", 0.5),
        (1.49, "1", 0.01),
        (1.5, "2", 0.0),
        (1.75, "2", 0.25),
        (2.0, "2", 0.5),
    ],
)
def test_score_rounds_to_the_nearest_level_half_up(
    scale: Level, value: float, result: str, margin: float
) -> None:
    sim = run(scale, {"urgency": score(value)})
    (reading,) = sim.readings
    assert (reading.type, reading.result, reading.score) == ("score", result, value)
    assert reading.margin == margin
    assert sim.outcome == ("arrived" if result == "2" else "wrong_tunnel")


def test_every_switch_on_the_path_is_read_in_order(make_level: MakeLevel) -> None:
    level = make_level(
        [Cell(x=0, y=1, kind="start"), Cell(x=3, y=1, kind="mine")],
        [cargo(1, 1, {"gold": "E", "coal": "N"}), danger(2, 1, {"no": "E", "yes": "S"})],
    )
    sim = run(level, {"cargo": choice("gold"), "danger": noul(0.1)})
    assert sim.outcome == "arrived"
    assert [r.switch_id for r in sim.readings] == ["cargo", "danger"]
    assert not any(r.clean for r in sim.readings)  # marking is the app's job, via is_clean


def test_without_answers_the_run_stops_on_the_first_switch(make_level: MakeLevel) -> None:
    level = make_level(
        [Cell(x=0, y=1, kind="start"), Cell(x=3, y=1, kind="mine")],
        [cargo(1, 1, {"gold": "E", "coal": "N"}), danger(2, 1, {"no": "E", "yes": "S"})],
    )
    sim = run(level)
    assert sim.needs_jev
    assert steps(sim)[-1] == (1, 1, "W", None)


def test_switches_off_the_path_need_no_answer(make_level: MakeLevel) -> None:
    level = make_level(
        [Cell(x=0, y=1, kind="start"), Cell(x=2, y=1, kind="mine")],
        [cargo(1, 1, {"gold": "E", "coal": "N"}), danger(3, 0, {"no": "E", "yes": "S"})],
    )
    assert run(level, {"cargo": choice("gold")}).outcome == "arrived"


@pytest.mark.parametrize(
    ("answers", "message"),
    [
        ({}, "switch cargo: no answer"),
        ({"danger": noul(0.9)}, "switch cargo: no answer"),
        ({"cargo": noul(0.9)}, "switch cargo: asked choice, answered noul"),
        ({"cargo": score(1.0)}, "switch cargo: asked choice, answered score"),
        ({"cargo": choice("crystal")}, "switch cargo: the choice is not one of the exits"),
    ],
)
def test_an_unusable_choice_answer_is_an_error(
    forked: Level, answers: dict[str, Answer], message: str
) -> None:
    with pytest.raises(ValueError) as caught:
        run(forked, answers)
    assert str(caught.value) == message


@pytest.mark.parametrize("value", [-0.01, 2.01, 3.0, -1.0, float("nan"), float("inf")])
def test_a_score_off_the_scale_is_an_error_never_clamped(scale: Level, value: float) -> None:
    with pytest.raises(ValueError) as caught:
        run(scale, {"urgency": score(value)})
    assert str(caught.value) == "switch urgency: the score is outside the 3 levels asked"


@pytest.mark.parametrize(
    ("answer", "message"),
    [
        (choice("yes"), "switch danger: asked noul, answered choice"),
        (score(1.0), "switch danger: asked noul, answered score"),
    ],
)
def test_a_noul_switch_refuses_another_type(gate: Level, answer: Answer, message: str) -> None:
    with pytest.raises(ValueError) as caught:
        run(gate, {"danger": answer})
    assert str(caught.value) == message


def test_a_score_switch_refuses_another_type(scale: Level) -> None:
    with pytest.raises(ValueError) as caught:
        run(scale, {"urgency": choice("2")})
    assert str(caught.value) == "switch urgency: asked score, answered choice"
