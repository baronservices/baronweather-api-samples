"""Tests for the HTTP surface.

No test here touches the network. Upstream calls are faked with
httpx.MockTransport by replacing the shared client on app.state, which the
lifespan handler creates when TestClient enters its context.
"""

import sys
from pathlib import Path
from urllib.parse import quote

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


def test_instance_rejects_a_non_json_body(client):
    # A 200 only means the connection succeeded, not that Baron sent JSON.
    client.app.state.client = mock_upstream(
        lambda request: httpx.Response(200, text="<html>oops</html>")
    )
    assert client.get(INSTANCE_PATH).status_code == 502


def test_instance_rejects_a_json_object_instead_of_a_list(client):
    # Truthy, so `if not instances` lets it through; instances[0] then fails.
    client.app.state.client = mock_upstream(
        lambda request: httpx.Response(200, json={"error": "nope"})
    )
    assert client.get(INSTANCE_PATH).status_code == 502


def test_instance_rejects_an_entry_missing_the_time_field(client):
    client.app.state.client = mock_upstream(
        lambda request: httpx.Response(200, json=[{"created": "x"}])
    )
    assert client.get(INSTANCE_PATH).status_code == 502


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


# --- /api/tms ----------------------------------------------------------------

TILE_PATH = (
    "/api/tms/C39-0x0302-0/Standard-Mercator/2026-08-11T16:20:38Z/3/1/2.png"
)


def test_tile_is_proxied_with_its_bytes_intact(client):
    def handler(request):
        assert "/tms/1.0.0/" in str(request.url)
        assert "C39-0x0302-0+Standard-Mercator+2026-08-11T16:20:38Z" in str(request.url)
        return httpx.Response(
            200, content=b"\x89PNG-tile", headers={"content-type": "image/png"}
        )

    client.app.state.client = mock_upstream(handler)
    response = client.get(TILE_PATH)
    assert response.status_code == 200
    assert response.content == b"\x89PNG-tile"
    assert response.headers["content-type"] == "image/png"


def test_a_second_request_is_served_from_the_cache(client):
    calls = []

    def handler(request):
        calls.append(request.url)
        return httpx.Response(
            200, content=b"\x89PNG-tile", headers={"content-type": "image/png"}
        )

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


# --- instance-time validation --------------------------------------------
#
# `time` is interpolated straight into the signed upstream URL (baron.tms_url
# / baron.wms_url), so a value that is not a plain instance timestamp can
# truncate that URL at a "?", divert the tail into a "#" fragment, or walk it
# to a different resource with "../". The "?" and "#" cases are exercised
# through the TMS route's {time} path segment, quoted with quote(..., safe="")
# the way a browser or curl would, exactly as in the verified exploit. The
# "../" case needs a literal "/" to form real dot-segments, which cannot
# survive inside that single path segment — Starlette's router 404s on it
# before our handler runs — so it is exercised through the WMS route, where
# `time` is a query parameter and a "/" passes through untouched.


def test_tile_rejects_a_time_with_a_query_string(client):
    calls = []

    def handler(request):
        calls.append(request.url)
        return httpx.Response(200, content=b"", headers={"content-type": "image/png"})

    client.app.state.client = mock_upstream(handler)
    bad_time = quote("T?evil=1", safe="")
    response = client.get(f"/api/tms/C39-0x0302-0/Standard-Mercator/{bad_time}/3/1/2.png")
    assert response.status_code == 400
    assert calls == []


def test_tile_rejects_a_time_with_a_fragment(client):
    calls = []

    def handler(request):
        calls.append(request.url)
        return httpx.Response(200, content=b"", headers={"content-type": "image/png"})

    client.app.state.client = mock_upstream(handler)
    bad_time = quote("T#evil", safe="")
    response = client.get(f"/api/tms/C39-0x0302-0/Standard-Mercator/{bad_time}/3/1/2.png")
    assert response.status_code == 400
    assert calls == []


def test_wms_rejects_a_time_with_dot_segments(client):
    # A literal "/" cannot survive inside the TMS route's single {time} path
    # segment — Starlette's own router 404s on it before our handler ever
    # runs. The WMS route takes `time` as a query parameter instead, where a
    # "/" passes through untouched, so this is where the dot-segment payload
    # actually reaches valid_instance_time() to be rejected.
    calls = []

    def handler(request):
        calls.append(request.url)
        return httpx.Response(200, content=b"", headers={"content-type": "image/png"})

    client.app.state.client = mock_upstream(handler)
    response = client.get(
        WMS_PATH, params={**WMS_QUERY, "time": "../../../meta/tiles/x"}
    )
    assert response.status_code == 400
    assert calls == []


def test_tile_accepts_a_well_formed_instance_timestamp(client):
    # The rejections above must not be the result of an overzealous check
    # that also blocks the timestamp shape every real request uses.
    client.app.state.client = mock_upstream(
        lambda request: httpx.Response(
            200, content=b"\x89PNG-tile", headers={"content-type": "image/png"}
        )
    )
    assert client.get(TILE_PATH).status_code == 200


def test_wms_rejects_a_malformed_time(client):
    calls = []

    def handler(request):
        calls.append(request.url)
        return httpx.Response(200, content=b"", headers={"content-type": "image/png"})

    client.app.state.client = mock_upstream(handler)
    response = client.get(WMS_PATH, params={**WMS_QUERY, "time": "T?evil=1"})
    assert response.status_code == 400
    assert calls == []


# --- non-image 200 bodies (OGC error-as-200 convention) -----------------


def test_tile_with_a_200_xml_body_is_rejected_and_not_cached(client):
    calls = []

    def handler(request):
        calls.append(request.url)
        return httpx.Response(
            200,
            content=b"<ServiceExceptionReport>bad time</ServiceExceptionReport>",
            headers={"content-type": "text/xml"},
        )

    client.app.state.client = mock_upstream(handler)
    response = client.get(TILE_PATH)
    assert response.status_code == 502
    # Not cached: a second request must reach upstream again, not a cache hit.
    client.get(TILE_PATH)
    assert len(calls) == 2


def test_tile_with_a_200_empty_body_is_rejected(client):
    client.app.state.client = mock_upstream(
        lambda request: httpx.Response(
            200, content=b"", headers={"content-type": "image/png"}
        )
    )
    assert client.get(TILE_PATH).status_code == 502


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
        return httpx.Response(
            200, content=b"\x89PNG-image", headers={"content-type": "image/png"}
        )

    client.app.state.client = mock_upstream(handler)
    response = client.get(WMS_PATH, params=WMS_QUERY)
    assert response.status_code == 200
    assert response.content == b"\x89PNG-image"


def test_wms_is_not_cached(client):
    calls = []

    def handler(request):
        calls.append(request.url)
        return httpx.Response(
            200, content=b"\x89PNG-image", headers={"content-type": "image/png"}
        )

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


def test_wms_with_a_200_xml_body_is_rejected(client):
    client.app.state.client = mock_upstream(
        lambda request: httpx.Response(
            200,
            content=b"<ServiceExceptionReport>bad bbox</ServiceExceptionReport>",
            headers={"content-type": "text/xml"},
        )
    )
    assert client.get(WMS_PATH, params=WMS_QUERY).status_code == 502


def test_wms_with_a_200_empty_body_is_rejected(client):
    client.app.state.client = mock_upstream(
        lambda request: httpx.Response(
            200, content=b"", headers={"content-type": "image/png"}
        )
    )
    assert client.get(WMS_PATH, params=WMS_QUERY).status_code == 502


def test_wms_rejects_an_unknown_product(client):
    response = client.get(
        "/api/wms/not-a-product/Standard-Mercator", params=WMS_QUERY
    )
    assert response.status_code == 404


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


def test_a_malformed_legend_body_is_rejected_and_not_cached(client):
    # A 200 that is not valid JSON must not be forwarded and pinned as
    # application/json: the browser's response.json() would fail in a way
    # indistinguishable from a network error, and the panel would wrongly
    # report "no legend published" for a product that has one — and keep
    # saying so for the full cache TTL.
    calls = []

    def handler(request):
        calls.append(request.url)
        return httpx.Response(200, content=b"<html>nope</html>")

    client.app.state.client = mock_upstream(handler)
    response = client.get(LEGEND_PATH)
    assert response.status_code == 502
    # Not cached: a second request must reach upstream again.
    client.get(LEGEND_PATH)
    assert len(calls) == 2


def test_a_valid_legend_body_is_returned_and_cached(client):
    calls = []

    def handler(request):
        calls.append(request.url)
        return httpx.Response(200, json=LEGEND_BODY)

    client.app.state.client = mock_upstream(handler)
    response = client.get(LEGEND_PATH)
    assert response.status_code == 200
    assert response.json() == LEGEND_BODY
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


# --- The upstream error body never reaches the browser -----------------------
#
# These pin an invariant that had no test at all: an upstream failure body is
# logged server-side and replaced with an empty one, because that body is the
# only payload in this app whose contents another service decides. Every other
# non-200 mock in this file uses content=b"", so deleting the suppression
# blocks from main.py used to leave the whole suite green.

# Deliberately shaped like the worst case: an upstream that echoes the request
# it received, signature and all.
LEAKY_ERROR_BODY = (
    b'{"status":403,"echo":"https://api.velocityweather.com/v1/SECRET_KEY'
    b'/tms/1.0.0/C39-0x0302-0+Standard-Mercator+2026-01-01T00:00:00Z'
    b'/3/1/2.png?ts=1786549272&sig=27DQTO3VTfThX0wAh12zjDrmCwQ%3D"}'
)


def test_tile_error_body_never_reaches_the_browser(client):
    client.app.state.client = mock_upstream(
        lambda request: httpx.Response(403, content=LEAKY_ERROR_BODY)
    )
    response = client.get(TILE_PATH)

    # The status passes through — that part is deliberate, so a 403 storm in
    # the browser console still reads as a 403.
    assert response.status_code == 403
    # The body does not.
    assert response.content == b""
    assert b"SECRET_KEY" not in response.content
    assert b"sig=" not in response.content


def test_tile_error_is_not_cacheable_by_the_browser(client):
    client.app.state.client = mock_upstream(
        lambda request: httpx.Response(403, content=LEAKY_ERROR_BODY)
    )
    # max-age on an error lets a browser hold a 403 for minutes after the user
    # has fixed the cause, with no request reaching the server to explain why.
    assert client.get(TILE_PATH).headers["cache-control"] == "no-store"


def test_tile_success_is_still_cacheable(client):
    client.app.state.client = mock_upstream(
        lambda request: httpx.Response(
            200, content=b"\x89PNG-tile", headers={"content-type": "image/png"}
        )
    )
    response = client.get(TILE_PATH)
    assert response.status_code == 200
    assert response.content == b"\x89PNG-tile"
    assert response.headers["cache-control"] == "public, max-age=300"


def test_wms_error_body_never_reaches_the_browser(client):
    client.app.state.client = mock_upstream(
        lambda request: httpx.Response(403, content=LEAKY_ERROR_BODY)
    )
    response = client.get(WMS_PATH, params=WMS_QUERY)

    assert response.status_code == 403
    assert response.content == b""
    assert b"SECRET_KEY" not in response.content
    assert b"sig=" not in response.content
