"""Deciding which scraped shows a watch actually cares about."""

from __future__ import annotations

import datetime as dt

from .models import Show, Watch

# Substrings that should not count as a loose match for a shorter filter.
# "ICE" is the troublesome one: it appears inside "RECLINER", "PRICE", etc.
# so it is matched as a whole word instead of a bare substring.
WORD_MATCH_FILTERS = {"ice", "ted", "max"}


def _matches_token(haystack: str, token: str) -> bool:
    token = token.strip().lower()
    if not token:
        return False
    if token in WORD_MATCH_FILTERS:
        import re

        return re.search(rf"\b{re.escape(token)}\b", haystack) is not None
    return token in haystack


def target_dates(watch: Watch, today: dt.date | None = None) -> list[str]:
    """The YYYYMMDD dates this watch should check, soonest first.

    Explicit dates win over the rolling window. Dates already in the past are
    dropped, since BookMyShow won't list them and requesting one silently
    returns today's data.
    """
    today = today or dt.date.today()
    if watch.dates:
        wanted = sorted(set(watch.dates))
        return [d for d in wanted if d >= today.strftime("%Y%m%d")]
    return [(today + dt.timedelta(days=i)).strftime("%Y%m%d") for i in range(watch.days_ahead)]


def matches(show: Show, watch: Watch) -> bool:
    """True if this show satisfies every filter on the watch.

    Empty filter lists mean "no constraint", so a watch with nothing ticked
    matches everything for that movie and city.
    """
    if watch.formats:
        haystack = show.format_haystack
        if not any(_matches_token(haystack, f) for f in watch.formats):
            return False

    if watch.venues:
        venue_hay = f"{show.venue} {show.venue_code}".lower()
        if not any(_matches_token(venue_hay, v) for v in watch.venues):
            return False

    if watch.languages:
        lang_hay = f"{show.language} {show.format_raw}".lower()
        if not any(_matches_token(lang_hay, l) for l in watch.languages):
            return False

    return True


def filter_shows(shows: list[Show], watch: Watch) -> list[Show]:
    return [s for s in shows if matches(s, watch)]


def new_shows(shows: list[Show], watch: Watch, seen: set[str]) -> tuple[list[Show], set[str]]:
    """Split matching shows into ones worth alerting about, plus all keys seen.

    Collapses to one representative show per dedupe key, so a coarse
    granularity like "movie" yields a single alert rather than hundreds.
    Returns (shows_to_alert, all_keys_present_now).
    """
    fresh: list[Show] = []
    keys_now: set[str] = set()
    alerted_keys: set[str] = set()

    for show in sorted(shows, key=lambda s: (s.date, s.time_code, s.venue)):
        key = show.key(watch.alert_on)
        keys_now.add(key)
        if key in seen or key in alerted_keys:
            continue
        alerted_keys.add(key)
        fresh.append(show)

    return fresh, keys_now
