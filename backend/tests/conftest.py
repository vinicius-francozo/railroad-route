"""Small levels built in code, so each engine test shows the board it is about.

The real levels in `levels/` belong to their own front and change with the investigation; a
test of the engine should not break because a puzzle was retuned.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest

from railroad.models import Cell, Inventory, Level, Switch, Tuning


@pytest.fixture
def make_level() -> Callable[..., Level]:
    """A level around `cells` and `switches`, with defaults for everything a test does not
    care about. The model still validates it, so a test cannot build an impossible level."""

    def make(
        cells: list[Cell],
        switches: list[Switch] | None = None,
        *,
        width: int = 4,
        height: int = 3,
        inventory: Inventory | None = None,
        taboo: list[str] | None = None,
        max_words: int = 12,
        par_pieces: int = 0,
    ) -> Level:
        return Level(
            id="test",
            name="Test",
            order=1,
            width=width,
            height=height,
            cells=cells,
            switches=switches or [],
            inventory=inventory or Inventory(),
            taboo=taboo or [],
            max_words=max_words,
            par_pieces=par_pieces,
        )

    return make


@pytest.fixture
def tuning() -> Tuning:
    """The provisional values in `levels/tuning.json`, copied so the tests do not move with it."""
    return Tuning(choice_min_confidence=0.8, noul_margin=0.15, score_margin=0.25)
