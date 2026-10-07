"""Vercel's entry point: the one Python function, serving every `/api/*` path.

`vercel.json` rewrites `/api/(.*)` here, and the app routes on the path the visitor asked for.
The game itself lives in `backend/railroad`, which is not a package on Vercel's path, so its
parent is put there first. Vercel bundles every project file reachable at build time with a
Python function, `backend/` and `levels/` included, and `vercel.json` only leaves
`backend/tests/` out (https://vercel.com/docs/functions/runtimes/python, "Controlling what gets
bundled"). Vercel loads the top-level `app`, an ASGI application
(https://vercel.com/docs/functions/runtimes/python/api-directory).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from railroad.app import app

__all__ = ["app"]
