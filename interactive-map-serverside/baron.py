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
