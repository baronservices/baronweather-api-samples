# Interactive Map, Server-Side — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a FastAPI counterpart to `interactive-map/` in which the server holds the Baron
credentials, signs every request, and proxies every byte, so that nothing secret ever reaches
the browser.

**Architecture:** Three server modules with one job each — `baron.py` (credentials, signing,
upstream URL building; imports no FastAPI), `cache.py` (a TTL byte cache that knows nothing
about HTTP), and `main.py` (routes, the shared `httpx` client, the static mount; computes no
signature). The browser gets `static/index.html` and `static/app.js`, which talk only to
`localhost:8000`. This mirrors `interactive-map/`, where `baron.js` calls no MapLibre API and
`app.js` computes no signature.

**Tech Stack:** Python 3.11, FastAPI, uvicorn, httpx, python-dotenv, pytest (dev only),
MapLibre GL JS 5.24.0 from CDN. No build step, no npm.

**Spec:** `docs/superpowers/specs/2026-08-11-interactive-map-serverside-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Working folder is `interactive-map-serverside/`.** All paths below are relative to the
  repository root, `/Users/sherman/code/baronweather-api-samples`.
- **`baron.py` must never import FastAPI. `main.py` must never compute a signature.** This
  boundary is the point of the design; breaking it defeats the comparison with the twin.
- **`cache.py` stores bytes and knows nothing about tiles, products, or HTTP.**
- **API base:** `https://api.velocityweather.com/v1`
- **Legend base:** `https://static.velocityweather.com/legends`
- **Signature:** `urlsafe_b64encode(HMAC_SHA1(secret, "<key>:<ts>"))`, `ts` = integer Unix
  seconds. **Pass `sig` raw through httpx's `params=`.** Hand-encoding `=` to `%3D` produces
  `%253D` and silently breaks signing. Verified 2026-08-11 against httpx 0.28.1.
- **Never cache a signature.** Sign per request. See spec 2.1.
- **WMS:** `version=1.3.0`, `crs=EPSG:3857`, `width` and `height` each capped at 3000.
- **TMS:** the MapLibre raster source needs `scheme: 'tms'`. The proxy passes `z`/`x`/`y`
  through unchanged, so Baron's bottom-up row order still reaches the browser.
- **Cache:** TTL 60 seconds, maxsize 500 entries.
- **Port 8000.**
- **Bounds clamp:** ±180 longitude, ±85.05112878 latitude, applied at **exactly one site** in
  `app.js`. Two clamp sites is the bug `interactive-map/` shipped.
- **MapLibre GL 5.24.0 exactly.** 6.x is ES-modules-only and will not load from a `<script>` tag.
- **Products**, defined once in `main.py`:
  | Label | Code | Config |
  |---|---|---|
  | Max Reflectivity Composite | `C39-0x0302-0` | `Standard-Mercator` |
  | Lightning Heatmap | `lightning-heatmap-global` | `Standard-Mercator` |
  | GOES East Full Disk IR | `goes-east-fulldisk-hires-ir` | `Standard-Mercator` |
- **Default view:** centre `[-90, 30]`, zoom 3.
- **Never commit `.env`.** The root `.gitignore` already ignores it at any depth and tracks
  `env.example`. Do not modify the root `.gitignore`.
- **No test touches the network and no test needs credentials.** Fake upstream calls with
  `httpx.MockTransport`.
- **Run all commands from `interactive-map-serverside/`** unless a step says otherwise.

---

### Task 1: Project scaffolding and the TTL cache

**Files:**
- Create: `interactive-map-serverside/requirements.txt`
- Create: `interactive-map-serverside/env.example`
- Create: `interactive-map-serverside/cache.py`
- Test: `interactive-map-serverside/tests/test_cache.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `TTLCache(ttl: int = 60, maxsize: int = 500)` with `get(key: str) -> bytes | None`
  and `set(key: str, value: bytes) -> None`. Used by Task 6 and Task 8.

- [ ] **Step 1: Create the folder and the dependency list**

```bash
mkdir -p interactive-map-serverside/tests interactive-map-serverside/static
```

Create `interactive-map-serverside/requirements.txt`:

```
# Application
fastapi==0.128.0
uvicorn==0.42.0
httpx==0.28.1
python-dotenv==1.0.0

# Development only. The application does not import pytest.
pytest==9.0.2
```

- [ ] **Step 2: Create the credential template**

Create `interactive-map-serverside/env.example`:

```
# Copy this file to .env and fill in valid credentials.
#
# Unlike ../interactive-map, this file is never served to the browser. Only the
# static/ folder is mounted, so .env sits outside the served tree entirely.
#
# Either name pair works. BARON_API_KEY / BARON_API_SECRET is checked first and
# BARON_ACCESS_KEY / BARON_ACCESS_KEY_SECRET is the fallback, so one .env can
# serve every folder in this repository.

BARON_API_KEY=your_access_key
BARON_API_SECRET=your_access_secret
```

- [ ] **Step 3: Write the failing tests**

Create `interactive-map-serverside/tests/test_cache.py`:

```python
"""Tests for the TTL byte cache.

A cache that never expires does not raise — it quietly serves stale imagery.
That is why expiry gets a test rather than a code comment.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cache import TTLCache


def test_returns_a_stored_value():
    cache = TTLCache()
    cache.set("a", b"A")
    assert cache.get("a") == b"A"


def test_returns_none_for_an_unknown_key():
    assert TTLCache().get("missing") is None


def test_expired_entry_returns_none_and_is_dropped():
    cache = TTLCache(ttl=0)
    cache.set("a", b"A")
    assert cache.get("a") is None
    # The read must also free the memory, or an expired entry lingers forever.
    assert len(cache._items) == 0


def test_overflow_evicts_the_oldest_entry():
    cache = TTLCache(maxsize=2)
    cache.set("a", b"A")
    cache.set("b", b"B")
    cache.set("c", b"C")
    assert cache.get("a") is None
    assert cache.get("b") == b"B"
    assert cache.get("c") == b"C"


def test_re_setting_a_key_makes_it_newest():
    cache = TTLCache(maxsize=2)
    cache.set("a", b"A")
    cache.set("b", b"B")
    cache.set("a", b"A2")   # "a" becomes newest, so "b" is now the oldest
    cache.set("c", b"C")
    assert cache.get("b") is None
    assert cache.get("a") == b"A2"
    assert cache.get("c") == b"C"
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd interactive-map-serverside && python3 -m pytest tests/test_cache.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'cache'`

- [ ] **Step 5: Write the implementation**

Create `interactive-map-serverside/cache.py`:

```python
"""A small in-memory cache of bytes, with a time limit and a size limit.

It stores bytes. It does not know what a tile is, what a product is, or that
HTTP exists — callers build their own keys and hand over their own bytes.

Why a cache at all: MapLibre re-requests the same tiles while panning, and
every browser pointed at this server shares one cache, so the same tile is
commonly asked for many times in a minute.

Why the entries cannot go stale: the caller puts the product instance time
into the key (see main.py), so a new instance produces new keys and an old
entry is simply never asked for again. The TTL therefore bounds *memory*, not
staleness. Sixty seconds is long enough to absorb a pan and short enough to
give the memory back promptly; raising it costs nothing but memory.
"""

from collections import OrderedDict
from time import monotonic


class TTLCache:
    """Keys map to bytes, evicted by age and by count.

    Eviction is oldest-inserted-first, not least-recently-used: reading an
    entry does not extend its life. For a tile cache that is the right
    behaviour, because a tile's usefulness is set by how recently it was
    fetched, not by how often it has been read.
    """

    def __init__(self, ttl: int = 60, maxsize: int = 500):
        self.ttl = ttl
        self.maxsize = maxsize
        # Ordered oldest-first, so popitem(last=False) removes the oldest.
        self._items: OrderedDict[str, tuple[float, bytes]] = OrderedDict()

    def get(self, key: str) -> bytes | None:
        """Return the stored bytes, or None if absent or expired."""
        item = self._items.get(key)
        if item is None:
            return None

        expires_at, value = item
        if monotonic() >= expires_at:
            # Drop it here rather than sweeping periodically. Expired entries
            # are found on read, which is the only moment they matter.
            del self._items[key]
            return None

        return value

    def set(self, key: str, value: bytes) -> None:
        """Store bytes under a key, evicting the oldest entry if full."""
        if key in self._items:
            # Re-inserting moves the key to the newest position.
            del self._items[key]
        elif len(self._items) >= self.maxsize:
            self._items.popitem(last=False)

        # monotonic() rather than time(): a clock adjustment must not make an
        # entry immortal or expire the whole cache at once.
        self._items[key] = (monotonic() + self.ttl, value)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd interactive-map-serverside && python3 -m pytest tests/test_cache.py -q`
Expected: PASS, 5 tests

- [ ] **Step 7: Commit**

```bash
git add interactive-map-serverside/requirements.txt \
        interactive-map-serverside/env.example \
        interactive-map-serverside/cache.py \
        interactive-map-serverside/tests/test_cache.py
git commit -m "Add the TTL byte cache for the server-side map"
```

---

### Task 2: Credentials and signing

**Files:**
- Create: `interactive-map-serverside/baron.py`
- Test: `interactive-map-serverside/tests/test_baron.py`

**Interfaces:**
- Consumes: nothing.
- Produces, used by Tasks 3 to 8:
  - `API_BASE: str`, `LEGEND_BASE: str`
  - `load_credentials() -> tuple[str, str] | None`
  - `configured() -> bool`
  - `signed_params() -> dict` returning `{"ts": int, "sig": str}`

- [ ] **Step 1: Write the failing tests**

Create `interactive-map-serverside/tests/test_baron.py`:

```python
"""Tests for credentials, signing, and upstream URL building.

The failure this file exists to prevent: a signature that is encoded twice.
It does not raise. It returns a perfectly plausible 403 from the API, which
looks exactly like a wrong secret or a skewed clock. See test_signature_is_
passed_raw_so_httpx_encodes_it_once.
"""

import hashlib
import hmac
import sys
from base64 import urlsafe_b64encode
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import baron


@pytest.fixture(autouse=True)
def clear_credentials(monkeypatch):
    """Every test starts with no credentials in the environment."""
    for name in (
        "BARON_API_KEY",
        "BARON_API_SECRET",
        "BARON_ACCESS_KEY",
        "BARON_ACCESS_KEY_SECRET",
    ):
        monkeypatch.delenv(name, raising=False)
    baron._key = None
    baron._secret = None


def test_loads_the_preferred_name_pair(monkeypatch):
    monkeypatch.setenv("BARON_API_KEY", "k1")
    monkeypatch.setenv("BARON_API_SECRET", "s1")
    assert baron.load_credentials() == ("k1", "s1")
    assert baron.configured() is True


def test_falls_back_to_the_access_key_name_pair(monkeypatch):
    monkeypatch.setenv("BARON_ACCESS_KEY", "k2")
    monkeypatch.setenv("BARON_ACCESS_KEY_SECRET", "s2")
    assert baron.load_credentials() == ("k2", "s2")


def test_prefers_the_api_key_pair_when_both_are_present(monkeypatch):
    monkeypatch.setenv("BARON_API_KEY", "k1")
    monkeypatch.setenv("BARON_API_SECRET", "s1")
    monkeypatch.setenv("BARON_ACCESS_KEY", "k2")
    monkeypatch.setenv("BARON_ACCESS_KEY_SECRET", "s2")
    assert baron.load_credentials() == ("k1", "s1")


def test_missing_credentials_return_none_rather_than_raising():
    # A missing .env must not stop the server from starting.
    assert baron.load_credentials() is None
    assert baron.configured() is False


def test_half_a_pair_is_not_credentials(monkeypatch):
    monkeypatch.setenv("BARON_API_KEY", "k1")
    assert baron.load_credentials() is None


def test_signature_matches_the_documented_formula(monkeypatch):
    monkeypatch.setenv("BARON_API_KEY", "demo_key")
    monkeypatch.setenv("BARON_API_SECRET", "demo_secret")
    baron.load_credentials()

    params = baron.signed_params()

    expected = urlsafe_b64encode(
        hmac.new(
            b"demo_secret", f"demo_key:{params['ts']}".encode(), hashlib.sha1
        ).digest()
    ).decode()
    assert params["sig"] == expected
    assert isinstance(params["ts"], int)


def test_signature_keeps_its_base64_padding(monkeypatch):
    # A SHA-1 digest is 20 bytes, so the base64 form always ends in one "=".
    # Stripping it here and re-adding it later is how double-encoding starts.
    monkeypatch.setenv("BARON_API_KEY", "demo_key")
    monkeypatch.setenv("BARON_API_SECRET", "demo_secret")
    baron.load_credentials()
    assert baron.signed_params()["sig"].endswith("=")


def test_signature_is_passed_raw_so_httpx_encodes_it_once(monkeypatch):
    """The trap this whole module is arranged around.

    httpx percent-encodes the "=" padding itself. Hand-encoding it first
    yields "%253D", which the API rejects with a 403 that looks identical to
    a wrong secret. Verified against httpx 0.28.1 on 2026-08-11.
    """
    monkeypatch.setenv("BARON_API_KEY", "demo_key")
    monkeypatch.setenv("BARON_API_SECRET", "demo_secret")
    baron.load_credentials()

    request = httpx.Request("GET", "https://example.test/x", params=baron.signed_params())

    assert "%3D" in str(request.url)
    assert "%253D" not in str(request.url)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd interactive-map-serverside && python3 -m pytest tests/test_baron.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'baron'`

- [ ] **Step 3: Write the implementation**

Create `interactive-map-serverside/baron.py`:

```python
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd interactive-map-serverside && python3 -m pytest tests/test_baron.py -q`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add interactive-map-serverside/baron.py interactive-map-serverside/tests/test_baron.py
git commit -m "Add credential loading and request signing"
```

---

### Task 3: Upstream URL building

**Files:**
- Modify: `interactive-map-serverside/baron.py` (append to the end)
- Modify: `interactive-map-serverside/tests/test_baron.py` (append to the end)

**Interfaces:**
- Consumes: `API_BASE`, `LEGEND_BASE`, `_key` from Task 2.
- Produces, used by Tasks 5 to 8:
  - `instance_url(product: str, config: str) -> str`
  - `tms_url(product: str, config: str, time: str, z: int, x: int, y: int) -> str`
  - `wms_url(product, config, time, bbox: str, width: int, height: int) -> tuple[str, dict]`
  - `legend_url(product: str, config: str) -> str`

  `wms_url` returns a `(url, params)` pair rather than one joined string, so the caller hands
  both to httpx and the double-encoding trap cannot be reintroduced by string concatenation.

- [ ] **Step 1: Write the failing tests**

Append to `interactive-map-serverside/tests/test_baron.py`:

```python
# --- Upstream URL building ---------------------------------------------------


@pytest.fixture
def credentials(monkeypatch):
    monkeypatch.setenv("BARON_API_KEY", "demo_key")
    monkeypatch.setenv("BARON_API_SECRET", "demo_secret")
    baron.load_credentials()


def test_instance_url_targets_the_tiles_metadata_endpoint(credentials):
    url = baron.instance_url("C39-0x0302-0", "Standard-Mercator")
    assert url == (
        "https://api.velocityweather.com/v1/demo_key"
        "/meta/tiles/product-instances/C39-0x0302-0/Standard-Mercator.json"
    )


def test_tms_url_joins_the_layer_name_with_plus_signs(credentials):
    url = baron.tms_url(
        "C39-0x0302-0", "Standard-Mercator", "2026-08-11T16:20:38Z", 3, 1, 2
    )
    assert url == (
        "https://api.velocityweather.com/v1/demo_key/tms/1.0.0/"
        "C39-0x0302-0+Standard-Mercator+2026-08-11T16:20:38Z/3/1/2.png"
    )


def test_tms_url_survives_httpx_without_quoting(credentials):
    # "+" and ":" are legal in a path segment and must reach the API intact.
    # Quoting them to %2B and %3A produces a 404 that looks like a missing
    # product. Verified against httpx 0.28.1 on 2026-08-11.
    url = baron.tms_url(
        "C39-0x0302-0", "Standard-Mercator", "2026-08-11T16:20:38Z", 3, 1, 2
    )
    sent = str(httpx.Request("GET", url).url)
    assert "C39-0x0302-0+Standard-Mercator+2026-08-11T16:20:38Z" in sent
    assert "%2B" not in sent


def test_wms_url_carries_the_required_parameters(credentials):
    url, params = baron.wms_url(
        "C39-0x0302-0",
        "Standard-Mercator",
        "2026-08-11T16:20:38Z",
        "-1.0,-2.0,3.0,4.0",
        800,
        600,
    )
    assert url == (
        "https://api.velocityweather.com/v1/demo_key/wms/C39-0x0302-0/Standard-Mercator"
    )
    assert params["service"] == "WMS"
    assert params["version"] == "1.3.0"        # 1.1.1 is rejected outright
    assert params["request"] == "GetMap"
    assert params["crs"] == "EPSG:3857"        # the only projection offered
    assert params["format"] == "image/png"
    assert params["transparent"] == "true"
    assert params["bbox"] == "-1.0,-2.0,3.0,4.0"
    assert params["width"] == 800
    assert params["height"] == 600
    # LAYERS is the instance timestamp. The product code returns 400.
    assert params["layers"] == "2026-08-11T16:20:38Z"


def test_wms_url_clamps_dimensions_to_the_service_maximum(credentials):
    _, params = baron.wms_url(
        "p", "c", "t", "-1,-2,3,4", 5000, 4000
    )
    # 3001 returns 400 InvalidParameter, so clamp rather than let it fail.
    assert params["width"] == 3000
    assert params["height"] == 3000


def test_legend_url_is_public_and_unsigned():
    url = baron.legend_url("C39-0x0302-0", "Standard-Mercator")
    assert url == (
        "https://static.velocityweather.com/legends"
        "/C39-0x0302-0/Standard-Mercator/legend.json"
    )
    assert "ts=" not in url and "sig=" not in url
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd interactive-map-serverside && python3 -m pytest tests/test_baron.py -q`
Expected: FAIL with `AttributeError: module 'baron' has no attribute 'instance_url'`

- [ ] **Step 3: Write the implementation**

Append to `interactive-map-serverside/baron.py`:

```python
# The service rejects width or height above this with 400 InvalidParameter.
# GetCapabilities reports the same figure as MaxWidth and MaxHeight.
WMS_MAX_DIMENSION = 3000


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
    url = f"{API_BASE}/{_key}/wms/{product}/{config}"
    params = {
        "service": "WMS",
        "version": "1.3.0",
        "request": "GetMap",
        "crs": "EPSG:3857",
        "bbox": bbox,
        "width": min(int(width), WMS_MAX_DIMENSION),
        "height": min(int(height), WMS_MAX_DIMENSION),
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd interactive-map-serverside && python3 -m pytest tests/test_baron.py -q`
Expected: PASS, 14 tests

- [ ] **Step 5: Commit**

```bash
git add interactive-map-serverside/baron.py interactive-map-serverside/tests/test_baron.py
git commit -m "Add upstream URL building for instances, TMS, WMS, and legends"
```

---

### Task 4: FastAPI skeleton, health, config, and the static mount

**Files:**
- Create: `interactive-map-serverside/main.py`
- Create: `interactive-map-serverside/static/index.html` (minimal; Task 9 replaces it)
- Test: `interactive-map-serverside/tests/test_api.py`

**Interfaces:**
- Consumes: `baron.load_credentials()`, `baron.configured()` from Task 2.
- Produces, used by Tasks 5 to 8:
  - `app: FastAPI` with `app.state.client: httpx.AsyncClient`
  - `PRODUCTS: list[dict]` with keys `label`, `product`, `config`
  - `find_product(product: str, config: str) -> dict | None`
  - `require_credentials() -> None`, raising `HTTPException(503, SETUP_MESSAGE)`
  - `SETUP_MESSAGE: str`

- [ ] **Step 1: Write the failing tests**

Create `interactive-map-serverside/tests/test_api.py`:

```python
"""Tests for the HTTP surface.

No test here touches the network. Upstream calls are faked with
httpx.MockTransport by replacing the shared client on app.state, which the
lifespan handler creates when TestClient enters its context.
"""

import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import baron
import main


@pytest.fixture
def client(monkeypatch):
    """A TestClient with credentials present and the network unavailable."""
    monkeypatch.setenv("BARON_API_KEY", "demo_key")
    monkeypatch.setenv("BARON_API_SECRET", "demo_secret")
    baron.load_credentials()
    main.tile_cache._items.clear()
    with TestClient(main.app) as test_client:
        yield test_client


def mock_upstream(handler):
    """Build a client whose requests never leave the process."""
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_health_reports_configured_credentials(client):
    body = client.get("/health").json()
    assert body == {"status": "ok", "credentials": True}


def test_health_reports_missing_credentials(client, monkeypatch):
    monkeypatch.setattr(baron, "_key", None)
    monkeypatch.setattr(baron, "_secret", None)
    assert client.get("/health").json()["credentials"] is False


def test_config_lists_the_three_products(client):
    body = client.get("/api/config").json()
    assert body["credentials"] is True
    assert body["center"] == [-90, 30]
    assert body["zoom"] == 3
    codes = [p["product"] for p in body["products"]]
    assert codes == [
        "C39-0x0302-0",
        "lightning-heatmap-global",
        "goes-east-fulldisk-hires-ir",
    ]
    assert all(p["config"] == "Standard-Mercator" for p in body["products"])


def test_config_never_leaks_the_credentials(client):
    # The whole point of the app. If either value appears here, it appears in
    # the browser, and this variant has no reason to exist.
    body = client.get("/api/config").text
    assert "demo_key" not in body
    assert "demo_secret" not in body


def test_root_serves_the_page(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]


def test_the_static_mount_does_not_shadow_the_api(client):
    # StaticFiles at "/" matches every path, so it must be declared last.
    # Mounted first, this returns 404.
    assert client.get("/api/config").status_code == 200


def test_the_env_file_is_not_served(client):
    # ../interactive-map serves its whole folder and says so in its README.
    # This app mounts only static/, so .env is unreachable by construction.
    assert client.get("/.env").status_code == 404
    assert client.get("/../.env").status_code == 404
    assert client.get("/%2e%2e/.env").status_code == 404
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd interactive-map-serverside && python3 -m pytest tests/test_api.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'main'`

- [ ] **Step 3: Write the minimal page**

Create `interactive-map-serverside/static/index.html`. Task 9 replaces this file entirely;
it exists now so the static mount has a directory to serve and Task 4's tests can pass.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Baron Weather — Server-Side Map</title>
</head>
<body>
  <p>Server is running. The map arrives in Task 9.</p>
</body>
</html>
```

- [ ] **Step 4: Write the implementation**

Create `interactive-map-serverside/main.py`:

```python
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd interactive-map-serverside && python3 -m pytest tests/ -q`
Expected: PASS, 26 tests

- [ ] **Step 6: Commit**

```bash
git add interactive-map-serverside/main.py \
        interactive-map-serverside/static/index.html \
        interactive-map-serverside/tests/test_api.py
git commit -m "Add the FastAPI skeleton with health, config, and static serving"
```

---

### Task 5: The instance lookup route

**Files:**
- Modify: `interactive-map-serverside/main.py` (insert above the static mount)
- Modify: `interactive-map-serverside/tests/test_api.py` (append)

**Interfaces:**
- Consumes: `baron.instance_url`, `baron.signed_params`, `find_product`,
  `require_credentials`, `app.state.client`.
- Produces: `GET /api/instance/{product}/{config}` → `{"time": "..."}`. Task 9 calls it.

**Every remaining route inserts above the static mount.** Adding one below it produces a
404 that looks like a typo.

- [ ] **Step 1: Write the failing tests**

Append to `interactive-map-serverside/tests/test_api.py`:

```python
# --- /api/instance -----------------------------------------------------------

INSTANCE_PATH = "/api/instance/C39-0x0302-0/Standard-Mercator"


def test_instance_returns_the_newest_time(client):
    def handler(request):
        # page_size=1 keeps the response to the newest entry.
        assert request.url.params["page_size"] == "1"
        assert "ts" in request.url.params and "sig" in request.url.params
        return httpx.Response(
            200,
            json=[
                {"time": "2026-08-11T16:20:38Z", "created": "2026-08-11T16:21:59Z"}
            ],
        )

    client.app.state.client = mock_upstream(handler)
    response = client.get(INSTANCE_PATH)
    assert response.status_code == 200
    assert response.json() == {"time": "2026-08-11T16:20:38Z"}


def test_instance_rejects_an_unknown_product(client):
    response = client.get("/api/instance/not-a-product/Standard-Mercator")
    assert response.status_code == 404


def test_instance_explains_a_403_rather_than_calling_it_empty(client):
    # A 403 here has three real causes and none of them is "no data". Saying
    # "no instances" misdirects every first-run failure.
    client.app.state.client = mock_upstream(
        lambda request: httpx.Response(403, json={"message": "Expired timestamp"})
    )
    response = client.get(INSTANCE_PATH)
    assert response.status_code == 502
    detail = response.json()["detail"].lower()
    assert "entitle" in detail
    assert "secret" in detail
    assert "clock" in detail


def test_instance_reports_an_empty_list_as_an_error(client):
    client.app.state.client = mock_upstream(lambda request: httpx.Response(200, json=[]))
    response = client.get(INSTANCE_PATH)
    assert response.status_code == 502
    assert "no published instances" in response.json()["detail"]


def test_instance_maps_a_timeout_to_504(client):
    def handler(request):
        raise httpx.TimeoutException("timed out", request=request)

    client.app.state.client = mock_upstream(handler)
    response = client.get(INSTANCE_PATH)
    assert response.status_code == 504
    assert "api.velocityweather.com" in response.json()["detail"]


def test_instance_returns_503_without_credentials(client, monkeypatch):
    monkeypatch.setattr(baron, "_key", None)
    monkeypatch.setattr(baron, "_secret", None)
    response = client.get(INSTANCE_PATH)
    assert response.status_code == 503
    assert "env.example" in response.json()["detail"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd interactive-map-serverside && python3 -m pytest tests/test_api.py -q`
Expected: FAIL — the instance tests return 404 because the route does not exist

- [ ] **Step 3: Write the implementation**

Insert into `interactive-map-serverside/main.py`, above the static mount comment block:

```python
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd interactive-map-serverside && python3 -m pytest tests/ -q`
Expected: PASS, 32 tests

- [ ] **Step 5: Commit**

```bash
git add interactive-map-serverside/main.py interactive-map-serverside/tests/test_api.py
git commit -m "Add the instance lookup route with named failure causes"
```

---

### Task 6: The TMS tile proxy

**Files:**
- Modify: `interactive-map-serverside/main.py` (insert above the static mount)
- Modify: `interactive-map-serverside/tests/test_api.py` (append)

**Interfaces:**
- Consumes: `baron.tms_url`, `fetch_upstream`, `tile_cache`, `find_product`.
- Produces: `GET /api/tms/{product}/{config}/{time}/{z}/{x}/{y}.png`. Task 9 uses it as a
  MapLibre tile template.

- [ ] **Step 1: Write the failing tests**

Append to `interactive-map-serverside/tests/test_api.py`:

```python
# --- /api/tms ----------------------------------------------------------------

TILE_PATH = (
    "/api/tms/C39-0x0302-0/Standard-Mercator/2026-08-11T16:20:38Z/3/1/2.png"
)


def test_tile_is_proxied_with_its_bytes_intact(client):
    def handler(request):
        assert "/tms/1.0.0/" in str(request.url)
        assert "C39-0x0302-0+Standard-Mercator+2026-08-11T16:20:38Z" in str(request.url)
        return httpx.Response(200, content=b"\x89PNG-tile")

    client.app.state.client = mock_upstream(handler)
    response = client.get(TILE_PATH)
    assert response.status_code == 200
    assert response.content == b"\x89PNG-tile"
    assert response.headers["content-type"] == "image/png"


def test_a_second_request_is_served_from_the_cache(client):
    calls = []

    def handler(request):
        calls.append(request.url)
        return httpx.Response(200, content=b"\x89PNG-tile")

    client.app.state.client = mock_upstream(handler)
    assert client.get(TILE_PATH).content == b"\x89PNG-tile"
    assert client.get(TILE_PATH).content == b"\x89PNG-tile"
    # One upstream call for two browser requests. This is the cache's entire job.
    assert len(calls) == 1


def test_an_upstream_error_is_not_cached(client):
    calls = []

    def handler(request):
        calls.append(request.url)
        return httpx.Response(404, content=b"")

    client.app.state.client = mock_upstream(handler)
    client.get(TILE_PATH)
    client.get(TILE_PATH)
    # Caching a 404 would keep a transient failure alive for a full minute.
    assert len(calls) == 2


def test_upstream_status_passes_through(client):
    client.app.state.client = mock_upstream(
        lambda request: httpx.Response(403, content=b"")
    )
    # Not flattened to 500: MapLibre's error handler should see the real code.
    assert client.get(TILE_PATH).status_code == 403


def test_tile_rejects_an_unknown_product(client):
    response = client.get(
        "/api/tms/not-a-product/Standard-Mercator/2026-08-11T16:20:38Z/3/1/2.png"
    )
    assert response.status_code == 404
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd interactive-map-serverside && python3 -m pytest tests/test_api.py -q`
Expected: FAIL — the tile tests 404 because the route does not exist

- [ ] **Step 3: Write the implementation**

Insert into `interactive-map-serverside/main.py`, above the static mount comment block:

```python
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
    # 403 storm in the browser console still reads as a 403.
    return Response(
        content=response.content,
        status_code=response.status_code,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=300", "X-Cache": "MISS"},
    )
```

Add `Response` to the FastAPI import at the top of `main.py`:

```python
from fastapi import FastAPI, HTTPException, Response
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd interactive-map-serverside && python3 -m pytest tests/ -q`
Expected: PASS, 37 tests

- [ ] **Step 5: Commit**

```bash
git add interactive-map-serverside/main.py interactive-map-serverside/tests/test_api.py
git commit -m "Add the cached TMS tile proxy"
```

---

### Task 7: The WMS image proxy

**Files:**
- Modify: `interactive-map-serverside/main.py` (insert above the static mount)
- Modify: `interactive-map-serverside/tests/test_api.py` (append)

**Interfaces:**
- Consumes: `baron.wms_url`, `fetch_upstream`, `find_product`.
- Produces: `GET /api/wms/{product}/{config}?time=&bbox=&width=&height=`. Task 9 calls it.

- [ ] **Step 1: Write the failing tests**

Append to `interactive-map-serverside/tests/test_api.py`:

```python
# --- /api/wms ----------------------------------------------------------------

WMS_PATH = "/api/wms/C39-0x0302-0/Standard-Mercator"
WMS_QUERY = {
    "time": "2026-08-11T16:20:38Z",
    "bbox": "-10018754.2,2504688.5,-8766409.9,3757032.8",
    "width": "800",
    "height": "600",
}


def test_wms_image_is_proxied(client):
    def handler(request):
        params = request.url.params
        assert params["request"] == "GetMap"
        assert params["version"] == "1.3.0"
        assert params["crs"] == "EPSG:3857"
        assert params["layers"] == "2026-08-11T16:20:38Z"
        assert params["width"] == "800"
        assert params["height"] == "600"
        return httpx.Response(200, content=b"\x89PNG-image")

    client.app.state.client = mock_upstream(handler)
    response = client.get(WMS_PATH, params=WMS_QUERY)
    assert response.status_code == 200
    assert response.content == b"\x89PNG-image"


def test_wms_is_not_cached(client):
    calls = []

    def handler(request):
        calls.append(request.url)
        return httpx.Response(200, content=b"\x89PNG-image")

    client.app.state.client = mock_upstream(handler)
    client.get(WMS_PATH, params=WMS_QUERY)
    client.get(WMS_PATH, params=WMS_QUERY)
    # A GetMap image is built for one arbitrary viewport and is essentially
    # never requested twice, so caching it would spend memory for nothing.
    assert len(calls) == 2


def test_wms_rejects_a_zero_dimension(client):
    response = client.get(WMS_PATH, params={**WMS_QUERY, "width": "0"})
    assert response.status_code == 400


def test_wms_rejects_a_malformed_bbox(client):
    response = client.get(WMS_PATH, params={**WMS_QUERY, "bbox": "1,2,3"})
    assert response.status_code == 400


def test_wms_rejects_an_unknown_product(client):
    response = client.get(
        "/api/wms/not-a-product/Standard-Mercator", params=WMS_QUERY
    )
    assert response.status_code == 404
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd interactive-map-serverside && python3 -m pytest tests/test_api.py -q`
Expected: FAIL — the WMS tests 404 because the route does not exist

- [ ] **Step 3: Write the implementation**

Insert into `interactive-map-serverside/main.py`, above the static mount comment block:

```python
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

    return Response(
        content=response.content,
        status_code=response.status_code,
        media_type="image/png",
        headers={"Cache-Control": "no-store"},
    )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd interactive-map-serverside && python3 -m pytest tests/ -q`
Expected: PASS, 42 tests

- [ ] **Step 5: Commit**

```bash
git add interactive-map-serverside/main.py interactive-map-serverside/tests/test_api.py
git commit -m "Add the WMS image proxy"
```

---

### Task 8: The legend proxy

**Files:**
- Modify: `interactive-map-serverside/main.py` (insert above the static mount)
- Modify: `interactive-map-serverside/tests/test_api.py` (append)

**Interfaces:**
- Consumes: `baron.legend_url`, `fetch_upstream`, `tile_cache`, `find_product`.
- Produces: `GET /api/legend/{product}/{config}` → legend JSON, or 404. Task 10 calls it.

- [ ] **Step 1: Write the failing tests**

Append to `interactive-map-serverside/tests/test_api.py`:

```python
# --- /api/legend -------------------------------------------------------------

LEGEND_PATH = "/api/legend/C39-0x0302-0/Standard-Mercator"
LEGEND_BODY = {"palettes": [{"entries": [{"color": "#a4ffa47f", "value": "5 dBZ"}]}]}


def test_legend_is_proxied(client):
    def handler(request):
        assert "static.velocityweather.com" in str(request.url)
        # The legend CDN is public. Signing it would be harmless but wrong.
        assert "sig" not in request.url.params
        return httpx.Response(200, json=LEGEND_BODY)

    client.app.state.client = mock_upstream(handler)
    response = client.get(LEGEND_PATH)
    assert response.status_code == 200
    assert response.json() == LEGEND_BODY


def test_a_403_from_the_cdn_becomes_a_plain_404(client):
    # The bucket denies ListBucket, so a missing legend answers 403 rather
    # than 404. From outside, absent and forbidden are indistinguishable —
    # and neither yields a legend, so both mean the same thing to a client.
    client.app.state.client = mock_upstream(
        lambda request: httpx.Response(403, text="AccessDenied")
    )
    response = client.get(LEGEND_PATH)
    assert response.status_code == 404
    assert "no legend published" in response.json()["detail"].lower()


def test_a_404_from_the_cdn_becomes_a_plain_404(client):
    client.app.state.client = mock_upstream(lambda request: httpx.Response(404))
    assert client.get(LEGEND_PATH).status_code == 404


def test_a_server_error_from_the_cdn_is_not_disguised_as_absence(client):
    # A 500 is a fault. Reporting it as "no legend published" would hide a
    # real outage behind the silence a genuinely absent legend earns.
    client.app.state.client = mock_upstream(lambda request: httpx.Response(500))
    assert client.get(LEGEND_PATH).status_code == 502


def test_a_second_legend_request_is_served_from_the_cache(client):
    calls = []

    def handler(request):
        calls.append(request.url)
        return httpx.Response(200, json=LEGEND_BODY)

    client.app.state.client = mock_upstream(handler)
    client.get(LEGEND_PATH)
    client.get(LEGEND_PATH)
    assert len(calls) == 1


def test_legend_works_without_credentials(client, monkeypatch):
    # The legend CDN needs no signature, so an unconfigured server can still
    # answer this one. It must not 503 like the signed routes do.
    monkeypatch.setattr(baron, "_key", None)
    monkeypatch.setattr(baron, "_secret", None)
    client.app.state.client = mock_upstream(
        lambda request: httpx.Response(200, json=LEGEND_BODY)
    )
    assert client.get(LEGEND_PATH).status_code == 200
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd interactive-map-serverside && python3 -m pytest tests/test_api.py -q`
Expected: FAIL — the legend tests 404 because the route does not exist

- [ ] **Step 3: Write the implementation**

Insert into `interactive-map-serverside/main.py`, above the static mount comment block:

```python
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd interactive-map-serverside && python3 -m pytest tests/ -q`
Expected: PASS, 48 tests

- [ ] **Step 5: Commit**

```bash
git add interactive-map-serverside/main.py interactive-map-serverside/tests/test_api.py
git commit -m "Add the legend proxy, normalising a CDN 403 into a plain 404"
```

---

### Task 9: The page and the map, in both delivery modes

**Files:**
- Modify: `interactive-map-serverside/static/index.html` (replace entirely)
- Create: `interactive-map-serverside/static/app.js`

**Interfaces:**
- Consumes: `GET /api/config`, `GET /api/instance/{product}/{config}`,
  `GET /api/tms/{product}/{config}/{time}/{z}/{x}/{y}.png`,
  `GET /api/wms/{product}/{config}?time=&bbox=&width=&height=`.
- Produces, used by Task 10:
  - `state` — object with `products`, `product`, `config`, `protocol`, `time`, `ready`
  - `showProduct()` — the single redraw path
  - `getJson(url)` — fetch helper that raises the server's `detail` text
  - `setStatus(text, isError)` — writes the panel's message line

TMS and WMS ship together because the protocol toggle is one control and one code branch;
splitting them would leave a button that throws. The legend is genuinely separable and is
Task 10.

Verification for this task is manual — there is no DOM test harness.

**This task carries the bug `interactive-map/` actually shipped.** Read the comment on
`viewGeometry()` before writing it.

- [ ] **Step 1: Replace the page**

Replace `interactive-map-serverside/static/index.html` entirely. The legend markup is included
now and stays empty until Task 10 fills it.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Baron Weather — Server-Side Map</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.css">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  #map { position: absolute; inset: 0; }
  #panel {
    position: absolute; top: 12px; left: 12px; width: 260px; z-index: 1;
    background: rgba(18, 20, 24, 0.92); color: #e8e8e8;
    border: 1px solid #333; border-radius: 6px; padding: 12px; font-size: 12px;
  }
  #panel h1 {
    font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase;
    margin: 0 0 2px; color: #7fd4ff;
  }
  #panel .subtitle { color: #8a8f98; margin: 0 0 10px; font-size: 10px; }
  #panel h2 {
    font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
    color: #8a8f98; margin: 12px 0 6px; font-weight: normal;
  }
  #products label { display: block; padding: 2px 0; cursor: pointer; }
  #protocol button, #refresh {
    font: inherit; background: #23262c; color: #cfd3d8;
    border: 1px solid #3a3e45; border-radius: 4px; padding: 4px 10px; cursor: pointer;
  }
  #protocol button.on { background: #7fd4ff; border-color: #7fd4ff; color: #10131a; }
  #refresh { margin-top: 12px; width: 100%; }
  #status { color: #8a8f98; margin: 10px 0 0; min-height: 2.4em; word-break: break-word; }
  #status.error { color: #ff9b9b; }
  #legend-bar {
    height: 12px; border: 1px solid #3a3e45; border-radius: 2px;
    margin-top: 8px; display: none;
  }
  #legend-labels { display: flex; justify-content: space-between; color: #8a8f98; margin-top: 4px; }
  #legend-note { color: #8a8f98; margin: 8px 0 0; }
</style>
</head>
<body>
  <div id="map"></div>

  <div id="panel">
    <h1>Baron Weather</h1>
    <p class="subtitle">Server-side signing</p>

    <h2>Product</h2>
    <!-- Built by app.js from /api/config, so the product list lives on the
         server and exists in exactly one place. -->
    <div id="products"></div>

    <h2>Delivery</h2>
    <div id="protocol">
      <button data-protocol="tms" class="on">TMS</button>
      <button data-protocol="wms">WMS</button>
    </div>

    <button id="refresh">Refresh</button>

    <p id="status">Starting…</p>

    <!-- Filled by Task 10. Empty until then, which shows nothing. -->
    <div id="legend">
      <div id="legend-bar"></div>
      <div id="legend-labels"></div>
      <p id="legend-note"></p>
    </div>
  </div>

  <!-- MapLibre 5.24.0 is the newest release with a classic build usable from
       a plain script tag. Version 6.x is ES modules only. -->
  <script src="https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js"></script>
  <script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write the application script**

Create `interactive-map-serverside/static/app.js`:

```js
// The browser half of the server-side map.
//
// Compare ../../interactive-map/app.js, which has a baron.js beside it holding
// credentials, HMAC signing, a signature cache, and a secure-context check.
// None of that is here. Every URL below points at this app's own server, which
// signs and fetches on our behalf, so this file has no idea what a signature is.
//
// What did NOT move to the server is the WMS geometry near the bottom. It
// exists to serve MapLibre's camera, so it belongs beside the camera.

const SOURCE_ID = 'wx'
const LAYER_ID = 'wx'

// The first symbol layer in MapLibre's demo style. Inserting below it keeps
// country labels readable above the weather.
const LABEL_ANCHOR = 'geolines-label'

const panel = {
  products: document.getElementById('products'),
  protocol: document.getElementById('protocol'),
  refresh: document.getElementById('refresh'),
  status: document.getElementById('status'),
}

// Everything the redraw path needs. `time` is remembered so a map move can
// rebuild a WMS URL without a second instance lookup.
const state = {
  products: [],
  product: null,
  config: null,
  protocol: 'tms',
  time: null,
  // Until /api/config returns there is nothing to draw. Without this flag an
  // early click replaces the setup message with a null dereference from
  // somewhere deeper in the stack.
  ready: false,
}

let map = null

/** Write the panel's message line. */
function setStatus(text, isError = false) {
  panel.status.textContent = text
  panel.status.classList.toggle('error', isError)
}

/**
 * Fetch JSON from our own server, raising the server's `detail` text.
 *
 * The server writes messages meant for a person to read — it names the three
 * causes of a 403, for instance — so showing `detail` verbatim beats inventing
 * a client-side phrasing that throws that detail away.
 */
async function getJson(url) {
  const response = await fetch(url)
  if (!response.ok) {
    let detail = `Request failed with ${response.status}`
    try {
      const body = await response.json()
      if (body.detail) detail = body.detail
    } catch {
      // A non-JSON error body leaves the status-code message in place.
    }
    const error = new Error(detail)
    error.status = response.status
    throw error
  }
  return response.json()
}

// --- Startup ----------------------------------------------------------------

async function start() {
  let config
  try {
    config = await getJson('/api/config')
  } catch (error) {
    // The same process serves this page and answers /api/config, so a failure
    // here almost always means the server died rather than a bad URL.
    setStatus(`Cannot reach the server: ${error.message}`, true)
    return
  }

  state.products = config.products
  buildProductList(config.products)
  createMap(config.center, config.zoom)

  if (!config.credentials) {
    // The basemap still loads. Only the weather layer is unavailable.
    setStatus(config.setupMessage, true)
    return
  }

  state.ready = true
  state.product = config.products[0].product
  state.config = config.products[0].config
  redraw()
}

function buildProductList(products) {
  panel.products.innerHTML = ''
  products.forEach((entry, index) => {
    const label = document.createElement('label')
    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'product'
    radio.value = entry.product
    radio.checked = index === 0
    radio.addEventListener('change', () => {
      state.product = entry.product
      state.config = entry.config
      redraw()
    })
    label.append(radio, ` ${entry.label}`)
    panel.products.append(label)
  })
}

function createMap(center, zoom) {
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://demotiles.maplibre.org/style.json',
    center,
    zoom,
  })

  // One persistent listener, attached once, here, because this is the only
  // place `map` is known to exist. It no-ops unless WMS is active, so it never
  // needs attaching and detaching — and a listener that is never removed
  // cannot leak.
  map.on('moveend', () => {
    if (state.protocol !== 'wms') return

    const source = map.getSource(SOURCE_ID)
    if (!source) return

    const view = viewGeometry()
    if (!view) return

    // updateImage aborts any in-flight request and applies the new coordinates
    // only once the new image has loaded, so the URL and the corners always
    // commit together. Until it lands the previous image stays pinned to its
    // own corners: it scales and blurs on zoom, and leaves the newly revealed
    // edge blank on pan, rather than stretching to fill the new view.
    source.updateImage({ url: wmsUrl(view), coordinates: view.coordinates })
  })
}

// --- The single redraw path -------------------------------------------------

/**
 * Rebuild the weather layer. Product change, protocol change, and Refresh all
 * come through here, so there is one path to reason about rather than three.
 */
async function showProduct() {
  if (!state.ready) return

  // Removed first, and the moveend handler above depends on the source being
  // absent for the whole of the await below.
  removeWeatherLayer()
  setStatus('Loading…')

  const { time } = await getJson(`/api/instance/${state.product}/${state.config}`)
  state.time = time

  if (state.protocol === 'tms') {
    addTmsSource()
  } else {
    addWmsSource()
  }

  map.addLayer(
    {
      id: LAYER_ID,
      type: 'raster',
      source: SOURCE_ID,
      // A raster layer renders both source types. Zero fade stops the image
      // flashing when WMS replaces it on a move.
      paint: { 'raster-fade-duration': 0 },
    },
    map.getLayer(LABEL_ANCHOR) ? LABEL_ANCHOR : undefined
  )

  setStatus(`Valid ${time}`)
}

/**
 * Every entry point calls showProduct through here.
 *
 * Without the catch, a throw after the layer is removed leaves the panel
 * reading "Loading…" with the real reason only in the console.
 */
function redraw() {
  showProduct().catch((error) => setStatus(error.message, true))
}

function removeWeatherLayer() {
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID)
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID)
}

function addTmsSource() {
  map.addSource(SOURCE_ID, {
    type: 'raster',
    tiles: [
      `/api/tms/${state.product}/${state.config}/${encodeURIComponent(state.time)}/{z}/{x}/{y}.png`,
    ],
    tileSize: 256,
    // Baron serves TMS row order, bottom-up. The proxy passes z/x/y through
    // untouched, so this is still required even though the URL is local.
    scheme: 'tms',
    attribution: '&copy; Baron Weather',
  })
}

// --- WMS mode ---------------------------------------------------------------
//
// WMS serves one image for one arbitrary view. That is the contrast this app
// exists to show: TMS serves fixed 256px tiles at fixed zoom levels. A tiled
// source re-requests tiles for a new view by itself; a single image does not,
// which is why createMap installs a moveend handler.

// Web Mercator is undefined beyond this latitude.
const MAX_LATITUDE = 85.05112878

// The service rejects anything larger with 400 InvalidParameter.
const MAX_DIMENSION = 3000

/**
 * The current view as a bbox and as its four corners, from ONE clamp.
 *
 * Both outputs come from the same four numbers, and that is the entire point
 * of this function. `interactive-map` shipped a bug where the bbox was clamped
 * and the corners were not: getBounds() runs past ±180 whenever the viewport
 * is wider than the world, and at any zoom near the antimeridian, because
 * MapLibre leaves longitude unconstrained by default. The image then covered
 * one rectangle and was placed on another, stretching the overlay 1.4× at low
 * zoom and 1.2× near the antimeridian.
 *
 * Keep exactly one clamp site. Two is what caused it.
 *
 * Returns null when the view has no area, so the caller can skip the request
 * rather than send a malformed URL.
 */
function viewGeometry() {
  const bounds = map.getBounds()

  const west = Math.max(bounds.getWest(), -180)
  const east = Math.min(bounds.getEast(), 180)
  const south = Math.max(bounds.getSouth(), -MAX_LATITUDE)
  const north = Math.min(bounds.getNorth(), MAX_LATITUDE)

  const [minX, minY] = toMercator(west, south)
  const [maxX, maxY] = toMercator(east, north)

  const spanX = maxX - minX
  const spanY = maxY - minY
  if (spanX <= 0 || spanY <= 0) return null

  // Height comes from the BBOX aspect, never the canvas aspect, so rotating
  // the camera cannot distort the image. A bbox whose aspect disagrees with
  // width and height still returns HTTP 200 and silently distorts, so there is
  // no error to catch — it has to be prevented here.
  const width = Math.min(Math.round(map.getCanvas().clientWidth), MAX_DIMENSION)
  const height = Math.min(Math.round(width * (spanY / spanX)), MAX_DIMENSION)
  if (width < 1 || height < 1) return null

  return {
    bbox: `${minX},${minY},${maxX},${maxY}`,
    width,
    height,
    // The same clamped corners the bbox was built from, in the order an image
    // source expects: top-left, top-right, bottom-right, bottom-left.
    coordinates: [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ],
  }
}

/** Longitude and latitude to EPSG:3857 metres. */
function toMercator(lng, lat) {
  const RADIUS = 6378137
  const x = (RADIUS * lng * Math.PI) / 180
  const y = RADIUS * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
  return [x, y]
}

/** The GetMap URL for a given view. */
function wmsUrl(view) {
  const query = new URLSearchParams({
    time: state.time,
    bbox: view.bbox,
    width: view.width,
    height: view.height,
  })
  return `/api/wms/${state.product}/${state.config}?${query}`
}

function addWmsSource() {
  const view = viewGeometry()
  if (!view) throw new Error('The map view has no area to request.')

  // An image source accepts only url and coordinates. addSource rejects an
  // attribution property outright, so WMS mode carries none.
  map.addSource(SOURCE_ID, {
    type: 'image',
    url: wmsUrl(view),
    coordinates: view.coordinates,
  })
}

// --- Wiring -----------------------------------------------------------------

panel.protocol.addEventListener('click', (event) => {
  const button = event.target.closest('button')
  if (!button) return

  state.protocol = button.dataset.protocol
  for (const other of panel.protocol.querySelectorAll('button')) {
    other.classList.toggle('on', other === button)
  }
  // scheme cannot be changed after a source is created, and the two protocols
  // need different source types anyway, so a switch always re-adds the source.
  // One path stays simpler than two.
  redraw()
})

panel.refresh.addEventListener('click', redraw)

start()
```

- [ ] **Step 3: Check the script parses**

Run: `cd interactive-map-serverside && node --check static/app.js 2>/dev/null && echo "parses" || echo "node unavailable — skip, the browser console will report syntax errors"`

- [ ] **Step 4: Verify by hand**

Run: `cd interactive-map-serverside && ./run.sh`

With a valid `.env` in place, open `http://localhost:8000/`:

1. Each of the three products draws tiles in TMS mode.
2. The valid time appears in the panel and matches the newest instance.
3. The WMS toggle redraws each product. The network panel shows `/api/wms` requests.
4. In the network panel, **every request goes to `localhost:8000`**, and no `ts` or `sig`
   appears anywhere. This is the check the whole app exists to pass.
5. In WMS mode, exactly one `/api/wms` request fires per settled move.
6. In WMS mode, zoom out to about z1. The overlay stays registered against the basemap, with
   blank margins where the map wraps — not stretched to fill them.
7. In WMS mode, pan to about longitude ±175. The overlay still registers.

Steps 6 and 7 are the only two camera positions where a bbox/corner mismatch becomes visible,
and the default view reaches neither. Shortcut: select GOES East, whose full-disk imagery is a
circle, so any horizontal stretch shows up immediately as an ellipse.

- [ ] **Step 5: Commit**

```bash
git add interactive-map-serverside/static/index.html interactive-map-serverside/static/app.js
git commit -m "Add the map page with TMS and WMS delivery"
```

---

### Task 10: The legend

**Files:**
- Modify: `interactive-map-serverside/static/app.js`

**Interfaces:**
- Consumes: `GET /api/legend/{product}/{config}`, plus `state`, `getJson` from Task 9.
- Produces: `showLegend()`, called from `showProduct()`.

- [ ] **Step 1: Add the legend section**

Insert into `interactive-map-serverside/static/app.js`, immediately before the
`// --- Wiring ---` section:

```js
// --- Legend -----------------------------------------------------------------
//
// Legend quality varies by product and a client has to cope with all of it:
// Max Reflectivity publishes 15 labelled entries, GOES East publishes 254 whose
// every label is the string "Undefined", and Lightning Heatmap publishes none
// at all. "No legend" is a normal, permanent state — not an error.

const legend = {
  bar: document.getElementById('legend-bar'),
  labels: document.getElementById('legend-labels'),
  note: document.getElementById('legend-note'),
}

/** The literal label the API uses for an entry with no meaningful value. */
const UNDEFINED_LABEL = 'Undefined'

const NO_LEGEND_TEXT = 'No legend published for this product.'

async function showLegend() {
  // Cleared first, so a failure below cannot leave the previous product's
  // legend sitting beside an error message about a different one.
  clearLegend()

  let data
  try {
    data = await getJson(`/api/legend/${state.product}/${state.config}`)
  } catch (error) {
    legend.note.textContent = NO_LEGEND_TEXT
    // A 404 is the normal answer for some products, so it stays silent. Any
    // other failure is a real fault and must not hide behind that silence.
    if (error.status !== 404) {
      console.warn(`Legend request failed: ${error.message}`)
    }
    return
  }

  const entries = data?.palettes?.[0]?.entries
  if (!entries || entries.length === 0) {
    legend.note.textContent = NO_LEGEND_TEXT
    console.warn('Legend response carried no palette entries.')
    return
  }

  drawGradient(entries)
  drawLabels(entries)
}

function clearLegend() {
  legend.bar.style.display = 'none'
  legend.bar.style.background = ''
  legend.labels.innerHTML = ''
  legend.note.textContent = ''
}

function drawGradient(entries) {
  // Colours arrive as #rrggbbaa, which CSS accepts directly.
  if (entries.length === 1) {
    // One entry would divide by zero below and produce NaN stops.
    legend.bar.style.background = entries[0].color
  } else {
    const stops = entries.map(
      (entry, index) =>
        `${entry.color} ${((index / (entries.length - 1)) * 100).toFixed(2)}%`
    )
    legend.bar.style.background = `linear-gradient(to right, ${stops.join(', ')})`
  }
  legend.bar.style.display = 'block'
}

function drawLabels(entries) {
  const real = entries
    .map((entry) => entry.value)
    .filter((value) => value && value !== UNDEFINED_LABEL)

  // GOES East publishes 254 entries whose every label is "Undefined". Showing
  // the ramp with no labels is more honest than printing "Undefined" three times.
  if (real.length === 0) return

  const picks =
    real.length < 3
      ? real
      : [real[0], real[Math.floor(real.length / 2)], real[real.length - 1]]

  for (const text of picks) {
    const span = document.createElement('span')
    span.textContent = text
    legend.labels.append(span)
  }
}
```

- [ ] **Step 2: Call it from the redraw path**

In `showProduct()`, replace the final line:

```js
  setStatus(`Valid ${time}`)
}
```

with:

```js
  setStatus(`Valid ${time}`)
  await showLegend()
}
```

- [ ] **Step 3: Verify by hand**

Run: `cd interactive-map-serverside && ./run.sh`

Open `http://localhost:8000/` and select each product:

1. Max Reflectivity Composite — a gradient bar with three labels, from `5 dBZ` to `75 dBZ`.
2. GOES East Full Disk IR — a gradient bar with no labels.
3. Lightning Heatmap — the text `No legend published for this product.`, and **no console
   warning**. A warning here means a 403 is being treated as a fault rather than as absence.

- [ ] **Step 4: Commit**

```bash
git add interactive-map-serverside/static/app.js
git commit -m "Add legend rendering with its three degradation steps"
```

---

### Task 11: The runner and the README

**Files:**
- Create: `interactive-map-serverside/run.sh`
- Create: `interactive-map-serverside/README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Write the runner**

Create `interactive-map-serverside/run.sh`:

```bash
#!/bin/bash
# Start the server-side Baron map. Creates a virtual environment on first run.
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -d venv ]; then
  echo "Creating the virtual environment…"
  python3 -m venv venv
fi

source venv/bin/activate
pip install -q -r requirements.txt

if [ ! -f .env ]; then
  # A warning rather than an exit. The server starts, serves the page, and
  # shows the setup message in the panel; exiting here would hide that path
  # and make a missing .env look like a broken app.
  echo
  echo "WARNING: no .env found. Copy env.example to .env and add your key."
  echo "         The map will load without weather until you do."
  echo
fi

echo "Serving on http://localhost:8000/  (Ctrl-C to stop)"
exec uvicorn main:app --port 8000 --reload
```

Make it executable:

```bash
chmod +x interactive-map-serverside/run.sh
```

- [ ] **Step 2: Write the README**

Create `interactive-map-serverside/README.md`:

````markdown
# Baron Interactive Map — Server-Side

The same three [Baron Weather](https://www.baronweather.com/) raster products as
[`../interactive-map`](../interactive-map), delivered through either TMS or WMS — but with a
FastAPI server holding the credentials, signing every request, and proxying every byte.

The browser never sees the key, the secret, or a signature. It talks only to `localhost:8000`.

**Read this alongside `../interactive-map`.** That app puts the credentials in the browser and
says so in its own README. This one is the answer to that warning, and the two are meant to be
compared.

## Setup

```bash
cp env.example .env      # then fill in your key and secret
./run.sh
```

Open <http://localhost:8000/>.

`run.sh` creates a virtual environment on first run, installs the dependencies, and starts
uvicorn with `--reload`. It runs in the foreground until you press `Ctrl-C`.

Without a `.env` the server still starts: the page and the basemap load, and the panel shows a
setup message instead of weather. That is deliberate — a missing `.env` should look like a
missing `.env`, not like a broken app.

## Security

The secret stays in the server process, and `.env` sits outside the served tree entirely — only
`static/` is mounted, so `curl localhost:8000/.env` returns 404.

**That is the only thing this app hardens.** There is no TLS, no authentication, and no rate
limiting, so anyone who can reach the port can spend your key's entitlement through the proxy.
Keep it bound to localhost. This is a demonstration, not a deployment.

## What changed from the client-side version

| Concern | `../interactive-map` | This app |
|---|---|---|
| Who holds the secret | The browser | The server process |
| Who can read `.env` | Anything that reaches the port | Nothing |
| Signing | `crypto.subtle` in the browser | `hmac` on the server |
| Signature cache | Required | Gone |
| Secure-context check | Required | Gone |
| Product list | Hard-coded in `app.js` | Served by `/api/config` |
| `baron.js` | 233 lines | Gone |

Three of those deserve an explanation.

**The signature cache disappears.** `baron.js` caches a signature and renews it on a timer for
exactly one reason: MapLibre's `transformRequest` hook must return synchronously, and
`crypto.subtle.sign` is asynchronous. A server has no such constraint — it signs inside the
request handler, so the timestamp is milliseconds old against a window of about ±15 minutes.
The client-side README's "leave it open for 20 minutes, then pan" check has no equivalent here,
because there is no longer a code path that could fail it.

**The secure-context check disappears.** `crypto.subtle` exists only in a secure context, which
is why the client-side app refuses to work when served from a LAN address. Nothing in this
browser code signs anything, so the constraint does not apply.

**The WMS geometry did not move.** Deriving a bbox from the camera exists to serve MapLibre, so
it stays in `app.js`. See the comment on `viewGeometry()` — it guards a bug this project
actually shipped.

## Files

| File | Purpose |
|---|---|
| `main.py` | Routes, the shared httpx client, the static mount. Computes no signature |
| `baron.py` | Credentials, signing, upstream URLs. Imports no FastAPI |
| `cache.py` | A TTL byte cache. Knows nothing about tiles or HTTP |
| `static/index.html` | Panel markup, styles, MapLibre tags |
| `static/app.js` | Map, panel, legend, WMS bbox maths. Knows nothing about signing |
| `tests/` | pytest suite. No network, no credentials required |

`baron.py` imports no FastAPI and `main.py` computes no signature — the same boundary that
`baron.js` and `app.js` keep in the client-side version, in a different language.

## Endpoints

| Route | Returns |
|---|---|
| `GET /` | The map page |
| `GET /api/config` | Products, default view, and whether credentials are loaded |
| `GET /api/instance/{product}/{config}` | `{"time": "2026-08-11T16:20:38Z"}` |
| `GET /api/tms/{product}/{config}/{time}/{z}/{x}/{y}.png` | One signed, cached tile |
| `GET /api/wms/{product}/{config}?time=&bbox=&width=&height=` | One signed GetMap image |
| `GET /api/legend/{product}/{config}` | Legend JSON, or 404 |
| `GET /health` | `{"status": "ok", "credentials": true}` |

TMS tiles and legends are cached in memory for 60 seconds. WMS is not cached: a GetMap image is
built for one arbitrary viewport and is essentially never requested twice, so caching it would
spend memory for nothing.

The tile cache key includes the instance time, so a cached tile cannot go stale — a new instance
simply produces keys nobody has asked for yet. The TTL bounds memory, not staleness.

## Products

| Label | Code | Config |
|---|---|---|
| Max Reflectivity Composite | `C39-0x0302-0` | `Standard-Mercator` |
| Lightning Heatmap | `lightning-heatmap-global` | `Standard-Mercator` |
| GOES East Full Disk IR | `goes-east-fulldisk-hires-ir` | `Standard-Mercator` |

Defined once, in `main.py`. Availability depends on what your key is entitled to; a key without
one of these gets a message in the panel rather than a blank map.

## API notes

The reusable part of this sample. Each item was verified against the live service.

### Signing

```
ts      = floor(unix seconds)
to_sign = "<key>:<ts>"
sig     = urlsafe_base64(HMAC_SHA1(secret, to_sign))
query   = "ts=<ts>&sig=<sig>"
```

A signature is valid for about ±15 minutes. At 20 minutes old the API returns
`403 {"status":403,"message":"Expired timestamp","code":800311}`. Because signing is
timestamp-based, a system clock more than about 15 minutes out fails every request the same way,
even though the key and secret are correct.

**Pass the signature to httpx raw.** A SHA-1 digest is 20 bytes, so the base64 form always ends
in one `=`, and httpx percent-encodes it to `%3D` for you. Encoding it yourself first produces
`%253D` and a 403 that looks exactly like a wrong secret.

### Newest instance

```
GET /v1/{key}/meta/tiles/product-instances/{product}/{config}.json?page_size=1&{sig}
→ [{"time":"2026-08-11T16:20:38Z","created":"2026-08-11T16:21:59Z"}]
```

Ordered newest first. Observational products live under `/meta/tiles/`; forecast products live
under `/meta/maps/`, which this app does not use.

### TMS

```
/v1/{key}/tms/1.0.0/{product}+{config}+{time}/{z}/{x}/{y}.png
```

The instance time is part of the path and is required — omitting it returns 404. Rows run
bottom-up, so a MapLibre raster source needs `scheme: 'tms'`. That stays true through the proxy,
which passes `z`/`x`/`y` unchanged.

Neither the `+` nor the `:` inside the timestamp needs quoting; both are legal in a path segment.

### WMS

```
/v1/{key}/wms/{product}/{config}
  ?service=WMS&version=1.3.0&request=GetMap
  &crs=EPSG:3857&bbox={minx},{miny},{maxx},{maxy}
  &width={w}&height={h}&format=image/png&transparent=true
  &layers={instance time}
```

One image for the whole view, rebuilt on `moveend` — not a tile pyramid. That is what WMS is
designed for, and it is the contrast this app exists to show.

Three traps:

- **`LAYERS` is the instance timestamp, not the product code.** The product code returns
  `400 InvalidParameter`.
- **`VERSION` must be `1.3.0`.** `1.1.1` is rejected.
- **`CRS=EPSG:3857` is the only projection offered.**

And two limits:

- **`WIDTH`/`HEIGHT` are capped at 3000.** `3001` returns `400 InvalidParameter`.
- **A bbox whose aspect ratio disagrees with `width`/`height` still returns HTTP 200** and
  silently distorts the image. There is no error to catch — the caller must derive one dimension
  from the other rather than trusting the service to complain.

### Legends

```
https://static.velocityweather.com/legends/{product}/{config}/legend.json
→ {"palettes": [{"entries": [{"color": "#a4ffa47f", "value": "5 dBZ"}]}]}
```

Public — no signature. Colours are `#rrggbbaa`, which CSS accepts directly.

Quality varies, and a client has to handle all three cases:

| Product | Legend |
|---|---|
| `C39-0x0302-0` | 15 entries, all labelled, `5 dBZ` to `75 dBZ` in 5 dBZ steps |
| `goes-east-fulldisk-hires-ir` | 254 entries, every label is the string `Undefined` |
| `lightning-heatmap-global` | None. The CDN returns `403 AccessDenied` |

The CDN answers `403` rather than `404` because the bucket denies `ListBucket`, so a missing
object and a forbidden one look identical from outside. This server normalises both to a plain
404, and the page treats that as a normal state rather than an error.

WMS is no fallback: the service answers `400 OperationNotSupported` for `GetLegendGraphic`, and
its `GetCapabilities` advertises no `LegendURL` and no `<Style>` blocks. If the CDN has no
legend, there is no legend.

## Tests

```bash
pytest
```

No test touches the network and none needs credentials — upstream calls are faked with
`httpx.MockTransport`. The suite covers what fails *silently*: a double-encoded signature
returns a plausible 403 rather than raising, and a cache that never expires just serves stale
imagery. Neither is visible in a browser, which is why they get tests while the map does not.

MapLibre rendering is not tested. That is the checklist below.

## Verification

1. Copy `env.example` to `.env` and fill in a valid key and secret.
2. Run `./run.sh`. Open <http://localhost:8000/>.
3. `curl localhost:8000/health` → `{"status":"ok","credentials":true}`.
4. Each of the three products draws tiles in TMS mode.
5. The WMS toggle redraws each product.
6. The valid time appears and matches the newest instance.
7. Max Reflectivity shows a labelled legend. GOES East shows an unlabelled ramp. Lightning
   Heatmap shows `No legend published for this product.`
8. Refresh re-resolves the instance and the map redraws.
9. **In the browser's network panel, every request goes to `localhost:8000`.** Nothing reaches
   `api.velocityweather.com`, and no `ts` or `sig` appears anywhere. This is the check the whole
   app exists to pass.
10. `curl localhost:8000/.env` → 404. The secret is not in the served tree.
11. Pan back over ground already visited. Tiles return instantly and the server log stops
    growing — the cache is working.
12. In WMS mode, exactly one `/api/wms` request fires per settled move, sized to the viewport.
13. In WMS mode, zoom out to about z1. The overlay stays registered against the basemap, with
    blank margins where the map wraps — not stretched to fill them.
14. In WMS mode, pan to about longitude ±175 at a working zoom. The overlay still registers.
15. Rename `.env` and restart. The server still starts, `/health` reports `credentials: false`,
    the panel shows the setup message, and the basemap still loads.

Steps 9 and 10 are what separate this app from its twin; both pass trivially on a finished proxy
and fail on a half-finished one.

Steps 13 and 14 catch a geometry bug `../interactive-map` actually shipped. They are the only
two camera positions where a mismatch between the requested bbox and the placed image corners
becomes visible, and the default view reaches neither. A shortcut for both: GOES East's
full-disk imagery is a circle, so any horizontal stretch shows up immediately as an ellipse.

The common thread across 11, 13, and 14 is that each visits a state the opening screen never
reaches. Verification that only exercises the default view will pass while any of these bugs is
present.

## Limitations

The basemap is MapLibre's demo style — country outlines only, no state borders and no cities, so
placing radar geographically is hard. Swap the `style` URL in `app.js` for something with more
detail if that matters.

One weather layer at a time. No animation, no instance history, no point queries, and no
automatic polling for new instances — the Refresh button covers that.

The tile cache is per-process and in-memory, so `--reload` empties it on every code change.

In WMS mode, one image covers one view. MapLibre applies a new image's coordinates only once the
replacement has loaded, so the previous image stays pinned to its own geographic corners until
then: on zoom it scales and blurs while staying correctly registered, and on pan the newly
revealed edge is blank until the new image arrives at `moveend`. Tiled TMS does not do this —
each tile is independent, so only the tiles entering the view need to load.
````

- [ ] **Step 3: Run the whole suite one final time**

Run: `cd interactive-map-serverside && python3 -m pytest tests/ -q`
Expected: PASS, 48 tests

- [ ] **Step 4: Confirm nothing secret is tracked**

```bash
cd interactive-map-serverside
git status --porcelain
git check-ignore -v .env && echo ".env is ignored — good" || echo "WARNING: .env is NOT ignored — stop and fix"
```

Expected: `.env` reported as ignored by the root `.gitignore`.

- [ ] **Step 5: Commit**

```bash
git add interactive-map-serverside/run.sh interactive-map-serverside/README.md
git commit -m "Add the runner script and the README"
```

---

## Self-Review Notes

Checked against the spec on 2026-08-11.

**Spec coverage.** Every section maps to a task:

| Spec section | Task |
|---|---|
| 2 — what changes server-side | 11 (README comparison table) |
| 3 — verified API behaviour | 2, 3, 5, 6, 7, 8 (code comments) and 11 (README API notes) |
| 4 — products | 4 (`PRODUCTS`) |
| 5 — files and module interfaces | 1–11 |
| 6 — endpoints, cache keys, mount order | 4, 5, 6, 7, 8 |
| 7 — client behaviour, map setup, WMS currency | 9 |
| 8 — legend | 10 |
| 9 — error handling table | 4, 5, 6, 7, 8, 9 |
| 10 — README contents | 11 |
| 11.1 — automated tests | 1–8 |
| 11.2 — manual checklist | 9, 10, 11 |

**Type consistency.** Each of `find_product`, `require_credentials`, `fetch_upstream`,
`tile_cache`, `SETUP_MESSAGE`, `AUTH_FAILURE_MESSAGE`, `state`, `showProduct`, `redraw`,
`setStatus`, `getJson`, `viewGeometry`, `toMercator`, `wmsUrl`, `addTmsSource`, `addWmsSource`,
and `showLegend` is defined once and referenced with the same name and signature everywhere.

**Working software at every commit.** Tasks 1–8 each end with a passing test run. Task 9 ends
with a working map in both delivery modes. Task 10 adds the legend to a map that already worked.
No task commits code that calls a function defined in a later task.

**Test count checkpoints.** 5 after Task 1, 13 after Task 2, 19 after Task 3, 26 after Task 4,
32 after Task 5, 37 after Task 6, 42 after Task 7, 48 after Task 8. If a run disagrees, a test
was dropped rather than added — check before continuing.
