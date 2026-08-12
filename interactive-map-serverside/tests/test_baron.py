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
    # 3001 returns 400 InvalidParameter, so clamp rather than let it fail —
    # but scaled by the SAME factor, so the 5:4 aspect ratio survives the
    # clamp instead of being stretched into a square.
    assert params["width"] == 3000
    assert params["height"] == 2400


def test_wms_url_clamp_preserves_a_wide_aspect_ratio(credentials):
    # Independent min() calls on width and height would send this upstream
    # as 3000x1000 — a 3:1 grid over a 4:1 region — silently distorting the
    # image. Scaling both by the same factor keeps it 4:1.
    _, params = baron.wms_url(
        "p", "c", "t", "-1,-2,3,4", 4000, 1000
    )
    assert params["width"] == 3000
    assert params["height"] == 750


def test_wms_url_leaves_small_dimensions_untouched(credentials):
    _, params = baron.wms_url(
        "p", "c", "t", "-1,-2,3,4", 800, 600
    )
    assert params["width"] == 800
    assert params["height"] == 600


def test_valid_instance_time_accepts_the_documented_shape():
    assert baron.valid_instance_time("2026-08-11T16:20:38Z") is True


def test_valid_instance_time_rejects_a_query_string():
    # A "?" truncates the signed upstream URL, discarding everything after it.
    assert baron.valid_instance_time("T?evil=1") is False


def test_valid_instance_time_rejects_a_fragment():
    # A "#" pushes everything after it out of the path entirely.
    assert baron.valid_instance_time("T#evil") is False


def test_valid_instance_time_rejects_dot_segments():
    # Dot segments collapse to walk the signed URL to a different resource.
    assert baron.valid_instance_time("../../../meta/tiles/x") is False


def test_legend_url_is_public_and_unsigned():
    url = baron.legend_url("C39-0x0302-0", "Standard-Mercator")
    assert url == (
        "https://static.velocityweather.com/legends"
        "/C39-0x0302-0/Standard-Mercator/legend.json"
    )
    assert "ts=" not in url and "sig=" not in url
