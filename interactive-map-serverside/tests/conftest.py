"""Test configuration and fixtures.

Tests must not read a developer's real .env file. The load_dotenv(...,
override=False) call in baron.load_credentials() only declines to overwrite
environment variables that are ALREADY SET. Once clear_credentials deletes
them, load_dotenv repopulates them from the .env file on disk. This makes
tests non-hermetic: the result depends on whether the developer has created
that file. The fix is to neutralise load_dotenv for the entire test session,
so tests see only the environment they set explicitly via monkeypatch.
"""

from unittest.mock import patch

import pytest


@pytest.fixture(scope="session", autouse=True)
def disable_load_dotenv_for_tests():
    """Patch baron.load_dotenv to a no-op for all tests in this session."""
    with patch("baron.load_dotenv"):
        yield
