"""The API, end to end through `TestClient`, with Jev and Upstash stood in by
`httpx.MockTransport` and the store in memory. No test here reaches the network.

The levels are built here rather than read from `levels/`, which belongs to its own front: a
test of the wiring should not move when a puzzle is retuned.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import Callable, Iterator
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

import railroad.app as app_module
from railroad.app import MAX_BODY_BYTES, cache_id, create_app, store_from_env
from railroad.models import (
    Answers,
    ChoiceAnswer,
    Level,
    QuotaResult,
    ScoreAnswer,
    Tuning,
)
from railroad.store import MemoryStore, QuotaLimits, StoreUnavailable, UpstashStore

SERVER_KEY = "ts-server-key-91c2-DO-NOT-LEAK"
BYOK = "ts-visitor-key-5e8d-DO-NOT-LEAK"
SENTENCE = "shiny nuggets that kings stamp onto coins"
"""Distinctive on purpose: the keys and the sentence are searched for in every answer and log."""

LIMITS = QuotaLimits(per_ip=10, global_=300)

TUNING = Tuning(choice_min_confidence=0.8, noul_margin=0.15, score_margin=0.25)


def make_level(*, instructions: str = "What does the cart carry?", **changes: Any) -> Level:
    """A 5x3 line: start, a rotatable straight, `cargo` (choice), `urgency` (score), the mine.

    ```
    y=1   S  =  [cargo]  [urgency]  M      gold -> E, then "1" -> E -> the mine
    y=2           T          T             coal -> S, "0" -> S: a tunnel each
    ```
    """
    data: dict[str, Any] = {
        "id": "line",
        "name": "Line",
        "order": 1,
        "width": 5,
        "height": 3,
        "cells": [
            {"x": 0, "y": 1, "kind": "start"},
            {"x": 1, "y": 1, "kind": "straight", "rotation": 1, "mode": "rotatable"},
            {"x": 4, "y": 1, "kind": "mine"},
            {"x": 2, "y": 2, "kind": "tunnel", "rotation": 1},
            {"x": 3, "y": 2, "kind": "tunnel", "rotation": 1},
            {"x": 0, "y": 0, "kind": "rock"},
        ],
        "switches": [
            {
                "id": "cargo",
                "x": 2,
                "y": 1,
                "entry": "W",
                "question": {
                    "type": "choice",
                    "instructions": instructions,
                    "criteria": {"coal": "Coal", "gold": "Gold"},
                },
                "exits": {"gold": "E", "coal": "S"},
            },
            {
                "id": "urgency",
                "x": 3,
                "y": 1,
                "entry": "W",
                "question": {
                    "type": "score",
                    "instructions": "How urgent is the delivery?",
                    "criteria": ["Calm", "Rush"],
                },
                "exits": {"0": "S", "1": "E"},
            },
        ],
        "inventory": {"straight": 1},
        "taboo": ["gold"],
        "max_words": 8,
        "par_pieces": 0,
        "reference_solution": {"sentence": "secret reference sentence"},
    }
    data.update(changes)
    return Level.model_validate(data)


LEVEL = make_level()

GOOD = {
    "cargo": {"type": "choice", "choice": "gold", "confidence": 0.97},
    "urgency": {"type": "score", "score": 0.9, "confidence": 0.9},
}
"""Gold, then rush: into the mine with both switches clean (0.97; 0.5 - 0.1 = 0.4)."""


def jev_body(**changes: object) -> dict[str, object]:
    return {"answers": {**GOOD, **changes}}


class Jev:
    """Stands in for TypeSafe: answers `reply` and records every request it gets."""

    def __init__(self) -> None:
        self.calls: list[httpx.Request] = []
        self.reply: Callable[[httpx.Request], httpx.Response] = lambda _r: httpx.Response(
            200, json=jev_body()
        )

    def answer(self, payload: object, status: int = 200) -> None:
        self.reply = lambda _r: httpx.Response(status, json=payload)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        return self.reply(request)


class SpyStore(MemoryStore):
    """A `MemoryStore` that also records who asked for quota and how often the cache was read."""

    def __init__(self, limits: QuotaLimits = LIMITS) -> None:
        super().__init__(limits=limits)
        self.quota_ips: list[str] = []
        self.reads = 0

    async def get_cached(self, level_id: str, sentence: str) -> Answers | None:
        self.reads += 1
        return await super().get_cached(level_id, sentence)

    async def take_quota(self, ip: str) -> QuotaResult:
        self.quota_ips.append(ip)
        return await super().take_quota(ip)


class Harness:
    """One app with its fakes, and a `run` that checks every answer for a leak."""

    def __init__(
        self,
        *,
        levels: list[Level] | None = None,
        store: Any = None,
        server_key: str | None = SERVER_KEY,
        jev: Jev | None = None,
    ) -> None:
        self.jev = jev or Jev()
        self.store: Any = store if store is not None else SpyStore()
        app = create_app(
            levels={lv.id: lv for lv in (levels or [LEVEL])},
            tuning=TUNING,
            store=self.store,
            client=httpx.AsyncClient(transport=httpx.MockTransport(self.jev.handle)),
            server_key=server_key,
            environ={},
        )
        self.client = TestClient(app)

    def run(
        self,
        sentence: str = SENTENCE,
        *,
        level_id: str = "line",
        rotations: list[dict[str, int]] | None = None,
        placements: list[dict[str, object]] | None = None,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        body = {
            "level_id": level_id,
            "sentence": sentence,
            "rotations": rotations or [],
            "placements": placements or [],
        }
        response: httpx.Response = self.client.post("/api/run", json=body, headers=headers or {})
        assert_no_leak(response.text, sentence)
        return response


def assert_no_leak(text: str, sentence: str = SENTENCE) -> None:
    for secret in (SERVER_KEY, BYOK, sentence):
        assert secret not in text


@pytest.fixture
def make_harness() -> Iterator[Callable[..., Harness]]:
    """Harnesses with their lifespan running, all closed when the test ends."""
    with contextlib.ExitStack() as stack:

        def make(**kwargs: Any) -> Harness:
            h = Harness(**kwargs)
            stack.enter_context(h.client)
            return h

        yield make


@pytest.fixture
def harness(make_harness: Callable[..., Harness]) -> Harness:
    return make_harness()


def error(response: httpx.Response) -> tuple[int, str]:
    body = response.json()
    assert set(body) == {"error", "detail"}
    assert isinstance(body["detail"], str) and body["detail"]
    return response.status_code, body["error"]


# --- GET /api/levels ---------------------------------------------------------------------------


PUBLIC_LEVEL_KEYS = {
    "id",
    "name",
    "order",
    "width",
    "height",
    "cells",
    "switches",
    "inventory",
    "taboo",
    "max_words",
    "par_pieces",
}
"""`PublicLevel` in `src/contract.ts`, field by field."""


def test_levels_are_public_levels_in_order_without_the_reference_solution(
    make_harness: Callable[..., Harness],
) -> None:
    gate = Level.model_validate(
        {
            "id": "gate",
            "name": "Gate",
            "order": 2,
            "width": 3,
            "height": 2,
            "cells": [{"x": 0, "y": 0, "kind": "start"}, {"x": 2, "y": 0, "kind": "mine"}],
            "switches": [
                {
                    "id": "danger",
                    "x": 1,
                    "y": 0,
                    "entry": "W",
                    "question": {
                        "type": "noul",
                        "instructions": "Is it dangerous?",
                        "criteria": {"true": "Yes", "false": "No"},
                    },
                    "exits": {"yes": "E", "no": "S"},
                    "threshold": 0.5,
                }
            ],
            "max_words": 10,
            "par_pieces": 0,
            "reference_solution": {"sentence": "secret reference sentence"},
        }
    )
    h = make_harness(levels=[LEVEL, gate])

    response = h.client.get("/api/levels")

    assert response.status_code == 200
    assert "secret reference sentence" not in response.text
    levels = response.json()
    assert [lv["id"] for lv in levels] == ["line", "gate"]
    for lv in levels:
        assert set(lv) == PUBLIC_LEVEL_KEYS
        assert set(lv["inventory"]) == {"straight", "curve", "cross"}
        for cell in lv["cells"]:
            assert set(cell) == {"x", "y", "kind", "rotation", "mode"}
        for switch in lv["switches"]:
            assert set(switch) == {"id", "x", "y", "entry", "question", "exits", "threshold"}
    assert levels[0]["cells"][0] == {
        "x": 0,
        "y": 1,
        "kind": "start",
        "rotation": 0,
        "mode": "fixed",
    }
    assert levels[0]["inventory"] == {"straight": 1, "curve": 0, "cross": 0}
    assert [s["threshold"] for s in levels[0]["switches"]] == [None, None]
    assert levels[1]["switches"][0]["threshold"] == 0.5
    assert levels[0]["switches"][1]["question"]["criteria"] == ["Calm", "Rush"]


# --- 200 ---------------------------------------------------------------------------------------


def test_a_clean_run_into_the_mine(harness: Harness) -> None:
    response = harness.run()

    assert response.status_code == 200
    assert response.json() == {
        "outcome": "arrived",
        "path": [
            {"x": 0, "y": 1, "from_side": None, "to_side": "E"},
            {"x": 1, "y": 1, "from_side": "W", "to_side": "E"},
            {"x": 2, "y": 1, "from_side": "W", "to_side": "E"},
            {"x": 3, "y": 1, "from_side": "W", "to_side": "E"},
            {"x": 4, "y": 1, "from_side": "W", "to_side": None},
        ],
        "readings": [
            {
                "switch_id": "cargo",
                "type": "choice",
                "result": "gold",
                "confidence": 0.97,
                "noul": None,
                "threshold": None,
                "score": None,
                "margin": 0.97,
                "clean": True,
            },
            {
                "switch_id": "urgency",
                "type": "score",
                "result": "1",
                "confidence": None,
                "noul": None,
                "threshold": None,
                "score": 0.9,
                "margin": 0.4,
                "clean": True,
            },
        ],
        "stars": 3,
        "cached": False,
        "quota": {"remaining": 9, "byok": False},
    }
    assert len(harness.jev.calls) == 1
    assert harness.jev.calls[0].headers["authorization"] == f"Bearer {SERVER_KEY}"
    assert json.loads(harness.jev.calls[0].content)["state"] == SENTENCE


def test_clean_is_filled_per_reading_and_drives_the_stars(harness: Harness) -> None:
    harness.jev.answer(jev_body(urgency={"type": "score", "score": 0.6, "confidence": 0.9}))

    body = harness.run().json()

    assert [r["clean"] for r in body["readings"]] == [True, False]
    assert body["stars"] == 1


def test_a_run_that_leaves_the_track_before_any_switch_asks_nothing_and_spends_nothing(
    harness: Harness,
) -> None:
    # The straight turned north-south: the cart, coming from the west, falls off it.
    response = harness.run(rotations=[{"x": 1, "y": 1, "rotation": 0}])

    assert response.status_code == 200
    body = response.json()
    assert body["outcome"] == "derailed"
    assert body["readings"] == []
    assert body["stars"] == 0
    assert body["cached"] is False
    assert body["quota"] == {"remaining": None, "byok": False}
    assert harness.jev.calls == []
    assert harness.store.quota_ips == []
    assert harness.store.reads == 0


def test_a_run_before_any_switch_reports_byok_when_a_key_is_sent(harness: Harness) -> None:
    response = harness.run(
        rotations=[{"x": 1, "y": 1, "rotation": 0}], headers={"x-typesafe-key": BYOK}
    )

    assert response.json()["quota"] == {"remaining": None, "byok": True}
    assert harness.jev.calls == []


def test_a_cache_hit_asks_no_one_and_spends_nothing(harness: Harness) -> None:
    harness.run()
    # Same sentence to the cache: case and spacing are normalised by the store.
    response = harness.run("  Shiny NUGGETS that kings stamp onto coins ")

    assert response.status_code == 200
    body = response.json()
    assert body["cached"] is True
    assert body["quota"] == {"remaining": None, "byok": False}
    assert body["outcome"] == "arrived"
    assert all(r["clean"] for r in body["readings"])
    assert len(harness.jev.calls) == 1
    assert len(harness.store.quota_ips) == 1


def test_the_cache_does_not_care_how_the_track_was_laid(harness: Harness) -> None:
    harness.run()
    response = harness.run(placements=[{"x": 1, "y": 0, "kind": "straight", "rotation": 0}])

    body = response.json()
    assert body["cached"] is True
    assert body["stars"] == 2  # one piece over a par of 0
    assert len(harness.jev.calls) == 1


def test_changing_a_levels_questions_moves_it_onto_fresh_cache_entries(
    make_harness: Callable[..., Harness],
) -> None:
    store = SpyStore()
    first = make_harness(store=store, levels=[make_level()])
    first.run()
    assert len(first.jev.calls) == 1

    reworded = make_harness(store=store, levels=[make_level(instructions="What is in the cart?")])
    response = reworded.run()

    assert response.json()["cached"] is False
    assert len(reworded.jev.calls) == 1


def test_the_cache_id_is_the_level_id_and_a_hash_of_what_jev_is_asked() -> None:
    base = cache_id(make_level())

    assert base.startswith("line@")
    assert len(base) == len("line@") + 16
    assert cache_id(make_level()) == base
    # Track and rules do not touch the questions, so they keep the cache.
    assert cache_id(make_level(max_words=3, par_pieces=4, taboo=["coal"])) == base
    assert cache_id(make_level(instructions="What is in the cart?")) != base
    swapped = make_level()
    swapped_switches = [s.model_dump() for s in swapped.switches]
    swapped_switches[0]["exits"] = {"gold": "S", "coal": "E"}
    assert cache_id(make_level(switches=swapped_switches)) != base


def test_a_cached_answer_the_engine_refuses_is_asked_again(harness: Harness) -> None:
    broken: Answers = {
        "cargo": ChoiceAnswer(type="choice", choice="gold", confidence=0.97),
        "urgency": ScoreAnswer(type="score", score=7.0, confidence=0.9),
    }
    asyncio.run(harness.store.put_cached(cache_id(LEVEL), SENTENCE, broken))

    response = harness.run()

    assert response.status_code == 200
    assert response.json()["cached"] is False
    assert len(harness.jev.calls) == 1
    assert harness.run().json()["cached"] is True  # the good answer replaced the broken one


def test_byok_spends_no_quota_and_is_sent_to_jev_as_the_bearer(harness: Harness) -> None:
    response = harness.run(headers={"x-typesafe-key": f"  {BYOK} "})

    assert response.status_code == 200
    assert response.json()["quota"] == {"remaining": None, "byok": True}
    assert harness.jev.calls[0].headers["authorization"] == f"Bearer {BYOK}"
    assert harness.store.quota_ips == []


def test_a_blank_byok_header_is_no_key(harness: Harness) -> None:
    response = harness.run(headers={"x-typesafe-key": "   "})

    assert response.json()["quota"] == {"remaining": 9, "byok": False}
    assert harness.jev.calls[0].headers["authorization"] == f"Bearer {SERVER_KEY}"


def test_byok_plays_on_a_server_with_no_key(make_harness: Callable[..., Harness]) -> None:
    h = make_harness(server_key=None)  # read from an empty environment

    response = h.run(headers={"x-typesafe-key": BYOK})

    assert response.status_code == 200
    assert response.json()["quota"]["byok"] is True


# --- The visitor's address --------------------------------------------------------------------


def test_the_quota_is_counted_on_the_first_forwarded_address(harness: Harness) -> None:
    harness.run(headers={"x-forwarded-for": " 203.0.113.7 , 10.0.0.1"})
    harness.run("cart full of coal dust", headers={"x-forwarded-for": "203.0.113.8"})
    harness.run("cart of crystals")

    assert harness.store.quota_ips == ["203.0.113.7", "203.0.113.8", "testclient"]


def test_each_address_has_its_own_quota(make_harness: Callable[..., Harness]) -> None:
    h = make_harness(store=SpyStore(QuotaLimits(per_ip=1, global_=10)))
    a = {"x-forwarded-for": "203.0.113.7"}

    assert h.run(headers=a).json()["quota"] == {"remaining": 0, "byok": False}
    assert error(h.run("cart of crystals", headers=a)) == (429, "quota_exhausted")
    assert h.run("cart of crystals", headers={"x-forwarded-for": "203.0.113.8"}).status_code == 200
    assert len(h.jev.calls) == 2


# --- 422 ---------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("sentence", "kind"),
    [
        ("!!! ...", "empty_sentence"),
        ("a " * 101, "too_long"),
        ("one two three four five six seven eight nine", "too_many_words"),
        ("pure golden nuggets", "taboo"),
    ],
)
def test_a_sentence_that_breaks_a_rule(harness: Harness, sentence: str, kind: str) -> None:
    response = harness.run(sentence)

    assert error(response) == (422, kind)
    assert harness.jev.calls == []
    assert harness.store.quota_ips == []


def test_the_taboo_detail_names_the_levels_term(harness: Harness) -> None:
    assert harness.run("pure golden nuggets").json()["detail"] == "forbidden on this level: gold"


def test_an_unknown_level(harness: Harness) -> None:
    response = harness.run(level_id="no-such-level-xyz")

    assert error(response) == (422, "unknown_level")
    assert "no-such-level-xyz" not in response.text


@pytest.mark.parametrize(
    ("rotations", "placements"),
    [
        ([{"x": 4, "y": 1, "rotation": 1}], []),  # the mine is fixed
        ([], [{"x": 0, "y": 0, "kind": "straight", "rotation": 0}]),  # rock
        ([], [{"x": 9, "y": 9, "kind": "straight", "rotation": 0}]),  # off the grid
        ([], [{"x": 1, "y": 0, "kind": "curve", "rotation": 0}]),  # none in the inventory
    ],
)
def test_an_edit_the_level_does_not_allow(
    harness: Harness, rotations: list[dict[str, int]], placements: list[dict[str, object]]
) -> None:
    response = harness.run(rotations=rotations, placements=placements)

    assert error(response) == (422, "invalid_board")
    assert harness.jev.calls == []


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        b"[]",
        b'{"level_id": "line"}',
        b'{"level_id": "line", "sentence": 7}',
        b'{"level_id": "line", "sentence": "x", "rotations": [{"x": 1, "y": 1, "rotation": 4}]}',
        b'{"level_id": "line", "sentence": "x", "extra": true}',
        b"\xff\xfe",
    ],
)
def test_a_body_that_is_not_a_run(harness: Harness, body: bytes) -> None:
    response = harness.client.post(
        "/api/run", content=body, headers={"content-type": "application/json"}
    )

    assert error(response) == (422, "invalid_board")
    assert response.json()["detail"] == "The request is not a valid run."


def test_a_malformed_body_never_echoes_what_it_carried(harness: Harness) -> None:
    body = json.dumps({"level_id": "line", "sentence": SENTENCE, "rotations": "bad"})

    response = harness.client.post("/api/run", content=body)

    assert error(response) == (422, "invalid_board")
    assert_no_leak(response.text)


def test_a_body_over_the_cap_is_refused_before_the_sentence_is_read(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    checked: list[str] = []
    monkeypatch.setattr(app_module, "check_sentence", lambda _lv, s: checked.append(s))
    huge = "gold " * (MAX_BODY_BYTES // 5 + 1)

    declared = harness.run(huge)
    chunked = harness.client.post(
        "/api/run",
        content=iter([json.dumps({"level_id": "line", "sentence": huge}).encode()]),
        headers={"content-type": "application/json"},
    )

    assert error(declared) == (422, "invalid_board")
    assert error(chunked) == (422, "invalid_board")
    assert checked == []


@pytest.mark.parametrize("declared", [str(MAX_BODY_BYTES + 1).encode(), b"abc", b"\xb2"])
def test_a_declared_length_over_the_cap_is_refused_unread(
    harness: Harness, declared: bytes
) -> None:
    body = json.dumps({"level_id": "line", "sentence": SENTENCE}).encode()

    response = harness.client.post("/api/run", content=body, headers={"content-length": declared})

    assert error(response) == (422, "invalid_board")
    assert harness.jev.calls == []


def test_a_body_at_the_cap_is_read(harness: Harness) -> None:
    body = json.dumps({"level_id": "line", "sentence": SENTENCE}).encode()
    padded = body[:-1] + b" " * (MAX_BODY_BYTES - len(body)) + b"}"

    response = harness.client.post("/api/run", content=padded)

    assert len(padded) == MAX_BODY_BYTES
    assert response.status_code == 200


# --- 429, 401, 502 -----------------------------------------------------------------------------


def test_the_quota_runs_out(make_harness: Callable[..., Harness]) -> None:
    h = make_harness(store=SpyStore(QuotaLimits(per_ip=1, global_=300)))
    h.run()

    response = h.run("cart of crystals")

    assert error(response) == (429, "quota_exhausted")
    assert len(h.jev.calls) == 1


def test_a_server_with_no_key_spends_no_quota(make_harness: Callable[..., Harness]) -> None:
    h = make_harness(server_key="  ")

    response = h.run()

    assert error(response) == (502, "jev_unavailable")
    assert h.store.quota_ips == []
    assert h.jev.calls == []


@pytest.mark.parametrize("status", [401, 403])
def test_a_refused_visitor_key_is_401(harness: Harness, status: int) -> None:
    harness.jev.answer({"error": "nope"}, status)

    response = harness.run(headers={"x-typesafe-key": BYOK})

    assert error(response) == (401, "key_rejected")


def test_a_refused_server_key_is_the_servers_problem(harness: Harness) -> None:
    harness.jev.answer({"error": "nope"}, 401)

    assert error(harness.run()) == (502, "jev_unavailable")


def test_a_malformed_visitor_key_is_refused_without_a_call(harness: Harness) -> None:
    response = harness.run(headers={"x-typesafe-key": "two words"})

    assert error(response) == (401, "key_rejected")
    assert harness.jev.calls == []


def test_jev_down(harness: Harness) -> None:
    harness.jev.answer({}, 503)

    assert error(harness.run()) == (502, "jev_unavailable")


def test_jev_unreachable(harness: Harness) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("simulated", request=request)

    harness.jev.reply = refuse

    assert error(harness.run()) == (502, "jev_unavailable")


def test_an_answer_jev_should_not_have_given(harness: Harness) -> None:
    harness.jev.answer({"answers": {"cargo": GOOD["cargo"]}})

    assert error(harness.run()) == (502, "jev_unusable")


def test_an_answer_the_engine_refuses_is_not_cached(harness: Harness) -> None:
    harness.jev.answer(jev_body(urgency={"type": "score", "score": 1.7, "confidence": 0.9}))

    assert error(harness.run()) == (502, "jev_unusable")
    assert asyncio.run(harness.store.get_cached(cache_id(LEVEL), SENTENCE)) is None

    harness.jev.answer(jev_body())
    assert harness.run().json()["cached"] is False
    assert len(harness.jev.calls) == 2


class DownStore:
    """A store whose `broken` method fails as Upstash does when it cannot be reached."""

    def __init__(self, broken: str) -> None:
        self.broken = broken
        self.inner = MemoryStore(limits=LIMITS)
        self.quota_ips: list[str] = []

    def _check(self, name: str) -> None:
        if name == self.broken:
            raise StoreUnavailable("Upstash did not answer.")

    async def get_cached(self, level_id: str, sentence: str) -> Answers | None:
        self._check("get_cached")
        return await self.inner.get_cached(level_id, sentence)

    async def put_cached(self, level_id: str, sentence: str, answers: Answers) -> None:
        self._check("put_cached")
        await self.inner.put_cached(level_id, sentence, answers)

    async def take_quota(self, ip: str) -> QuotaResult:
        self._check("take_quota")
        self.quota_ips.append(ip)
        return await self.inner.take_quota(ip)


@pytest.mark.parametrize("broken", ["get_cached", "take_quota"])
def test_storage_down_stops_a_free_run(make_harness: Callable[..., Harness], broken: str) -> None:
    h = make_harness(store=DownStore(broken))

    assert error(h.run()) == (502, "jev_unavailable")
    assert h.jev.calls == []


def test_a_cache_that_cannot_be_read_is_a_miss_with_the_visitors_key(
    make_harness: Callable[..., Harness],
) -> None:
    h = make_harness(store=DownStore("get_cached"))

    response = h.run(headers={"x-typesafe-key": BYOK})

    assert response.status_code == 200
    assert response.json()["cached"] is False
    assert response.json()["quota"] == {"remaining": None, "byok": True}
    assert len(h.jev.calls) == 1
    assert h.jev.calls[0].headers["authorization"] == f"Bearer {BYOK}"
    assert h.store.quota_ips == []


def test_an_answer_the_store_cannot_keep_is_still_served(
    make_harness: Callable[..., Harness],
) -> None:
    h = make_harness(store=DownStore("put_cached"))

    response = h.run()

    assert response.status_code == 200
    assert response.json()["cached"] is False
    assert response.json()["quota"] == {"remaining": 9, "byok": False}
    assert response.json()["outcome"] == "arrived"
    assert len(h.store.quota_ips) == 1
    assert len(h.jev.calls) == 1


# --- Nothing written down ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("byok", "jev_status"),
    [(False, 200), (True, 200), (False, 401), (True, 401), (False, 500), (True, 500)],
)
def test_no_key_or_sentence_reaches_a_log(
    make_harness: Callable[..., Harness],
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
    byok: bool,
    jev_status: int,
) -> None:
    caplog.set_level("DEBUG")
    h = make_harness()
    h.jev.answer(jev_body() if jev_status == 200 else {"error": "x"}, jev_status)
    headers = {"x-typesafe-key": BYOK} if byok else {}

    h.run(headers=headers)
    h.run("pure golden nuggets", headers=headers)
    h.client.post("/api/run", content=json.dumps({"level_id": "x", "sentence": SENTENCE}))

    out, err = capsys.readouterr()
    assert_no_leak(caplog.text + out + err)
    assert_no_leak(caplog.text + out + err, "pure golden nuggets")


# --- Wiring from the environment --------------------------------------------------------------


UPSTASH_HALF_SET = (
    "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set together, or neither."
)


def test_the_store_is_upstash_with_both_variables_and_memory_with_neither() -> None:
    client = httpx.AsyncClient()
    both = {"UPSTASH_REDIS_REST_URL": "https://x.upstash.io", "UPSTASH_REDIS_REST_TOKEN": "t"}

    assert isinstance(store_from_env(both, client), UpstashStore)
    assert isinstance(store_from_env({}, client), MemoryStore)
    blank = {"UPSTASH_REDIS_REST_URL": " ", "UPSTASH_REDIS_REST_TOKEN": "\n"}
    assert isinstance(store_from_env(blank, client), MemoryStore)


@pytest.mark.parametrize(
    "environ",
    [
        {"UPSTASH_REDIS_REST_URL": "https://half-set.upstash.io"},
        {"UPSTASH_REDIS_REST_TOKEN": "half-set-token"},
        {"UPSTASH_REDIS_REST_URL": "https://half-set.upstash.io", "UPSTASH_REDIS_REST_TOKEN": " "},
    ],
)
def test_one_upstash_variable_without_the_other_stops_the_app_from_starting(
    environ: dict[str, str],
) -> None:
    with pytest.raises(ValueError) as from_env:
        store_from_env(environ, httpx.AsyncClient())
    with pytest.raises(ValueError) as from_create:
        create_app(levels={"line": LEVEL}, tuning=TUNING, environ=environ)

    for raised in (from_env, from_create):
        assert str(raised.value) == UPSTASH_HALF_SET
        assert "half-set" not in str(raised.value)


def test_the_lifespan_shares_one_client_with_upstash_and_strips_its_token() -> None:
    jev = Jev()
    upstash: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.host != "db.upstash.io":
            return jev.handle(request)
        upstash.append(request)
        command = json.loads(request.content)
        if request.url.path == "/multi-exec":
            return httpx.Response(200, json=[{"result": 1} for _ in command])
        return httpx.Response(200, json={"result": None if command[0] == "GET" else "OK"})

    app = create_app(
        levels={"line": LEVEL},
        tuning=TUNING,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handle)),
        environ={
            "TYPESAFE_API_KEY": f"{SERVER_KEY}\n",
            "UPSTASH_REDIS_REST_URL": "https://db.upstash.io",
            "UPSTASH_REDIS_REST_TOKEN": " upstash-token\n",
        },
    )
    with TestClient(app) as client:
        response = client.post("/api/run", json={"level_id": "line", "sentence": SENTENCE})

    assert response.status_code == 200
    assert response.json()["quota"] == {"remaining": 9, "byok": False}
    commands = [json.loads(r.content)[0] for r in upstash]
    assert [c if isinstance(c, str) else c[0] for c in commands] == ["GET", "INCR", "SET"]
    assert {r.headers["authorization"] for r in upstash} == {"Bearer upstash-token"}
    assert jev.calls[0].headers["authorization"] == f"Bearer {SERVER_KEY}"


def test_the_module_exposes_an_app() -> None:
    assert app_module.app.title == "Railroad Route"
