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
