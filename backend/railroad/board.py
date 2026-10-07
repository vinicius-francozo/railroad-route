"""The level's grid with the player's edits applied, or the reason the edits are refused.

The page is trusted with nothing here: it sends the edits, and every one is held to the level
before the cart sees the board. A refused edit refuses the whole board rather than being
skipped, because a run on a board the player did not build would score a track they never
made.
"""

from __future__ import annotations

from railroad.models import Board, Cell, InvalidBoard, Level, Placement, RotationEdit


def build_board(level: Level, rotations: list[RotationEdit], placements: list[Placement]) -> Board:
    """`level`'s cells after `rotations` and `placements`.

    A rotation is absolute: it replaces the level's rotation of that cell, it is not added to
    it. A placed piece may face any way, since the player chose where it goes.

    :raises InvalidBoard: on the first edit the level does not allow.
    """
    cells = {(c.x, c.y): c for c in level.cells}
    switches = {(s.x, s.y) for s in level.switches}
    edited: set[tuple[int, int]] = set()

    def claim(x: int, y: int) -> tuple[int, int]:
        if not (0 <= x < level.width and 0 <= y < level.height):
            raise InvalidBoard(f"({x}, {y}) is outside the {level.width}x{level.height} grid")
        # Two edits on one cell have no order the player could see, so neither is chosen.
        if (x, y) in edited:
            raise InvalidBoard(f"({x}, {y}) is edited twice")
        edited.add((x, y))
        return (x, y)

    for r in rotations:
        at = claim(r.x, r.y)
        if at in switches:
            raise InvalidBoard(f"the switch at {at} does not rotate")
        cell = cells.get(at)
        if cell is None:
            raise InvalidBoard(f"{at} is empty and has nothing to rotate")
        if cell.mode != "rotatable":
            raise InvalidBoard(f"the {cell.kind} at {at} is fixed")
        cells[at] = cell.model_copy(update={"rotation": r.rotation})

    left = level.inventory.model_dump()
    for p in placements:
        at = claim(p.x, p.y)
        if at in switches:
            raise InvalidBoard(f"{at} holds a switch")
        cell = cells.get(at)
        if cell is not None and cell.kind == "rock":
            raise InvalidBoard(f"{at} is rock")
        if cell is not None:
            raise InvalidBoard(f"{at} already holds a {cell.kind}")
        if left[p.kind] == 0:
            raise InvalidBoard(f"no {p.kind} left in the inventory")
        left[p.kind] -= 1
        cells[at] = Cell(x=p.x, y=p.y, kind=p.kind, rotation=p.rotation)

    return Board(cells=cells, placed=len(placements))
