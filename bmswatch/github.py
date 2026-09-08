"""Minimal GitHub REST client.

Uses stdlib urllib rather than a HTTP library: the only other dependency here
is curl_cffi, which exists purely for TLS impersonation against Cloudflare and
would be a confusing thing to point at api.github.com.

Inside Actions, GITHUB_TOKEN and GITHUB_REPOSITORY are injected automatically,
so nothing needs configuring for the issue-driven flow to work.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request

log = logging.getLogger(__name__)

API = "https://api.github.com"
WATCH_LABEL = "watch"
INVALID_LABEL = "watch:invalid"
ACTIVE_LABEL = "watch:active"


class GitHubError(RuntimeError):
    pass


class GitHub:
    def __init__(self, token: str | None = None, repo: str | None = None):
        self.token = token or os.environ.get("GITHUB_TOKEN", "")
        self.repo = repo or os.environ.get("GITHUB_REPOSITORY", "")

    @property
    def configured(self) -> bool:
        return bool(self.token and self.repo)

    @property
    def owner(self) -> str:
        """The account that owns the repo, i.e. the only trusted issue author."""
        return self.repo.split("/", 1)[0] if self.repo else ""

    def _require(self) -> None:
        if not self.configured:
            raise GitHubError(
                "GITHUB_TOKEN and GITHUB_REPOSITORY must be set. Inside GitHub "
                "Actions both are provided automatically; locally, export them "
                "or use --watchlist to read watches from a file instead."
            )

    def _call(self, method: str, path: str, body: dict | None = None) -> object:
        self._require()
        url = path if path.startswith("http") else f"{API}{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("X-GitHub-Api-Version", "2022-11-28")
        req.add_header("User-Agent", "bms-watch")
        if data is not None:
            req.add_header("Content-Type", "application/json")

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
                link = resp.headers.get("Link", "")
                parsed = json.loads(raw) if raw else None
                return (parsed, link) if method == "GET" else parsed
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:400]
            raise GitHubError(f"{method} {url} -> HTTP {e.code}: {detail}") from None
        except urllib.error.URLError as e:
            raise GitHubError(f"{method} {url} failed: {e.reason}") from None

    def open_watch_issues(self, label: str = WATCH_LABEL) -> list[dict]:
        """Every open issue carrying the watch label, following pagination."""
        issues: list[dict] = []
        path = (
            f"/repos/{self.repo}/issues"
            f"?state=open&labels={urllib.parse.quote(label)}&per_page=100"
        )
        while path:
            payload, link = self._call("GET", path)  # type: ignore[misc]
            if not isinstance(payload, list):
                raise GitHubError(f"unexpected issues payload: {type(payload).__name__}")
            # Pull requests also appear on the issues endpoint; skip them.
            issues.extend(i for i in payload if "pull_request" not in i)
            path = _next_link(link)
        return issues

    def get_issue(self, number: int) -> dict:
        payload, _ = self._call("GET", f"/repos/{self.repo}/issues/{number}")  # type: ignore[misc]
        if not isinstance(payload, dict):
            raise GitHubError("unexpected issue payload")
        return payload

    def comment(self, number: int, body: str) -> None:
        self._call("POST", f"/repos/{self.repo}/issues/{number}/comments", {"body": body})

    def add_labels(self, number: int, labels: list[str]) -> None:
        if labels:
            self._call("POST", f"/repos/{self.repo}/issues/{number}/labels", {"labels": labels})

    def remove_label(self, number: int, label: str) -> None:
        try:
            self._call(
                "DELETE",
                f"/repos/{self.repo}/issues/{number}/labels/{urllib.parse.quote(label)}",
            )
        except GitHubError as e:
            # Removing a label that isn't there is not an error worth failing on.
            if "404" not in str(e):
                raise


def _next_link(link_header: str) -> str | None:
    """Extract rel="next" from a Link header."""
    for part in (link_header or "").split(","):
        if 'rel="next"' in part:
            start = part.find("<")
            end = part.find(">")
            if start != -1 and end != -1:
                return part[start + 1 : end]
    return None
