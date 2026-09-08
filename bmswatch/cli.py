"""Entry point.

Two subcommands:

  validate  one issue -> parse, confirm or explain, label accordingly
  check     every open watch issue -> poll BMS, alert on anything new
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import NamedTuple

from . import notify
from .fetch import FetchBlocked, FetchFailed, get, polite_pause, showtimes_url
from .github import ACTIVE_LABEL, INVALID_LABEL, GitHub, GitHubError
from .issueform import IssueFormError, watch_from_issue
from .match import filter_shows, new_shows, target_dates
from .models import Show, Watch
from .parse import ParseError, parse_shows
from .store import Store

log = logging.getLogger("bmswatch")

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_STATE = ROOT / "state.json"


# --------------------------------------------------------------------------- #
# loading watches
# --------------------------------------------------------------------------- #


def watches_from_issues(gh: GitHub) -> list[Watch]:
    """Every open, valid watch issue authored by the repo owner.

    The owner check is a security boundary, not tidiness. The repo has to be
    public for free Pages and unlimited Actions minutes, which means anyone can
    open an issue on it. Honouring a stranger's issue would let them spend the
    owner's Actions minutes and push alerts into the owner's Telegram.
    """
    owner = gh.owner
    watches: list[Watch] = []
    for issue in gh.open_watch_issues():
        number = issue["number"]

        author = ((issue.get("user") or {}).get("login") or "").lower()
        if not owner or author != owner.lower():
            log.warning("ignoring issue #%s from untrusted author %r", number, author or "unknown")
            continue

        labels = {lbl["name"] for lbl in issue.get("labels") or []}
        if INVALID_LABEL in labels:
            log.info("issue #%s is marked invalid; skipping", number)
            continue
        try:
            watches.append(
                watch_from_issue(issue.get("body") or "", number, issue.get("title") or "")
            )
        except IssueFormError as e:
            # Don't let one malformed issue stop the whole run.
            log.warning("issue #%s is not a usable watch: %s", number, e)
    return watches


def watches_from_file(path: Path) -> list[Watch]:
    """Local escape hatch so the poller can be exercised without GitHub."""
    try:
        raw = json.loads(path.read_text())
    except FileNotFoundError:
        raise SystemExit(f"watchlist not found: {path}") from None
    except json.JSONDecodeError as e:
        raise SystemExit(f"{path} is not valid JSON: {e}") from None
    if not isinstance(raw, list):
        raise SystemExit(f"{path} must be a JSON array of watch objects")
    try:
        return [w for w in (Watch.from_dict(i) for i in raw) if w.enabled]
    except (ValueError, TypeError, AttributeError) as e:
        raise SystemExit(f"invalid watchlist {path}: {e}") from None


# --------------------------------------------------------------------------- #
# validate
# --------------------------------------------------------------------------- #


def cmd_validate(args: argparse.Namespace) -> int:
    gh = GitHub()
    number = args.issue

    try:
        issue = gh.get_issue(number)
    except GitHubError as e:
        log.error("%s", e)
        return 1

    # Same boundary as watches_from_issues: on a public repo anyone can open an
    # issue, and this command comments and labels with a write-scoped token.
    author = ((issue.get("user") or {}).get("login") or "").lower()
    if not gh.owner or author != gh.owner.lower():
        log.warning(
            "issue #%s was opened by %r, not the repo owner %r; ignoring",
            number,
            author or "unknown",
            gh.owner,
        )
        return 0

    try:
        watch = watch_from_issue(issue.get("body") or "", number, issue.get("title") or "")
    except IssueFormError as e:
        log.warning("issue #%s invalid: %s", number, e)
        gh.comment(number, notify.markdown_invalid(str(e)))
        gh.add_labels(number, [INVALID_LABEL])
        gh.remove_label(number, ACTIVE_LABEL)
        return 0  # a bad form is user error, not a workflow failure

    # Confirm the movie really resolves, so typos surface now rather than as
    # silence later.
    movie_hint = ""
    dates = target_dates(watch)
    if dates:
        try:
            html_text = get(showtimes_url(watch.region, watch.event_code, dates[0]))
            shows = parse_shows(html_text, region=watch.region, expected_date=dates[0])
            if shows:
                movie_hint = shows[0].movie
        except (FetchBlocked, FetchFailed, ParseError) as e:
            log.warning("could not pre-check %s: %s", watch.event_code, e)

    gh.comment(number, notify.markdown_confirmation(watch, movie_hint))
    gh.remove_label(number, INVALID_LABEL)
    gh.add_labels(number, [ACTIVE_LABEL])
    log.info("issue #%s validated: %s", number, watch.describe())
    return 0


# --------------------------------------------------------------------------- #
# check
# --------------------------------------------------------------------------- #


class CollectResult(NamedTuple):
    shows: list[Show]  # matching this watch's filters
    movie: str
    listed: int  # total listed across dates, before filtering
    problems: list[str]


def collect(watch: Watch) -> CollectResult:
    """Poll every target date for one watch.

    Raises FetchBlocked, which must abort the whole run rather than be
    swallowed: a block means we saw nothing, not that nothing is listed.
    """
    matching: list[Show] = []
    problems: list[str] = []
    movie = ""
    listed_total = 0

    for i, date in enumerate(target_dates(watch)):
        if i:
            polite_pause()
        url = showtimes_url(watch.region, watch.event_code, date)
        try:
            html_text = get(url)
        except FetchFailed as e:
            problems.append(f"{date}: {e}")
            continue

        try:
            shows = parse_shows(html_text, region=watch.region, expected_date=date)
        except ParseError as e:
            problems.append(f"{date}: {e}")
            continue

        if shows and not movie:
            movie = shows[0].movie
        listed_total += len(shows)
        hits = filter_shows(shows, watch)
        log.info(
            "%s | %s | %s: %d listed, %d matching", watch.name, watch.region, date, len(shows), len(hits)
        )
        matching.extend(hits)

    return CollectResult(matching, movie, listed_total, problems)


def cmd_check(args: argparse.Namespace) -> int:
    gh = GitHub()

    if args.watchlist:
        watches = watches_from_file(Path(args.watchlist))
        source = str(args.watchlist)
    else:
        try:
            watches = watches_from_issues(gh)
        except GitHubError as e:
            raise SystemExit(str(e)) from None
        source = "open issues"

    log.info("loaded %d watch(es) from %s", len(watches), source)
    if not watches:
        log.info("nothing to check")
        return 0

    try:
        store = Store(Path(args.state))
    except RuntimeError as e:
        raise SystemExit(str(e)) from None

    seeding = args.seed or (not store.existed and not args.alert_on_first_run)
    if seeding:
        log.warning("seeding a baseline: recording what's listed now WITHOUT alerting")

    telegram = notify.Telegram()
    if telegram.configured:
        log.info("Telegram is configured; alerts go to both the issue and Telegram")

    total_new = 0
    problems: list[str] = []

    for watch in watches:
        try:
            result = collect(watch)
        except FetchBlocked as e:
            # The run saw nothing, so saving state would wrongly mark shows seen.
            log.error("blocked: %s", e)
            if not args.dry_run and watch.issue_number and gh.configured:
                try:
                    gh.comment(watch.issue_number, notify.markdown_blocked(str(e)))
                except GitHubError as ce:
                    log.error("could not post block notice: %s", ce)
            if not args.dry_run:
                telegram.send(f"🚧 <b>bms-watch blocked</b>\n\n{e}")
            return 2

        problems += [f"{watch.name} {p}" for p in result.problems]
        store.note_run(
            watch.slug, listed=result.listed, matched=len(result.shows), movie=result.movie
        )

        seen = store.seen_keys(watch.slug)
        fresh, _keys_now = new_shows(result.shows, watch, seen)

        if not fresh:
            log.info("%s: nothing new", watch.name)
            continue

        total_new += len(fresh)

        if seeding:
            for s in fresh:
                store.remember(watch.slug, s.key(watch.alert_on), s)
            log.info("%s: seeded %d key(s)", watch.name, len(fresh))
            continue

        if args.dry_run:
            print("\n" + "=" * 68)
            print(f"[DRY RUN] {watch.name}: {len(fresh)} new")
            print("=" * 68)
            print(notify.markdown_alert(watch.name, fresh, watch.alert_on))
            continue

        # Issue comment first: it's the channel that needs no secrets, so if
        # anything fails afterwards there's still a durable record.
        if watch.issue_number and gh.configured:
            try:
                gh.comment(
                    watch.issue_number, notify.markdown_alert(watch.name, fresh, watch.alert_on)
                )
            except GitHubError as e:
                problems.append(f"{watch.name}: could not comment on issue: {e}")

        telegram.send(notify.telegram_alert(watch.name, fresh, watch.alert_on))

        for s in fresh:
            store.remember(watch.slug, s.key(watch.alert_on), s)
        log.info("%s: alerted on %d new show(s)", watch.name, len(fresh))

    # Forget watches whose issues were closed, so state doesn't grow forever.
    if not args.watchlist:
        live = {w.slug for w in watches}
        for slug in store.active_slugs() - live:
            store.forget_watch(slug)

    store.prune_past()

    for p in problems:
        log.warning("problem: %s", p)

    if args.dry_run:
        log.info("dry run: state not saved (%d would-be new)", total_new)
    else:
        store.save()

    log.info("done: %d new show(s) across %d watch(es)", total_new, len(watches))
    return 0


# --------------------------------------------------------------------------- #


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="bmswatch",
        description="Alert when a movie, cinema or format opens for booking on BookMyShow.",
    )
    sub = p.add_subparsers(dest="command", required=True)

    c = sub.add_parser("check", help="poll BookMyShow for every active watch")
    c.add_argument("--state", default=str(DEFAULT_STATE))
    c.add_argument(
        "--watchlist",
        help="read watches from a JSON file instead of GitHub issues (for local testing)",
    )
    c.add_argument("--dry-run", action="store_true", help="print alerts, send nothing, save nothing")
    c.add_argument("--seed", action="store_true", help="record what's listed now without alerting")
    c.add_argument(
        "--alert-on-first-run",
        action="store_true",
        help="alert for everything on a fresh state file instead of seeding",
    )
    c.set_defaults(func=cmd_check)

    v = sub.add_parser("validate", help="validate one watch issue and reply to it")
    v.add_argument("--issue", type=int, required=True)
    v.set_defaults(func=cmd_validate)

    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
