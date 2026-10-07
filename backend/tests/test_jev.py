"""`ask_jev`, with the network stood in by `httpx.MockTransport`. No test here reaches TypeSafe.

The bodies Jev answers with are typed out by hand, not built from the level or from the answer
models: a fake assembled out of the code under test moves with it and asserts nothing.
"""

from __future__ import annotations

import json
from collections.abc import Callable

import httpx
import pytest

from railroad.jev import (
    JEV_ENDPOINT,
    UPSTREAM_TIMEOUT,
    JevError,
    JevRejectedKey,
    JevUnavailable,
    JevUnusableAnswer,
    ask_jev,
)
from railroad.models import ChoiceAnswer, Level, NoulAnswer, ScoreAnswer

KEY = "ts-live-key-7f3a9c-DO-NOT-LEAK"
"""Distinctive on purpose: it is searched for in every log line and every message below."""

SENTENCE = "a heavy cart of shiny nuggets, nothing that could blow up, and we are late"

LEVEL = Level.model_validate(
    {
        "id": "test-level",
        "name": "Test",
        "order": 1,
        "width": 6,
        "height": 3,
        "cells": [{"x": 0, "y": 1, "kind": "start"}, {"x": 5, "y": 1, "kind": "mine"}],
        "switches": [
            {
                "id": "cargo",
                "x": 1,
                "y": 1,
                "entry": "W",
                "question": {
                    "type": "choice",
                    "instructions": "What is the cart carrying?",
                    "criteria": {"coal": "Coal", "gold": "Gold"},
                },
                "exits": {"coal": "N", "gold": "E"},
            },
            {
                "id": "danger",
                "x": 2,
                "y": 1,
                "entry": "W",
                "question": {
                    "type": "noul",
                    "instructions": "Is the cargo dangerous?",
                    "criteria": {"true": "Dangerous", "false": "Safe"},
                },
                "exits": {"yes": "S", "no": "E"},
                "threshold": 0.5,
            },
            {
                "id": "urgency",
                "x": 3,
                "y": 1,
                "entry": "W",
                "question": {
                    "type": "score",
                    "instructions": "How urgent is the delivery?",
                    "criteria": ["Calm", "Normal", "Rush"],
                },
                "exits": {"0": "N", "1": "E", "2": "S"},
            },
        ],
        "max_words": 12,
        "par_pieces": 0,
    }
)

GOOD_ANSWERS = {
    "cargo": {
        "type": "choice",
        "choice": "gold",
        "probabilities": {"coal": 0.02, "gold": 0.98},
        "confidence": 0.94,
    },
    "danger": {"type": "noul", "noul": 0.08},
    "urgency": {"type": "score", "score": 1.8, "legend": {}, "confidence": 0.81},
}

Handler = Callable[[httpx.Request], httpx.Response]


def answering(payload: object, status: int = 200) -> Handler:
    return lambda _request: httpx.Response(status, json=payload)


def answering_text(text: str, status: int = 200) -> Handler:
    return lambda _request: httpx.Response(status, text=text)


def failing(error: type[httpx.TransportError]) -> Handler:
    def handler(request: httpx.Request) -> httpx.Response:
        raise error("simulated", request=request)

    return handler


def with_answers(**changes: object) -> dict[str, object]:
    """`GOOD_ANSWERS` with some answers replaced, or removed when the change is None."""
    answers: dict[str, object] = {**GOOD_ANSWERS, **changes}
    return {"answers": {k: v for k, v in answers.items() if v is not None}}


async def run(handler: Handler, key: str = KEY) -> tuple[object, list[httpx.Request]]:
    """`ask_jev` through `handler`. Returns its result, or the exception it raised."""
    calls: list[httpx.Request] = []

    def recording(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return handler(request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(recording)) as client:
        try:
            return await ask_jev(LEVEL, SENTENCE, key, client), calls
        except JevError as error:
            return error, calls


# --- The request ---------------------------------------------------------------------------


async def test_sends_every_switch_question_without_the_threshold() -> None:
    _, calls = await run(answering(with_answers()))

    assert len(calls) == 1
    assert json.loads(calls[0].content) == {
        "state": SENTENCE,
        "model": "jev-latest",
        "questions": {
            "cargo": {
                "type": "choice",
                "instructions": "What is the cart carrying?",
                "criteria": {"coal": "Coal", "gold": "Gold"},
            },
            "danger": {
                "type": "noul",
                "instructions": "Is the cargo dangerous?",
                "criteria": {"true": "Dangerous", "false": "Safe"},
            },
            "urgency": {
                "type": "score",
                "instructions": "How urgent is the delivery?",
                "criteria": ["Calm", "Normal", "Rush"],
            },
        },
    }


async def test_posts_to_the_endpoint_with_the_key_as_a_bearer_token() -> None:
    _, calls = await run(answering(with_answers()))

    request = calls[0]
    assert request.method == "POST"
    assert str(request.url) == JEV_ENDPOINT == "https://api.typesafe.ai/v1/systemone"
    assert request.headers["authorization"] == f"Bearer {KEY}"
    assert request.headers["content-type"] == "application/json"
    # The key travels in the header and nowhere else.
    assert KEY not in str(request.url)
    assert KEY.encode() not in request.content


async def test_carries_a_30_second_deadline() -> None:
    _, calls = await run(answering(with_answers()))

    assert UPSTREAM_TIMEOUT == 30.0
    assert calls[0].extensions["timeout"] == {
        "connect": 30.0,
        "read": 30.0,
        "write": 30.0,
        "pool": 30.0,
    }


async def test_strips_whitespace_around_the_key() -> None:
    _, calls = await run(answering(with_answers()), key=f"  {KEY}\n")

    assert calls[0].headers["authorization"] == f"Bearer {KEY}"


# --- What comes back -----------------------------------------------------------------------


async def test_reads_a_whole_answer() -> None:
    result, _ = await run(answering(with_answers()))

    assert result == {
        "cargo": ChoiceAnswer(type="choice", choice="gold", confidence=0.94),
        "danger": NoulAnswer(type="noul", noul=0.08),
        "urgency": ScoreAnswer(type="score", score=1.8, confidence=0.81),
    }


async def test_leaves_a_score_outside_the_scale_to_the_engine() -> None:
    # Only the format is checked here; `simulate.py` refuses a score outside the scale.
    result, _ = await run(
        answering(with_answers(urgency={"type": "score", "score": 7.0, "confidence": 0.5}))
    )

    assert isinstance(result, dict)
    assert result["urgency"] == ScoreAnswer(type="score", score=7.0, confidence=0.5)


# --- Refused key ---------------------------------------------------------------------------


@pytest.mark.parametrize("key", ["", "   ", "\n\t", "two words", "chave-é"])
async def test_refuses_a_missing_or_malformed_key_without_a_call(key: str) -> None:
    result, calls = await run(answering(with_answers()), key=key)

    assert isinstance(result, JevRejectedKey)
    assert calls == []


@pytest.mark.parametrize("status", [401, 403])
async def test_reports_a_refused_key(status: int) -> None:
    result, _ = await run(answering({"error": "invalid api key"}, status))

    assert isinstance(result, JevRejectedKey)


# --- Unavailable ---------------------------------------------------------------------------


@pytest.mark.parametrize("status", [500, 502, 503, 429, 404, 400, 301])
async def test_reports_every_other_bad_status_as_unavailable(status: int) -> None:
    result, _ = await run(answering({"error": "nope"}, status))

    assert isinstance(result, JevUnavailable)


@pytest.mark.parametrize(
    "error", [httpx.ConnectError, httpx.ReadTimeout, httpx.ConnectTimeout, httpx.ReadError]
)
async def test_reports_a_transport_failure_or_timeout_as_unavailable(
    error: type[httpx.TransportError],
) -> None:
    result, _ = await run(failing(error))

    assert isinstance(result, JevUnavailable)


# --- Unusable answer -----------------------------------------------------------------------


UNUSABLE_BODIES: dict[str, Handler] = {
    "html": answering_text("<!doctype html><title>502</title>"),
    "empty": answering_text(""),
    "nan": answering_text('{"answers": {"danger": {"type": "noul", "noul": NaN}}}'),
    "null": answering(None),
    "a list": answering([GOOD_ANSWERS]),
    "no answers": answering({"model": "jev-1.13.0"}),
    "answers not an object": answering({"answers": [GOOD_ANSWERS]}),
    "an answer too many": answering(
        with_answers(weather={"type": "noul", "noul": 0.5}),
    ),
    "an answer missing": answering(with_answers(danger=None)),
    "no answers at all": answering({"answers": {}}),
    "type swapped": answering(with_answers(cargo={"type": "noul", "noul": 0.9})),
    "score for a noul": answering(
        with_answers(danger={"type": "score", "score": 1.0, "confidence": 0.9})
    ),
    "choice for a score": answering(
        with_answers(urgency={"type": "choice", "choice": "rush", "confidence": 0.9})
    ),
    "choice not in criteria": answering(
        with_answers(cargo={"type": "choice", "choice": "crystal", "confidence": 0.9})
    ),
    "confidence above 1": answering(
        with_answers(cargo={"type": "choice", "choice": "gold", "confidence": 1.2})
    ),
    "noul below 0": answering(with_answers(danger={"type": "noul", "noul": -0.1})),
    "noul as a string": answering(with_answers(danger={"type": "noul", "noul": "0.5"})),
    "noul as a boolean": answering(with_answers(danger={"type": "noul", "noul": True})),
    "noul missing": answering(with_answers(danger={"type": "noul"})),
    "unknown type": answering(with_answers(danger={"type": "maybe", "noul": 0.5})),
    "infinite score": answering_text(
        '{"answers": {"cargo": {"type": "choice", "choice": "gold", "confidence": 0.9},'
        ' "danger": {"type": "noul", "noul": 0.1},'
        ' "urgency": {"type": "score", "score": 1e999, "confidence": 0.9}}}'
    ),
}


@pytest.mark.parametrize("name", list(UNUSABLE_BODIES))
async def test_reports_an_answer_it_cannot_use(name: str) -> None:
    result, _ = await run(UNUSABLE_BODIES[name])

    assert isinstance(result, JevUnusableAnswer)


# --- Never writing the key or the sentence down --------------------------------------------


def echoing(status: int) -> Handler:
    """An upstream that quotes the whole request back, the worst case for a leak."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status,
            text=f"{request.headers['authorization']} {request.content.decode()}",
        )

    return handler


EVERY_FAILURE: dict[str, tuple[Handler, str]] = {
    "empty key": (answering(with_answers()), ""),
    "malformed key": (answering(with_answers()), f"{KEY} {SENTENCE}"),
    "401 echoing": (echoing(401), KEY),
    "403 echoing": (echoing(403), KEY),
    "500 echoing": (echoing(500), KEY),
    "connect error": (failing(httpx.ConnectError), KEY),
    "timeout": (failing(httpx.ReadTimeout), KEY),
    "200 echoing, not JSON": (echoing(200), KEY),
    **{f"unusable: {name}": (handler, KEY) for name, handler in UNUSABLE_BODIES.items()},
    "choice echoing the sentence": (
        answering(with_answers(cargo={"type": "choice", "choice": SENTENCE, "confidence": 0.9})),
        KEY,
    ),
    "invalid answer echoing the key": (
        answering(with_answers(danger={"type": "noul", "noul": KEY})),
        KEY,
    ),
}


@pytest.mark.parametrize("name", list(EVERY_FAILURE))
async def test_never_writes_the_key_or_the_sentence_down(
    name: str, caplog: pytest.LogCaptureFixture, capsys: pytest.CaptureFixture[str]
) -> None:
    handler, key = EVERY_FAILURE[name]
    caplog.set_level("DEBUG")

    result, _ = await run(handler, key=key)

    assert isinstance(result, JevError)
    # Nothing that could hold the request survives on the exception: the chain is empty.
    assert result.__cause__ is None
    assert result.__context__ is None
    out, err = capsys.readouterr()
    written = " ".join([str(result), repr(result), *map(str, result.args), caplog.text, out, err])
    for secret in (KEY, KEY[:8], SENTENCE):
        assert secret not in written
