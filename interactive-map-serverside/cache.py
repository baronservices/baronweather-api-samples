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
