"""FastAPI server for the Baron Weather map.

The browser talks only to this server. This server talks to Baron. That one
sentence is the whole difference from ../interactive-map, where the browser
holds the key and the secret and signs for itself.

This module computes no signature — it asks baron.py for URLs and parameters
and forwards the bytes. Keeping that boundary is what makes the two apps
readable side by side.
"""

import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

import baron
from cache import TTLCache

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger("baron-map")

# Products live here and nowhere else. app.js builds its radio buttons from
# /api/config, so adding a product is a one-line change in one file.
PRODUCTS = [
    {
        "label": "Max Reflectivity Composite",
        "product": "C39-0x0302-0",
        "config": "Standard-Mercator",
    },
    {
        "label": "Lightning Heatmap",
        "product": "lightning-heatmap-global",
        "config": "Standard-Mercator",
    },
    {
        "label": "GOES East Full Disk IR",
        "product": "goes-east-fulldisk-hires-ir",
        "config": "Standard-Mercator",
    },
]

DEFAULT_CENTER = [-90, 30]
DEFAULT_ZOOM = 3

SETUP_MESSAGE = (
    "No credentials. Copy env.example to .env in interactive-map-serverside/ "
    "and fill in your Baron key and secret."
)

# Shared by the TMS and legend routes. WMS is deliberately excluded: a GetMap
# image is built for one arbitrary viewport and is essentially never requested
# twice, so caching it would spend memory for nothing.
tile_cache = TTLCache(ttl=60, maxsize=500)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Hold one httpx client for the process, so connections are pooled.

    The reference app this is modelled on used a ThreadPoolExecutor, a
    per-host Semaphore map, and an atexit hook to manage concurrency. Async
    handlers make all three unnecessary.
    """
    if baron.load_credentials():
        log.info("Baron credentials loaded")
    else:
        # A warning, not a crash. The server still serves the page and the
        # basemap, and /api/config tells the browser to show the setup text.
        log.warning(SETUP_MESSAGE)

    app.state.client = httpx.AsyncClient(timeout=10.0)
    yield
    await app.state.client.aclose()


app = FastAPI(title="Baron Weather — Server-Side Map", lifespan=lifespan)


def find_product(product: str, config: str) -> dict | None:
    """Look up a product/config pair in PRODUCTS.

    Routes validate against this list so an arbitrary path cannot be turned
    into an arbitrary upstream request signed with our key.
    """
    for entry in PRODUCTS:
        if entry["product"] == product and entry["config"] == config:
            return entry
    return None


def require_credentials() -> None:
    """Raise 503 with the setup text when no credentials are loaded.

    Answering 503 rather than letting the request fail upstream means a
    missing .env reads as a missing .env, not as a network fault.
    """
    if not baron.configured():
        raise HTTPException(status_code=503, detail=SETUP_MESSAGE)


@app.get("/health")
async def health() -> dict:
    """Liveness, plus whether the server can sign anything."""
    return {"status": "ok", "credentials": baron.configured()}


@app.get("/api/config")
async def config() -> JSONResponse:
    """Client configuration.

    Carries no key, no secret, and no signature — by design. Compare
    ../interactive-map, where the browser fetches .env itself.
    """
    return JSONResponse(
        {
            "products": PRODUCTS,
            "center": DEFAULT_CENTER,
            "zoom": DEFAULT_ZOOM,
            "credentials": baron.configured(),
            "setupMessage": SETUP_MESSAGE,
        }
    )


# ---------------------------------------------------------------------------
# The static mount must stay at the bottom of this file.
#
# StaticFiles at "/" matches every path, and Starlette matches routes in
# declaration order, so mounting it above any /api route silently shadows the
# whole API. Only static/ is exposed, which is why .env — one level up — is
# unreachable.
# ---------------------------------------------------------------------------
app.mount("/", StaticFiles(directory="static", html=True), name="static")
