"""The stars a run earns.

| stars | when                                                                             |
| ----- | -------------------------------------------------------------------------------- |
| 0     | the cart did not arrive                                                          |
| 1     | it arrived                                                                       |
| 2     | it arrived and every switch on the path decided cleanly (none on the path counts) |
| 3     | all of that, with no more pieces placed than the level's par                     |

"Cleanly" is a margin, not correctness. Jev's answers wobble between runs (a worst case of
0.05 measured in `gridsmith/src/interpreter/jev/questions.ts:130-132`), so a switch decided by
a hair could have gone the other way on the next call; the second star is for a sentence that
would not. A margin exactly at the tuning value counts as clean.
"""

from __future__ import annotations

from railroad.models import Board, Level, Reading, Simulation, Tuning


def is_clean(reading: Reading, tuning: Tuning) -> bool:
    """Whether `reading` decided with at least the margin `tuning` asks of its type.

    For a choice the margin is the confidence (see `Reading`), so the one comparison covers it.
    """
    if reading.type == "choice":
        return reading.margin >= tuning.choice_min_confidence
    if reading.type == "noul":
        return reading.margin >= tuning.noul_margin
    return reading.margin >= tuning.score_margin


def score(level: Level, board: Board, sim: Simulation, tuning: Tuning) -> int:
    """The stars, 0 to 3, `sim` earns on `level` with `board`."""
    if sim.outcome != "arrived":
        return 0
    if not all(is_clean(r, tuning) for r in sim.readings):
        return 1
    if board.placed > level.par_pieces:
        return 2
    return 3
