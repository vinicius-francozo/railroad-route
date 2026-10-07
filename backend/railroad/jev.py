"""One call to Jev (TypeSafe System One) per run, with every switch of the level in it.

Every switch is asked at once, rather than only the ones on the cart's path, because the
sentence is fixed for the whole run and several questions in one request do not move each
other's answers: 0.006 of mean drift going from 7 to 13 questions, 0.0050 going to 16, measured
in gridsmith (`src/interpreter/jev/questions.ts:9-17`). One call then decides the whole path, and
the answers can be cached per (level, sentence) because a level's questions never change.

## The key

The key is either the server's or one a visitor pasted. Nothing in this module logs, prints or
stores it, and every exception message is a literal written here: nothing read off the request
or the response, and no caught exception, is ever interpolated into one, because a message that
echoes the request is the shape a leaked key arrives in (the posture of gridsmith's
`api/jev.ts:21-29` and `:129-140`).

That goes for the exception chain too. An `httpx.HTTPError` holds the `httpx.Request`, and the
request holds the `authorization` header; a pydantic `ValidationError` holds the input it
refused, which is the body, which can quote the sentence. `raise ... from None` is not enough,
since it only hides `__context__` from the traceback and keeps the reference. So each failure is
suppressed where it happens and raised after it, where there is no exception being handled and
both `__cause__` and `__context__` are None.
"""

from __future__ import annotations

import contextlib
import json
import math
import re
from typing import Any, NoReturn

import httpx
from pydantic import TypeAdapter, ValidationError

from railroad.models import (
    Answer,
    Answers,
    ChoiceAnswer,
    ChoiceQuestion,
    Level,
    NoulAnswer,
    NoulQuestion,
    ScoreAnswer,
    ScoreQuestion,
)

JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone"

JEV_MODEL = "jev-latest"

UPSTREAM_TIMEOUT = 30.0
"""Seconds to wait before calling it silence.

"Did not answer" has to include "never answered". Without a deadline a hung upstream becomes
whatever timeout the host enforces, and the run fails as the host's error instead of as
`JevUnavailable` (gridsmith `api/jev.ts:53-60`).
"""

_TOKEN = re.compile(r"[\x21-\x7e]+")
"""Printable ASCII with no space: what can travel in an `authorization` header as it is.

Anything else would fail inside httpx while the request is being built, with an exception that
carries the header value, so it is refused here first.
"""

_ANSWER: TypeAdapter[Answer] = TypeAdapter(Answer)

_NOT_JSON = object()


class JevError(Exception):
    """Any of the three ways a call to Jev fails. The message is always a literal."""


class JevUnavailable(JevError):
    """The request never came back with an answer: the network, a timeout, or any status that
    is not a success and not a refused key. One type, because the answer to all of them is the
    same: wait and try again."""


class JevRejectedKey(JevError):
    """The key is missing, is not a token, or Jev answered 401 or 403 to it."""


class JevUnusableAnswer(JevError):
    """Jev answered, and the answer is not something the game can use."""


async def ask_jev(level: Level, sentence: str, api_key: str, client: httpx.AsyncClient) -> Answers:
    """Jev's answer to every switch of `level`, about `sentence`.

    `client` is the seam the tests drive this through, the counterpart of gridsmith's
    `fetchImpl` (`src/interpreter/jev/jev.ts:46-49`).

    The key is stripped first. A server key read from the environment with a trailing newline
    is the same key, and the header a visitor's key arrives in has already been stripped by the
    HTTP server, so this only changes what would otherwise fail as an illegal header.

    :raises JevRejectedKey: before any request, if the key is empty or not a token; after it, on
        401 or 403.
    :raises JevUnavailable: on any transport failure, a timeout, or any other status that is not
        2xx.
    :raises JevUnusableAnswer: if a 2xx body is not the answers to exactly the questions asked,
        each in the shape of its question.
    """
    key = api_key.strip()
    # Before the request: an empty key travels as an empty `Bearer` and comes back a round trip
    # later as a 401, which reads as "that key is wrong" to somebody who supplied none
    # (gridsmith `api/jev.ts:164-171`).
    if _TOKEN.fullmatch(key) is None:
        raise JevRejectedKey("The TypeSafe key was not accepted.")

    body = {
        "state": sentence,
        "model": JEV_MODEL,
        # The question only. A noul switch's `threshold` lives on the switch, not on its
        # question: it is the game's reading of the answer, and Jev is not told about it.
        "questions": {s.id: s.question.model_dump(mode="json") for s in level.switches},
    }

    response: httpx.Response | None = None
    # Suppressed and raised below, outside the handler; see the module docstring.
    with contextlib.suppress(httpx.HTTPError):
        response = await client.post(
            JEV_ENDPOINT,
            json=body,
            headers={"authorization": f"Bearer {key}", "content-type": "application/json"},
            timeout=UPSTREAM_TIMEOUT,
        )
    if response is None:
        raise JevUnavailable("The Jev request did not get through.")

    if response.status_code in (401, 403):
        raise JevRejectedKey("The TypeSafe key was not accepted.")
    if not response.is_success:
        raise JevUnavailable("The Jev request did not get through.")

    return _read(level, response.content)


def _read(level: Level, content: bytes) -> Answers:
    """The answers in a 2xx body, once they are known to answer exactly what was asked.

    The score is held to its format (a finite number) and not to its scale. Whether it falls
    inside `0..len(criteria) - 1` is the engine's call: `simulate.py` refuses a score outside
    the scale rather than clamping it (gridsmith `read.ts:284-303`), and a second copy of that
    rule here would be one more place for the two to drift apart.
    """
    data: Any = _NOT_JSON
    with contextlib.suppress(ValueError):
        data = json.loads(content, parse_constant=_reject_constant)
    if data is _NOT_JSON:
        _unusable("The response was not JSON.")
    if not isinstance(data, dict) or not isinstance(data.get("answers"), dict):
        _unusable("The response carried no answers.")
    raw: dict[str, Any] = data["answers"]

    # Both directions (gridsmith `read.ts:242-267`). An answer missing would be a switch with no
    # way out; an answer nobody asked for means the response is about another request.
    if set(raw) != {s.id for s in level.switches}:
        _unusable("The answers are not the questions that were asked.")

    answers: Answers = {}
    for switch in level.switches:
        answer: Answer | None = None
        # Strict, so that "0.5" or `true` is refused rather than read as a number.
        with contextlib.suppress(ValidationError):
            answer = _ANSWER.validate_python(raw[switch.id], strict=True)
        if answer is None:
            _unusable("An answer is not in the shape of any question type.")

        question = switch.question
        if isinstance(question, ChoiceQuestion):
            if not isinstance(answer, ChoiceAnswer):
                _unusable("An answer is of a different type than its question.")
            if answer.choice not in question.criteria:
                _unusable("A choice is not one of its question's keys.")
        elif isinstance(question, NoulQuestion):
            if not isinstance(answer, NoulAnswer):
                _unusable("An answer is of a different type than its question.")
        elif isinstance(question, ScoreQuestion):
            if not isinstance(answer, ScoreAnswer):
                _unusable("An answer is of a different type than its question.")
            # `1e999` is valid JSON and parses to infinity, which no rounding can place.
            if not math.isfinite(answer.score):
                _unusable("A score is not a finite number.")
        answers[switch.id] = answer
    return answers


def _reject_constant(_: str) -> NoReturn:
    """`NaN` and `Infinity` are not JSON, though Python's parser accepts them by default."""
    raise ValueError("not JSON")


def _unusable(message: str) -> NoReturn:
    raise JevUnusableAnswer(message)
