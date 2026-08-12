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
