"""Parse a GitHub issue-form body into a Watch.

GitHub renders issue forms into markdown shaped like:

    ### Field label

    the value

    ### Formats

    - [x] IMAX
    - [ ] 4DX

Unanswered optional fields come through as the literal `_No response_`.

The label strings and dropdown options below must stay character-for-character
in sync with `.github/ISSUE_TEMPLATE/watch.yml`. If you rename a field label in
the form, rename it here too, or that field silently reads as empty.
"""

from __future__ import annotations

import datetime as dt
import re

from .models import Watch

NO_RESPONSE = {"_no response_", "_none_", ""}

# form label -> internal field name
FIELDS = {
    "BookMyShow movie link": "url",
    "City override": "city",
    "Formats": "formats",
    "Other formats": "formats_other",
    "Cinemas": "venues",
    "Languages": "languages",
    "How far ahead to look": "days_ahead",
    "Specific dates": "dates",
    "How often should it alert?": "alert_on",
    "Acknowledgement": "ack",
}

# dropdown answer -> dedupe granularity
ALERT_ON = {
    "Once — just tell me when booking opens": "movie",
    "Once per cinema": "venue",
    "Once per cinema and format": "format",
    "Every single new showtime": "show",
}

DAYS_AHEAD = {
    "1 day (today only)": 1,
    "3 days": 3,
    "7 days": 7,
    "14 days": 14,
}

EVENT_CODE_RE = re.compile(r"\b(ET\d{6,})\b", re.IGNORECASE)


class IssueFormError(ValueError):
    """The issue body could not be turned into a usable watch."""


# The one heading that must be present for a body to count as a watch form.
# Derived from FIELDS so it can't drift from the label the parser looks for.
FORM_ANCHOR = "### BookMyShow movie link"


def looks_like_watch_form(body: str) -> bool:
    """Whether this body is an attempt at the watch form at all.

    Lets validation distinguish "someone opened an unrelated issue" (ignore it
    silently) from "someone used the watch form but got a field wrong" (explain
    what to fix). Without this, every unrelated issue the owner opened would get
    a bot comment telling them it isn't a valid watch.
    """
    return FORM_ANCHOR in (body or "")


def split_sections(body: str) -> dict[str, str]:
    """Split an issue-form body into {label: raw_value}."""
    if not body:
        return {}
    body = body.replace("\r\n", "\n")
    sections: dict[str, str] = {}
    # Split on '### ' at start of a line.
    parts = re.split(r"^###[ \t]+", body, flags=re.MULTILINE)
    for part in parts[1:]:  # parts[0] is anything before the first heading
        lines = part.split("\n", 1)
        label = lines[0].strip()
        value = (lines[1] if len(lines) > 1 else "").strip()
        sections[label] = value
    return sections


def _scalar(sections: dict[str, str], label: str) -> str:
    raw = sections.get(label, "").strip()
    if raw.lower() in NO_RESPONSE:
        return ""
    return raw


def _checked(sections: dict[str, str], label: str) -> list[str]:
    """Return the labels of ticked checkboxes."""
    raw = sections.get(label, "")
    out = []
    for line in raw.split("\n"):
        m = re.match(r"[-*]\s*\[([xX])\]\s*(.+)", line.strip())
        if m:
            out.append(m.group(2).strip())
    return out


def _csv(value: str) -> list[str]:
    return [p.strip() for p in value.split(",") if p.strip()]


def _lines(value: str) -> list[str]:
    return [p.strip() for p in value.split("\n") if p.strip()]


def parse_link(url: str) -> tuple[str | None, str | None]:
    """Pull (region_slug, event_code) out of a BookMyShow movie URL.

    Handles the shapes BMS actually uses:
      /movies/<city>/<slug>/<EVENT>
      /movies/<city>/<slug>/buytickets/<EVENT>/<date>
      /buytickets/<slug>-<city>/movie-<city>-<EVENT>-MT/<date>
    """
    region = None
    m = re.search(r"/movies/([a-z0-9\-]+)/", url, re.IGNORECASE)
    if m:
        region = m.group(1).lower()
    else:
        m = re.search(r"/movie-([a-z0-9\-]+)-ET\d+", url, re.IGNORECASE)
        if m:
            region = m.group(1).lower()

    code_m = EVENT_CODE_RE.search(url)
    event_code = code_m.group(1).upper() if code_m else None
    return region, event_code


def normalise_dates(raw: str, today: dt.date | None = None) -> list[str]:
    """Accept YYYY-MM-DD / YYYYMMDD / DD-MM-YYYY, emit YYYYMMDD.

    Refuses a date list that is entirely in the past. Explicit dates override
    the rolling window, so an all-past list leaves the watcher with nothing to
    fetch: it runs forever, finds nothing, and reports success. Better to reject
    it and explain than to look healthy while doing no work.
    """
    today = today or dt.date.today()
    out: list[str] = []
    past: list[str] = []
    for token in _csv(raw):
        t = token.strip()
        parsed = None
        for fmt in ("%Y-%m-%d", "%Y%m%d", "%d-%m-%Y", "%d/%m/%Y", "%Y/%m/%d"):
            try:
                parsed = dt.datetime.strptime(t, fmt).date()
                break
            except ValueError:
                continue
        if parsed is None:
            raise IssueFormError(
                f"Could not read the date `{token}`. Use `YYYY-MM-DD`, e.g. "
                f"`{(today + dt.timedelta(days=7)).isoformat()}`."
            )
        if parsed < today:
            past.append(parsed.isoformat())
        else:
            out.append(parsed.strftime("%Y%m%d"))

    if past and not out:
        raise IssueFormError(
            f"Every date given is in the past ({', '.join('`' + p + '`' for p in past)}), "
            f"and today is `{today.isoformat()}`.\n\n"
            "BookMyShow doesn't list past dates, so this watch would never match "
            "anything. Either pick a future date, or clear the **Specific dates** "
            "field to fall back on the rolling window."
        )

    return out


def watch_from_issue(body: str, issue_number: int, title: str = "") -> Watch:
    """Build a Watch from an issue-form body. Raises IssueFormError on bad input."""
    sections = split_sections(body)
    if not sections:
        raise IssueFormError(
            "This issue doesn't look like it came from the watch form. "
            "Please open a new issue using the **🎬 Watch a show** template."
        )

    url = _scalar(sections, "BookMyShow movie link")
    if not url:
        raise IssueFormError("The **BookMyShow movie link** field is empty. It's required.")

    region, event_code = parse_link(url)

    city_override = _scalar(sections, "City override")
    if city_override:
        region = city_override.strip().lower().replace(" ", "-")

    if not event_code:
        raise IssueFormError(
            f"Couldn't find a movie code (like `ET00369074`) in the link:\n\n> {url}\n\n"
            "Open the movie's page on BookMyShow and copy the address from your browser."
        )
    if not region:
        raise IssueFormError(
            f"Couldn't work out the city from the link:\n\n> {url}\n\n"
            "Either use a link that contains the city (e.g. "
            "`/movies/bengaluru/...`) or fill in the **City override** field."
        )

    formats = _checked(sections, "Formats") + _csv(_scalar(sections, "Other formats"))
    # "IMAX 3D" already implies IMAX; keep both, matching is substring-based.
    formats = list(dict.fromkeys(f for f in formats if f))

    alert_label = _scalar(sections, "How often should it alert?")
    alert_on = ALERT_ON.get(alert_label, "format")

    days_label = _scalar(sections, "How far ahead to look")
    days_ahead = DAYS_AHEAD.get(days_label, 3)

    dates = normalise_dates(_scalar(sections, "Specific dates"))

    clean_title = re.sub(r"^\s*\[watch\]\s*", "", title or "", flags=re.IGNORECASE).strip()

    return Watch(
        name=clean_title or f"{event_code} in {region}",
        event_code=event_code,
        region=region,
        formats=formats,
        venues=_lines(_scalar(sections, "Cinemas")),
        languages=_csv(_scalar(sections, "Languages")),
        dates=dates,
        days_ahead=days_ahead,
        alert_on=alert_on,
        issue_number=issue_number,
    )
