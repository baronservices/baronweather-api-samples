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
