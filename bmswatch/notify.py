"""Alert delivery.

Two channels, deliberately:

* A comment on the watch's issue. Free, needs no secrets, and GitHub already
  emails and push-notifies you for your own issue threads. This always happens.
* Telegram, if TELEGRAM_TOKEN and TELEGRAM_CHAT_ID are set. Faster and better
  for racing a queue, but optional.
"""

from __future__ import annotations

import html
import json
import logging
import os
import time
import urllib.error
import urllib.request

from .models import Show

log = logging.getLogger(__name__)

TELEGRAM_API = "https://api.telegram.org"
TELEGRAM_MAX = 4096


class Telegram:
    def __init__(self, token: str | None = None, chat_id: str | None = None):
        self.token = token or os.environ.get("TELEGRAM_TOKEN", "")
        self.chat_id = chat_id or os.environ.get("TELEGRAM_CHAT_ID", "")

    @property
    def configured(self) -> bool:
        return bool(self.token and self.chat_id)

    def send(self, text: str, *, retries: int = 3) -> None:
        if not self.configured:
            return

        if len(text) > TELEGRAM_MAX:
            text = text[: TELEGRAM_MAX - 24].rstrip() + "\n… (truncated)"

        payload = json.dumps(
            {
                "chat_id": self.chat_id,
                "text": text,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            }
        ).encode()

        url = f"{TELEGRAM_API}/bot{self.token}/sendMessage"
        last = ""
        for attempt in range(1, retries + 1):
            req = urllib.request.Request(url, data=payload, method="POST")
            req.add_header("Content-Type", "application/json")
            try:
                with urllib.request.urlopen(req, timeout=20) as resp:
                    if resp.status == 200:
                        return
                    last = f"HTTP {resp.status}"
            except urllib.error.HTTPError as e:
                detail = e.read().decode(errors="replace")[:200]
                last = f"HTTP {e.code}: {detail}"
                if e.code == 429:
                    # Telegram tells us how long to wait; obey rather than guess.
                    wait = 5
                    try:
                        wait = int(json.loads(detail).get("parameters", {}).get("retry_after", 5))
                    except Exception:  # noqa: BLE001
                        pass
                    log.warning("telegram rate limited, waiting %ss", wait)
                    time.sleep(wait + 1)
                    continue
            except urllib.error.URLError as e:
                last = str(e.reason)

            log.warning("telegram attempt %d/%d failed: %s", attempt, retries, last)
            time.sleep(2**attempt)

        # A failed Telegram send must not abort the run; the issue comment is the
        # channel we actually rely on.
        log.error("giving up on Telegram after %d attempts: %s", retries, last)


def _group_by_venue(shows: list[Show]) -> dict[str, list[Show]]:
    grouped: dict[str, list[Show]] = {}
    for s in shows:
        grouped.setdefault(s.venue or s.venue_code or "Unknown cinema", []).append(s)
    return grouped


def markdown_alert(watch_name: str, shows: list[Show], alert_on: str) -> str:
    """Issue-comment body."""
    first = shows[0]
    lines = [f"### 🎟️ {first.movie or watch_name} — tickets listed", ""]

    if alert_on == "movie":
        lines += [f"Booking is now open in **{first.region.replace('-', ' ').title()}**.", ""]

    grouped = _group_by_venue(shows)
    for venue, group in sorted(grouped.items()):
        lines.append(f"**{venue}**")
        lines.append("")
        lines.append("| Date | Time | Format |")
        lines.append("| --- | --- | --- |")
        for s in sorted(group, key=lambda x: (x.date, x.time_code))[:12]:
            lines.append(f"| {s.pretty_date} | {s.time} | {s.format_label} |")
        if len(group) > 12:
            lines.append(f"| … | +{len(group) - 12} more | |")
        lines.append("")

    lines += [f"[Book on BookMyShow →]({first.booking_url})", ""]
    lines += ["<sub>Close this issue to stop these alerts. Edit it to change the filters.</sub>"]
    return "\n".join(lines)


def telegram_alert(watch_name: str, shows: list[Show], alert_on: str) -> str:
    """Telegram HTML body. Kept compact; Telegram has no tables."""
    first = shows[0]
    out = [f"🎟️ <b>{html.escape(first.movie or watch_name)}</b>"]
    if watch_name and first.movie and watch_name != first.movie:
        out.append(f"<i>{html.escape(watch_name)}</i>")
    out.append("")

    if alert_on == "movie":
        out += [f"Booking is open in {html.escape(first.region.replace('-', ' ').title())}.", ""]

    grouped = _group_by_venue(shows)
    for i, (venue, group) in enumerate(sorted(grouped.items())):
        if i >= 12:
            out.append(f"… and {len(grouped) - 12} more cinema(s)")
            break
        out.append(f"📍 <b>{html.escape(venue)}</b>")
        for s in sorted(group, key=lambda x: (x.date, x.time_code))[:8]:
            out.append(f"   {s.pretty_date} · {html.escape(s.time)} · {html.escape(s.format_label)}")
        if len(group) > 8:
            out.append(f"   … +{len(group) - 8} more")
        out.append("")

    out.append(f'<a href="{html.escape(first.booking_url)}">Book on BookMyShow →</a>')
    return "\n".join(out)


def markdown_confirmation(watch, movie_hint: str = "") -> str:
    """Posted when an issue is validated, so the user sees what was understood."""
    lines = ["### ✅ Watch is active", ""]
    if movie_hint:
        lines += [f"Tracking **{movie_hint}**.", ""]
    lines += [
        "| Setting | Value |",
        "| --- | --- |",
        f"| Movie code | `{watch.event_code}` |",
        f"| City | `{watch.region}` |",
        f"| Formats | {', '.join(f'`{f}`' for f in watch.formats) if watch.formats else 'any'} |",
        f"| Cinemas | {', '.join(f'`{v}`' for v in watch.venues) if watch.venues else 'any'} |",
        f"| Languages | {', '.join(f'`{l}`' for l in watch.languages) if watch.languages else 'any'} |",
        (
            f"| Dates | {', '.join(watch.dates)} |"
            if watch.dates
            else f"| Dates | next {watch.days_ahead} day(s) |"
        ),
        f"| Alerts | {_alert_help(watch.alert_on)} |",
        "",
        "You'll get a comment here the moment something matching shows up.",
        "",
        "- **Change the filters** — edit this issue, it re-validates automatically.",
        "- **Stop the alerts** — close this issue.",
    ]
    return "\n".join(lines)


def markdown_invalid(reason: str) -> str:
    return "\n".join(
        [
            "### ⚠️ Couldn't set up this watch",
            "",
            reason,
            "",
            "Edit the issue to fix it and it'll be re-checked automatically.",
        ]
    )


def _alert_help(alert_on: str) -> str:
    return {
        "movie": "once, when booking first opens",
        "venue": "once per cinema",
        "format": "once per cinema and format",
        "show": "every new showtime",
    }.get(alert_on, alert_on)


def markdown_blocked(detail: str) -> str:
    return "\n".join(
        [
            "### 🚧 Check couldn't run",
            "",
            "BookMyShow returned a bot-check page instead of showtimes, so this "
            "run checked nothing. No state was saved, so nothing was missed — "
            "the next run will pick up where this left off.",
            "",
            "If this keeps happening, the poller needs to move off GitHub's IP "
            "ranges (a Raspberry Pi or small VPS both work).",
            "",
            "<details><summary>Details</summary>",
            "",
            f"```\n{detail[:800]}\n```",
            "",
            "</details>",
        ]
    )
