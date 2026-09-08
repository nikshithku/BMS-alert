"""Fetching BookMyShow pages.

BookMyShow sits behind Cloudflare, which fingerprints the TLS handshake, not
just headers. Plain `requests`/`urllib`/`curl` get a 403 on every path,
including robots.txt. `curl_cffi` replays a real Chrome handshake, which gets
a normal 200.

Only pages allowed by robots.txt for `User-agent: *` are fetched. The movie
showtimes path is not disallowed there; payment/order/booking paths are, and
this never touches them.
"""

from __future__ import annotations

import random
import time

from curl_cffi import requests

BASE = "https://in.bookmyshow.com"
IMPERSONATE = "chrome"
TIMEOUT = 30

# Fingerprints of a Cloudflare interstitial rather than real content.
BLOCK_MARKERS = (
    "Attention Required",
    "cf-error-details",
    "you have been blocked",
    "Just a moment...",
    "Enable JavaScript and cookies to continue",
)


class FetchBlocked(RuntimeError):
    """The response was a bot-check page rather than real content.

    Raised separately from other failures because it means the whole approach
    is being refused, not that one page is missing.
    """


class FetchFailed(RuntimeError):
    """Transport-level or unexpected-status failure."""


def showtimes_url(region: str, event_code: str, date: str, slug: str = "x") -> str:
    """Movie showtimes page for one city on one date.

    The slug segment is cosmetic; BMS resolves the page from the event code
    alone (verified), so callers don't need the real movie name.
    """
    return f"{BASE}/movies/{region}/{slug}/buytickets/{event_code}/{date}"


def get(url: str, *, retries: int = 3, session=None) -> str:
    """GET a page as Chrome, retrying transient failures with backoff."""
    last_err: Exception | None = None
    for attempt in range(retries):
        if attempt:
            time.sleep((2**attempt) + random.uniform(0, 1.0))
        try:
            client = session or requests
            r = client.get(url, impersonate=IMPERSONATE, timeout=TIMEOUT)
        except Exception as e:  # noqa: BLE001 - curl_cffi raises a range of types
            last_err = FetchFailed(f"{type(e).__name__} fetching {url}: {e}")
            continue

        body = r.text or ""
        if any(m in body for m in BLOCK_MARKERS):
            last_err = FetchBlocked(
                f"BookMyShow returned a bot-check page for {url} (HTTP {r.status_code}). "
                "The runner's IP or TLS fingerprint is being refused."
            )
            continue
        if r.status_code != 200:
            last_err = FetchFailed(f"HTTP {r.status_code} for {url}")
            continue
        return body

    raise last_err if last_err else FetchFailed(f"exhausted retries for {url}")


def polite_pause(seconds: float = 2.0, jitter: float = 1.5) -> None:
    """Space out consecutive requests so we stay a well-behaved client."""
    time.sleep(seconds + random.uniform(0, jitter))
