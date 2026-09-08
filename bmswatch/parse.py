"""Turn a BookMyShow showtimes page into normalised Show records.

The page embeds its whole Redux store in `window.__INITIAL_STATE__`. The
showtimes live under a RTK Query cache entry whose key is built from the event
code, date and region, so it's looked up by prefix rather than exact name.
"""

from __future__ import annotations

import json

from .models import Show

DYNAMIC_QUERY_PREFIX = "fetchPrimaryDynamic"


class ParseError(RuntimeError):
    """The page loaded but didn't contain the structure we rely on."""


def extract_initial_state(html: str) -> dict:
    """Pull the `window.__INITIAL_STATE__ = {...}` object out of the page.

    Brace-matched rather than regexed: the blob is ~500KB of nested JSON with
    braces inside string literals, which a regex gets wrong.
    """
    anchor = html.find("__INITIAL_STATE__")
    if anchor == -1:
        raise ParseError("no __INITIAL_STATE__ in page (BMS may have changed their markup)")

    start = html.find("{", anchor)
    if start == -1:
        raise ParseError("__INITIAL_STATE__ found but no opening brace followed it")

    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(html)):
        ch = html[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                raw = html[start : i + 1]
                try:
                    return json.loads(raw)
                except json.JSONDecodeError as e:
                    raise ParseError(f"__INITIAL_STATE__ was not valid JSON: {e}") from e

    raise ParseError("__INITIAL_STATE__ object was never closed")


def _dynamic_payload(state: dict) -> dict | None:
    """The RTK Query cache entry holding this date's showtimes, if present."""
    queries = (state.get("showtimesFunctionalApi") or {}).get("queries") or {}
    for key, entry in queries.items():
        if not key.startswith(DYNAMIC_QUERY_PREFIX):
            continue
        data = ((entry or {}).get("data") or {}).get("data")
        if isinstance(data, dict):
            return data
    return None


def _movie_title(payload: dict) -> str:
    return (((payload.get("header") or {}).get("title") or {}).get("text") or "").strip()


def _venue_groups(payload: dict) -> list[dict]:
    """The per-venue entries inside the groupList widget."""
    for widget in payload.get("showtimeWidgets") or []:
        if widget.get("type") != "groupList":
            continue
        for group in widget.get("data") or []:
            inner = group.get("data")
            if isinstance(inner, list) and inner:
                return inner
    return []


def _format_string(showtime: dict) -> str:
    """The combined 'Hindi • 2D | IMAX' label, if BMS included it."""
    try:
        widgets = showtime["customGestureCTA"]["additionalData"]["bottomSheetData"]["widgets"]
    except (KeyError, TypeError):
        return ""
    for w in widgets or []:
        value = (w.get("variableData") or {}).get("format")
        if value:
            return str(value).strip()
    return ""


# Some venues send placeholder junk instead of a real screen attribute.
_ATTR_JUNK = {"", "0", "-", "na", "n/a", "null", "none"}


def _clean_attr(value) -> str:
    attr = (str(value) if value is not None else "").strip()
    return "" if attr.lower() in _ATTR_JUNK else attr


def _split_format(format_raw: str) -> tuple[str, str]:
    """'Hindi • 2D | IMAX' -> ('Hindi', '2D'). Screen attr comes from elsewhere."""
    if not format_raw:
        return "", ""
    head = format_raw.split("|", 1)[0]
    parts = [p.strip() for p in head.replace("\u2022", "•").split("•") if p.strip()]
    if len(parts) >= 2:
        return parts[0], parts[1]
    if len(parts) == 1:
        return "", parts[0]
    return "", ""


def parse_shows(html: str, *, region: str, expected_date: str) -> list[Show]:
    """Extract every show on the page that genuinely belongs to `expected_date`.

    The date filter is load-bearing, not defensive. When a requested date has
    no listings, BookMyShow serves *today's* showtimes while still echoing the
    requested date back in `currentDateCode`. Trusting that field makes every
    future date look like it just opened for booking. The per-showtime
    `showDateCode` is the only trustworthy signal, so anything that disagrees
    with the date we asked for is discarded.
    """
    state = extract_initial_state(html)
    payload = _dynamic_payload(state)
    if payload is None:
        # Past dates and unknown event codes render a page with no showtimes
        # cache entry at all. That's "nothing listed", not a failure.
        return []

    movie = _movie_title(payload)
    shows: list[Show] = []

    for venue in _venue_groups(payload):
        vinfo = venue.get("additionalData") or {}
        venue_name = (vinfo.get("venueName") or "").strip()
        venue_code = (vinfo.get("venueCode") or "").strip()

        for section in venue.get("showtimesSections") or []:
            event_code = ((section.get("additionalData") or {}).get("eventCode") or "").strip()

            for st in section.get("showtimes") or []:
                sd = st.get("additionalData") or {}
                show_date = (sd.get("showDateCode") or "").strip()
                if show_date != expected_date:
                    continue

                format_raw = _format_string(st)
                language, dimension = _split_format(format_raw)
                screen_attr = _clean_attr(st.get("screenAttr") or sd.get("attributes"))

                shows.append(
                    Show(
                        event_code=event_code,
                        movie=movie,
                        region=region,
                        venue_code=venue_code,
                        venue=venue_name,
                        date=show_date,
                        time=(sd.get("showTime") or st.get("title") or "").strip(),
                        time_code=(sd.get("showTimeCode") or "").strip(),
                        session_id=(sd.get("sessionId") or "").strip(),
                        language=language,
                        dimension=dimension,
                        screen_attr=screen_attr,
                        format_raw=format_raw,
                        avail_status=(sd.get("availStatus") or "").strip(),
                    )
                )

    return shows
