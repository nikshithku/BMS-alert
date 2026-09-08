/* ==========================================================================
   BMS Alert — front-end
   No build step, no framework: served straight from GitHub Pages.

   Watches are GitHub issues. The body format is the contract shared with
   GitHub's issue form and the Python parser; it lives in issue-body.js so it
   can be verified outside a browser.
   ========================================================================== */

import { CONTRACT, fromIssueBody, parseLink, toIssueBody } from "./issue-body.js";

const ALERT_HELP = {
  "Once — just tell me when booking opens": "One message when tickets first appear anywhere.",
  "Once per cinema": "One message per cinema that lists it.",
  "Once per cinema and format": "One per cinema and format — good default.",
  "Every single new showtime": "Every new slot. Chatty on popular films.",
};

const ALERT_SHORT = {
  "Once — just tell me when booking opens": "once",
  "Once per cinema": "per cinema",
  "Once per cinema and format": "per format",
  "Every single new showtime": "every show",
};

/* --- tiny helpers --------------------------------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const el = (tag, props = {}, kids = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) {
    if (k != null) node.append(k);
  }
  return node;
};

const csv = (s) =>
  (s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const lines = (s) =>
  (s || "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

function relativeTime(iso) {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/* --- config -------------------------------------------------------------- */

const STORE_KEY = "bms-alert:config";

const config = {
  owner: "",
  repo: "",
  token: "",
  branch: "main",

  load() {
    try {
      Object.assign(this, JSON.parse(localStorage.getItem(STORE_KEY) || "{}"));
    } catch {
      /* corrupt entry: fall through to defaults */
    }
    // Infer from the Pages URL so a fresh visit is already pointed at the repo.
    if (!this.owner || !this.repo) {
      const host = location.hostname.match(/^([^.]+)\.github\.io$/i);
      const seg = location.pathname.split("/").filter(Boolean);
      if (host) {
        this.owner ||= host[1];
        this.repo ||= seg[0] || `${host[1]}.github.io`;
      }
    }
    return this;
  },

  save() {
    const { owner, repo, token, branch } = this;
    localStorage.setItem(STORE_KEY, JSON.stringify({ owner, repo, token, branch }));
  },

  get slug() {
    return this.owner && this.repo ? `${this.owner}/${this.repo}` : "";
  },

  get ready() {
    return Boolean(this.slug);
  },

  get canWrite() {
    return Boolean(this.slug && this.token);
  },
};

/* --- GitHub API ---------------------------------------------------------- */

const api = {
  async call(path, { method = "GET", body, auth = true } = {}) {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (auth && config.token) headers.Authorization = `Bearer ${config.token}`;
    if (body) headers["Content-Type"] = "application/json";

    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 204) return null;

    const text = await res.text();
    const data = text ? JSON.parse(text) : null;

    if (!res.ok) {
      // GitHub's own messages here are terse to the point of being unhelpful
      // ("Resource not accessible by personal access token" for a missing
      // permission), so translate the ones that actually happen.
      if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
        throw new Error("GitHub rate limit reached. Add a token in Settings, or wait an hour.");
      }
      if (res.status === 401) {
        throw new Error("Token rejected — it may be expired, revoked, or mistyped.");
      }
      if (res.status === 404) {
        throw new Error(
          `Can't see ${config.slug}. Either the name is wrong in Settings, or the token wasn't granted access to this repository.`
        );
      }
      if (res.status === 403 && /not accessible by personal access token/i.test(data?.message || "")) {
        const needed = path.includes("/actions/")
          ? "Actions: Read and write"
          : "Issues: Read and write";
        throw new Error(
          `Token is missing a permission. Edit it on GitHub and set ${needed}, and make sure ${config.repo} is listed under Repository access. Changes apply immediately, no new token needed.`
        );
      }
      throw new Error(data?.message || `GitHub returned ${res.status}`);
    }
    return data;
  },

  whoami() {
    return this.call("/user");
  },

  listWatches() {
    const q = new URLSearchParams({
      state: "open",
      labels: CONTRACT.watchLabel,
      per_page: "100",
      sort: "created",
      direction: "desc",
    });
    return this.call(`/repos/${config.slug}/issues?${q}`);
  },

  createWatch(title, body) {
    return this.call(`/repos/${config.slug}/issues`, {
      method: "POST",
      body: { title, body, labels: [CONTRACT.watchLabel] },
    });
  },

  updateWatch(number, title, body) {
    return this.call(`/repos/${config.slug}/issues/${number}`, {
      method: "PATCH",
      body: { title, body },
    });
  },

  closeWatch(number) {
    return this.call(`/repos/${config.slug}/issues/${number}`, {
      method: "PATCH",
      body: { state: "closed" },
    });
  },

  runCheck() {
    return this.call(`/repos/${config.slug}/actions/workflows/watch.yml/dispatches`, {
      method: "POST",
      body: { ref: config.branch },
    });
  },

  async state() {
    // Public raw file, so no token and no API quota consumed.
    const url = `https://raw.githubusercontent.com/${config.slug}/${config.branch}/state.json?t=${Date.now()}`;
    const res = await fetch(url);
    return res.ok ? res.json() : null;
  },
};

/* --- toasts -------------------------------------------------------------- */

function toast(kind, title, detail = "") {
  const glyph = { ok: "✓", err: "!", info: "i" }[kind] || "i";
  const node = el("div", { className: `toast toast--${kind}`, role: "alert" }, [
    el("span", { className: "toast__icon", textContent: glyph, ariaHidden: "true" }),
    el("div", { className: "toast__body" }, [
      el("strong", { textContent: title }),
      detail ? el("span", { textContent: detail }) : null,
    ]),
  ]);
  $("#toasts").append(node);
  setTimeout(() => {
    node.classList.add("toast--out");
    node.addEventListener("animationend", () => node.remove(), { once: true });
  }, kind === "err" ? 7000 : 4200);
}

/* --- dialogs ------------------------------------------------------------- */

let lastFocused = null;

function openModal(id) {
  lastFocused = document.activeElement;
  const dlg = $(id);
  dlg.showModal();
  // Focus the first real control rather than the close button.
  const target = $("input:not([type=hidden]), textarea, button.btn--primary", dlg);
  target?.focus({ preventScroll: true });
}

function closeModal(dlg) {
  dlg.close();
  lastFocused?.focus?.({ preventScroll: true });
}

$$("[data-close]").forEach((b) =>
  b.addEventListener("click", () => closeModal(b.closest("dialog")))
);

// Clicking the backdrop dismisses, but only when the press started outside.
$$("dialog.modal").forEach((dlg) => {
  dlg.addEventListener("pointerdown", (e) => {
    dlg._fromBackdrop = e.target === dlg;
  });
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg && dlg._fromBackdrop) closeModal(dlg);
  });
});

/* --- editor form building ------------------------------------------------ */

const state = { watches: [], editing: null, confirmFn: null };

function buildChips() {
  const box = $("#f-formats");
  box.replaceChildren(
    ...CONTRACT.formats.map((f) =>
      el("button", {
        type: "button",
        className: "chip",
        textContent: f,
        ariaPressed: "false",
        onclick(e) {
          const on = e.currentTarget.getAttribute("aria-pressed") === "true";
          e.currentTarget.setAttribute("aria-pressed", String(!on));
        },
      })
    )
  );
}

function buildSegment() {
  const box = $("#f-days");
  box.replaceChildren(
    ...CONTRACT.days.map((d, i) =>
      el("button", {
        type: "button",
        role: "radio",
        textContent: d.replace(" (today only)", ""),
        ariaChecked: String(i === 1),
        onclick(e) {
          $$("button", box).forEach((b) => b.setAttribute("aria-checked", "false"));
          e.currentTarget.setAttribute("aria-checked", "true");
        },
      })
    )
  );
  // Keep the full contract string available even though the label is shortened.
  $$("button", box).forEach((b, i) => (b.dataset.value = CONTRACT.days[i]));
}

function buildOptions() {
  const box = $("#f-alert");
  box.replaceChildren(
    ...CONTRACT.alerts.map((a, i) =>
      el(
        "button",
        {
          type: "button",
          role: "radio",
          className: "option",
          ariaChecked: String(i === 2),
          onclick(e) {
            $$(".option", box).forEach((b) => b.setAttribute("aria-checked", "false"));
            e.currentTarget.setAttribute("aria-checked", "true");
          },
        },
        [
          el("span", { className: "option__dot", ariaHidden: "true" }),
          el("span", { className: "option__text" }, [
            el("strong", { textContent: a.replace("Once — just tell me when booking opens", "Just once") }),
            el("span", { textContent: ALERT_HELP[a] || "" }),
          ]),
        ]
      )
    )
  );
  $$(".option", box).forEach((b, i) => (b.dataset.value = CONTRACT.alerts[i]));
}

function readForm() {
  return {
    url: $("#f-url").value.trim(),
    city: $("#f-city").value.trim().toLowerCase().replace(/\s+/g, "-"),
    formats: $$("#f-formats .chip[aria-pressed=true]").map((c) => c.textContent),
    formatsOther: $("#f-formats-other").value.trim(),
    venues: lines($("#f-venues").value).join("\n"),
    languages: csv($("#f-languages").value).join(", "),
    days: $("#f-days button[aria-checked=true]")?.dataset.value || CONTRACT.days[1],
    dates: csv($("#f-dates").value).join(", "),
    alert: $("#f-alert .option[aria-checked=true]")?.dataset.value || CONTRACT.alerts[2],
  };
}

function fillForm(w) {
  $("#f-url").value = w.url || "";
  $("#f-city").value = w.city || "";
  $("#f-formats-other").value = w.formatsOther || "";
  $("#f-venues").value = w.venues || "";
  $("#f-languages").value = w.languages || "";
  $("#f-dates").value = w.dates || "";

  $$("#f-formats .chip").forEach((c) =>
    c.setAttribute("aria-pressed", String((w.formats || []).includes(c.textContent)))
  );
  $$("#f-days button").forEach((b) =>
    b.setAttribute("aria-checked", String(b.dataset.value === w.days))
  );
  $$("#f-alert .option").forEach((b) =>
    b.setAttribute("aria-checked", String(b.dataset.value === w.alert))
  );
  showParsed();
}

function showParsed() {
  const box = $("#url-parsed");
  const raw = $("#f-url").value.trim();
  if (!raw) {
    box.dataset.state = "";
    box.replaceChildren();
    return;
  }
  const { region, eventCode } = parseLink(raw);
  const city = $("#f-city").value.trim().toLowerCase() || region;

  if (eventCode && city) {
    box.dataset.state = "ok";
    box.replaceChildren(
      el("span", { textContent: "✓ Reading" }),
      el("code", { textContent: eventCode }),
      el("span", { textContent: "in" }),
      el("code", { textContent: city })
    );
  } else {
    box.dataset.state = "bad";
    box.replaceChildren(
      el("span", {
        textContent: !eventCode
          ? "No movie code (ET…) in that link yet"
          : "No city in that link — fill in the City field",
      })
    );
  }
}

/* --- rendering ----------------------------------------------------------- */

function watchCard(issue, idx, stats) {
  const w = fromIssueBody(issue.body);
  const { eventCode } = parseLink(w.url);
  const city = w.city || parseLink(w.url).region || "—";
  const name = issue.title.replace(/^\s*\[watch\]\s*/i, "").trim() || `${eventCode} in ${city}`;

  const allFormats = [...w.formats, ...csv(w.formatsOther)];
  const bucket = stats?.watches?.[`issue-${issue.number}`];
  const invalid = (issue.labels || []).some((l) => (l.name || l) === CONTRACT.invalidLabel);

  const row = (key, value) =>
    el("div", { className: "card__row" }, [
      el("span", { className: "card__key", textContent: key }),
      el("span", { className: "card__val", textContent: value }),
    ]);

  return el("article", { className: "card", style: `--i:${idx}` }, [
    el("div", { className: "card__top" }, [
      el("div", {}, [
        el("h3", { className: "card__title", textContent: bucket?.movie || name }),
        el("p", {
          className: "card__sub",
          textContent: `${city} · ${eventCode || "no code"} · #${issue.number}`,
        }),
      ]),
      el("div", { className: "card__menu" }, [
        el(
          "button",
          {
            className: "icon-btn",
            title: "Edit watch",
            ariaLabel: `Edit ${name}`,
            onclick: () => startEdit(issue),
          },
          [iconSvg("M4 20h4l10-10-4-4L4 16v4Z")]
        ),
        el(
          "button",
          {
            className: "icon-btn",
            title: "Stop watching",
            ariaLabel: `Stop watching ${name}`,
            onclick: () => askStop(issue, name),
          },
          [iconSvg("M6 7h12M9 7V5h6v2M8 7l1 12h6l1-12")]
        ),
      ]),
    ]),

    el("div", { className: "tags" },
      allFormats.length
        ? allFormats.slice(0, 6).map((f) => el("span", { className: "tag", textContent: f }))
        : [el("span", { className: "tag tag--muted", textContent: "any format" })]
    ),

    el("div", {}, [
      row("Cinemas", lines(w.venues).join(", ") || "any"),
      w.languages ? row("Language", w.languages) : null,
      row("Window", w.dates || w.days),
      row("Alerts", ALERT_SHORT[w.alert] || w.alert),
    ]),

    el("div", { className: "card__foot" }, [
      invalid
        ? el("span", { className: "badge badge--warn" }, [
            el("span", { className: "badge__dot", ariaHidden: "true" }),
            "needs fixing",
          ])
        : el("span", { className: "badge badge--live" }, [
            el("span", { className: "badge__dot", ariaHidden: "true" }),
            "watching",
          ]),
      el("span", {
        textContent: bucket?.last_checked
          ? `checked ${relativeTime(bucket.last_checked)}`
          : "not checked yet",
      }),
    ]),
  ]);
}

function iconSvg(d) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", d);
  svg.append(p);
  return svg;
}

function countUp(node, to) {
  const from = Number(node.dataset.count || 0);
  node.dataset.count = String(to);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || from === to) {
    node.textContent = String(to);
    return;
  }
  const start = performance.now();
  const dur = 650;
  const tick = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = String(Math.round(from + (to - from) * eased));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function renderStats(stats) {
  const n = state.watches.length;
  countUp($("#stat-watches"), n);
  $("#stat-watches-foot").textContent =
    n === 0 ? "no watches yet" : n === 1 ? "1 movie tracked" : `${n} movies tracked`;

  const seen = Object.values(stats?.watches || {}).reduce(
    (acc, b) => acc + Object.keys(b.seen || {}).length,
    0
  );
  countUp($("#stat-seen"), seen);

  $("#stat-checked").textContent = relativeTime(stats?.updated_at);
  $("#stat-checked-foot").textContent = stats?.updated_at
    ? new Date(stats.updated_at).toLocaleString()
    : "waiting for first run";
}

async function refresh() {
  const box = $("#watches");
  const empty = $("#empty");
  const needsToken = $("#needs-token");

  if (!config.ready) {
    box.replaceChildren();
    box.ariaBusy = "false";
    empty.hidden = true;
    needsToken.hidden = false;
    return;
  }

  needsToken.hidden = true;
  box.ariaBusy = "true";

  try {
    const [issues, stats] = await Promise.all([
      api.listWatches(),
      api.state().catch(() => null),
    ]);

    // The issues endpoint also returns PRs; drop them.
    state.watches = (issues || []).filter((i) => !i.pull_request);
    box.replaceChildren(...state.watches.map((iss, i) => watchCard(iss, i, stats)));
    empty.hidden = state.watches.length > 0;
    renderStats(stats);

    $("#hero-status").textContent = stats?.updated_at
      ? `Last checked ${relativeTime(stats.updated_at)}`
      : "Checking every 15 minutes";
  } catch (err) {
    box.replaceChildren();
    empty.hidden = true;
    toast("err", "Couldn't load watches", err.message);
  } finally {
    box.ariaBusy = "false";
  }
}

/* --- actions ------------------------------------------------------------- */

function startCreate() {
  state.editing = null;
  $("#modal-watch-title").textContent = "New watch";
  $(".btn__label", $("#btn-save")).textContent = "Create watch";
  $("#form-watch").reset();
  $("#form-error").hidden = true;
  fillForm({ days: CONTRACT.days[1], alert: CONTRACT.alerts[2], formats: [] });
  openModal("#modal-watch");
}

function startEdit(issue) {
  state.editing = issue;
  $("#modal-watch-title").textContent = "Edit watch";
  $(".btn__label", $("#btn-save")).textContent = "Save changes";
  $("#form-error").hidden = true;
  fillForm(fromIssueBody(issue.body));
  openModal("#modal-watch");
}

function askStop(issue, name) {
  $("#confirm-body").textContent =
    `“${name}” will stop being checked. This closes issue #${issue.number}; you can reopen it on GitHub if you change your mind.`;
  state.confirmFn = async () => {
    await api.closeWatch(issue.number);
    toast("ok", "Stopped watching", name);
    await refresh();
  };
  openModal("#modal-confirm");
}

async function busy(btn, fn) {
  btn.setAttribute("aria-busy", "true");
  try {
    return await fn();
  } finally {
    btn.removeAttribute("aria-busy");
  }
}

/* --- wiring -------------------------------------------------------------- */

function wire() {
  $("#btn-new").addEventListener("click", startCreate);
  $("#btn-refresh").addEventListener("click", (e) => busy(e.currentTarget, refresh));
  $("#btn-settings").addEventListener("click", openSettings);

  $$("[data-action=new]").forEach((b) => b.addEventListener("click", startCreate));
  $$("[data-action=settings]").forEach((b) => b.addEventListener("click", openSettings));

  $("#f-url").addEventListener("input", showParsed);
  $("#f-city").addEventListener("input", showParsed);

  // theme
  $("#btn-theme").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("bms-alert:theme", next);
    $("#btn-theme").setAttribute("aria-label", `Switch to ${next === "dark" ? "light" : "dark"} theme`);
  });

  // save watch
  $("#form-watch").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#form-error");
    err.hidden = true;

    const w = readForm();
    const { eventCode, region } = parseLink(w.url);

    if (!eventCode) {
      err.textContent = "That link has no movie code (like ET00369074) in it. Open the movie on BookMyShow and copy the address bar.";
      err.hidden = false;
      return;
    }
    if (!w.city && !region) {
      err.textContent = "Couldn't find the city in that link. Fill in the City field.";
      err.hidden = false;
      return;
    }
    for (const d of csv(w.dates)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        err.textContent = `Date “${d}” should look like 2026-09-18.`;
        err.hidden = false;
        return;
      }
    }
    if (!config.canWrite) {
      err.textContent = "Add a GitHub token in Settings first — that's what lets this create the watch.";
      err.hidden = false;
      return;
    }

    const city = w.city || region;
    const label = [...w.formats, ...csv(w.formatsOther)].slice(0, 2).join("/") || "any format";
    const title = `[watch] ${eventCode} · ${city} · ${label}`;

    await busy($("#btn-save"), async () => {
      try {
        if (state.editing) {
          await api.updateWatch(state.editing.number, title, toIssueBody(w));
          toast("ok", "Watch updated", "It'll be re-checked on the next run.");
        } else {
          const issue = await api.createWatch(title, toIssueBody(w));
          toast("ok", `Watch created (#${issue.number})`, "A bot will confirm on the issue shortly.");
        }
        closeModal($("#modal-watch"));
        await refresh();
      } catch (e2) {
        err.textContent = e2.message;
        err.hidden = false;
      }
    });
  });

  // confirm stop
  $("#btn-confirm").addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      try {
        await state.confirmFn?.();
        closeModal($("#modal-confirm"));
      } catch (err) {
        toast("err", "Couldn't stop the watch", err.message);
      }
    })
  );

  // check now
  $("#btn-run").addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      try {
        await api.runCheck();
        toast("ok", "Check queued", "Give it a minute, then refresh.");
      } catch (err) {
        toast("err", "Couldn't start a check", `${err.message} (needs Actions: write on the token)`);
      }
    })
  );

  // settings
  $("#btn-reveal").addEventListener("click", () => {
    const input = $("#s-token");
    const shown = input.type === "text";
    input.type = shown ? "password" : "text";
    $("#btn-reveal").textContent = shown ? "Show" : "Hide";
    $("#btn-reveal").setAttribute("aria-label", shown ? "Show token" : "Hide token");
  });

  $("#btn-forget").addEventListener("click", () => {
    config.token = "";
    config.save();
    $("#s-token").value = "";
    $("#token-status").dataset.state = "";
    $("#token-status").textContent = "Token removed from this browser.";
    $("#btn-run").hidden = true;
    toast("info", "Token forgotten", "Reading still works; creating watches won't.");
  });

  $("#form-settings").addEventListener("submit", async (e) => {
    e.preventDefault();
    config.owner = $("#s-owner").value.trim();
    config.repo = $("#s-repo").value.trim();
    config.token = $("#s-token").value.trim();
    config.save();
    updateLinks();

    const status = $("#token-status");
    if (config.token) {
      try {
        const me = await api.whoami();
        status.dataset.state = "ok";
        status.textContent = `Connected as ${me.login}.`;
        $("#btn-run").hidden = false;
        if (config.owner && me.login.toLowerCase() !== config.owner.toLowerCase()) {
          toast(
            "err",
            "Wrong account",
            `Token belongs to ${me.login}, but the repo is under ${config.owner}. Watches from another account are ignored.`
          );
        }
      } catch (err) {
        status.dataset.state = "bad";
        status.textContent = err.message;
      }
    }

    closeModal($("#modal-settings"));
    toast("ok", "Settings saved");
    await refresh();
  });
}

function openSettings() {
  $("#s-owner").value = config.owner;
  $("#s-repo").value = config.repo;
  $("#s-token").value = config.token;
  $("#token-status").textContent = "";
  $("#token-status").dataset.state = "";
  openModal("#modal-settings");
}

function updateLinks() {
  const base = config.slug ? `https://github.com/${config.slug}` : "#";
  $("#repo-link").href = base;
  $("#issues-link").href = config.slug ? `${base}/issues?q=is%3Aissue+label%3Awatch` : "#";
}

/* --- boot ---------------------------------------------------------------- */

function boot() {
  const savedTheme = localStorage.getItem("bms-alert:theme");
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  else if (matchMedia("(prefers-color-scheme: light)").matches) {
    document.documentElement.dataset.theme = "light";
  }

  config.load();
  buildChips();
  buildSegment();
  buildOptions();
  wire();
  updateLinks();

  $("#btn-run").hidden = !config.canWrite;
  $("#stat-channels").textContent = "Issues";

  refresh();
}

boot();
