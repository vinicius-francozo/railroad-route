"""The HTTP face of the game: `GET /api/levels` and `POST /api/run`.

Nothing here decides a rule of the game. It reads the request, calls the engine and Jev in the
order the map lays out (`rules` -> `board` -> `simulate` -> cache -> quota -> Jev -> `simulate`
-> stars), and turns each failure into the `ErrorResponse` the page expects.

## The key

The server's key (`TYPESAFE_API_KEY`) and a visitor's (`x-typesafe-key`) are handed to
`ask_jev` and to nothing else. This module has no `logging` and no `print`, and every `detail`
it writes is a literal: nothing read off the request, not the sentence, not the body, not a
key, is ever interpolated into one (the posture of gridsmith's `api/jev.ts:21-29`). The two
details that do carry something are the engine's own: `RuleViolation.detail` names the level's
Taboo terms or counts, never the sentence, and `InvalidBoard.detail` names a cell and a piece.

## Decisions this module makes

- **A malformed body is `invalid_board`.** `ErrorKind` has no generic "bad request", and
  widening the contract is not this module's call; the run the page sent is, in the end, not a
  board the level can take.
- **The body is capped at `MAX_BODY_BYTES` before it is parsed.** `rules.py` folds the whole
  sentence before it checks its length, so the fold of a huge one costs in proportion to its
  size. The cap is counted on the bytes as they arrive, not only on `content-length`, so a
  chunked body is held to it too.
- **Quota spent on a call that then fails is not given back.** `Store` has no refund, and a
  call that reached Jev was a call the server's key paid for.
- **A cached answer the engine refuses is a miss, not an answer.** It is asked again, and the
  new answer overwrites the entry.
- **A cache that cannot be read is a miss only with the visitor's key.** That run goes on to Jev
  on the visitor's key, which needs nothing from the store. Without it the run stops at 502:
  the quota lives in the same store, and a free run cannot be counted without it.
- **An answer the store cannot keep is still served.** The quota is spent and Jev has answered;
  failing the run there would spend both again on every retry. The write is lost, and the next
  run of the same sentence asks Jev again.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
from collections.abc import AsyncIterator, Mapping
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass
from typing import Annotated, Any

import httpx
from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from railroad.board import build_board
from railroad.jev import JevRejectedKey, JevUnavailable, JevUnusableAnswer, ask_jev
from railroad.models import (
    Answers,
    Board,
    ErrorKind,
    ErrorResponse,
    InvalidBoard,
    Level,
    QuotaInfo,
    RuleViolation,
    RunRequest,
    RunResponse,
    Simulation,
    Store,
    Tuning,
    load_levels,
    load_tuning,
)
from railroad.rules import check_sentence
from railroad.scoring import is_clean, score
from railroad.simulate import simulate
from railroad.store import MemoryStore, QuotaLimits, StoreUnavailable, UpstashStore

KEY_HEADER = "x-typesafe-key"
"""The header a visitor's own key arrives in (BYOK). Not `authorization`, as in gridsmith's
`api/jev.ts:44-51`, so it is never mistaken for a credential of this deployment."""

MAX_BODY_BYTES = 16 * 1024
"""The largest `POST /api/run` body read. A real run is a sentence of at most 200 characters
and a few dozen edits on a 16x16 grid at most, well under a kilobyte or two."""

_NOT_A_RUN = "The request is not a valid run."
_UNKNOWN_LEVEL = "There is no level with that id."
_NO_SERVER_KEY = "This server has no TypeSafe key. Paste your own key to play."
_QUOTA_EXHAUSTED = "The free runs for today are used up. Paste your own TypeSafe key to play on."
_KEY_REJECTED = "The TypeSafe key was not accepted."
_JEV_UNAVAILABLE = "Jev could not be reached. Try again in a moment."
_JEV_UNUSABLE = "Jev answered with something the switches cannot read."
_STORE_UNAVAILABLE = "The game's storage could not be reached. Try again in a moment."
_UPSTASH_HALF_SET = (
    "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set together, or neither."
)


def cache_id(level: Level) -> str:
    """The id `level`'s answers are cached under: its id, `@`, and a hash of its questions.

    The cache holds per (level, sentence) because a level's questions never change while it is
    published. They do change between versions of the game, though, and an entry keyed by the
    level id alone would then keep serving answers to the old questions for the 30 days the
    entry lives (`store.CACHE_TTL`): a sentence that read "gold" against "coal / gold" would
    still read "gold" after a third option was added. Folding the questions into the id moves
    every changed level onto fresh keys without touching the store's contract. Only what Jev
    is asked and how its answer is read goes in (the switch id, the question, the exits and
    the threshold), so moving track or retuning the stars keeps the cache.
    """
    switches = [
        {
            "id": s.id,
            "question": s.question.model_dump(mode="json"),
            "exits": s.exits,
            "threshold": s.threshold,
        }
        for s in level.switches
    ]
    canonical = json.dumps(switches, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return f"{level.id}@{hashlib.sha256(canonical.encode()).hexdigest()[:16]}"


def client_ip(request: Request) -> str:
    """The visitor's address: the first entry of `x-forwarded-for`, else the socket's peer.

    On Vercel the header is the platform's, not the visitor's: Vercel overwrites
    `X-Forwarded-For` and does not forward external IPs, "to prevent IP spoofing"
    (https://vercel.com/docs/headers/request-headers#x-forwarded-for). Anywhere else, `uvicorn`
    in development included, a client can set it to anything, and the quota per IP is only as
    good as the proxy in front.
    """
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    if forwarded:
        return forwarded
    if request.client is not None and request.client.host:
        return request.client.host
    return "unknown"


def public_level(level: Level) -> dict[str, Any]:
    """`level` as the page receives it (`PublicLevel` in `src/contract.ts`)."""
    return level.model_dump(mode="json", exclude={"reference_solution"})


def _upstash_settings(environ: Mapping[str, str]) -> tuple[str, str] | None:
    """The Upstash URL and token when both are set, None when neither is.

    :raises ValueError: when only one of them is set (blank counts as unset). Falling back to
        memory then would hide a deploy that meant to use Upstash and missed a variable. The
        message names the variables and never their values.
    """
    url = environ.get("UPSTASH_REDIS_REST_URL", "").strip()
    token = environ.get("UPSTASH_REDIS_REST_TOKEN", "").strip()
    if url and token:
        return url, token
    if url or token:
        raise ValueError(_UPSTASH_HALF_SET)
    return None


def store_from_env(environ: Mapping[str, str], client: httpx.AsyncClient) -> Store:
    """Upstash when both of its variables are set, memory when neither is.

    The memory store lives as long as one process. That is right for development, and only
    for it: in production both `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are
    required, or every serverless instance keeps its own cache and its own quota, and the
    daily limits hold per instance rather than for the deploy.

    :raises ValueError: when only one of the two is set (see `_upstash_settings`).
    """
    settings = _upstash_settings(environ)
    limits = QuotaLimits.from_env(environ)
    if settings is not None:
        url, token = settings
        return UpstashStore(url, token, client, limits=limits)
    return MemoryStore(limits=limits)


@dataclass
class _Services:
    """What the lifespan opens. None until it has run."""

    store: Store | None = None
    client: httpx.AsyncClient | None = None


def create_app(
    *,
    levels: dict[str, Level] | None = None,
    tuning: Tuning | None = None,
    store: Store | None = None,
    client: httpx.AsyncClient | None = None,
    server_key: str | None = None,
    environ: Mapping[str, str] | None = None,
) -> FastAPI:
    """The app, with every dependency injectable.

    Whatever is not passed comes from `environ` (`os.environ` by default) and from `levels/`:
    the levels and the tuning are read once, here; the HTTP client and the store are opened by
    the lifespan, so one `httpx.AsyncClient` serves both Jev and Upstash for the app's life. A
    client passed in belongs to the caller, and is not closed.

    :raises ValueError: when no store is passed and only one of Upstash's two variables is set,
        here rather than in the lifespan, so a deploy missing one fails as it starts.
    """
    env: Mapping[str, str] = os.environ if environ is None else environ
    if store is None:
        _upstash_settings(env)
    all_levels = load_levels() if levels is None else levels
    the_tuning = load_tuning() if tuning is None else tuning
    own_key = (env.get("TYPESAFE_API_KEY", "") if server_key is None else server_key).strip()
    cache_ids = {level_id: cache_id(level) for level_id, level in all_levels.items()}
    public = [public_level(level) for level in all_levels.values()]
    services = _Services()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        async with AsyncExitStack() as stack:
            http = client
            if http is None:
                http = await stack.enter_async_context(httpx.AsyncClient())
            services.client = http
            services.store = store if store is not None else store_from_env(env, http)
            yield

    app = FastAPI(title="Railroad Route", lifespan=lifespan)

    @app.get("/api/levels")
    async def get_levels() -> JSONResponse:
        return JSONResponse(public)

    @app.post("/api/run")
    async def post_run(
        request: Request,
        x_typesafe_key: Annotated[str | None, Header(alias=KEY_HEADER)] = None,
    ) -> JSONResponse:
        the_store, http = services.store, services.client
        if the_store is None or http is None:
            raise RuntimeError("the app's lifespan has not run")

        body = await _read_body(request)
        run: RunRequest | None = None
        if body is not None:
            # A `ValidationError` holds the input it refused, which can quote the sentence, so
            # it is dropped here rather than kept on the way to a response.
            with contextlib.suppress(ValidationError):
                run = RunRequest.model_validate_json(body)
        if run is None:
            return _error(422, "invalid_board", _NOT_A_RUN)

        level = all_levels.get(run.level_id)
        if level is None:
            return _error(422, "unknown_level", _UNKNOWN_LEVEL)
        try:
            check_sentence(level, run.sentence)
        except RuleViolation as violation:
            return _error(422, violation.kind, violation.detail)
        try:
            board = build_board(level, run.rotations, run.placements)
        except InvalidBoard as invalid:
            return _error(422, "invalid_board", invalid.detail)

        visitor_key = (x_typesafe_key or "").strip()
        byok = visitor_key != ""
        free = QuotaInfo(remaining=None, byok=byok)

        # The cart may leave the track before any switch: then no question needs asking, and
        # the run spends neither a call nor the quota.
        first = simulate(level, board, None)
        if not first.needs_jev:
            return _finish(level, board, first, the_tuning, cached=False, quota=free)

        try:
            cached = await the_store.get_cached(cache_ids[level.id], run.sentence)
        except StoreUnavailable:
            # The visitor's key needs nothing more from the store; a free run needs its quota.
            if not byok:
                return _error(502, "jev_unavailable", _STORE_UNAVAILABLE)
            cached = None
        if cached is not None:
            from_cache = _simulate(level, board, cached)
            if from_cache is not None:
                return _finish(level, board, from_cache, the_tuning, cached=True, quota=free)

        if byok:
            key, quota = visitor_key, free
        else:
            # Checked before the quota, so a server with no key spends nobody's runs.
            if not own_key:
                return _error(502, "jev_unavailable", _NO_SERVER_KEY)
            try:
                taken = await the_store.take_quota(client_ip(request))
            except StoreUnavailable:
                return _error(502, "jev_unavailable", _STORE_UNAVAILABLE)
            if not taken.allowed:
                return _error(429, "quota_exhausted", _QUOTA_EXHAUSTED)
            key, quota = own_key, QuotaInfo(remaining=taken.remaining, byok=False)

        try:
            answers = await ask_jev(level, run.sentence, key, http)
        except JevRejectedKey:
            # The server's own key being refused is this deployment's configuration, not
            # something the visitor did or can fix.
            if byok:
                return _error(401, "key_rejected", _KEY_REJECTED)
            return _error(502, "jev_unavailable", _JEV_UNAVAILABLE)
        except JevUnavailable:
            return _error(502, "jev_unavailable", _JEV_UNAVAILABLE)
        except JevUnusableAnswer:
            return _error(502, "jev_unusable", _JEV_UNUSABLE)

        sim = _simulate(level, board, answers)
        if sim is None:
            # Not cached: an answer the engine cannot use must not be served again.
            return _error(502, "jev_unusable", _JEV_UNUSABLE)
        # The answer is paid for and good: a store that cannot keep it loses the write, not
        # the run.
        with contextlib.suppress(StoreUnavailable):
            await the_store.put_cached(cache_ids[level.id], run.sentence, answers)
        return _finish(level, board, sim, the_tuning, cached=False, quota=quota)

    return app


async def _read_body(request: Request) -> bytes | None:
    """The request body, or None if it is larger than `MAX_BODY_BYTES`.

    A declared `content-length` over the cap is refused before a byte is read; the count as the
    body streams in catches a body that declared none (chunked) or declared less.
    """
    declared = request.headers.get("content-length")
    if declared is not None and not (
        declared.isascii() and declared.isdigit() and int(declared) <= MAX_BODY_BYTES
    ):
        return None
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_BODY_BYTES:
            return None
    return bytes(body)


def _simulate(level: Level, board: Board, answers: Answers) -> Simulation | None:
    """The run with `answers`, or None when the engine refuses them (a score off the scale, a
    choice that is not an exit; see `simulate.py`)."""
    try:
        return simulate(level, board, answers)
    except ValueError:
        return None


def _finish(
    level: Level, board: Board, sim: Simulation, tuning: Tuning, *, cached: bool, quota: QuotaInfo
) -> JSONResponse:
    assert sim.outcome is not None, "a finished run has an outcome"
    response = RunResponse(
        outcome=sim.outcome,
        path=sim.path,
        readings=[r.model_copy(update={"clean": is_clean(r, tuning)}) for r in sim.readings],
        stars=score(level, board, sim, tuning),
        cached=cached,
        quota=quota,
    )
    return JSONResponse(response.model_dump(mode="json"))


def _error(status: int, kind: ErrorKind, detail: str) -> JSONResponse:
    """Every non-200 answer. `detail` is a literal of this module or an engine's own detail."""
    return JSONResponse(ErrorResponse(error=kind, detail=detail).model_dump(), status_code=status)


app = create_app()
