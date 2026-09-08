"""Persisted 'already alerted' state.

A plain JSON file so the Actions run can commit it back to the repo: free
persistence, plus a git history of when each show first appeared.

State is namespaced per watch. Two issues can watch the same movie with
different filters or granularity, and neither should suppress the other's
alerts.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
from pathlib import Path

from .models import Show

log = logging.getLogger(__name__)

SCHEMA = 2


class Store:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.existed = self.path.exists()
        self.data = self._load()

    def _load(self) -> dict:
        if not self.existed:
            log.info("no state file at %s; first run will seed a baseline", self.path)
            return {"schema": SCHEMA, "watches": {}}

        try:
            raw = json.loads(self.path.read_text() or "{}")
        except json.JSONDecodeError as e:
            # Silently resetting would replay every alert at once. Refuse instead.
            raise RuntimeError(
                f"state file {self.path} is corrupt ({e}). Inspect it, or delete it "
                f"and re-run with --seed to rebuild a baseline without alerting."
            ) from None

        if raw.get("schema") not in (None, SCHEMA):
            log.warning(
                "state schema is %s, expected %s; treating unknown entries as unseen",
                raw.get("schema"),
                SCHEMA,
            )
        raw.setdefault("watches", {})
        return raw

    def seen_keys(self, watch_slug: str) -> set[str]:
        entry = self.data["watches"].get(watch_slug) or {}
        return set((entry.get("seen") or {}).keys())

    def remember(self, watch_slug: str, key: str, show: Show) -> None:
        bucket = self.data["watches"].setdefault(watch_slug, {"seen": {}})
        bucket.setdefault("seen", {})[key] = {
            "first_seen": _now(),
            "movie": show.movie,
            "venue": show.venue,
            "date": show.date,
            "time": show.time,
            "format": show.format_label,
        }

    def note_run(self, watch_slug: str, *, listed: int, matched: int, movie: str = "") -> None:
        bucket = self.data["watches"].setdefault(watch_slug, {"seen": {}})
        bucket["last_checked"] = _now()
        bucket["last_listed"] = listed
        bucket["last_matched"] = matched
        if movie:
            bucket["movie"] = movie

    def forget_watch(self, watch_slug: str) -> None:
        """Drop state for a watch whose issue was closed."""
        if watch_slug in self.data["watches"]:
            del self.data["watches"][watch_slug]
            log.info("dropped state for %s (no longer active)", watch_slug)

    def active_slugs(self) -> set[str]:
        return set(self.data["watches"].keys())

    def prune_past(self, today: str | None = None) -> int:
        """Remove entries for showtimes whose date has passed."""
        today = today or dt.date.today().strftime("%Y%m%d")
        removed = 0
        for bucket in self.data["watches"].values():
            seen = bucket.get("seen") or {}
            stale = [k for k, v in seen.items() if (v.get("date") or "99999999") < today]
            for k in stale:
                del seen[k]
            removed += len(stale)
        if removed:
            log.info("pruned %d past showtime(s) from state", removed)
        return removed

    def total_keys(self) -> int:
        return sum(len(b.get("seen") or {}) for b in self.data["watches"].values())

    def save(self) -> None:
        self.data["schema"] = SCHEMA
        self.data["updated_at"] = _now()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps(self.data, indent=2, sort_keys=True) + "\n")
        tmp.replace(self.path)  # atomic, so an interrupted run can't truncate state
        log.info("state saved: %d watch(es), %d key(s)", len(self.data["watches"]), self.total_keys())


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
