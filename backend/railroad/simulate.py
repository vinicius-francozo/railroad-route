"""The cart's run over a board, cell by cell, and what the switches on the way read.

## How a run ends, and what the path says about it

Every step records the side the cart came in through (`from_side`) and the side it left
through (`to_side`). How the last step looks depends on the ending:

| ending         | last step                                                              |
| -------------- | ---------------------------------------------------------------------- |
| `arrived`      | the mine, `to_side` None                                               |
| `wrong_tunnel` | the tunnel, `to_side` None                                             |
| `derailed`     | the last cell the cart was really on, `to_side` the side it left by    |
| `loop`         | the last cell before the repeat, `to_side` pointing back into the loop |
| `needs_jev`    | the switch, `to_side` None                                             |

So a derail does *not* follow `PathStep`'s "`to_side` is None on the last cell": the cart never
got onto the cell it was heading for (off the grid, an empty cell, rock, a side that does not
open), so that cell is not in the path, and `to_side` on the last one is the direction the page
animates the cart leaving the rails in. A loop ends the same way for the same reason: the cell
ahead is already in the path, and the page can show the cart heading back into it.

Entering a `start` is a derail. The start is a buffer stop the cart leaves from; nothing in the
rules says what arriving at it would mean, and ending there would look like a finish.

## Why no level can reach a loop or the start, and why both are still handled

Every piece links its sides in pairs (a straight or curve one pair, a cross two), and a switch
is only ever entered through `entry`. So each (cell, side entered) has at most one state that
leads to it, and a run that came back to a state would have to come back through the state
before the first cell, which is the start, which is a derail. With today's pieces a cart can
neither loop nor reach the start. Both checks stay because they are what makes the walk end
whatever the board holds: a passive junction (out of scope in v1) is all it takes to make a
loop real, and `_through` has no answer for a cart inside a start.

## Switches

Without answers the run stops on the first switch and asks for Jev (`needs_jev`), because the
answers are what decides every switch after it. With answers, the switch's result comes from
its answer alone. An answer that cannot be a result of its question is a `ValueError`, and the
run never picks a side on Jev's behalf: a choice outside the exits, a score outside the scale
(refused rather than clamped, as `gridsmith/src/interpreter/jev/read.ts:284-303` does, because
clamping would turn a broken answer into a plausible route), an answer of the wrong type, or no
answer at all.
"""

from __future__ import annotations

import math

from railroad.models import (
    Answers,
    Board,
    ChoiceAnswer,
    ChoiceQuestion,
    Level,
    NoulAnswer,
    NoulQuestion,
    Outcome,
    PathStep,
    PieceKind,
    Reading,
    ScoreAnswer,
    Side,
    Simulation,
    Switch,
)

_SIDES: tuple[Side, ...] = ("N", "E", "S", "W")
_OPPOSITE: dict[Side, Side] = {"N": "S", "E": "W", "S": "N", "W": "E"}
_STEP: dict[Side, tuple[int, int]] = {"N": (0, -1), "E": (1, 0), "S": (0, 1), "W": (-1, 0)}

# Margins are differences of decimals, and a difference of two floats lands a hair off the
# decimal it stands for: 0.2 - 0.05 is 0.15000000000000002, 0.35 - 0.2 is 0.14999999999999997.
# A margin exactly at the tuning value counts as clean, so the hair would decide the star.
# Jev answers in a few decimal places, and nine keeps every one of them while dropping the hair.
_MARGIN_DIGITS = 9

# What each kind opens on at rotation 0 (the table in `models.py`). A cross opens on all four
# sides, and `_through` keeps the cart on its axis.
_OPEN: dict[PieceKind, tuple[Side, ...]] = {
    "straight": ("N", "S"),
    "curve": ("N", "E"),
    "cross": ("N", "E", "S", "W"),
    "start": ("E",),
    "mine": ("W",),
    "tunnel": ("W",),
    "rock": (),
}


def _turn(side: Side, rotation: int) -> Side:
    """`side` after `rotation` quarter turns clockwise."""
    return _SIDES[(_SIDES.index(side) + rotation) % 4]


def opens(kind: PieceKind, rotation: int) -> set[Side]:
    """The sides a piece of `kind` opens on at `rotation`."""
    return {_turn(s, rotation) for s in _OPEN[kind]}


def _through(kind: PieceKind, rotation: int, entry: Side) -> Side:
    """The side a cart that came in through `entry` leaves by, on straight, curve or cross."""
    if kind == "cross":
        return _OPPOSITE[entry]
    (other,) = opens(kind, rotation) - {entry}
    return other


def simulate(level: Level, board: Board, answers: Answers | None) -> Simulation:
    """Run the cart from the start until it ends, or until the first switch if `answers` is None.

    :raises ValueError: if a switch on the path has no usable answer in `answers` (see the
        module docstring). The message names the switch and never echoes the answer's values.
    """
    switches = {(s.x, s.y): s for s in level.switches}
    start = next(c for c in board.cells.values() if c.kind == "start")
    (out,) = opens(start.kind, start.rotation)
    path = [PathStep(x=start.x, y=start.y, from_side=None, to_side=out)]
    readings: list[Reading] = []
    # (x, y, entry side). A cross entered on its other axis is a new key, so it is not a loop.
    entered: set[tuple[int, int, Side]] = set()

    def ended(outcome: Outcome) -> Simulation:
        return Simulation(outcome=outcome, path=path, readings=readings)

    x, y = start.x, start.y
    while True:
        dx, dy = _STEP[out]
        x, y = x + dx, y + dy
        entry = _OPPOSITE[out]
        if not (0 <= x < level.width and 0 <= y < level.height):
            return ended("derailed")
        if (x, y, entry) in entered:
            return ended("loop")

        switch = switches.get((x, y))
        if switch is not None:
            if entry != switch.entry:
                return ended("derailed")
            entered.add((x, y, entry))
            if answers is None:
                path.append(PathStep(x=x, y=y, from_side=entry, to_side=None))
                return Simulation(outcome=None, path=path, readings=readings, needs_jev=True)
            reading = read_switch(switch, answers)
            readings.append(reading)
            out = switch.exits[reading.result]
            path.append(PathStep(x=x, y=y, from_side=entry, to_side=out))
            continue

        cell = board.cells.get((x, y))
        if cell is None or entry not in opens(cell.kind, cell.rotation) or cell.kind == "start":
            return ended("derailed")
        entered.add((x, y, entry))
        if cell.kind in ("mine", "tunnel"):
            path.append(PathStep(x=x, y=y, from_side=entry, to_side=None))
            return ended("arrived" if cell.kind == "mine" else "wrong_tunnel")
        out = _through(cell.kind, cell.rotation, entry)
        path.append(PathStep(x=x, y=y, from_side=entry, to_side=out))


def read_switch(switch: Switch, answers: Answers) -> Reading:
    """What `switch` reads from its answer: the result (a key of `switch.exits`) and the margin.

    :raises ValueError: when the answer is missing, of another type than the question, or not
        a result the question can have.
    """
    answer = answers.get(switch.id)
    if answer is None:
        raise ValueError(f"switch {switch.id}: no answer")
    question = switch.question
    if answer.type != question.type:
        raise ValueError(f"switch {switch.id}: asked {question.type}, answered {answer.type}")

    if isinstance(question, ChoiceQuestion):
        assert isinstance(answer, ChoiceAnswer)
        if answer.choice not in switch.exits:
            raise ValueError(f"switch {switch.id}: the choice is not one of the exits")
        return Reading(
            switch_id=switch.id,
            type="choice",
            result=answer.choice,
            confidence=answer.confidence,
            margin=answer.confidence,
        )

    if isinstance(question, NoulQuestion):
        assert isinstance(answer, NoulAnswer)
        # The model requires a threshold on every noul switch; this narrows the type.
        assert switch.threshold is not None
        return Reading(
            switch_id=switch.id,
            type="noul",
            result="yes" if answer.noul >= switch.threshold else "no",
            noul=answer.noul,
            threshold=switch.threshold,
            margin=round(abs(answer.noul - switch.threshold), _MARGIN_DIGITS),
        )

    assert isinstance(answer, ScoreAnswer)
    top = len(question.criteria) - 1
    # Written so that NaN fails it too: every comparison with NaN is False.
    if not (0 <= answer.score <= top):
        raise ValueError(f"switch {switch.id}: the score is outside the {top + 1} levels asked")
    nearest = _round_half_up(answer.score)
    return Reading(
        switch_id=switch.id,
        type="score",
        result=str(nearest),
        score=answer.score,
        margin=round(0.5 - abs(answer.score - nearest), _MARGIN_DIGITS),
    )


def _round_half_up(score: float) -> int:
    """`score` to the nearest level, a half going up.

    Python's `round` sends a half to the even neighbour, so `round(0.5)` is 0 and `round(1.5)`
    is 2: the same distance from a boundary would land on different sides depending on the
    level. Half-up is also what `Math.round` does in the gridsmith reading this mirrors.
    Comparing the fraction, instead of `floor(score + 0.5)`, keeps the addition from rounding
    a score just under a half up to it.
    """
    whole = math.floor(score)
    return whole + 1 if score - whole >= 0.5 else whole
