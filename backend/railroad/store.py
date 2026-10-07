"""Jev's answers cached per (level, sentence), and the free daily quota of the server's key.

Two implementations of `models.Store`: `MemoryStore` for dev and tests, `UpstashStore` for the
deploy, which talks to Upstash Redis over its REST API with the injected `httpx.AsyncClient`
(no SDK). Both take the clock as a callable, so a test can cross midnight without waiting.

## The cache

Keyed by `(level_id, normalize(sentence))`. It holds because a level's switches are fixed: moving
track never changes the questions, so the answers to one sentence on one level are the answers
for every board. It also makes a run stable for the player: Jev wobbles up to 0.05 between runs
of the same sentence (gridsmith `src/interpreter/jev/questions.ts:130-132`), and the same
sentence on the same level now gives the same path for as long as the entry lives.

Entries live `CACHE_TTL` (30 days): long enough that a published level keeps answering a sentence
it has seen, short enough that nothing accumulates forever. Jev is always sent the sentence as
typed; only the cache key is normalized.

## The quota

Each `take_quota(ip)` spends one of `ip`'s daily calls *and* one of the global daily ceiling, or
neither. A day is a UTC calendar day, so the counters are named after the day and roll over by
name; their TTL only clears yesterday's keys away.
"""

from __future__ import annotations

import contextlib
import hashlib
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Self

import httpx
from pydantic import TypeAdapter, ValidationError

from railroad.models import Answers, QuotaResult

QUOTA_PER_IP = 10
QUOTA_GLOBAL = 300
"""Defaults for `RAILROAD_QUOTA_PER_IP` and `RAILROAD_QUOTA_GLOBAL`: calls to Jev per IP per UTC
day, and for everybody together per UTC day."""

CACHE_TTL = timedelta(days=30)

QUOTA_TTL = timedelta(days=2)
"""How long a day's counter outlives its last use in Upstash. Two days rather than one so that
a clock running a little ahead of Redis's never expires a counter that is still today's."""

STORE_TIMEOUT = 5.0
"""Seconds to wait for Upstash. A store that hangs should fail the run quickly, not hold it for
the 30 seconds Jev is allowed."""

Clock = Callable[[], datetime]
"""Returns the current time as an aware datetime."""

_ANSWERS: TypeAdapter[Answers] = TypeAdapter(Answers)


def utc_now() -> datetime:
    return datetime.now(UTC)


def normalize(sentence: str) -> str:
    """The sentence as the cache sees it: casefolded, whitespace collapsed, ends stripped.

    "Gold  nuggets " and "gold nuggets" are the same sentence to the player, and to the Taboo
    check, which ignores case too. Treating them as two would let a player re-roll Jev's answer,
    and spend quota, just by retyping. Accents and punctuation are kept: "por" and "pôr" are
    different words. That Jev reads the case variants alike is assumed, not measured.
    """
    return " ".join(sentence.casefold().split())


@dataclass(frozen=True)
class QuotaLimits:
    per_ip: int
    global_: int

    @classmethod
    def from_env(cls, environ: Mapping[str, str] = os.environ) -> Self:
        """`RAILROAD_QUOTA_PER_IP` and `RAILROAD_QUOTA_GLOBAL`, or the defaults.

        :raises ValueError: if either is set to something that is not a whole number >= 0, so a
            typo fails at startup instead of silently giving the default.
        """
        return cls(
            per_ip=_limit(environ, "RAILROAD_QUOTA_PER_IP", QUOTA_PER_IP),
            global_=_limit(environ, "RAILROAD_QUOTA_GLOBAL", QUOTA_GLOBAL),
        )

    def result(self, allowed: bool, ip_count: int, global_count: int) -> QuotaResult:
        """`remaining` is what is left to `ip` today: the lesser of its own and the global."""
        remaining = min(self.per_ip - ip_count, self.global_ - global_count)
        return QuotaResult(allowed=allowed, remaining=max(0, remaining))


def _limit(environ: Mapping[str, str], name: str, default: int) -> int:
    raw = environ.get(name)
    if raw is None:
        return default
    value = int(raw)  # A ValueError here names the bad value, which is configuration, not a key.
    if value < 0:
        raise ValueError(f"{name} must be >= 0")
    return value


def _day(clock: Clock) -> str:
    now = clock()
    if now.tzinfo is None:
        # A naive datetime would be read as local time and move midnight off UTC.
        raise ValueError("the clock must return an aware datetime")
    return now.astimezone(UTC).date().isoformat()


class StoreUnavailable(Exception):
    """Upstash did not answer, or answered with something other than a result.

    The message is always a literal: the request held the token in its `authorization` header,
    and the failure is raised outside the handler so that neither `__cause__` nor `__context__`
    keeps it (the same arrangement as `jev.py`).
    """


# --- In memory -----------------------------------------------------------------------------


class MemoryStore:
    """For dev and tests. Nothing awaits between reading and writing a counter, so on one event
    loop a `take_quota` cannot interleave with another."""

    def __init__(
        self,
        *,
        limits: QuotaLimits | None = None,
        clock: Clock = utc_now,
        cache_ttl: timedelta = CACHE_TTL,
    ) -> None:
        self._limits = limits if limits is not None else QuotaLimits.from_env()
        self._clock = clock
        self._cache_ttl = cache_ttl
        self._cache: dict[tuple[str, str], tuple[datetime, Answers]] = {}
        self._day = ""
        self._per_ip: dict[str, int] = {}
        self._global = 0

    async def get_cached(self, level_id: str, sentence: str) -> Answers | None:
        key = (level_id, normalize(sentence))
        entry = self._cache.get(key)
        if entry is None:
            return None
        expires, answers = entry
        if self._clock() >= expires:
            del self._cache[key]
            return None
        return dict(answers)

    async def put_cached(self, level_id: str, sentence: str, answers: Answers) -> None:
        expires = self._clock() + self._cache_ttl
        self._cache[(level_id, normalize(sentence))] = (expires, dict(answers))

    async def take_quota(self, ip: str) -> QuotaResult:
        day = _day(self._clock)
        if day != self._day:
            # Yesterday's counters are dropped rather than kept beside today's.
            self._day, self._per_ip, self._global = day, {}, 0
        ip_count = self._per_ip.get(ip, 0) + 1
        global_count = self._global + 1
        if ip_count > self._limits.per_ip or global_count > self._limits.global_:
            return self._limits.result(False, ip_count - 1, global_count - 1)
        self._per_ip[ip], self._global = ip_count, global_count
        return self._limits.result(True, ip_count, global_count)


# --- Upstash -------------------------------------------------------------------------------


class UpstashStore:
    """Upstash Redis through its REST API (https://upstash.com/docs/redis/features/restapi).

    One command is a `POST` to the database URL with the command as a JSON array, answered with
    `{"result": ...}` or `{"error": ...}`. A transaction is the same array of arrays posted to
    `/multi-exec`, answered with one `{"result"}` or `{"error"}` per command.

    ## The quota, atomically enough

    Both counters are `INCR`ed, and their `EXPIRE` set, in one `MULTI/EXEC`, so each request
    sees the counts its own increments produced. If either is now over its limit the request is
    refused and both are `DECR`ed back in a second transaction. A request is allowed only when
    its own increment left the counter within the limit, so the number allowed can never pass
    a limit, however many arrive at once.

    The cost is on the other side: between one request's `INCR` and its `DECR`, another can see
    the inflated count and be refused too. That is only possible at the edge of a limit, where
    the answer is about to be "no" anyway, and it errs towards refusing, never towards spending
    the server's key past the ceiling. A Lua script would close it, at the price of testing a
    Python stand-in for the script instead of the commands that actually run. If the `DECR`
    itself fails, `StoreUnavailable` is raised and that refused call stays counted until the
    day's key rolls over.

    Key names never carry player text or an address: the sentence and the IP are hashed. The
    IP arrives from a header anybody can set, and a hash bounds the key's length as well as
    keeping addresses out of the database.
    """

    def __init__(
        self,
        url: str,
        token: str,
        client: httpx.AsyncClient,
        *,
        limits: QuotaLimits | None = None,
        clock: Clock = utc_now,
        cache_ttl: timedelta = CACHE_TTL,
    ) -> None:
        self._url = url.rstrip("/")
        self._token = token
        self._client = client
        self._limits = limits if limits is not None else QuotaLimits.from_env()
        self._clock = clock
        self._cache_ttl = cache_ttl

    async def get_cached(self, level_id: str, sentence: str) -> Answers | None:
        raw = await self._command(["GET", _cache_key(level_id, sentence)])
        if raw is None:
            return None
        if not isinstance(raw, str):
            raise StoreUnavailable("Upstash answered with something other than a result.")
        answers: Answers | None = None
        # An entry that no longer reads as answers is treated as a miss: the run asks Jev
        # again and `put_cached` overwrites it.
        with contextlib.suppress(ValidationError):
            answers = _ANSWERS.validate_json(raw)
        return answers

    async def put_cached(self, level_id: str, sentence: str, answers: Answers) -> None:
        value = _ANSWERS.dump_json(answers).decode()
        ttl = int(self._cache_ttl.total_seconds())
        await self._command(["SET", _cache_key(level_id, sentence), value, "EX", ttl])

    async def take_quota(self, ip: str) -> QuotaResult:
        day = _day(self._clock)
        ip_key = f"railroad:quota:{day}:ip:{_digest(ip)}"
        global_key = f"railroad:quota:{day}:global"
        ttl = int(QUOTA_TTL.total_seconds())

        ip_count, _, global_count, _ = await self._transaction(
            ["INCR", ip_key],
            ["EXPIRE", ip_key, ttl],
            ["INCR", global_key],
            ["EXPIRE", global_key, ttl],
        )
        if not (isinstance(ip_count, int) and isinstance(global_count, int)):
            raise StoreUnavailable("Upstash answered with something other than a result.")
        if ip_count <= self._limits.per_ip and global_count <= self._limits.global_:
            return self._limits.result(True, ip_count, global_count)

        await self._transaction(["DECR", ip_key], ["DECR", global_key])
        return self._limits.result(False, ip_count - 1, global_count - 1)

    async def _command(self, command: list[str | int]) -> Any:
        reply = await self._post(self._url, command)
        if not isinstance(reply, dict) or "result" not in reply:
            raise StoreUnavailable("Upstash answered with something other than a result.")
        return reply["result"]

    async def _transaction(self, *commands: list[str | int]) -> list[Any]:
        reply = await self._post(f"{self._url}/multi-exec", list(commands))
        # A discarded transaction is a single `{"error": ...}`; a command that failed inside one
        # is an `{"error": ...}` in its place.
        if not (
            isinstance(reply, list)
            and len(reply) == len(commands)
            and all(isinstance(item, dict) and "result" in item for item in reply)
        ):
            raise StoreUnavailable("Upstash answered with something other than a result.")
        return [item["result"] for item in reply]

    async def _post(self, url: str, body: object) -> Any:
        response: httpx.Response | None = None
        # Suppressed and raised below, outside the handler; see `StoreUnavailable`.
        with contextlib.suppress(httpx.HTTPError):
            response = await self._client.post(
                url,
                json=body,
                headers={"authorization": f"Bearer {self._token}"},
                timeout=STORE_TIMEOUT,
            )
        if response is None or response.status_code != 200:
            raise StoreUnavailable("Upstash did not answer.")
        reply: Any = None
        with contextlib.suppress(ValueError):
            reply = response.json()
        return reply


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _cache_key(level_id: str, sentence: str) -> str:
    return f"railroad:cache:{level_id}:{_digest(normalize(sentence))}"
