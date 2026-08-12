"""Everything that knows about Baron Weather: credentials, signing, and URLs.

This module imports no FastAPI and no web framework of any kind. It is the
server-side mirror of ../interactive-map/baron.js, which calls no MapLibre
API, and the two are meant to be read side by side.

The key and the secret live in module scope, so no caller has to pass them
around — and, more to the point, so no route handler ever holds them.
"""

import hashlib
import hmac
import os
import re
from base64 import urlsafe_b64encode
from pathlib import Path
from time import time

from dotenv import load_dotenv

# The signing endpoint. Every product request goes through here.
API_BASE = "https://api.velocityweather.com/v1"

# Legends are published to a public CDN and need no signature at all.
LEGEND_BASE = "https://static.velocityweather.com/legends"

# Module-scope credentials, populated by load_credentials().
_key: str | None = None
_secret: str | None = None


def load_credentials() -> tuple[str, str] | None:
    """Read the key and secret from .env, or from the environment.

    Returns None when no usable pair is found. That is a reportable state,
    not an error: the server still starts, still serves the basemap, and
    /api/config tells the browser to show a setup message. A crash here would
    make a missing .env look like a broken app.

    Two name pairs are accepted so that one .env file can serve every folder
    in this repository. BARON_API_KEY wins when both are present.
    """
    global _key, _secret

    # override=False so a real environment variable beats the file, which is
    # what a deployment would expect.
    load_dotenv(Path(__file__).resolve().parent / ".env", override=False)

    for key_name, secret_name in (
        ("BARON_API_KEY", "BARON_API_SECRET"),
        ("BARON_ACCESS_KEY", "BARON_ACCESS_KEY_SECRET"),
    ):
        key = os.getenv(key_name)
        secret = os.getenv(secret_name)
        # Both halves, or neither. A key without a secret cannot sign, and
        # reporting it as "configured" produces a confusing 403 later.
        if key and secret:
            _key, _secret = key, secret
            return key, secret

    _key, _secret = None, None
    return None


def configured() -> bool:
    """True once a usable key and secret have been loaded."""
    return bool(_key and _secret)


def signed_params() -> dict:
    """Return {"ts", "sig"} for right now.

    There is deliberately no cache here. ../interactive-map/baron.js has to
    cache a signature because MapLibre's transformRequest hook must return
    synchronously while crypto.subtle.sign is asynchronous. A server has no
    such constraint: HMAC-SHA1 takes microseconds, so it signs inside the
    request handler and ts is always milliseconds old against a window of
    about plus or minus 15 minutes. The expiry hazard that dominates the
    client-side design does not exist here.

    The returned "sig" still carries its base64 "=" padding. Hand this dict
    straight to httpx as params= and let httpx encode it. Encoding the "="
    yourself produces "%253D" and a 403 that looks like a wrong secret.
    """
    ts = int(time())
    digest = hmac.new(
        _secret.encode(), f"{_key}:{ts}".encode(), hashlib.sha1
    ).digest()
    return {"ts": ts, "sig": urlsafe_b64encode(digest).decode()}


# The service rejects width or height above this with 400 InvalidParameter.
# GetCapabilities reports the same figure as MaxWidth and MaxHeight.
WMS_MAX_DIMENSION = 3000

# Instance times come from /meta/tiles as "2026-08-11T16:20:38Z" and are
# interpolated straight into the signed upstream URL. Anything else is
# rejected before signing: a "?" truncates that URL, a "#" swallows the
# tile path, and dot segments walk it to a different resource under our
# key. This is the only caller-controlled value that reaches the URL, so
# it is the only one that needs the check.
INSTANCE_TIME = re.compile(r"\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\Z")


def valid_instance_time(time: str) -> bool:
    """True when `time` is an instance timestamp and safe to interpolate."""
    return bool(INSTANCE_TIME.match(time))


def instance_url(product: str, config: str) -> str:
    """URL for the product's instance list, newest first.

    Observational products live under /meta/tiles/. Forecast products live
    under /meta/maps/, which this app does not use.
    """
    return (
        f"{API_BASE}/{_key}/meta/tiles/product-instances/{product}/{config}.json"
    )


def tms_url(product: str, config: str, time: str, z: int, x: int, y: int) -> str:
    """URL for one TMS tile.

    The layer name joins three fields with "+", and the instance time is
    required — omitting it returns 404 rather than the newest data.

    Neither the "+" nor the ":" inside the timestamp needs quoting: both are
    legal in a path segment and httpx leaves them alone. Quoting them yields
    a 404 that reads like a missing product.
    """
    layer = f"{product}+{config}+{time}"
    return f"{API_BASE}/{_key}/tms/1.0.0/{layer}/{z}/{x}/{y}.png"


def wms_url(
    product: str,
    config: str,
    time: str,
    bbox: str,
    width: int,
    height: int,
) -> tuple[str, dict]:
    """URL and query parameters for one WMS GetMap image.

    Returns the pair unjoined on purpose. The caller passes params straight to
    httpx, which encodes them correctly; building one string here would invite
    somebody to append the signature by hand and re-create the %253D bug.

    Three constraints, each confirmed against the live service:
      - layers is the *instance timestamp*; the product code returns 400.
      - version must be 1.3.0; 1.1.1 is rejected.
      - crs=EPSG:3857 is the only projection offered.

    A bbox whose aspect ratio disagrees with width and height still returns
    HTTP 200 and silently distorts the image, so the caller must derive one
    dimension from the other. app.js does this.
    """
    width, height = int(width), int(height)
    # Clamping width and height independently — two separate min() calls —
    # is exactly what produces the aspect-ratio mismatch this docstring (and
    # app.js) warns about: a 4:1 request at 4000x1000 would come out 3000x1000,
    # a 3:1 grid over a 4:1 region. Scale both dimensions by the same factor
    # instead, so the ratio the caller asked for survives the clamp. floor at
    # 1 so a very thin dimension cannot round down to 0 and get rejected
    # upstream as InvalidParameter.
    longest = max(width, height)
    if longest > WMS_MAX_DIMENSION:
        scale = WMS_MAX_DIMENSION / longest
        width = max(1, round(width * scale))
        height = max(1, round(height * scale))

    url = f"{API_BASE}/{_key}/wms/{product}/{config}"
    params = {
        "service": "WMS",
        "version": "1.3.0",
        "request": "GetMap",
        "crs": "EPSG:3857",
        "bbox": bbox,
        "width": width,
        "height": height,
        "format": "image/png",
        "transparent": "true",
        "layers": time,
    }
    return url, params


def legend_url(product: str, config: str) -> str:
    """URL for the product's published legend.

    Public CDN, no signature. Note this is a different document from the
    geotiff_legend.json that ../geotiff_fetch uses.
    """
    return f"{LEGEND_BASE}/{product}/{config}/legend.json"
