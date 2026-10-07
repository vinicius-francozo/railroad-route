from __future__ import annotations

from collections.abc import Callable

import pytest

from railroad.board import build_board
from railroad.models import (
    Cell,
    ChoiceQuestion,
    InvalidBoard,
    Inventory,
    Level,
    Placement,
    RotationEdit,
    Switch,
)

#   x:  0       1          2      3
# y 0   .       curve(f)   rock   .
# y 1   start   straight   .      mine
# y 2   .       switch     .      .
#
# The straight is rotatable; everything else listed is fixed. `.` is empty.


@pytest.fixture
def level(make_level: Callable[..., Level]) -> Level:
    return make_level(
        [
            Cell(x=1, y=0, kind="curve"),
            Cell(x=2, y=0, kind="rock"),
            Cell(x=0, y=1, kind="start"),
            Cell(x=1, y=1, kind="straight", mode="rotatable"),
            Cell(x=3, y=1, kind="mine"),
        ],
        [
            Switch(
                id="cargo",
                x=1,
                y=2,
                entry="N",
                question=ChoiceQuestion(
                    type="choice", instructions="?", criteria={"coal": "c", "gold": "g"}
                ),
                exits={"coal": "W", "gold": "E"},
            )
        ],
        inventory=Inventory(straight=1, cross=1),
    )


def refusal(level: Level, rotations: list[RotationEdit], placements: list[Placement]) -> str:
    with pytest.raises(InvalidBoard) as caught:
        build_board(level, rotations, placements)
    return caught.value.detail


def test_no_edits_is_the_level_as_written(level: Level) -> None:
    board = build_board(level, [], [])
    assert board.cells == {(c.x, c.y): c for c in level.cells}
    assert board.placed == 0


def test_a_rotation_replaces_the_levels_rotation(level: Level) -> None:
    turned = level.model_copy(
        update={"cells": [c.model_copy(update={"rotation": 3}) for c in level.cells]}
    )
    board = build_board(turned, [RotationEdit(x=1, y=1, rotation=1)], [])
    # Absolute, not added: 3 + 1 would have been 0.
    assert board.cells[(1, 1)].rotation == 1
    assert board.cells[(1, 1)].kind == "straight"


def test_placements_fill_empty_cells_facing_any_way(level: Level) -> None:
    board = build_board(
        level,
        [RotationEdit(x=1, y=1, rotation=1)],
        [
            Placement(x=2, y=1, kind="straight", rotation=1),
            Placement(x=3, y=2, kind="cross", rotation=3),
        ],
    )
    assert board.cells[(2, 1)] == Cell(x=2, y=1, kind="straight", rotation=1)
    assert board.cells[(3, 2)] == Cell(x=3, y=2, kind="cross", rotation=3)
    assert board.placed == 2
    # The switch is never a cell of the board.
    assert (1, 2) not in board.cells


def test_the_level_is_left_as_it_was(level: Level) -> None:
    before = level.model_copy(deep=True)
    build_board(level, [RotationEdit(x=1, y=1, rotation=2)], [Placement(x=2, y=1, kind="cross")])
    assert level == before


@pytest.mark.parametrize(
    ("x", "y", "detail"),
    [
        (1, 0, "the curve at (1, 0) is fixed"),
        (0, 1, "the start at (0, 1) is fixed"),
        (2, 0, "the rock at (2, 0) is fixed"),
        (1, 2, "the switch at (1, 2) does not rotate"),
        (2, 1, "(2, 1) is empty and has nothing to rotate"),
        (4, 1, "(4, 1) is outside the 4x3 grid"),
        (0, 3, "(0, 3) is outside the 4x3 grid"),
        (-1, 0, "(-1, 0) is outside the 4x3 grid"),
    ],
)
def test_refuses_a_rotation(level: Level, x: int, y: int, detail: str) -> None:
    assert refusal(level, [RotationEdit(x=x, y=y, rotation=1)], []) == detail


@pytest.mark.parametrize(
    ("x", "y", "detail"),
    [
        (1, 1, "(1, 1) already holds a straight"),
        (3, 1, "(3, 1) already holds a mine"),
        (2, 0, "(2, 0) is rock"),
        (1, 2, "(1, 2) holds a switch"),
        (4, 0, "(4, 0) is outside the 4x3 grid"),
        (0, -1, "(0, -1) is outside the 4x3 grid"),
    ],
)
def test_refuses_a_placement(level: Level, x: int, y: int, detail: str) -> None:
    assert refusal(level, [], [Placement(x=x, y=y, kind="straight")]) == detail


def test_refuses_more_pieces_than_the_inventory(level: Level) -> None:
    one = [Placement(x=2, y=1, kind="straight")]
    two = [*one, Placement(x=2, y=2, kind="straight")]
    build_board(level, [], one)
    assert refusal(level, [], two) == "no straight left in the inventory"
    # The inventory counts by kind, and this level has no curves at all.
    assert refusal(level, [], [Placement(x=2, y=1, kind="curve")]) == (
        "no curve left in the inventory"
    )


@pytest.mark.parametrize(
    ("rotations", "placements", "at"),
    [
        ([RotationEdit(x=1, y=1, rotation=1), RotationEdit(x=1, y=1, rotation=2)], [], "(1, 1)"),
        ([], [Placement(x=2, y=1, kind="straight"), Placement(x=2, y=1, kind="cross")], "(2, 1)"),
        ([RotationEdit(x=1, y=1, rotation=1)], [Placement(x=1, y=1, kind="cross")], "(1, 1)"),
    ],
)
def test_refuses_two_edits_on_one_cell(
    level: Level, rotations: list[RotationEdit], placements: list[Placement], at: str
) -> None:
    assert refusal(level, rotations, placements) == f"{at} is edited twice"
