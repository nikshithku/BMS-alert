/* ==========================================================================
   BMS Alert — front-end
   No build step, no framework: served straight from GitHub Pages.

   Watches are GitHub issues. The body format is the contract shared with
   GitHub's issue form and the Python parser; it lives in issue-body.js so it
   can be verified outside a browser.
   ========================================================================== */

import { catalog, upcomingDates } from "./catalog.js";
import { CONTRACT, fromIssueBody, parseLink, toIssueBody } from "./issue-body.js";

/* --- searchable select ---------------------------------------------------- */

/**
 * Minimal accessible combobox over a static list.
 *
 * Exists because the city list is ~2,000 entries: a plain <select> is unusable
 * at that size, and a <datalist> can't show poster art or be styled.
 */
function combobox(rootId, inputId, listId, { onPick, onInput, render, placeholder }) {
  const root = $(`#${rootId}`);
  const input = $(`#${inputId}`);
  const list = $(`#${listId}`);
  const status = el("span", { className: "visually-hidden", role: "status", ariaLive: "polite" });
  root.append(status);
  let items = [];
  let filtered = [];
  let active = -1;

  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  };

  const open = () => {
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };

  function draw() {
    list.replaceChildren();
    if (!filtered.length) {
      list.append(
        el("li", {
          className: "combo__opt combo__opt--empty",
          role: "option",
          ariaDisabled: "true",
          textContent: "No matches",
        })
      );
      input.removeAttribute("aria-activedescendant");
      status.textContent = "No matches";
      open();
      return;
    }

    const visible = filtered.slice(0, 60);
    visible.forEach((item, i) => {
      const optionId = `${listId}-option-${i}`;
      const li = el("li", {
        id: optionId,
        className: "combo__opt",
        role: "option",
        ariaSelected: String(i === active),
        onmousedown: (e) => {
          // mousedown, not click: blur would close the list first.
          e.preventDefault();
          pick(item);
        },
      });
      render(li, item);
      list.append(li);
    });
    if (active >= 0) input.setAttribute("aria-activedescendant", `${listId}-option-${active}`);
    else input.removeAttribute("aria-activedescendant");
    status.textContent = `${visible.length} result${visible.length === 1 ? "" : "s"}${
      filtered.length > visible.length ? ` shown of ${filtered.length}` : ""
    }`;
    open();
  }

  function filter(q) {
    const needle = q.trim().toLowerCase();
    filtered = !needle
      ? items
      : items.filter((it) => api.text(it).toLowerCase().includes(needle));
    active = -1;
    draw();
  }

  function pick(item) {
    input.value = api.text(item);
    close();
    onPick(item);
  }

  // Deliberately no open-on-focus. With ~2,000 cities, dropping the whole list
  // open the moment the field is focused reads as a broken page rather than a
  // helpful one. Typing filters; ArrowDown opens deliberately.
  input.addEventListener("input", () => {
    onInput?.();
    filter(input.value);
  });
  input.addEventListener("blur", () => setTimeout(close, 120));

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) filter(input.value);
      const max = Math.min(filtered.length, 60) - 1;
      active = e.key === "ArrowDown" ? Math.min(active + 1, max) : Math.max(active - 1, 0);
      draw();
      $$(".combo__opt", list)[active]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      if (!list.hidden && filtered[active]) {
        e.preventDefault();
        pick(filtered[active]);
      }
    } else if (e.key === "Escape") {
      if (!list.hidden) {
        e.stopPropagation(); // don't let the dialog close too
        close();
      }
    }
  });

  const api = {
    text: (item) => String(item),
    setItems(next, { enabled = true, hint } = {}) {
      items = Array.isArray(next) ? next : [];
      filtered = items;
      input.disabled = !enabled;
      if (hint !== undefined) input.placeholder = hint;
      else if (placeholder) input.placeholder = placeholder;
      close();
    },
    setText(v) {
      input.value = v || "";
    },
    get value() {
      return input.value;
    },
    clear() {
      input.value = "";
      close();
    },
    root,
    input,
  };
  return api;
}

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

/** The repository that owns this deployed Pages site, independent of saved settings. */
function pagesRepository() {
  const host = location.hostname.match(/^([^.]+)\.github\.io$/i);
  if (!host) return null;
  const repo = location.pathname.split("/").filter(Boolean)[0];
  return {
    slug: repo ? `${host[1]}/${repo}` : `${host[1]}/${host[1]}.github.io`,
    branch: "main",
  };
}

function catalogRepository() {
  return pagesRepository() || { slug: config.slug, branch: config.branch };
}

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

  /** Ask the catalog workflow to rebuild, optionally adding a city. */
  runCatalog(cities = "") {
    return this.call(`/repos/${config.slug}/actions/workflows/catalog.yml/dispatches`, {
      method: "POST",
      body: { ref: config.branch, inputs: { cities, refresh_cached: "true" } },
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

const state = {
  watches: [],
  editing: null,
  confirmFn: null,
  city: null, // chosen city slug
  cityData: null, // dynamically loaded per-city catalog
  cityLoadId: 0, // guards against slow, stale city requests
  movie: null, // chosen movie object
  movieOptions: [],
  venues: [], // chosen venue names
};

let cityCombo;
let movieCombo;
let venueCombo;

function uniqueValues(values) {
  const seen = new Set();
  return (values || [])
    .map((value) => String(value || "").trim().replace(/\s+/g, " "))
    .filter((value) => {
      const key = value.toLocaleLowerCase();
      if (!value || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function prioritizedValues(primary, all) {
  return uniqueValues([...(primary || []), ...(all || [])]);
}

/** Toggle chips built from a list of strings. */
function buildChipGroup(boxId, values, { scroll = false, selected = [] } = {}) {
  const box = $(`#${boxId}`);
  const selectedKeys = new Set(selected.map((value) => value.toLocaleLowerCase()));
  const options = uniqueValues(values);
  box.classList.toggle("chips--scroll", scroll && options.length > 14);
  box.replaceChildren(
    ...options.map((value) =>
      el("button", {
        type: "button",
        className: "chip",
        textContent: value,
        ariaPressed: String(selectedKeys.has(value.toLocaleLowerCase())),
        onclick(e) {
          const on = e.currentTarget.getAttribute("aria-pressed") === "true";
          e.currentTarget.setAttribute("aria-pressed", String(!on));
        },
      })
    )
  );
}

function addSelectedChip(boxId, value) {
  const clean = uniqueValues([value])[0];
  if (!clean) return;
  const box = $(`#${boxId}`);
  const existing = $$(".chip", box).find(
    (chip) => chip.textContent.toLocaleLowerCase() === clean.toLocaleLowerCase()
  );
  if (existing) {
    existing.setAttribute("aria-pressed", "true");
    return;
  }
  const selected = chosenChips(boxId);
  const values = $$(".chip", box).map((chip) => chip.textContent);
  buildChipGroup(boxId, [...values, clean], {
    scroll: values.length >= 14,
    selected: [...selected, clean],
  });
}

function chosenChips(boxId) {
  return $$(`#${boxId} .chip[aria-pressed=true]`).map((c) => c.dataset.value ?? c.textContent);
}

/** Future-only date chips. No free text, so a past date can't be entered. */
function buildDateChips() {
  const box = $("#f-dates");
  const dates = upcomingDates(21);
  box.replaceChildren(
    ...dates.map((d) =>
      el(
        "button",
        {
          type: "button",
          className: "chip chip--date",
          ariaPressed: "false",
          title: d.value,
          onclick(e) {
            const on = e.currentTarget.getAttribute("aria-pressed") === "true";
            e.currentTarget.setAttribute("aria-pressed", String(!on));
          },
        },
        [el("span", { textContent: d.weekday }), el("span", { textContent: d.label })]
      )
    )
  );
  $$("#f-dates .chip").forEach((c, i) => (c.dataset.value = dates[i].value));
}

/** Chosen cinemas, shown as removable chips. */
function renderVenueChips() {
  const box = $("#f-venues");
  box.replaceChildren(
    ...state.venues.map((name) =>
      el(
        "button",
        {
          type: "button",
          className: "chip chip--remove",
          title: "Remove",
          ariaLabel: `Remove ${name}`,
          onclick() {
            state.venues = state.venues.filter((v) => v !== name);
            renderVenueChips();
          },
        },
        [
          el("span", { textContent: name }),
          (() => {
            const ns = "http://www.w3.org/2000/svg";
            const svg = document.createElementNS(ns, "svg");
            svg.setAttribute("viewBox", "0 0 24 24");
            svg.setAttribute("fill", "none");
            svg.setAttribute("stroke", "currentColor");
            svg.setAttribute("stroke-width", "2.4");
            svg.setAttribute("aria-hidden", "true");
            const p = document.createElementNS(ns, "path");
            p.setAttribute("d", "M6 6l12 12M18 6 6 18");
            p.setAttribute("stroke-linecap", "round");
            svg.append(p);
            return svg;
          })(),
        ]
      )
    )
  );
}

function movieMetadata(movie) {
  return uniqueValues([...(movie.languages || []), ...(movie.dimensions || [])]).join(" · ");
}

function moviesForCity(data) {
  const nationalByCode = new Map(catalog.movies.map((movie) => [movie.code, movie]));
  const local = (data?.movies || []).map((movie) => ({
    ...nationalByCode.get(movie.code),
    ...movie,
    cityObserved: true,
  }));
  const localCodes = new Set(local.map((movie) => movie.code));
  const national = catalog.movies
    .filter((movie) => !localCodes.has(movie.code))
    .map((movie) => ({ ...movie, cityObserved: false }));
  return [...local, ...national].sort(
    (a, b) => Number(b.cityObserved) - Number(a.cityObserved) || a.title.localeCompare(b.title)
  );
}

function applyMovieFilters(movie, { preserve = false } = {}) {
  if (!state.cityData) {
    $("#movie-note").textContent = "This city is not cached yet; add filters manually if needed.";
    return;
  }

  const data = state.cityData;
  const selectedFormats = preserve ? chosenChips("f-formats") : [];
  const selectedLanguages = preserve ? chosenChips("f-languages") : [];
  if (!preserve) {
    state.venues = [];
    renderVenueChips();
  }

  const movieFormats = movie?.dimensions || [];
  const movieLanguages = movie?.languages || [];
  const venueCodes = new Set(movie?.venues || []);
  const movieVenues = (data.venues || []).filter((venue) => venueCodes.has(venue.code));
  const otherVenues = (data.venues || []).filter((venue) => !venueCodes.has(venue.code));

  buildChipGroup("f-formats", prioritizedValues(movieFormats, data.formats), {
    scroll: true,
    selected: selectedFormats,
  });
  buildChipGroup("f-languages", prioritizedValues(movieLanguages, data.languages), {
    selected: selectedLanguages,
  });
  venueCombo.setItems([...movieVenues, ...otherVenues], {
    enabled: data.venues.length > 0,
    hint: data.venues.length ? `Search ${data.venues.length} cinemas…` : "No cinemas reported",
  });

  if (!movie) {
    $("#movie-note").textContent = "Choose a movie variant to prioritize its known filters.";
  } else if (movie.cityObserved) {
    $("#movie-note").textContent =
      "This variant was seen in the selected city; its known filters are listed first.";
  } else {
    $("#movie-note").textContent =
      "This movie is in the national catalog; city-wide filters remain available.";
  }
  $("#formats-note").textContent = movieFormats.length
    ? `${movieFormats.length} format${movieFormats.length === 1 ? "" : "s"} seen for this variant, followed by other city formats.`
    : `${data.formats.length} formats reported across this city.`;
  $("#languages-note").textContent = movieLanguages.length
    ? `${movieLanguages.length} language${movieLanguages.length === 1 ? "" : "s"} seen for this variant, followed by other city languages.`
    : `${data.languages.length} languages reported across this city.`;
  $("#venues-note").textContent = movieVenues.length
    ? `${movieVenues.length} cinema${movieVenues.length === 1 ? "" : "s"} seen for this variant, followed by other city cinemas.`
    : `${data.venues.length} cinemas reported across this city.`;
}

/** Load a city's movies, cinemas, formats, and languages into the pickers. */
async function applyCity(slug) {
  const loadId = ++state.cityLoadId;
  state.city = slug;
  state.cityData = null;
  state.movie = null;
  state.movieOptions = [];
  state.venues = [];
  $("#f-format-manual").value = "";
  $("#f-venue-manual").value = "";
  $("#f-language-manual").value = "";

  movieCombo.clear();
  movieCombo.setItems([], { enabled: false, hint: "Loading city movies…" });
  venueCombo.clear();
  venueCombo.setItems([], { enabled: false, hint: "Loading cinemas…" });
  buildChipGroup("f-formats", []);
  buildChipGroup("f-languages", []);
  renderPickedMovie();
  renderVenueChips();
  $("#city-note").textContent = "Loading this city's live catalog…";
  $("#movie-note").textContent = "Loading movie variants…";
  $("#formats-note").textContent = "Loading formats reported by this city's screens…";
  $("#languages-note").textContent = "Loading languages reported by this city's movies…";
  $("#venues-note").textContent = "Loading cinemas…";
  $("#lang-field").hidden = false;

  if (!catalog.hasCity(slug)) {
    state.movieOptions = catalog.moviesForDisplay();
    movieCombo.setItems(state.movieOptions, {
      enabled: state.movieOptions.length > 0,
      hint: "Search the national movie catalog…",
    });
    $("#city-note").textContent =
      "This city is not cached yet. Movies remain searchable; add formats, cinemas, or languages manually while its catalog is built.";
    $("#movie-note").textContent = "Showing the dynamically generated national movie catalog.";
    $("#formats-note").textContent = "No city formats are available yet; add one manually if you need a filter.";
    $("#languages-note").textContent = "No city languages are available yet; add one manually if you need a filter.";
    $("#venues-note").textContent = "No city cinemas are available yet; add one manually if you need a filter.";
    maybeRequestCity(slug);
    return;
  }

  const data = await catalog.city(slug);
  if (loadId !== state.cityLoadId || slug !== state.city) return;
  if (!data) {
    state.movieOptions = catalog.moviesForDisplay();
    movieCombo.setItems(state.movieOptions, {
      enabled: state.movieOptions.length > 0,
      hint: "Search the national movie catalog…",
    });
    $("#city-note").textContent =
      "Couldn't load this city's catalog. Movies are still available; filters can be added manually.";
    $("#movie-note").textContent = "Showing the dynamically generated national movie catalog.";
    $("#formats-note").textContent = "City formats failed to load; add one manually if needed.";
    $("#languages-note").textContent = "City languages failed to load; add one manually if needed.";
    $("#venues-note").textContent = "City cinemas failed to load; add one manually if needed.";
    return;
  }

  state.cityData = {
    ...data,
    venues: Array.isArray(data.venues) ? data.venues : [],
    formats: Array.isArray(data.formats) ? data.formats : [],
    languages: Array.isArray(data.languages) ? data.languages : [],
    movies: Array.isArray(data.movies) ? data.movies : [],
  };
  state.movieOptions = moviesForCity(state.cityData);
  movieCombo.setItems(state.movieOptions, {
    enabled: state.movieOptions.length > 0,
    hint: `Search ${state.movieOptions.length} movie variants…`,
  });
  buildChipGroup("f-formats", state.cityData.formats, { scroll: true });
  buildChipGroup("f-languages", state.cityData.languages);
  venueCombo.setItems(state.cityData.venues, {
    enabled: state.cityData.venues.length > 0,
    hint: state.cityData.venues.length
      ? `Search ${state.cityData.venues.length} cinemas…`
      : "No cinemas reported",
  });

  $("#city-note").textContent =
    `${state.cityData.movies.length} local movie variants · ${state.cityData.venues.length} cinemas · ` +
    `${state.cityData.formats.length} formats · ${state.cityData.languages.length} languages`;
  $("#movie-note").textContent = "City-observed variants are listed first, followed by the national catalog.";
  $("#formats-note").textContent = `${state.cityData.formats.length} formats reported across this city.`;
  $("#languages-note").textContent = `${state.cityData.languages.length} languages reported across this city.`;
  $("#venues-note").textContent = `${state.cityData.venues.length} cinemas reported across this city.`;
}

/** Ask the catalog workflow to build a city we don't have yet. */
async function maybeRequestCity(slug) {
  if (!config.canWrite || state._requested === slug) return;
  state._requested = slug;
  try {
    await api.runCatalog(slug);
    toast(
      "info",
      "Building this city's cinema list",
      "Takes a minute or two. Reopen this form afterwards to pick exact cinemas."
    );
  } catch {
    // Not fatal: the watch still works, just without cinema pick-lists.
  }
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
  const usingDates = $("#f-datemode button[aria-checked=true]")?.dataset.mode === "dates";
  const code = state.movie?.code || "";
  const city = state.city || "";
  const formats = uniqueValues([
    ...chosenChips("f-formats"),
    ...csv($("#f-format-manual").value),
  ]);
  const venues = uniqueValues([
    ...state.venues,
    ...lines($("#f-venue-manual").value),
  ]);
  const languages = uniqueValues([
    ...chosenChips("f-languages"),
    ...csv($("#f-language-manual").value),
  ]);

  return {
    // Synthesised rather than typed. The slug segment is cosmetic — BookMyShow
    // resolves the page from the event code alone (verified) — so selecting a
    // movie and a city is enough to build a link the parser accepts.
    url: code && city ? `https://in.bookmyshow.com/movies/${city}/x/${code}` : "",
    city,
    formats,
    // toIssueBody separates dynamic formats from the issue form's fixed
    // checkbox options and safely persists them through Other formats.
    formatsOther: "",
    venues: venues.join("\n"),
    languages: languages.join(", "),
    days: $("#f-days button[aria-checked=true]")?.dataset.value || CONTRACT.days[1],
    dates: usingDates ? chosenChips("f-dates").join(", ") : "",
    alert: $("#f-alert .option[aria-checked=true]")?.dataset.value || CONTRACT.alerts[2],
  };
}

async function fillForm(w) {
  const { region, eventCode } = parseLink(w.url || "");
  const city = w.city || region || "";

  $("#f-format-manual").value = "";
  $("#f-venue-manual").value = "";
  $("#f-language-manual").value = "";

  // City first: it decides which movie variants, cinemas, and filters are offered.
  if (city) {
    const known = catalog.cities.find((c) => c.slug === city);
    cityCombo.setText(known ? known.name : city);
    await applyCity(city);
  } else {
    cityCombo.clear();
    state.city = null;
  }

  const movie = state.movieOptions.find((item) => item.code === eventCode)
    || catalog.movies.find((item) => item.code === eventCode);
  state.movie = movie || (eventCode ? { code: eventCode, title: eventCode, poster: "" } : null);
  if (state.movie) applyMovieFilters(state.movie, { preserve: true });
  movieCombo.setText(state.movie ? movieCombo.text(state.movie) : "");
  renderPickedMovie();

  // Values from an existing issue may no longer be in the sampled catalog.
  // Append and select them instead of silently losing the user's filters.
  const wantedFormats = [...(w.formats || []), ...csv(w.formatsOther)];
  wantedFormats.forEach((format) => addSelectedChip("f-formats", format));

  state.venues = uniqueValues(lines(w.venues));
  renderVenueChips();

  const wantedLanguages = csv(w.languages);
  wantedLanguages.forEach((language) => addSelectedChip("f-languages", language));

  const hasDates = Boolean((w.dates || "").trim());
  setDateMode(hasDates ? "dates" : "window");
  const wantDates = csv(w.dates);
  $$("#f-dates .chip").forEach((c) =>
    c.setAttribute("aria-pressed", String(wantDates.includes(c.dataset.value)))
  );

  $$("#f-days button").forEach((b) =>
    b.setAttribute("aria-checked", String(b.dataset.value === w.days))
  );
  $$("#f-alert .option").forEach((b) =>
    b.setAttribute("aria-checked", String(b.dataset.value === w.alert))
  );
}

function renderPickedMovie() {
  const box = $("#movie-picked");
  if (!state.movie) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.hidden = false;
  box.replaceChildren(
    state.movie.poster
      ? el("img", { src: state.movie.poster, alt: "", loading: "lazy" })
      : el("div", { className: "picked__ph", ariaHidden: "true", textContent: "🎬" }),
    el("div", { className: "picked__meta" }, [
      el("strong", { textContent: state.movie.title }),
      movieMetadata(state.movie)
        ? el("span", { className: "hint", textContent: movieMetadata(state.movie) })
        : null,
      el("code", { textContent: state.movie.code }),
    ])
  );
}

function setDateMode(mode) {
  $$("#f-datemode button").forEach((b) =>
    b.setAttribute("aria-checked", String(b.dataset.mode === mode))
  );
  $("#pane-window").hidden = mode !== "window";
  $("#pane-dates").hidden = mode !== "dates";
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
      invalid || bucket?.stale
        ? el(
            "span",
            {
              className: "badge badge--warn",
              title: bucket?.note || "This watch needs fixing before it can alert.",
            },
            [
              el("span", { className: "badge__dot", ariaHidden: "true" }),
              bucket?.stale ? "dates passed" : "needs fixing",
            ]
          )
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

async function startCreate() {
  state.editing = null;
  state.movie = null;
  state.movieOptions = [];
  state.venues = [];
  state.city = null;
  state.cityData = null;
  state.cityLoadId += 1;
  $("#modal-watch-title").textContent = "New watch";
  $(".btn__label", $("#btn-save")).textContent = "Create watch";
  $("#form-error").hidden = true;
  cityCombo.clear();
  movieCombo.clear();
  movieCombo.setItems([], { enabled: false, hint: "Choose a city first" });
  venueCombo.clear();
  venueCombo.setItems([], { enabled: false, hint: "Choose a city first" });
  renderPickedMovie();
  renderVenueChips();
  buildChipGroup("f-formats", []);
  buildChipGroup("f-languages", []);
  $("#f-format-manual").value = "";
  $("#f-venue-manual").value = "";
  $("#f-language-manual").value = "";
  setDateMode("window");
  $$("#f-days button").forEach((b, i) => b.setAttribute("aria-checked", String(i === 1)));
  $$("#f-alert .option").forEach((b, i) => b.setAttribute("aria-checked", String(i === 2)));
  $$("#f-dates .chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
  $("#city-note").textContent = "Pick a city to load its movies and cinemas.";
  $("#movie-note").textContent = "Language and format variants come from the selected city's catalog.";
  $("#formats-note").textContent = "Pick a city to load formats reported by its screens.";
  $("#languages-note").textContent = "Pick a city to load languages reported by its movies.";
  $("#venues-note").textContent = "Pick a city to load cinemas.";
  openModal("#modal-watch");
}

async function startEdit(issue) {
  state.editing = issue;
  state.movie = null;
  state.venues = [];
  $("#modal-watch-title").textContent = "Edit watch";
  $(".btn__label", $("#btn-save")).textContent = "Save changes";
  $("#form-error").hidden = true;
  openModal("#modal-watch");
  await fillForm(fromIssueBody(issue.body));
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

function wireManualEntry(inputId, buttonId, add) {
  const input = $(`#${inputId}`);
  const commit = () => {
    const value = input.value.trim();
    if (!value) return;
    add(value);
    input.value = "";
    input.focus();
  };
  $(`#${buttonId}`).addEventListener("click", commit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    }
  });
}

/* --- wiring -------------------------------------------------------------- */

function wire() {
  $("#btn-new").addEventListener("click", startCreate);
  $("#btn-refresh").addEventListener("click", (e) => busy(e.currentTarget, refresh));
  $("#btn-settings").addEventListener("click", openSettings);

  $$("[data-action=new]").forEach((b) => b.addEventListener("click", startCreate));
  $$("[data-action=settings]").forEach((b) => b.addEventListener("click", openSettings));

  wireManualEntry("f-format-manual", "btn-add-format", (value) =>
    csv(value).forEach((format) => addSelectedChip("f-formats", format))
  );
  wireManualEntry("f-language-manual", "btn-add-language", (value) =>
    csv(value).forEach((language) => addSelectedChip("f-languages", language))
  );
  wireManualEntry("f-venue-manual", "btn-add-venue", (value) => {
    state.venues = uniqueValues([...state.venues, value]);
    renderVenueChips();
  });

  // date mode toggle
  $$("#f-datemode button").forEach((b) =>
    b.addEventListener("click", () => setDateMode(b.dataset.mode))
  );

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

    if (!state.city) {
      err.textContent = "Pick a city first.";
      err.hidden = false;
      return;
    }
    if (!state.movie) {
      err.textContent = "Pick a movie from the list.";
      err.hidden = false;
      return;
    }
    if ($("#f-datemode button[aria-checked=true]")?.dataset.mode === "dates" && !w.dates) {
      err.textContent = "Choose at least one date, or switch back to a rolling window.";
      err.hidden = false;
      return;
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
  $("#btn-catalog").addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      try {
        await refreshCatalog();
      } catch (err) {
        toast("err", "Couldn't refresh listings", `${err.message} (needs Actions: write on the token)`);
      }
    })
  );

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
    $("#btn-catalog").hidden = true;
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
        $("#btn-catalog").hidden = false;
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

function initCombos() {
  cityCombo = combobox("combo-city", "f-city", "city-list", {
    placeholder: "Start typing to find your city…",
    render: (li, c) => {
      li.append(el("strong", { textContent: c.name }));
      if (catalog.hasCity(c.slug)) {
        li.append(el("small", { textContent: "catalog ready" }));
      }
    },
    onInput: () => {
      state.cityLoadId += 1;
      state.city = null;
      state.cityData = null;
      state.movie = null;
      state.movieOptions = [];
      state.venues = [];
      movieCombo.clear();
      movieCombo.setItems([], { enabled: false, hint: "Pick a city from the results" });
      venueCombo.clear();
      venueCombo.setItems([], { enabled: false, hint: "Choose a city first" });
      buildChipGroup("f-formats", []);
      buildChipGroup("f-languages", []);
      renderPickedMovie();
      renderVenueChips();
      $("#city-note").textContent = "Pick a city from the matching results.";
    },
    onPick: (c) => applyCity(c.slug),
  });
  cityCombo.text = (c) => c.name;

  movieCombo = combobox("combo-movie", "f-movie", "movie-list", {
    placeholder: "Search for a movie…",
    render: (li, movie) => {
      li.append(
        movie.poster
          ? el("img", { src: movie.poster, alt: "", loading: "lazy" })
          : el("span", { textContent: "🎬", ariaHidden: "true" })
      );
      const metadata = movieMetadata(movie);
      li.append(
        el("span", { className: "combo__meta" }, [
          el("strong", { textContent: movie.title }),
          metadata
            ? el("small", { textContent: metadata })
            : el("small", { textContent: movie.cityObserved ? "seen in this city" : "national catalog" }),
        ])
      );
    },
    onInput: () => {
      state.movie = null;
      renderPickedMovie();
      applyMovieFilters(null);
    },
    onPick: (movie) => {
      state.movie = movie;
      applyMovieFilters(movie);
      renderPickedMovie();
    },
  });
  movieCombo.text = (movie) => {
    const metadata = movieMetadata(movie);
    return metadata ? `${movie.title} — ${metadata}` : movie.title;
  };

  venueCombo = combobox("combo-venue", "f-venue-search", "venue-list", {
    placeholder: "Search cinemas…",
    render: (li, venue) => {
      li.append(el("strong", { textContent: venue.name }));
      li.append(el("small", { textContent: venue.code }));
    },
    onPick: (venue) => {
      if (!state.venues.includes(venue.name)) state.venues.push(venue.name);
      renderVenueChips();
      venueCombo.clear();
    },
  });
  venueCombo.text = (venue) => venue.name;
}

async function loadCatalog() {
  cityCombo.clear();
  cityCombo.setItems([], { enabled: false, hint: "Loading cities…" });
  $("#city-note").textContent = "Loading the latest city and movie catalog…";

  const source = catalogRepository();
  const ok = await catalog.load(source.slug, source.branch);
  if (!ok) {
    cityCombo.setItems([], { enabled: false, hint: "City catalog unavailable" });
    $("#city-note").textContent =
      "Couldn't load the city catalog. Check your connection, then reload this page.";
    return;
  }

  cityCombo.setItems(catalog.cities, {
    enabled: true,
    hint: `Search ${catalog.cities.length} cities…`,
  });
  $("#city-note").textContent = `${catalog.cities.length.toLocaleString()} cities ready. Start typing to search.`;
  const age = catalog.ageHours;
  $("#hero-status").textContent =
    age < 1
      ? "Catalog just refreshed · checking every 15 minutes"
      : `Catalog ${Math.round(age)}h old · checking every 15 minutes`;

  updateCatalogButton();

  // "Refresh when the site opens" can't mean scraping from the browser (BMS
  // sends no CORS headers), so kick off the workflow instead and let the next
  // visit see the result.
  if (catalog.stale && config.canWrite) {
    try {
      await api.runCatalog("");
      toast("info", "Refreshing the catalog", "New movies and cinemas will appear shortly.");
    } catch {
      /* stale data is still usable */
    }
  }
}

/** Put the catalog's age on the button so staleness is visible, not guessed. */
function updateCatalogButton() {
  const btn = $("#btn-catalog");
  btn.hidden = !config.canWrite;
  if (!catalog.generatedAt) return;
  const age = catalog.ageHours;
  const when = age < 1 ? "just now" : age < 24 ? `${Math.round(age)}h ago` : `${Math.round(age / 24)}d ago`;
  $(".btn__label", btn).textContent = `Listings · ${when}`;
  btn.title = `Movie and cinema lists were built ${when}. Click to re-scan BookMyShow.`;
}

/** Trigger a catalog rebuild and wait for the result to actually appear.
 *
 * The workflow commits new JSON to the repo, so completion isn't observable
 * from the response. Poll the published timestamp instead and reload the
 * pickers in place once it moves.
 */
async function refreshCatalog() {
  const before = catalog.generatedAt;
  await api.runCatalog("");
  toast("info", "Re-scanning BookMyShow", "Fetching new movies and cinemas. This takes a minute or two.");

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15000));
    const previousMovies = catalog.movies.length;
    const source = catalogRepository();
    await catalog.load(source.slug, source.branch);
    if (catalog.generatedAt && catalog.generatedAt !== before) {
      cityCombo.setItems(catalog.cities);
      catalog.cityData.clear(); // per-city files were rebuilt too
      updateCatalogButton();
      const delta = catalog.movies.length - previousMovies;
      toast(
        "ok",
        "Listings updated",
        `${catalog.movies.length} movies available${delta > 0 ? ` (${delta} new)` : ""}.`
      );
      return;
    }
  }
  toast(
    "err",
    "Still building",
    "The refresh is taking longer than expected. Check the Actions tab, then reload."
  );
}

function boot() {
  const savedTheme = localStorage.getItem("bms-alert:theme");
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  else if (matchMedia("(prefers-color-scheme: light)").matches) {
    document.documentElement.dataset.theme = "light";
  }

  config.load();
  initCombos();
  buildSegment();
  buildOptions();
  buildDateChips();
  wire();
  updateLinks();

  $("#btn-run").hidden = !config.canWrite;
  $("#btn-catalog").hidden = !config.canWrite;
  $("#stat-channels").textContent = "Issues";

  refresh();
  loadCatalog();
}

boot();
