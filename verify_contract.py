"""Round-trip check: JS-generated issue bodies must parse in Python.

The web UI and the GitHub issue form both produce issue bodies; issueform.py
consumes them. That's a contract across three files in two languages with no
compiler to catch a drift. This executes the real JavaScript (via macOS's
built-in JavaScriptCore) and feeds its output to the real Python parser.

Run:  .venv/bin/python verify_contract.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import yaml

from bmswatch.issueform import ALERT_ON, DAYS_AHEAD, FIELDS, watch_from_issue

ROOT = Path(__file__).resolve().parent
JS_MODULE = ROOT / "docs" / "issue-body.js"
TEMPLATE = ROOT / ".github" / "ISSUE_TEMPLATE" / "watch.yml"

# Watches the UI might plausibly produce, including awkward edges.
CASES = [
    {
        "name": "everything filled",
        "watch": {
            "url": "https://in.bookmyshow.com/movies/bengaluru/avatar-fire-and-ash/ET00369074",
            "city": "",
            "formats": ["IMAX", "PXL"],
            "formatsOther": "EPIQ, Superplex",
            "venues": "PVR IMAX Orion\nINOX Garuda",
            "languages": "English, Hindi",
            "days": "7 days",
            "dates": "",
            "alert": "Once per cinema and format",
        },
        "expect": {
            "event_code": "ET00369074",
            "region": "bengaluru",
            "alert_on": "format",
            "days_ahead": 7,
            "formats": ["IMAX", "PXL", "EPIQ", "Superplex"],
            "venues": ["PVR IMAX Orion", "INOX Garuda"],
            "languages": ["English", "Hindi"],
            "dates": [],
        },
    },
    {
        "name": "bare minimum, nothing ticked",
        "watch": {
            "url": "https://in.bookmyshow.com/movies/mumbai/mirzapur/ET00417686",
            "city": "",
            "formats": [],
            "formatsOther": "",
            "venues": "",
            "languages": "",
            "days": "1 day (today only)",
            "dates": "",
            "alert": "Once — just tell me when booking opens",
        },
        "expect": {
            "event_code": "ET00417686",
            "region": "mumbai",
            "alert_on": "movie",  # the em-dash option must survive the round trip
            "days_ahead": 1,
            "formats": [],
            "venues": [],
            "languages": [],
            "dates": [],
        },
    },
    {
        "name": "city override wins over the link",
        "watch": {
            "url": "https://in.bookmyshow.com/movies/mumbai/mirzapur/ET00417686",
            "city": "national-capital-region-ncr",
            "formats": ["4DX"],
            "formatsOther": "",
            "venues": "",
            "languages": "",
            "days": "3 days",
            "dates": "",
            "alert": "Once per cinema",
        },
        "expect": {
            "event_code": "ET00417686",
            "region": "national-capital-region-ncr",
            "alert_on": "venue",
            "days_ahead": 3,
            "formats": ["4DX"],
        },
    },
    {
        "name": "explicit dates normalise to YYYYMMDD",
        "watch": {
            "url": "https://in.bookmyshow.com/movies/hyderabad/x/ET00123456",
            "city": "",
            "formats": ["IMAX 3D"],
            "formatsOther": "",
            "venues": "Prasads",
            "languages": "Telugu",
            "days": "14 days",
            "dates": "2026-09-18, 2026-09-19",
            "alert": "Every single new showtime",
        },
        "expect": {
            "event_code": "ET00123456",
            "region": "hyderabad",
            "alert_on": "show",
            "dates": ["20260918", "20260919"],
            "formats": ["IMAX 3D"],
            "venues": ["Prasads"],
            "languages": ["Telugu"],
        },
    },
]

JS_DRIVER = """
%(module)s

var cases = %(cases)s;
var out = cases.map(function (c) { return toIssueBody(c); });
JSON.stringify(out);
"""


def run_js(watches: list[dict]) -> list[str]:
    """Execute the real docs/issue-body.js and return the bodies it builds."""
    src = JS_MODULE.read_text()
    # osascript's JS host has no ES module loader, so strip the export keywords.
    src = src.replace("export function", "function").replace("export const", "const")

    script = JS_DRIVER % {"module": src, "cases": json.dumps(watches)}
    proc = subprocess.run(
        ["osascript", "-l", "JavaScript", "-e", script],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise SystemExit(f"JavaScript failed:\n{proc.stderr}")
    return json.loads(proc.stdout.strip())


def check_template_sync() -> list[str]:
    """The three sources of truth must agree on every label and option string."""
    problems: list[str] = []
    form = yaml.safe_load(TEMPLATE.read_text())
    body = form["body"]

    form_labels = {b["attributes"]["label"] for b in body if b.get("type") != "markdown"}
    if form_labels != set(FIELDS):
        problems.append(
            f"label mismatch:\n  only in form:   {form_labels - set(FIELDS)}\n"
            f"  only in parser: {set(FIELDS) - form_labels}"
        )

    js = JS_MODULE.read_text()
    for label in FIELDS:
        if label not in js:
            problems.append(f"label missing from issue-body.js: {label!r}")

    for b in body:
        if b.get("id") == "alert_on":
            for opt in b["attributes"]["options"]:
                if opt not in ALERT_ON:
                    problems.append(f"form alert option not mapped in Python: {opt!r}")
                if opt not in js:
                    problems.append(f"form alert option missing from JS: {opt!r}")
        if b.get("id") == "days_ahead":
            for opt in b["attributes"]["options"]:
                if opt not in DAYS_AHEAD:
                    problems.append(f"form day option not mapped in Python: {opt!r}")
                if opt not in js:
                    problems.append(f"form day option missing from JS: {opt!r}")
        if b.get("id") == "formats":
            for opt in b["attributes"]["options"]:
                if opt["label"] not in js:
                    problems.append(f"form format missing from JS: {opt['label']!r}")

    return problems


def main() -> int:
    failures = 0

    print("=" * 72)
    print("1. label/option sync across form, Python parser, and JS")
    print("=" * 72)
    problems = check_template_sync()
    if problems:
        failures += len(problems)
        for p in problems:
            print("  FAIL " + p)
    else:
        print("  OK — all labels and options agree across all three files")

    print()
    print("=" * 72)
    print("2. JS builds a body -> Python parses it -> values match")
    print("=" * 72)

    bodies = run_js([c["watch"] for c in CASES])

    for case, body in zip(CASES, bodies):
        print(f"\n  [{case['name']}]")
        try:
            w = watch_from_issue(body, issue_number=1, title="[watch] generated by UI")
        except Exception as e:  # noqa: BLE001
            print(f"    FAIL parser rejected the JS output: {type(e).__name__}: {e}")
            print("    ---- body ----")
            print("    " + body.replace("\n", "\n    ")[:600])
            failures += 1
            continue

        for field, expected in case["expect"].items():
            actual = getattr(w, field)
            if actual == expected:
                print(f"    ok   {field} = {actual!r}")
            else:
                print(f"    FAIL {field}: expected {expected!r}, got {actual!r}")
                failures += 1

    print()
    print("=" * 72)
    if failures:
        print(f"RESULT: {failures} failure(s)")
    else:
        print("RESULT: contract verified — the UI and the parser agree")
    print("=" * 72)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
