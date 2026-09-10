/* ==========================================================================
   The contract between this UI, GitHub's issue form, and the Python parser.

   Watches are GitHub issues. This file writes issue bodies in exactly the shape
   GitHub's issue forms produce, so:

     * bmswatch/issueform.py parses anything this UI creates, and
     * this UI can display anything created through the GitHub form.

   Three places must agree on these strings:
     .github/ISSUE_TEMPLATE/watch.yml   (field labels, option text)
     bmswatch/issueform.py             (FIELDS, ALERT_ON, DAYS_AHEAD)
     this file

   Change one and you must change all three. Deliberately kept free of any DOM
   reference so it can be executed and verified outside a browser.
   ========================================================================== */

export const CONTRACT = {
  labels: {
    url: "BookMyShow movie link",
    city: "City override",
    formats: "Formats",
    formatsOther: "Other formats",
    venues: "Cinemas",
    languages: "Languages",
    days: "How far ahead to look",
    dates: "Specific dates",
    alert: "How often should it alert?",
    ack: "Acknowledgement",
  },

  formats: [
    "IMAX",
    "IMAX 3D",
    "4DX",
    "ICE",
    "PXL",
    "LUXE",
    "INSIGNIA",
    "AUROMAX",
    "Dolby Atmos",
    "3D",
    "2D",
    "Recliner",
  ],

  days: ["1 day (today only)", "3 days", "7 days", "14 days"],

  // The em dash in the first option is significant: issueform.py matches the
  // whole string. Replacing it with a hyphen silently changes the granularity
  // to the default.
  alerts: [
    "Once — just tell me when booking opens",
    "Once per cinema",
    "Once per cinema and format",
    "Every single new showtime",
  ],

  ackText:
    "I understand this polls a public BookMyShow page on a schedule and that BookMyShow may change their site or block requests at any time.",

  noResponse: "_No response_",
  watchLabel: "watch",
  invalidLabel: "watch:invalid",
};

/** Build an issue body in the shape GitHub's rendered issue form produces. */
export function toIssueBody(w) {
  const L = CONTRACT.labels;
  const section = (label, value) => `### ${label}\n\n${value || CONTRACT.noResponse}\n`;

  // The catalog can discover formats that are not fixed options in GitHub's
  // issue form. Keep known values as checkboxes and route every discovered
  // value through "Other formats" so the Python watcher receives all of them.
  const knownFormats = new Set();
  const discoveredFormats = [];
  for (const value of w.formats || []) {
    const format = String(value).trim();
    const known = CONTRACT.formats.find((item) => item.toLowerCase() === format.toLowerCase());
    if (known) knownFormats.add(known);
    else if (format) discoveredFormats.push(format);
  }
  const otherFormats = [...String(w.formatsOther || "").split(","), ...discoveredFormats]
    .map((value) => value.trim())
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(", ");

  const checkboxes = CONTRACT.formats
    .map((f) => `- [${knownFormats.has(f) ? "x" : " "}] ${f}`)
    .join("\n");

  return [
    section(L.url, w.url),
    section(L.city, w.city),
    `### ${L.formats}\n\n${checkboxes}\n`,
    section(L.formatsOther, otherFormats),
    section(L.venues, w.venues),
    section(L.languages, w.languages),
    section(L.days, w.days),
    section(L.dates, w.dates),
    section(L.alert, w.alert),
    `### ${L.ack}\n\n- [x] ${CONTRACT.ackText}\n`,
  ].join("\n");
}

/** Inverse of toIssueBody, so an existing issue can be loaded into the editor. */
export function fromIssueBody(body) {
  const sections = {};
  const parts = (body || "").replace(/\r\n/g, "\n").split(/^###[ \t]+/m);
  for (const part of parts.slice(1)) {
    const nl = part.indexOf("\n");
    const label = (nl === -1 ? part : part.slice(0, nl)).trim();
    sections[label] = (nl === -1 ? "" : part.slice(nl + 1)).trim();
  }

  const scalar = (label) => {
    const v = (sections[label] || "").trim();
    return v === CONTRACT.noResponse || v === "_None_" ? "" : v;
  };

  const ticked = (label) =>
    (sections[label] || "")
      .split("\n")
      .map((l) => l.trim().match(/^[-*]\s*\[[xX]\]\s*(.+)$/))
      .filter(Boolean)
      .map((m) => m[1].trim());

  const L = CONTRACT.labels;
  return {
    url: scalar(L.url),
    city: scalar(L.city),
    formats: ticked(L.formats),
    formatsOther: scalar(L.formatsOther),
    venues: scalar(L.venues),
    languages: scalar(L.languages),
    days: scalar(L.days) || CONTRACT.days[1],
    dates: scalar(L.dates),
    alert: scalar(L.alert) || CONTRACT.alerts[2],
  };
}

/** Mirror of issueform.parse_link — pull city and event code out of a BMS URL. */
export function parseLink(url) {
  let region = null;
  const m = (url || "").match(/\/movies\/([a-z0-9-]+)\//i);
  if (m) {
    region = m[1].toLowerCase();
  } else {
    const alt = (url || "").match(/\/movie-([a-z0-9-]+)-ET\d+/i);
    if (alt) region = alt[1].toLowerCase();
  }
  const code = (url || "").match(/\b(ET\d{6,})\b/i);
  return { region, eventCode: code ? code[1].toUpperCase() : null };
}
