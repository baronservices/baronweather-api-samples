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
from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

import baron
from cache import TTLCache

logging.basicConfig(level=logging.WARNING, format="%(levelname)s: %(message)s")

# Our own logger is the only one turned up to INFO.
#
# basicConfig configures the ROOT logger, and httpx logs every request it makes
# at INFO — including the full signed URL. That URL carries the API key in its
# path and a live signature in its query, so setting the root level to INFO
# writes both to stdout on every proxied tile: hundreds of times a minute while
# panning, into journald, docker logs, and CI output, with the signature
# replayable for about 15 minutes.
#
# That would hand away through the log exactly what this app exists to keep out
# of the browser. Turning httpx down explicitly as well, so that raising the
# root level later cannot quietly re-open it.
log = logging.getLogger("baron-map")
log.setLevel(logging.INFO)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

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


# The three real causes of a 401 or 403 from the signing endpoint. Listing
# them beats "unauthorized", which sends people to check the one thing —
# the key string — that is usually right.
AUTH_FAILURE_MESSAGE = (
    "Baron rejected the credentials. Three things cause this: the key is not "
    "entitled to this product, the secret is wrong or malformed, or this "
    "machine's clock is more than about 15 minutes out, which makes every "
    "signature look expired."
)


async def fetch_upstream(client: httpx.AsyncClient, url: str, params: dict):
    """GET an upstream URL, turning transport failures into HTTP errors.

    Timeouts and connection errors become 504 naming the host, so a reader of
    the panel can tell "the network is down" from "Baron said no".
    """
    try:
        return await client.get(url, params=params)
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=504,
            detail=f"{httpx.URL(url).host} did not answer within 10 seconds.",
        )
    except httpx.RequestError as error:
        raise HTTPException(
            status_code=504,
            detail=f"Could not reach {httpx.URL(url).host}: {error}",
        )


@app.get("/api/instance/{product}/{config}")
async def instance(product: str, config: str) -> dict:
    """Newest published instance time for a product.

    The instance list is ordered newest first, so page_size=1 is the whole
    query. An empty list is possible and is treated as an error: without a
    time there is no tile URL to build.
    """
    require_credentials()
    if find_product(product, config) is None:
        raise HTTPException(status_code=404, detail=f"Unknown product: {product}")

    params = baron.signed_params()
    params["page_size"] = 1

    response = await fetch_upstream(
        app.state.client, baron.instance_url(product, config), params
    )

    if response.status_code in (401, 403):
        raise HTTPException(status_code=502, detail=AUTH_FAILURE_MESSAGE)
    if response.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Instance lookup failed with {response.status_code}.",
        )

    instances = response.json()
    if not instances:
        raise HTTPException(
            status_code=502,
            detail=f"{product} has no published instances.",
        )

    return {"time": instances[0]["time"]}


@app.get("/api/tms/{product}/{config}/{time}/{z}/{x}/{y}.png")
async def tms_tile(
    product: str, config: str, time: str, z: int, x: int, y: int
) -> Response:
    """One signed, proxied, cached TMS tile.

    z, x, and y pass through untouched, so Baron's bottom-up row order still
    reaches the browser and app.js still needs scheme: 'tms' on the source.

    The instance time is part of the cache key, so a cached tile can never be
    stale — a new instance simply produces keys nobody has asked for yet.
    """
    require_credentials()
    if find_product(product, config) is None:
        raise HTTPException(status_code=404, detail=f"Unknown product: {product}")

    key = f"tms:{product}:{config}:{time}:{z}:{x}:{y}"
    cached = tile_cache.get(key)
    if cached is not None:
        return Response(
            content=cached,
            media_type="image/png",
            headers={"Cache-Control": "public, max-age=300", "X-Cache": "HIT"},
        )

    response = await fetch_upstream(
        app.state.client,
        baron.tms_url(product, config, time, z, x, y),
        baron.signed_params(),
    )

    # Only success is worth keeping. Caching a 403 or a 404 would hold a
    # transient failure in place for the full TTL.
    if response.status_code == 200:
        tile_cache.set(key, response.content)

    # The upstream status passes through rather than being flattened, so a
    # 403 storm in the browser console still reads as a 403. The upstream
    # BODY does not: it is logged here, where it is safe to read, and the
    # browser gets an empty one. Nothing in this app puts a credential in an
    # error body, but an upstream could, and the promise that nothing secret
    # reaches the browser should be kept by this code rather than by the
    # formatting choices of a service we do not control.
    if response.status_code != 200:
        log.warning(
            "Tile upstream returned %s: %s",
            response.status_code,
            response.text[:200],
        )
        return Response(
            content=b"",
            status_code=response.status_code,
            media_type="image/png",
            headers={"Cache-Control": "no-store", "X-Cache": "MISS"},
        )

    return Response(
        content=response.content,
        status_code=response.status_code,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=300", "X-Cache": "MISS"},
    )


@app.get("/api/wms/{product}/{config}")
async def wms_image(
    product: str,
    config: str,
    time: str,
    bbox: str,
    width: int,
    height: int,
) -> Response:
    """One signed, proxied WMS GetMap image for the current view.

    Not cached, and not by oversight: WMS serves one image for one arbitrary
    viewport, so the same URL is essentially never requested twice.

    app.js derives height from the bbox aspect ratio, because a bbox whose
    aspect disagrees with width and height still returns HTTP 200 and silently
    distorts the image. There is no upstream error to catch, so the mismatch
    has to be prevented rather than detected.
    """
    require_credentials()
    if find_product(product, config) is None:
        raise HTTPException(status_code=404, detail=f"Unknown product: {product}")

    if width < 1 or height < 1:
        raise HTTPException(
            status_code=400, detail="width and height must both be at least 1."
        )
    if len(bbox.split(",")) != 4:
        raise HTTPException(
            status_code=400, detail="bbox must be minx,miny,maxx,maxy."
        )

    url, params = baron.wms_url(product, config, time, bbox, width, height)
    params.update(baron.signed_params())

    response = await fetch_upstream(app.state.client, url, params)

    # The upstream status passes through rather than being flattened, so a
    # 403 storm in the browser console still reads as a 403. The upstream
    # BODY does not: it is logged here, where it is safe to read, and the
    # browser gets an empty one. Nothing in this app puts a credential in an
    # error body, but an upstream could, and the promise that nothing secret
    # reaches the browser should be kept by this code rather than by the
    # formatting choices of a service we do not control.
    if response.status_code != 200:
        log.warning(
            "WMS upstream returned %s: %s",
            response.status_code,
            response.text[:200],
        )
        return Response(
            content=b"",
            status_code=response.status_code,
            media_type="image/png",
            headers={"Cache-Control": "no-store"},
        )

    return Response(
        content=response.content,
        status_code=response.status_code,
        media_type="image/png",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/legend/{product}/{config}")
async def legend(product: str, config: str) -> Response:
    """The product's published legend, or 404 when there is none.

    The legend CDN is public, so this route needs no credentials and does not
    call require_credentials(). It is proxied anyway for three reasons: the
    browser then has exactly one origin and CORS never arises, the CDN's
    403 can be normalised into an honest 404, and the response shares the
    tile cache.

    "No legend" is a normal, permanent state for some products, not a fault.
    lightning-heatmap-global has never published one.
    """
    if find_product(product, config) is None:
        raise HTTPException(status_code=404, detail=f"Unknown product: {product}")

    key = f"legend:{product}:{config}"
    cached = tile_cache.get(key)
    if cached is not None:
        return Response(
            content=cached,
            media_type="application/json",
            headers={"Cache-Control": "public, max-age=300", "X-Cache": "HIT"},
        )

    # No signed_params(): this host does not authenticate, and signing it
    # would imply to a reader that it does.
    response = await fetch_upstream(
        app.state.client, baron.legend_url(product, config), {}
    )

    if response.status_code in (403, 404):
        # The bucket denies ListBucket, so absent and forbidden look the same
        # from outside. Both mean the same thing to the client: no legend.
        raise HTTPException(
            status_code=404, detail="No legend published for this product."
        )
    if response.status_code != 200:
        # A 500 is an outage, not an absence. Keep them distinguishable.
        raise HTTPException(
            status_code=502,
            detail=f"Legend fetch failed with {response.status_code}.",
        )

    tile_cache.set(key, response.content)
    return Response(
        content=response.content,
        media_type="application/json",
        headers={"Cache-Control": "public, max-age=300", "X-Cache": "MISS"},
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
