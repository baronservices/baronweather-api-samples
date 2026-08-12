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
