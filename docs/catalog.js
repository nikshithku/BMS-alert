/* ==========================================================================
   Loading the pick-lists.

   The dashboard cannot fetch BookMyShow itself: BMS sends no
   `access-control-allow-origin` header (verified), so the browser blocks the
   request before it leaves. Everything selectable here is therefore static JSON
   published by the catalog workflow, read straight from the repo.

   That means "refresh when the site opens" can't mean "scrape now". It means:
   read the newest published catalog, and if it's stale, ask GitHub to run the
   catalog workflow in the background.
   ========================================================================== */

const STALE_AFTER_HOURS = 24;

export const catalog = {
  cities: [],
  movies: [],
  cityData: new Map(), // slug -> {venues, formats, languages}
  cachedCities: new Set(),
  generatedAt: null,

  /** Read the published catalog. Falls back gracefully if it isn't built yet. */
  async load(slug, branch = "main") {
    const base = `https://raw.githubusercontent.com/${slug}/${branch}/docs/data`;
    // Cache-bust so a fresh build is visible immediately rather than after the
    // CDN's TTL.
    const bust = `?t=${Date.now()}`;

    const [cities, movies, index] = await Promise.all([
      fetchJson(`${base}/cities.json${bust}`),
      fetchJson(`${base}/movies.json${bust}`),
      fetchJson(`${base}/city/index.json${bust}`),
    ]);

    this.cities = cities?.cities || [];
    this.movies = movies?.movies || [];
    this.cachedCities = new Set(index?.cities || []);
    this.generatedAt = movies?.generated_at || cities?.generated_at || null;
    this._base = base;

    return this.ready;
  },

  get ready() {
    return this.cities.length > 0 && this.movies.length > 0;
  },

  get ageHours() {
    if (!this.generatedAt) return Infinity;
    return (Date.now() - new Date(this.generatedAt).getTime()) / 36e5;
  },

  get stale() {
    return this.ageHours > STALE_AFTER_HOURS;
  },

  /** Per-city cinemas/formats/languages, fetched lazily and memoised. */
  async city(slug) {
    if (this.cityData.has(slug)) return this.cityData.get(slug);
    const data = await fetchJson(`${this._base}/city/${slug}.json?t=${Date.now()}`);
    if (data) this.cityData.set(slug, data);
    return data;
  },

  hasCity(slug) {
    return this.cachedCities.has(slug);
  },

  /** Movies sorted for display; `rank` holds BMS's own prominence ordering. */
  moviesForDisplay() {
    return [...this.movies].sort((a, b) => a.title.localeCompare(b.title));
  },
};

async function fetchJson(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** The next `count` days, starting today, as pickable options. */
export function upcomingDates(count = 21) {
  const out = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < count; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    out.push({
      // The issue form wants YYYY-MM-DD; build it from local parts so a
      // timezone offset can't shift the date by a day.
      value: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      weekday: i === 0 ? "Today" : d.toLocaleDateString(undefined, { weekday: "short" }),
      label: d.toLocaleDateString(undefined, { day: "numeric", month: "short" }),
    });
  }
  return out;
}

const pad = (n) => String(n).padStart(2, "0");
