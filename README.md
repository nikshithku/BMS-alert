# bms-watch

Get alerted when a movie opens for booking in the cinema and format you actually want — IMAX, 4DX, PXL, LUXE, Atmos — instead of finding out after the good seats have gone.

Runs entirely on GitHub, costs nothing, and needs no server.

BookMyShow's own "Notify Me" fires when booking opens *in general*. It can't tell you "IMAX at *this* cinema". That's the gap this fills.

## How you use it

**The dashboard:** [nikshithku.github.io/BMS-alert](https://nikshithku.github.io/BMS-alert)

Add a watch, see what's being tracked, and stop watches — all from the web UI. It talks to the GitHub API directly from your browser, so there's no server anywhere.

**Or open an issue.** The Issues tab → New issue → **🎬 Watch a show** does exactly the same thing. Both write the same format, so watches created either way show up in both places. A bot replies within a minute confirming exactly what it understood.

From then on, every 15 minutes it checks BookMyShow and comments on your issue the moment something matching appears. Since GitHub already emails and push-notifies you about your own issues, that's a working alert channel with zero setup.

- **Change the filters** → edit the issue, it re-validates automatically.
- **Stop the alerts** → close the issue.

An open issue *is* an active watch. There's no config file to keep in sync.

## Setup

1. Push these files to the repo.
2. **Actions** tab → enable workflows if prompted.
3. **Settings → Pages → Source: GitHub Actions.** That publishes the dashboard.
4. **Actions → Check watches → Run workflow → mode `seed`.**

Step 4 matters. Seeding records everything currently listed *without* alerting, so your first real run doesn't dump hundreds of already-available showtimes on you.

`GITHUB_TOKEN` is provided to the workflows automatically, so the alerting side needs no secrets.

### Token for the dashboard

Reading the dashboard needs nothing. **Creating and stopping watches from the web UI** needs a token, because a static page can't hold a secret of its own:

1. [Create a fine-grained token](https://github.com/settings/personal-access-tokens/new).
2. Repository access → only this repo.
3. Permissions → Repository → **Issues: Read and write**. Add **Actions: Read and write** if you want the "Check now" button.
4. Set an expiry, generate, then paste it into the dashboard's Settings panel.

The token is kept in that browser's local storage and sent only to `api.github.com`. It's never committed. Anyone with access to your browser profile can read it, which is why it should be scoped to this one repo with an expiry. If you'd rather not hold a token at all, use the Issues tab instead — that route needs nothing.

### Optional: Telegram

Issue comments are reliable but arrive at email speed. If you're racing a queue for a big release, add Telegram for near-instant alerts.

Message [@BotFather](https://t.me/BotFather), run `/newbot`, copy the token. Send your bot a message, then open:

```
https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
```

Your chat ID is at `result[0].message.chat.id`. Add both as repo secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `TELEGRAM_TOKEN` | the BotFather token |
| `TELEGRAM_CHAT_ID` | the chat ID |

Alerts then go to both channels. Leave them unset and only issue comments happen.

## The setting that matters most

**How often should it alert?** controls how chatty a watch is, by deciding what counts as a duplicate.

| Option | Alerts once per | Pick it when |
|---|---|---|
| Once, when booking opens | movie + city | you just want the starting gun |
| Once per cinema | + cinema | you care where, not when |
| Once per cinema and format | + format | "tell me when IMAX appears" — good default |
| Every single new showtime | + date + time | you want every slot, most chatty |

Popular films list 700+ showtimes a day in a big city, so "every single new showtime" with no format filter is genuinely a lot of notifications. Start coarse.

## Matching rules

Filters are case-insensitive text matches, and **all of them must pass**. Leaving a filter empty means "no constraint".

- **Formats** match against the format, screen name, and dimension together, so ticking `IMAX` catches both `IMAX 2D` and a screen attributed as `IMAX`.
- **Cinemas** accept partial names — `Orion` matches "PVR: Orion Mall, Rajajinagar" — or an exact 4-letter BookMyShow venue code.
- Short filters like `ICE` are matched as whole words, so they don't false-positive on `RECLINER`.

## Running locally

The poller can run against a JSON file instead of GitHub issues, which is how you test without touching the repo:

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# preview against watchlist.json, sending and saving nothing
.venv/bin/python -m bmswatch.cli check --watchlist watchlist.json --dry-run
```

`watchlist.json` in this repo exists only for that purpose. The real watches live in issues.

## Why the repo is public, and why that's safe

Two things force it. [Pages only works from public repos on the Free plan](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site), and [public repos get unlimited Actions minutes while private ones on Free get 2,000/month](https://github.com/orgs/community/discussions/184661). A 15-minute cron is ~2,880 runs a month, each billed as at least a whole minute, so a private repo would exhaust its quota partway through the first month.

Being public means **anyone can open an issue here**. Left unchecked that would let a stranger create watches, spend the owner's Actions minutes, and push alerts into the owner's Telegram. So watches are only honoured when the issue author is the repo owner. The check exists in two independent places:

- `validate-watch.yml` won't even start a job for a non-owner issue.
- `watches_from_issues()` in `cli.py` re-checks, so the rule survives someone loosening the workflow condition later.

Your Telegram credentials live in Actions secrets, not in the repo, and are not exposed by making it public.

What *is* public: your watch issues and `state.json`, which reveal which films you follow and at which cinemas. Harmless for most people, but it does hint at your city and viewing habits.

## Things worth knowing

**Cloudflare blocks ordinary HTTP clients.** BookMyShow fingerprints the TLS handshake, so `requests`, `httpx` and plain `curl` get a 403 on *every* path, including `robots.txt`. That's why this depends on `curl_cffi`, which replays a genuine Chrome handshake. It's pinned in `requirements.txt`, because an unexpected upgrade could break the one thing holding this together.

**Datacenter IPs are the real deployment risk.** Actions runners come from Azure ranges that get flagged harder than a home connection. This is the one thing that couldn't be verified before deploying — you'll find out on your first run. If it does get blocked, the watcher says so loudly on your issue rather than quietly reporting "nothing found", and it refuses to save state so nothing is wrongly marked as already-seen. Fallbacks are a Raspberry Pi, a cheap VPS, or any always-on box at home.

**BookMyShow lies about dates.** Request a date with no listings and it serves *today's* showtimes while still echoing your requested date back in `currentDateCode`. Trusting that field would make every future date look like booking just opened. The parser filters on each showtime's own `showDateCode` and discards mismatches. If you refactor `parse.py`, keep that guard — it's load-bearing, not defensive.

**Actions cron is not punctual.** Five minutes is the documented floor, but scheduled runs get delayed under load, sometimes 10–20 minutes. For beating a crowd to FDFS tickets that lag is real, and a tighter cron buys less than it appears to.

**Scheduled workflows get disabled after 60 days of repo inactivity.** The bot's own state commits count as activity, so this mostly takes care of itself.

**Poll politely.** Each watch costs one page fetch per date in its window, and requests are spaced with jitter. Please don't crank the cron to every minute across dozens of films — that's how you get IP-banned and how this stops being a reasonable personal-use tool. Scraping cuts against BookMyShow's terms even where the data is public, so keep it at personal scale.

## The three-way contract

A watch is a GitHub issue whose body follows the shape GitHub's issue forms
produce. Three files in two languages have to agree on every field label and
dropdown string:

| File | Role |
|---|---|
| `.github/ISSUE_TEMPLATE/watch.yml` | the form GitHub renders |
| `bmswatch/issueform.py` | reads bodies back into a `Watch` |
| `docs/issue-body.js` | the dashboard writes and reads the same shape |

Nothing catches a drift between them at compile time, so `verify_contract.py`
does it instead: it executes the real JavaScript, feeds the output to the real
Python parser, and asserts the values survive the trip.

```bash
.venv/bin/pip install pyyaml
.venv/bin/python verify_contract.py
```

Run it after touching any of those three files. The em dash in
"Once — just tell me when booking opens" is a real tripwire; swapping it for a
hyphen silently changes the alert granularity.

## Layout

```
docs/                          the dashboard (GitHub Pages)
  index.html
  styles.css
  app.js                       UI, GitHub API calls
  issue-body.js                the shared body format
.github/
  ISSUE_TEMPLATE/watch.yml     the form users fill in
  workflows/validate-watch.yml on issue open/edit -> confirm or explain
  workflows/watch.yml          cron -> check everything, alert, commit state
  workflows/pages.yml          publish docs/ to Pages
bmswatch/
  fetch.py       Chrome TLS impersonation, block detection
  parse.py       __INITIAL_STATE__ extraction, date-fallback guard
  issueform.py   issue body -> Watch
  github.py      issues API: list, comment, label
  match.py       filters, date windows, dedupe granularity
  store.py       state.json, namespaced per watch
  notify.py      issue-comment and Telegram formatting
  models.py      Show and Watch types
  cli.py         check / validate subcommands
```

State lives in `state.json`, committed back by the workflow. That gives free persistence plus a git history of when each show first appeared.
