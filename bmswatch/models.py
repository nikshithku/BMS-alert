"""Core data types."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

BASE = "https://in.bookmyshow.com"

# How coarse an alert should be. Determines the dedupe key, i.e. how many
# distinct alerts a single watch can ever produce.
GRANULARITIES = ("movie", "venue", "format", "show")


@dataclass(frozen=True)
class Show:
    """One bookable screening, normalised out of the BMS page payload."""

    event_code: str
    movie: str
    region: str
    venue_code: str
    venue: str
    date: str  # YYYYMMDD
    time: str  # "10:45 PM"
    time_code: str  # "2245"
    session_id: str
    language: str  # "Hindi"
    dimension: str  # "2D" / "3D" / "IMAX 2D"
    screen_attr: str  # "IMAX" / "INSIGNIA" / "" ...
    format_raw: str  # "Hindi • 2D | IMAX"
    avail_status: str

    @property
    def format_label(self) -> str:
        """Human label used in messages, e.g. '2D IMAX' or '3D'."""
        bits = [b for b in (self.dimension, self.screen_attr) if b]
        return " ".join(bits) or "Standard"

    @property
    def format_haystack(self) -> str:
        """Everything a user's format filter might reasonably match against.

        Includes the screen name and raw string so 'IMAX' matches whether BMS
        exposed it as a dimension ('IMAX 2D'), an attribute ('IMAX'), or only
        inside the combined format string.
        """
        return " | ".join(
            b for b in (self.format_raw, self.dimension, self.screen_attr, self.language) if b
        ).lower()

    @property
    def booking_url(self) -> str:
        slug = slugify(self.movie) or "movie"
        return f"{BASE}/movies/{self.region}/{slug}/buytickets/{self.event_code}/{self.date}"

    @property
    def pretty_date(self) -> str:
        d = self.date
        if len(d) == 8:
            return f"{d[6:8]}-{d[4:6]}-{d[0:4]}"
        return d

    def key(self, granularity: str) -> str:
        """Dedupe key. Coarser granularity => fewer, broader alerts."""
        if granularity == "movie":
            return f"{self.event_code}|{self.region}"
        if granularity == "venue":
            return f"{self.event_code}|{self.region}|{self.venue_code}"
        if granularity == "format":
            return f"{self.event_code}|{self.region}|{self.venue_code}|{self.format_label}"
        if granularity == "show":
            return (
                f"{self.event_code}|{self.region}|{self.venue_code}|"
                f"{self.date}|{self.time_code}|{self.format_label}"
            )
        raise ValueError(f"unknown granularity: {granularity!r} (expected one of {GRANULARITIES})")

    def to_dict(self) -> dict:
        d = asdict(self)
        d["format_label"] = self.format_label
        d["booking_url"] = self.booking_url
        return d


@dataclass
class Watch:
    """One user-declared thing to keep an eye on.

    Normally sourced from a GitHub issue created via the issue form, in which
    case `issue_number` is set and alerts are posted back to that thread.
    """

    name: str
    event_code: str
    region: str
    formats: list[str] = field(default_factory=list)
    venues: list[str] = field(default_factory=list)
    languages: list[str] = field(default_factory=list)
    dates: list[str] = field(default_factory=list)
    days_ahead: int = 3
    alert_on: str = "show"
    enabled: bool = True
    issue_number: int | None = None

    @property
    def slug(self) -> str:
        """Stable identifier used to namespace this watch's saved state."""
        if self.issue_number is not None:
            return f"issue-{self.issue_number}"
        return slugify(self.name) or "unnamed"

    def describe(self) -> str:
        """One-line summary of the filters, for confirmation comments."""
        bits = [f"movie `{self.event_code}`", f"city `{self.region}`"]
        bits.append("formats: " + (", ".join(self.formats) if self.formats else "any"))
        bits.append("cinemas: " + (", ".join(self.venues) if self.venues else "any"))
        if self.languages:
            bits.append("languages: " + ", ".join(self.languages))
        bits.append(
            "dates: " + (", ".join(self.dates) if self.dates else f"next {self.days_ahead} day(s)")
        )
        bits.append(f"alert granularity: {self.alert_on}")
        return " · ".join(bits)

    @classmethod
    def from_dict(cls, raw: dict) -> Watch:
        missing = [k for k in ("name", "event_code", "region") if not raw.get(k)]
        if missing:
            raise ValueError(
                f"watch entry is missing required field(s): {', '.join(missing)} -> {raw}"
            )

        alert_on = raw.get("alert_on", "show")
        if alert_on not in GRANULARITIES:
            raise ValueError(
                f"watch {raw['name']!r}: alert_on={alert_on!r} is invalid, "
                f"expected one of {GRANULARITIES}"
            )

        days_ahead = int(raw.get("days_ahead", 3))
        if days_ahead < 1:
            raise ValueError(f"watch {raw['name']!r}: days_ahead must be >= 1")

        return cls(
            name=raw["name"],
            event_code=raw["event_code"].strip(),
            region=raw["region"].strip().lower(),
            formats=[str(f) for f in raw.get("formats", [])],
            venues=[str(v) for v in raw.get("venues", [])],
            languages=[str(x) for x in raw.get("languages", [])],
            dates=[str(d) for d in raw.get("dates", [])],
            days_ahead=days_ahead,
            alert_on=alert_on,
            enabled=bool(raw.get("enabled", True)),
            issue_number=raw.get("issue_number"),
        )


def slugify(text: str) -> str:
    out: list[str] = []
    prev_dash = False
    for ch in text.lower():
        if ch.isalnum():
            out.append(ch)
            prev_dash = False
        elif not prev_dash:
            out.append("-")
            prev_dash = True
    return "".join(out).strip("-")
