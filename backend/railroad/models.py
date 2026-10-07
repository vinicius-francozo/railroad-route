"""The frozen contract every part of the backend is written against.

This module holds types and nothing that decides anything. The rules live beside it:

| module        | what it does                                                        |
| ------------- | ------------------------------------------------------------------- |
| `rules.py`    | `check_sentence(level, sentence) -> None`, raises `RuleViolation`   |
| `board.py`    | `build_board(level, rotations, placements) -> Board`,               |
|               | raises `InvalidBoard`                                               |
| `simulate.py` | `simulate(level, board, answers | None) -> Simulation`              |
| `scoring.py`  | `score(level, board, sim, tuning) -> int` (0..3) and                |
|               | `is_clean(reading, tuning) -> bool`                                 |
| `jev.py`      | `async ask_jev(level, sentence, api_key, client) -> Answers`,       |
|               | raises `JevUnavailable`, `JevRejectedKey`, `JevUnusableAnswer`      |
| `store.py`    | `MemoryStore` and `UpstashStore`, both satisfying `Store` below     |
| `app.py`      | the FastAPI app: `GET /api/levels`, `POST /api/run`                 |

## Geometry

The grid is `width` x `height`, `x` growing east and `y` growing south. A side is one of
`N`, `E`, `S`, `W`. A rotation is a number of quarter turns **clockwise**, `0` to `3`.

At rotation 0 each kind of piece opens on these sides:

| kind       | rotation 0 opens on      | notes                                               |
| ---------- | ------------------------ | --------------------------------------------------- |
| `straight` | N, S                     |                                                     |
| `curve`    | N, E                     |                                                     |
| `cross`    | N-S and E-W, separately  | a cart keeps its axis; it never turns on a cross    |
| `start`    | E                        | the cart leaves through it                          |
| `mine`     | W                        | the cart wins by entering through it                |
| `tunnel`   | W                        | a wrong destination: the cart ends there            |
| `rock`     | nothing                  | blocks placement                                    |

A switch is not a cell. It is listed in `Level.switches`, never rotates, and its sides are
absolute: the cart must come in through `entry`, and leaves through `exits[result]`.

A cell that is neither in `Level.cells` nor holding a switch is empty, and the player may
place a piece from the inventory there.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, model_validator

Side = Literal["N", "E", "S", "W"]
Rotation = Annotated[int, Field(ge=0, le=3)]
PieceKind = Literal["straight", "curve", "cross", "start", "mine", "tunnel", "rock"]
PlaceableKind = Literal["straight", "curve", "cross"]
Mode = Literal["fixed", "rotatable"]
Outcome = Literal["arrived", "derailed", "wrong_tunnel", "loop"]

Probability = Annotated[float, Field(ge=0.0, le=1.0)]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


# --- Levels -----------------------------------------------------------------------------------


class Cell(_Model):
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    kind: PieceKind
    rotation: Rotation = 0
    mode: Mode = "fixed"

    @model_validator(mode="after")
    def _only_track_rotates(self) -> Cell:
        if self.mode == "rotatable" and self.kind not in ("straight", "curve", "cross"):
            raise ValueError(f"a {self.kind} cannot be rotatable")
        return self


class ChoiceQuestion(_Model):
    """A closed set with no order. Jev answers with one of the keys."""

    type: Literal["choice"]
    instructions: str
    criteria: dict[str, str] = Field(min_length=2)


class NoulQuestion(_Model):
    """A proposition, answered with a calibrated probability."""

    type: Literal["noul"]
    instructions: str
    criteria: dict[Literal["true", "false"], str]


class ScoreQuestion(_Model):
    """An ordered scale. The criteria are the levels, in order, and Jev answers between them."""

    type: Literal["score"]
    instructions: str
    criteria: list[str] = Field(min_length=2)


Question = Annotated[ChoiceQuestion | NoulQuestion | ScoreQuestion, Field(discriminator="type")]


class Switch(_Model):
    """A Jev-operated switch.

    The result names in `exits` are, by question type:

    - `choice`: every key of `criteria`;
    - `noul`: `"yes"` (taken when `noul >= threshold`) and `"no"`;
    - `score`: `"0"`, `"1"`, ... one per level, the score rounded to the nearest level.
    """

    id: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    entry: Side
    question: Question
    exits: dict[str, Side]
    threshold: Probability | None = None

    @model_validator(mode="after")
    def _exits_match_question(self) -> Switch:
        q = self.question
        if isinstance(q, ChoiceQuestion):
            expected = set(q.criteria)
        elif isinstance(q, NoulQuestion):
            expected = {"yes", "no"}
        else:
            expected = {str(i) for i in range(len(q.criteria))}
        if set(self.exits) != expected:
            raise ValueError(f"switch {self.id}: exits {sorted(self.exits)} != {sorted(expected)}")
        if isinstance(q, NoulQuestion) != (self.threshold is not None):
            raise ValueError(f"switch {self.id}: a threshold is required for, and only for, noul")
        if self.entry in self.exits.values():
            raise ValueError(f"switch {self.id}: an exit cannot be the entry side")
        return self


class Inventory(_Model):
    straight: int = Field(default=0, ge=0)
    curve: int = Field(default=0, ge=0)
    cross: int = Field(default=0, ge=0)


class RotationEdit(_Model):
    x: int
    y: int
    rotation: Rotation


class Placement(_Model):
    x: int
    y: int
    kind: PlaceableKind
    rotation: Rotation = 0


class ReferenceSolution(_Model):
    """A known way through the level. Used by the tests, never sent to the page."""

    sentence: str
    rotations: list[RotationEdit] = []
    placements: list[Placement] = []


class Level(_Model):
    id: str = Field(pattern=r"^[a-z0-9-]+$")
    name: str
    order: int = Field(ge=1)
    width: int = Field(ge=2, le=16)
    height: int = Field(ge=2, le=16)
    cells: list[Cell]
    switches: list[Switch]
    inventory: Inventory = Inventory()
    taboo: list[str] = []
    max_words: int = Field(ge=1)
    par_pieces: int = Field(ge=0)
    reference_solution: ReferenceSolution | None = None

    @model_validator(mode="after")
    def _consistent(self) -> Level:
        seen: set[tuple[int, int]] = set()
        for x, y in [(c.x, c.y) for c in self.cells] + [(s.x, s.y) for s in self.switches]:
            if not (x < self.width and y < self.height):
                raise ValueError(f"({x}, {y}) is outside the {self.width}x{self.height} grid")
            if (x, y) in seen:
                raise ValueError(f"two things occupy ({x}, {y})")
            seen.add((x, y))
        kinds = [c.kind for c in self.cells]
        if kinds.count("start") != 1 or kinds.count("mine") != 1:
            raise ValueError("a level has exactly one start and one mine")
        for term in self.taboo:
            # The Taboo matches words, so a term with a space, a hyphen or nothing in it could
            # never match (or, empty, would match everything). See `rules.py`.
            if not re.fullmatch(r"[^\W_]+", term):
                raise ValueError(f"taboo term {term!r} is not a single word")
        ids = [s.id for s in self.switches]
        if len(ids) != len(set(ids)):
            raise ValueError("switch ids must be unique")
        return self


class Tuning(_Model):
    """How clearly Jev has to decide for a switch to count as clean (the second star)."""

    choice_min_confidence: Probability
    noul_margin: Probability
    score_margin: Annotated[float, Field(ge=0.0, le=0.5)]


# --- Jev's answers ----------------------------------------------------------------------------


class ChoiceAnswer(_Model):
    model_config = ConfigDict(extra="ignore", frozen=True)
    type: Literal["choice"]
    choice: str
    confidence: Probability


class NoulAnswer(_Model):
    model_config = ConfigDict(extra="ignore", frozen=True)
    type: Literal["noul"]
    noul: Probability


class ScoreAnswer(_Model):
    model_config = ConfigDict(extra="ignore", frozen=True)
    type: Literal["score"]
    score: float
    confidence: Probability


Answer = Annotated[ChoiceAnswer | NoulAnswer | ScoreAnswer, Field(discriminator="type")]

Answers = dict[str, Answer]
"""Switch id -> Jev's answer to that switch's question."""


# --- One run ----------------------------------------------------------------------------------


class RunRequest(_Model):
    level_id: str
    sentence: str
    rotations: list[RotationEdit] = []
    placements: list[Placement] = []


class PathStep(_Model):
    """One cell the cart went through. `from_side` is None on the start cell.

    `to_side` is None on the last cell of a run that ended inside a piece (`arrived`,
    `wrong_tunnel`, or a stop at a switch with `needs_jev`). On the last cell of `derailed` and
    `loop` it is the side the cart left through, so the page can show it rolling off the track.
    """

    x: int
    y: int
    from_side: Side | None
    to_side: Side | None


class Reading(_Model):
    """What one switch on the path read, and how far from the edge of its decision it was.

    `margin` is, by type: `choice` -> the confidence; `noul` -> `abs(noul - threshold)`;
    `score` -> the distance from the score to the nearest rounding boundary (`k + 0.5`).
    """

    switch_id: str
    type: Literal["choice", "noul", "score"]
    result: str
    confidence: Probability | None = None
    noul: Probability | None = None
    threshold: Probability | None = None
    score: float | None = None
    margin: float
    clean: bool = False


class QuotaInfo(_Model):
    remaining: int | None
    byok: bool


class RunResponse(_Model):
    outcome: Outcome
    path: list[PathStep]
    readings: list[Reading]
    stars: int = Field(ge=0, le=3)
    cached: bool
    quota: QuotaInfo


ErrorKind = Literal[
    "unknown_level",
    "empty_sentence",
    "too_long",
    "too_many_words",
    "taboo",
    "invalid_board",
    "quota_exhausted",
    "key_rejected",
    "jev_unavailable",
    "jev_unusable",
]


class ErrorResponse(_Model):
    """Every non-200 answer. `detail` is written by this backend and never echoes the sentence
    or a key."""

    error: ErrorKind
    detail: str


# --- Engine values and errors -----------------------------------------------------------------


@dataclass(frozen=True)
class Board:
    """The level's grid after the player's edits. Switches are not in `cells`."""

    cells: dict[tuple[int, int], Cell]
    placed: int


@dataclass(frozen=True)
class Simulation:
    """A run of the cart.

    When `simulate` is called without answers and the cart reaches a switch, it stops there:
    `needs_jev` is True, `outcome` is None, and `path` is the path up to the switch.
    """

    outcome: Outcome | None
    path: list[PathStep]
    readings: list[Reading] = field(default_factory=list)
    needs_jev: bool = False


class RuleViolation(Exception):
    """The sentence breaks one of the level's rules. `detail` never contains the sentence."""

    def __init__(
        self, kind: Literal["empty_sentence", "too_long", "too_many_words", "taboo"], detail: str
    ) -> None:
        super().__init__(detail)
        self.kind = kind
        self.detail = detail


class InvalidBoard(Exception):
    """The player's edits are not allowed on this level."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


# --- Storage ----------------------------------------------------------------------------------


@dataclass(frozen=True)
class QuotaResult:
    allowed: bool
    remaining: int


class Store(Protocol):
    """Jev's answers cached per (level, sentence), and the free quota of the server's key."""

    async def get_cached(self, level_id: str, sentence: str) -> Answers | None: ...

    async def put_cached(self, level_id: str, sentence: str, answers: Answers) -> None: ...

    async def take_quota(self, ip: str) -> QuotaResult:
        """Spend one call of `ip`'s daily quota and of the global daily ceiling, if both allow
        it. A refused call spends nothing."""
        ...


# --- Loading ----------------------------------------------------------------------------------

LEVELS_DIR = Path(__file__).resolve().parents[2] / "levels"


def load_levels(directory: Path = LEVELS_DIR) -> dict[str, Level]:
    """Every `<n>.json` level in `directory`, keyed by id, in `order`."""
    levels = [
        Level.model_validate_json(p.read_text(encoding="utf-8"))
        for p in sorted(directory.glob("*.json"))
        if p.name != "tuning.json"
    ]
    return {lv.id: lv for lv in sorted(levels, key=lambda lv: lv.order)}


def load_tuning(directory: Path = LEVELS_DIR) -> Tuning:
    return Tuning.model_validate(
        json.loads((directory / "tuning.json").read_text(encoding="utf-8"))
    )
