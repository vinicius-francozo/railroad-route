"""`MemoryStore` and `UpstashStore`, held to the same behaviour.

Upstash is stood in by `FakeUpstash` behind `httpx.MockTransport`: the REST protocol as its
documentation describes it (https://upstash.com/docs/redis/features/restapi), and only the
commands the store uses. No test here reaches the network.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import UTC, datetime, timedelta, timezone
from typing import Any

import httpx
import pytest

from railroad.models import Answers, ChoiceAnswer, NoulAnswer, ScoreAnswer, Store
from railroad.store import (
    CACHE_TTL,
    QUOTA_GLOBAL,
    QUOTA_PER_IP,
    MemoryStore,
    QuotaLimits,
    StoreUnavailable,
    UpstashStore,
    normalize,
)

TOKEN = "upstash-token-4b1e-DO-NOT-LEAK"
URL = "https://example-12345.upstash.io"
SENTENCE = "Shiny  NUGGETS for the mine "

ANSWERS: Answers = {
    "cargo": ChoiceAnswer(type="choice", choice="gold", confidence=0.94),
    "danger": NoulAnswer(type="noul", noul=0.08),
    "urgency": ScoreAnswer(type="score", score=1.8, confidence=0.81),
}


class FakeClock:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now

    def advance(self, delta: timedelta) -> None:
        self.now += delta


class FakeUpstash:
    """A Redis behind the Upstash REST protocol, expiring keys by the same clock as the store."""

    def __init__(self, clock: FakeClock) -> None:
        self.clock = clock
        self.data: dict[str, tuple[str, datetime | None]] = {}
        self.requests: list[tuple[str, Any]] = []
        self.fail_with: int | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        if self.fail_with is not None:
            return httpx.Response(self.fail_with, json={"error": "ERR simulated"})
        if request.headers.get("authorization") != f"Bearer {TOKEN}":
            return httpx.Response(401, json={"error": "WRONGPASS invalid password"})
        body = json.loads(request.content)
        self.requests.append((request.url.path, body))
        if request.url.path == "/multi-exec":
            return httpx.Response(200, json=[self.run(command) for command in body])
        if request.url.path in ("", "/"):
            reply = self.run(body)
            return httpx.Response(400 if "error" in reply else 200, json=reply)
        return httpx.Response(404, json={"error": "ERR not found"})

    def live(self, key: str) -> str | None:
        entry = self.data.get(key)
        if entry is None:
            return None
        value, expires = entry
        if expires is not None and self.clock() >= expires:
            del self.data[key]
            return None
        return value

    def run(self, command: list[Any]) -> dict[str, Any]:
        name, key, *args = command
        value = self.live(key)
        expires = self.data[key][1] if value is not None else None
        match name.upper(), args:
            case "GET", []:
                return {"result": value}
            case "SET", [str(new)]:
                self.data[key] = (new, None)
                return {"result": "OK"}
            case "SET", [str(new), "EX", int(seconds)]:
                self.data[key] = (new, self.clock() + timedelta(seconds=seconds))
                return {"result": "OK"}
            case ("INCR" | "DECR") as op, []:
                count = int(value or "0") + (1 if op == "INCR" else -1)
                self.data[key] = (str(count), expires)
                return {"result": count}
            case "EXPIRE", [int(seconds)]:
                if value is None:
                    return {"result": 0}
                self.data[key] = (value, self.clock() + timedelta(seconds=seconds))
                return {"result": 1}
        return {"error": "ERR unknown command"}

    def commands(self) -> list[str]:
        """Every command sent, as `path NAME`, in order."""
        out: list[str] = []
        for path, body in self.requests:
            for command in body if path == "/multi-exec" else [body]:
                out.append(f"{path} {command[0]}")
        return out


START = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)

DEFAULT_LIMITS = QuotaLimits(per_ip=10, global_=300)

MakeStore = Callable[..., Store]


@pytest.fixture(params=["memory", "upstash"])
async def make(request: pytest.FixtureRequest) -> AsyncIterator[MakeStore]:
    """Builds the store under test. Both kinds share `clock` and `limits`."""
    kind: str = request.param
    clients: list[httpx.AsyncClient] = []

    def build(clock: FakeClock, limits: QuotaLimits = DEFAULT_LIMITS) -> Store:
        if kind == "memory":
            return MemoryStore(limits=limits, clock=clock)
        fake = FakeUpstash(clock)
        client = httpx.AsyncClient(transport=httpx.MockTransport(fake.handler))
        clients.append(client)
        return UpstashStore(URL, TOKEN, client, limits=limits, clock=clock)

    yield build
    for client in clients:
        await client.aclose()


async def spend(store: Store, ip: str, times: int) -> list[bool]:
    return [(await store.take_quota(ip)).allowed for _ in range(times)]


# --- Cache ---------------------------------------------------------------------------------


async def test_cache_misses_then_hits(make: MakeStore) -> None:
    store = make(FakeClock(START))

    assert await store.get_cached("first-switch", SENTENCE) is None
    await store.put_cached("first-switch", SENTENCE, ANSWERS)
    assert await store.get_cached("first-switch", SENTENCE) == ANSWERS


async def test_cache_reads_case_and_spacing_variants_as_one_sentence(make: MakeStore) -> None:
    store = make(FakeClock(START))
    await store.put_cached("first-switch", SENTENCE, ANSWERS)

    assert await store.get_cached("first-switch", "shiny nuggets\tFOR the   mine") == ANSWERS


async def test_cache_keeps_accents_punctuation_and_levels_apart(make: MakeStore) -> None:
    store = make(FakeClock(START))
    await store.put_cached("first-switch", "pôr o ouro", ANSWERS)

    assert await store.get_cached("first-switch", "por o ouro") is None
    assert await store.get_cached("first-switch", "pôr o ouro!") is None
    assert await store.get_cached("the-gate", "pôr o ouro") is None


async def test_cache_entry_expires_after_its_ttl(make: MakeStore) -> None:
    clock = FakeClock(START)
    store = make(clock)
    await store.put_cached("first-switch", SENTENCE, ANSWERS)

    assert timedelta(days=30) == CACHE_TTL
    clock.advance(CACHE_TTL - timedelta(seconds=1))
    assert await store.get_cached("first-switch", SENTENCE) == ANSWERS
    clock.advance(timedelta(seconds=1))
    assert await store.get_cached("first-switch", SENTENCE) is None


def test_normalize() -> None:
    assert normalize("  Gold\n NUGGETS  ") == "gold nuggets"
    assert normalize("STRASSE Straße") == "strasse strasse"
    assert normalize("pôr") == "pôr"


# --- Quota ---------------------------------------------------------------------------------


async def test_quota_per_ip(make: MakeStore) -> None:
    store = make(FakeClock(START), QuotaLimits(per_ip=3, global_=300))

    results = [await store.take_quota("1.1.1.1") for _ in range(4)]

    assert [r.allowed for r in results] == [True, True, True, False]
    assert [r.remaining for r in results] == [2, 1, 0, 0]
    # Another address has its own count.
    assert await spend(store, "2.2.2.2", 3) == [True, True, True]


async def test_quota_global_ceiling(make: MakeStore) -> None:
    store = make(FakeClock(START), QuotaLimits(per_ip=10, global_=5))

    assert await spend(store, "1.1.1.1", 3) == [True] * 3
    assert (await store.take_quota("2.2.2.2")).remaining == 1  # min(10 - 1, 5 - 4)
    assert await spend(store, "3.3.3.3", 2) == [True, False]
    assert await spend(store, "4.4.4.4", 1) == [False]


async def test_refused_call_spends_nothing(make: MakeStore) -> None:
    store = make(FakeClock(START), QuotaLimits(per_ip=2, global_=5))

    assert await spend(store, "1.1.1.1", 2) == [True, True]
    # Refused by the address's own limit: must not eat into the global ceiling, so the other
    # three calls of the five are still there.
    assert await spend(store, "1.1.1.1", 5) == [False] * 5
    assert await spend(store, "2.2.2.2", 2) == [True, True]
    assert await spend(store, "3.3.3.3", 2) == [True, False]
    # Refused by the global ceiling: still nothing given out.
    assert await spend(store, "4.4.4.4", 3) == [False] * 3


async def test_quota_rolls_over_at_utc_midnight(make: MakeStore) -> None:
    clock = FakeClock(datetime(2026, 10, 6, 23, 59, tzinfo=UTC))
    store = make(clock, QuotaLimits(per_ip=1, global_=300))
    assert await spend(store, "1.1.1.1", 2) == [True, False]

    # 20:59 in Brasília is still 23:59 UTC: the same day.
    clock.now = datetime(2026, 10, 6, 20, 59, 30, tzinfo=timezone(timedelta(hours=-3)))
    assert await spend(store, "1.1.1.1", 1) == [False]

    # 21:00 in Brasília is 00:00 UTC on the 7th: a new day, though it is still the 6th there.
    clock.now = datetime(2026, 10, 6, 21, 0, tzinfo=timezone(timedelta(hours=-3)))
    assert await spend(store, "1.1.1.1", 2) == [True, False]


async def test_quota_global_ceiling_rolls_over_too(make: MakeStore) -> None:
    clock = FakeClock(START)
    store = make(clock, QuotaLimits(per_ip=10, global_=2))
    assert await spend(store, "1.1.1.1", 3) == [True, True, False]

    clock.advance(timedelta(days=1))
    assert await spend(store, "2.2.2.2", 3) == [True, True, False]


async def test_quota_refuses_a_naive_clock(make: MakeStore) -> None:
    store = make(FakeClock(datetime(2026, 10, 6, 12, 0)))

    with pytest.raises(ValueError):
        await store.take_quota("1.1.1.1")


async def test_concurrent_calls_never_pass_the_ceiling(make: MakeStore) -> None:
    store = make(FakeClock(START), QuotaLimits(per_ip=10, global_=30))

    results = await asyncio.gather(*(store.take_quota(f"10.0.0.{i}") for i in range(50)))

    assert sum(r.allowed for r in results) == 30
    # The 20 refused calls gave their increments back.
    assert await spend(store, "10.0.1.1", 1) == [False]


async def test_concurrent_calls_from_one_ip_never_pass_its_limit(make: MakeStore) -> None:
    store = make(FakeClock(START), QuotaLimits(per_ip=10, global_=300))

    results = await asyncio.gather(*(store.take_quota("1.1.1.1") for _ in range(25)))

    assert sum(r.allowed for r in results) == 10
    # And the global ceiling only counts the 10.
    assert (await store.take_quota("2.2.2.2")).remaining == 9  # min(10 - 1, 300 - 11)


# --- Limits from the environment -----------------------------------------------------------


def test_limits_default_to_10_per_ip_and_300_global() -> None:
    assert QuotaLimits.from_env({}) == QuotaLimits(per_ip=10, global_=300)
    assert (QUOTA_PER_IP, QUOTA_GLOBAL) == (10, 300)


def test_limits_read_the_environment() -> None:
    env = {"RAILROAD_QUOTA_PER_IP": "3", "RAILROAD_QUOTA_GLOBAL": "40"}
    assert QuotaLimits.from_env(env) == QuotaLimits(per_ip=3, global_=40)


@pytest.mark.parametrize("value", ["ten", "", "-1", "2.5"])
def test_limits_refuse_a_bad_value(value: str) -> None:
    with pytest.raises(ValueError):
        QuotaLimits.from_env({"RAILROAD_QUOTA_GLOBAL": value})


async def test_stores_read_the_limits_from_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RAILROAD_QUOTA_PER_IP", "1")
    monkeypatch.setenv("RAILROAD_QUOTA_GLOBAL", "1")
    fake = FakeUpstash(FakeClock(START))

    async with httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)) as client:
        for store in (
            MemoryStore(clock=FakeClock(START)),
            UpstashStore(URL, TOKEN, client, clock=FakeClock(START)),
        ):
            assert await spend(store, "1.1.1.1", 2) == [True, False]


# --- Upstash: what goes over the wire ------------------------------------------------------


@pytest.fixture
async def upstash() -> AsyncIterator[tuple[FakeUpstash, UpstashStore, FakeClock]]:
    clock = FakeClock(START)
    fake = FakeUpstash(clock)
    async with httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)) as client:
        yield (
            fake,
            UpstashStore(URL + "/", TOKEN, client, limits=QuotaLimits(2, 300), clock=clock),
            clock,
        )


async def test_upstash_counts_in_one_transaction_and_expires_the_counters(
    upstash: tuple[FakeUpstash, UpstashStore, FakeClock],
) -> None:
    fake, store, _ = upstash

    await store.take_quota("1.1.1.1")

    path, body = fake.requests[0]
    assert path == "/multi-exec"
    assert [command[0] for command in body] == ["INCR", "EXPIRE", "INCR", "EXPIRE"]
    ip_key, global_key = body[0][1], body[2][1]
    assert body[1] == ["EXPIRE", ip_key, 2 * 24 * 3600]
    assert body[3] == ["EXPIRE", global_key, 2 * 24 * 3600]
    assert global_key == "railroad:quota:2026-10-06:global"
    assert ip_key.startswith("railroad:quota:2026-10-06:ip:")
    assert "1.1.1.1" not in ip_key


async def test_upstash_gives_a_refused_call_back_in_one_transaction(
    upstash: tuple[FakeUpstash, UpstashStore, FakeClock],
) -> None:
    fake, store, _ = upstash

    await spend(store, "1.1.1.1", 3)

    assert fake.commands()[-2:] == ["/multi-exec DECR", "/multi-exec DECR"]
    assert [v for v, _ in fake.data.values()] == ["2", "2"]


async def test_upstash_counters_expire(
    upstash: tuple[FakeUpstash, UpstashStore, FakeClock],
) -> None:
    fake, store, clock = upstash
    await store.take_quota("1.1.1.1")

    clock.advance(timedelta(days=2))

    assert all(fake.live(key) is None for key in list(fake.data))


async def test_upstash_caches_with_set_ex_under_a_hashed_key(
    upstash: tuple[FakeUpstash, UpstashStore, FakeClock],
) -> None:
    fake, store, _ = upstash

    await store.put_cached("first-switch", SENTENCE, ANSWERS)

    path, body = fake.requests[0]
    assert path == "/"
    assert body[0] == "SET"
    assert body[3:] == ["EX", 30 * 24 * 3600]
    assert body[1].startswith("railroad:cache:first-switch:")
    assert "nuggets" not in body[1].lower()
    assert json.loads(body[2])["cargo"] == {"type": "choice", "choice": "gold", "confidence": 0.94}


async def test_upstash_treats_an_unreadable_entry_as_a_miss(
    upstash: tuple[FakeUpstash, UpstashStore, FakeClock],
) -> None:
    fake, store, _ = upstash
    await store.put_cached("first-switch", SENTENCE, ANSWERS)
    key = next(iter(fake.data))
    fake.data[key] = ('{"cargo": {"type": "nonsense"}}', None)

    assert await store.get_cached("first-switch", SENTENCE) is None


# --- Upstash: failures, and the token ------------------------------------------------------


def failing_transport(error: type[httpx.TransportError]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        raise error("simulated", request=request)

    return httpx.MockTransport(handler)


def replying(status: int, payload: object) -> httpx.MockTransport:
    return httpx.MockTransport(lambda _request: httpx.Response(status, json=payload))


FAILURES: dict[str, httpx.MockTransport] = {
    "connect error": failing_transport(httpx.ConnectError),
    "timeout": failing_transport(httpx.ReadTimeout),
    "401": replying(401, {"error": "WRONGPASS invalid password"}),
    "500": replying(500, {"error": f"ERR {TOKEN}"}),
    "400 error": replying(400, {"error": "ERR wrong number of arguments"}),
    "not json": httpx.MockTransport(lambda _r: httpx.Response(200, text=f"<html>{TOKEN}</html>")),
    "discarded transaction": replying(200, {"error": "ERR transaction discarded"}),
    "error inside a transaction": replying(
        200, [{"result": 1}, {"error": "ERR"}, {"result": 1}, {"result": 1}]
    ),
    "short transaction": replying(200, [{"result": 1}]),
    "count not a number": replying(
        200, [{"result": "1"}, {"result": 1}, {"result": 1}, {"result": 1}]
    ),
    "result missing": replying(200, {"value": None}),
}

OPERATIONS: dict[str, Callable[[UpstashStore], Awaitable[object]]] = {
    "get_cached": lambda store: store.get_cached("first-switch", SENTENCE),
    "put_cached": lambda store: store.put_cached("first-switch", SENTENCE, ANSWERS),
    "take_quota": lambda store: store.take_quota("1.1.1.1"),
}


@pytest.mark.parametrize("operation", list(OPERATIONS))
@pytest.mark.parametrize("failure", list(FAILURES))
async def test_upstash_failures_raise_without_the_token(
    failure: str,
    operation: str,
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
) -> None:
    caplog.set_level("DEBUG")
    async with httpx.AsyncClient(transport=FAILURES[failure]) as client:
        store = UpstashStore(
            URL, TOKEN, client, limits=QuotaLimits(10, 300), clock=FakeClock(START)
        )
        try:
            await OPERATIONS[operation](store)
        except StoreUnavailable as error:
            raised: StoreUnavailable | None = error
        else:
            raised = None

    assert raised is not None
    assert raised.__cause__ is None
    assert raised.__context__ is None
    out, err = capsys.readouterr()
    written = " ".join([str(raised), repr(raised), caplog.text, out, err])
    assert TOKEN not in written
    assert TOKEN[:8] not in written


async def test_upstash_sends_the_token_as_a_bearer_and_nowhere_else() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"result": None})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await UpstashStore(URL, TOKEN, client).get_cached("first-switch", SENTENCE)

    assert seen[0].headers["authorization"] == f"Bearer {TOKEN}"
    assert TOKEN not in str(seen[0].url)
    assert TOKEN.encode() not in seen[0].content
    assert seen[0].extensions["timeout"]["read"] == 5.0
