"""Build the pickable catalog the dashboard reads: cities, movies, cinemas, formats.

Why this exists at all: BookMyShow sends no CORS headers (verified — no
`access-control-allow-origin` on any page), so the dashboard running on
github.io physically cannot fetch BookMyShow itself. Something server-side has
to collect the options and publish them as static JSON. That's this module, run
by the catalog workflow.

Three separate sources, because no single page gives everything:

* Cities come from BookMyShow's own regions sitemap: one request for ~2,000
  city slugs.
* Movies come from the explore listing. Only the *default* region gets
  server-rendered — asking for /explore/movies-bengaluru returns an
  uninitialised store, and a region cookie doesn't change that. That's fine,
  because event codes are national: the same ET code works in every city.
* Cinemas, formats and languages are city-specific and come from actually
  parsing showtimes pages, reusing the same parser the watcher uses.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import re
from collections import Counter
from pathlib import Path

from . import fetch
from .parse import ParseError, extract_initial_state, parse_shows

log = logging.getLogger(__name__)

REGIONS_SITEMAP = "https://in.bookmyshow.com/sitemap/regions.xml"

# The explore page only server-renders for the default region, so the movie
# list is always read from this one URL and treated as national.
MOVIES_PAGE = "https://in.bookmyshow.com/explore/movies-mumbai"

EVENT_CODE_RE = re.compile(r"\b(ET\d{6,})\b", re.IGNORECASE)

# How many movies to sample when discovering a city's cinemas.
#
# One wide release reveals most of a city's screens, but there's no reliable way
# to know in advance which title that is: the explore page reorders constantly,
# and coming-soon films contribute nothing because they have no showtimes yet.
# Observed in practice, a run can spend eight fetches on limited releases and
# still only find a fraction of the cinemas. So sample generously and lean on
# the accumulation below rather than trying to guess well.
FACET_MOVIE_SAMPLE = 12

# Stop sampling once a fetch adds fewer than this many new venues...
FACET_PLATEAU = 2

# ...but only once coverage is clearly good. Below this, keep looking.
FACET_MIN_VENUES = 60


def _cards(node, out=None, depth=0):
    """Every object in the widget tree that carries a link."""
    if out is None:
        out = []
    if depth > 14:
        return out
    if isinstance(node, dict):
        if node.get("ctaUrl"):
            out.append(node)
        for v in node.values():
            _cards(v, out, depth + 1)
    elif isinstance(node, list):
        for v in node:
            _cards(v, out, depth + 1)
    return out


def fetch_cities() -> list[dict]:
    """Every city BookMyShow serves, from its regions sitemap."""
    xml = fetch.get(REGIONS_SITEMAP)
    slugs = re.findall(
        r"<loc>https://in\.bookmyshow\.com/explore/home/([^<]+)</loc>", xml, re.IGNORECASE
    )
    seen: dict[str, dict] = {}
    for slug in slugs:
        slug = slug.strip().lower()
        if not slug or slug in seen:
            continue
        seen[slug] = {"slug": slug, "name": _pretty_city(slug)}
    log.info("catalog: %d cities", len(seen))
    return sorted(seen.values(), key=lambda c: c["name"])


def _pretty_city(slug: str) -> str:
    # A couple of slugs read badly when naively title-cased.
    special = {
        "national-capital-region-ncr": "Delhi NCR",
        "bengaluru": "Bengaluru",
        "ncr": "Delhi NCR",
    }
    if slug in special:
        return special[slug]
    return " ".join(w.capitalize() for w in slug.split("-"))


def fetch_movies() -> list[dict]:
    """Movies currently listed or coming soon, with poster art.

    Event codes are national, so this list is reusable for every city even
    though it is read from a single region's page.
    """
    html = fetch.get(MOVIES_PAGE)
    state = extract_initial_state(html)
    queries = (state.get("exploreApi") or {}).get("queries") or {}
    payload = next((q["data"] for q in queries.values() if (q or {}).get("data")), None)
    if not payload:
        raise ParseError(
            "explore page returned no server-rendered listings; "
            "BookMyShow may have changed how that page loads"
        )

    movies: dict[str, dict] = {}

    # Walk widgets in page order rather than letting a generic tree walk decide.
    # The page lays films out roughly by prominence, so this ordering is the
    # only signal available for which titles are wide releases — and that
    # matters, because cinema discovery samples the first few and coming-soon
    # titles have no showtimes to learn from.
    for widget in payload.get("listings") or []:
        for card in _cards(widget):
            cta = card.get("ctaUrl") or ""
            m = EVENT_CODE_RE.search(cta)
            if not m:
                continue
            code = m.group(1).upper()
            if code in movies:
                continue
            analytics = card.get("analytics") or {}
            text = card.get("text")
            if isinstance(text, dict):
                text = text.get("title") or text.get("text")
            title = (analytics.get("title") or (text if isinstance(text, str) else "") or "").strip()
            if not title:
                continue
            movies[code] = {
                "code": code,
                "title": title,
                "poster": (card.get("image") or {}).get("url") or "",
                "rank": len(movies),
            }

    log.info("catalog: %d movies", len(movies))
    # Alphabetical for display; `rank` preserves the page's prominence order.
    return sorted(movies.values(), key=lambda m: m["title"].lower())


# How many of a city's cinemas to read when discovering what plays there.
# One request each. This finds the regional long tail the national list misses.
VENUE_SAMPLE = 16


def mine_venue_pages(city: str, venue_codes: list[str], date: str | None = None) -> dict:
    """Read a city's cinema pages to learn what is genuinely playing there.

    Two problems this solves, both verified against live data.

    The explore listing only server-renders for the default region, so the movie
    list was national. Sampling six Bengaluru cinemas surfaced eleven films
    absent from it, every one of them Kannada, Telugu or Tamil.

    And languages were wrong. BookMyShow issues a *separate event code per
    language*: Bethlehem Kudumba Unit is ET00502829 in Malayalam and ET00515244
    in Telugu. Language is therefore a property of the movie you pick, not a
    filter to apply afterwards. Reading it here lets the picker say
    "(Malayalam)" rather than offering a city-wide guess.
    """
    if date is None:
        date = (dt.date.today() + dt.timedelta(days=1)).strftime("%Y%m%d")

    movies: dict[str, dict] = {}

    for vcode in venue_codes[:VENUE_SAMPLE]:
        url = f"https://in.bookmyshow.com/cinemas/{city}/x/buytickets/{vcode}/{date}"
        try:
            state = extract_initial_state(fetch.get(url))
        except fetch.FetchBlocked:
            raise
        except (fetch.FetchFailed, ParseError) as e:
            log.warning("catalog: venue %s in %s: %s", vcode, city, e)
            continue
        finally:
            fetch.polite_pause()

        queries = (state.get("venueShowtimesFunctionalApi") or {}).get("queries") or {}
        detail = next(
            (
                ((q or {}).get("data") or {}).get("showDetailsTransformed")
                for q in queries.values()
                if ((q or {}).get("data") or {}).get("showDetailsTransformed")
            ),
            None,
        )
        if not detail:
            continue

        for event in detail.get("Event") or []:
            title = (event.get("EventTitle") or "").strip()
            for child in event.get("ChildEvents") or []:
                code = (child.get("EventCode") or "").strip().upper()
                if not code:
                    continue
                entry = movies.setdefault(
                    code,
                    {
                        "code": code,
                        "title": title or (child.get("EventName") or "").strip(),
                        "languages": [],
                        "dimensions": [],
                        "venues": [],
                    },
                )
                for key, field in (("EventLanguage", "languages"), ("EventDimension", "dimensions")):
                    val = (child.get(key) or "").strip()
                    if val and val not in entry[field]:
                        entry[field].append(val)
                if vcode not in entry["venues"]:
                    entry["venues"].append(vcode)

    log.info("catalog: %s venue scan -> %d movie(s) with languages", city, len(movies))
    return movies


def fetch_city_facets(
    city: str,
    movie_codes: list[str],
    date: str | None = None,
    previous: dict | None = None,
) -> dict:
    """Discover a city's cinemas, formats and languages from real showtimes.

    Uses tomorrow rather than today by default: a day that hasn't started still
    has its full slate listed, while today's has already lost the screenings
    whose booking window closed.

    Merges into `previous` rather than replacing it. Any single run sees only
    the films playing that day, so a quiet day would otherwise delete cinemas
    that are perfectly real. Accumulating means coverage only improves, at the
    cost of a closed cinema lingering in the picker — which is harmless, since
    an obsolete filter simply never matches.
    """
    if date is None:
        date = (dt.date.today() + dt.timedelta(days=1)).strftime("%Y%m%d")

    venues: dict[str, str] = {}
    formats: Counter[str] = Counter()
    languages: Counter[str] = Counter()
    fetched = 0

    if previous:
        for v in previous.get("venues") or []:
            if v.get("code") and v.get("name"):
                venues[v["code"]] = v["name"]
        # Preserve prior ordering by seeding descending weights.
        for i, f in enumerate(previous.get("formats") or []):
            formats[f] += len(previous["formats"]) - i
        for i, l in enumerate(previous.get("languages") or []):
            languages[l] += len(previous["languages"]) - i
        log.info("catalog: %s starting from %d known venue(s)", city, len(venues))

    for code in movie_codes[:FACET_MOVIE_SAMPLE]:
        before = len(venues)
        try:
            html = fetch.get(fetch.showtimes_url(city, code, date))
            shows = parse_shows(html, region=city, expected_date=date)
        except fetch.FetchBlocked:
            raise
        except (fetch.FetchFailed, ParseError) as e:
            log.warning("catalog: %s %s: %s", city, code, e)
            continue
        finally:
            fetch.polite_pause()

        fetched += 1
        for s in shows:
            if s.venue_code and s.venue:
                venues[s.venue_code] = s.venue
            if s.screen_attr:
                formats[s.screen_attr] += 1
            if s.dimension:
                formats[s.dimension] += 1
            if s.language:
                languages[s.language] += 1

        gained = len(venues) - before
        log.info(
            "catalog: %s via %s -> %d shows, +%d venues (%d total)",
            city,
            code,
            len(shows),
            gained,
            len(venues),
        )
        # Stop once coverage plateaus, but only after a real list has been
        # found. Bailing at the first quiet title left smaller cities with
        # almost-empty cinema pickers.
        if fetched >= 2 and gained < FACET_PLATEAU and len(venues) >= FACET_MIN_VENUES:
            break

    venue_list = [
        {"code": c, "name": n} for c, n in sorted(venues.items(), key=lambda kv: kv[1].lower())
    ]

    # Now that the city's cinemas are known, read a sample of them to find what
    # is actually playing here and in which language. Merged with anything
    # previously known so a quiet day never shrinks the picker.
    local = mine_venue_pages(city, [v["code"] for v in venue_list], date)
    for prev in (previous or {}).get("movies") or []:
        code = prev.get("code")
        if not code:
            continue
        if code in local:
            merged = local[code]
            for field in ("languages", "dimensions", "venues"):
                for val in prev.get(field) or []:
                    if val not in merged[field]:
                        merged[field].append(val)
        else:
            local[code] = prev

    return {
        "city": city,
        "name": _pretty_city(city),
        "sampled_date": date,
        "venues": venue_list,
        # Most-common first so the UI can show the useful ones without scrolling.
        "formats": [f for f, _ in formats.most_common()],
        "languages": [l for l, _ in languages.most_common()],
        # Per-movie truth: language comes from here, never from the city union.
        "movies": sorted(local.values(), key=lambda m: (m["title"].lower(), m["code"])),
    }


def build(out_dir: Path, cities: list[str], *, movies: list[dict] | None = None) -> dict:
    """Write cities.json, movies.json and one file per requested city."""
    out_dir = Path(out_dir)
    (out_dir / "city").mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

    def write(path: Path, payload: dict) -> None:
        payload["generated_at"] = stamp
        path.write_text(json.dumps(payload, indent=1, sort_keys=False) + "\n")
        log.info("catalog: wrote %s (%d bytes)", path, path.stat().st_size)

    all_cities = fetch_cities()
    write(out_dir / "cities.json", {"cities": all_cities})

    if movies is None:
        movies = fetch_movies()
    write(out_dir / "movies.json", {"movies": movies})

    # Sample wide releases first: they're what reveal a city's full cinema list.
    codes = [m["code"] for m in sorted(movies, key=lambda m: m.get("rank", 999))]
    built = []
    for city in cities:
        city = city.strip().lower()
        if not city:
            continue
        city_path = out_dir / "city" / f"{city}.json"

        # Feed yesterday's result back in so coverage accumulates.
        previous = None
        if city_path.exists():
            try:
                previous = json.loads(city_path.read_text())
            except json.JSONDecodeError:
                log.warning("catalog: %s was unreadable; rebuilding from scratch", city_path)

        facets = fetch_city_facets(city, codes, previous=previous)
        write(city_path, facets)
        built.append(city)

    # An index so the dashboard knows which cities are ready without probing.
    index_path = out_dir / "city" / "index.json"
    known = sorted({p.stem for p in (out_dir / "city").glob("*.json") if p.stem != "index"})
    write(index_path, {"cities": known})

    return {"cities": len(all_cities), "movies": len(movies), "built": built, "cached": known}
