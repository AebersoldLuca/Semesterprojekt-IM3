/**
 * «Wenn Flüsse Durst haben» – alles, was im Browser passiert.
 *
 * Diese Datei macht aus Zahlen Bilder, in vier Schritten:
 *
 *   Holen      Die Messwerte bei unload.php abholen (also aus unserer
 *              eigenen Datenbank, nie direkt beim BAFU oder bei MeteoSchweiz).
 *   Umformen   Die Werte sortieren und 2022 mit 2026 vergleichen.
 *   Zeichnen   Daraus die Grafiken zeichnen, mit D3.js.
 *   Reagieren  Auf die Maus, den Finger und die Knöpfe reagieren.
 *
 * Inhalt dieser Datei, der Reihe nach aufgebaut (jeder Teil braucht nur
 * die Teile davor):
 *
 *    1) Einstellungen                 6) Gemeinsame Grafiken
 *    2) Zahlen schön schreiben         7) Einen Fluss hervorheben
 *    3) Bausteine der Seite            8) Nur die Hauptseite
 *    4) Das Gedächtnis der Seite       9) Nur die Datenseite
 *    5) Daten holen und ausrechnen    10) Start
 *
 * Ob die Hauptseite oder die Datenseite offen ist, steht im HTML:
 * <body data-page="story"> oder <body data-page="daten">.
 */

'use strict';

/* ==================================================================
   1) EINSTELLUNGEN

   Hier steht alles, was man am ehesten ändern möchte: welche Jahre
   verglichen werden, welche Flüsse dazugehören, wie Messgrössen heissen.
   Alle anderen Teile holen sich diese Werte von hier.
   ================================================================== */

// Hier holt die Seite ihre Daten ab.
const ENDPUNKT = 'unload.php';

/** Welche Seite gerade offen ist: 'story' (index.html) oder 'daten' (daten.html) */
const PAGE = document.body.dataset.page || 'story';

/** Die zwei Jahre, die wir vergleichen: 2022 (Hitzesommer) und 2026 */
const YEARS = { ref: 2022, cur: 2026 };

/** Welcher Fluss ganz oben gezeigt wird: die Thur in Andelfingen */
const HERO_STATION = '2044';

/**
 * Was wir selbst zu jeder Station festlegen (keine Messwerte):
 * - group: Mittelland (dort gilt die These) oder Alpen (zum Vergleich)
 * - color: welche Farbe der Fluss in allen Grafiken hat
 * - role: ein Satz, was diesen Fluss besonders macht
 * - the, of: der Fluss mit dem richtigen Artikel, damit die Sätze stimmen
 *   («die Thur» / «der Rhein», «Pegel der Thur» / «Pegel des Rheins»)
 * Namen und Messwerte kommen aus der Datenbank.
 */
const STATIONS = [
  { no: '2243', group: 'mittelland', color: 2, the: 'die', of: 'der Limmat', role: 'Abfluss des Zürichsees: Das Wasser war zuvor im See, dessen Oberfläche sich im Sommer stark erwärmt.' },
  { no: '2044', group: 'mittelland', color: 4, the: 'die', of: 'der Thur', role: 'Fluss aus der Ostschweiz ohne grossen See und ohne grosse Gletscher im Einzugsgebiet.' },
  { no: '2091', group: 'mittelland', color: 6, the: 'der', of: 'des Rheins', role: 'Der Rhein unterhalb der Aaremündung. Hier fliesst das Wasser eines grossen Teils der Nordschweiz vorbei.' },
  { no: '2019', group: 'alpen', color: 1, the: 'die', of: 'der Aare', role: 'Die junge Aare im Berner Oberland, noch vor dem Brienzersee. Gespeist von Gletschern und Schneeschmelze.' },
  { no: '2009', group: 'alpen', color: 3, the: 'die', of: 'der Rhône', role: 'Die Rhône kurz vor dem Genfersee, mit dem Wasser aus den Walliser Alpen.' },
  { no: '2068', group: 'alpen', color: 5, the: 'der', of: 'des Ticino', role: 'Alpensüdseite: der Ticino kurz vor dem Lago Maggiore.' },
];

const GROUPS = [
  { key: 'mittelland', title: 'Mittelland · These' },
  { key: 'alpen', title: 'Alpen · Kontrollgruppe' },
];

/** Wo im Datensatz die Temperatur, der Wasserstand bzw. der Regen steht */
const FIELD = { WT: 'water_temperature_c', W: 'water_level_deviation_cm', N: 'precipitation_mm' };

/** Beschriftungen für Temperatur, Wasserstand und Regen (N wie Niederschlag) */
const PARAM_INFO = {
  WT: { label: 'Wassertemperatur', axis: 'in °C' },
  W:  { label: 'Wasserstand', axis: 'Abweichung vom mittleren Pegel in cm' },
  N:  { label: 'Regen', axis: 'in mm pro Tag' },
};

/** Hat das BAFU den Wert schon geprüft? So steht es im Tooltip. */
const RELEASE_LABEL = { 1: 'provisorisch', 2: 'validiert', 3: 'definitiv', null: 'ohne Status' };

/** Monatsnamen auf Deutsch */
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

const MONTHS_SHORT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

/**
 * Der Durchschnitt der Jahre 2020 bis 2025, als zweiter Massstab neben 2022.
 * Die Zahlen kommen aus der Zusammenfassung pro Fluss und Jahr (unload.php?summary=1),
 * jedes Jahr nur vom 1. Januar bis zum selben Stichtag wie 2026.
 * - nos: ein oder mehrere Flüsse, z.B. ['2044'] oder die drei Mittellandflüsse
 * - key: welche Kennzahl, z.B. 'days_ge_25' oder 'precipitation_sum_mm'
 * - year: ein bestimmtes Jahr statt des Durchschnitts
 * Fehlt die Zusammenfassung, kommt null zurück, und die Seite lässt den Vergleich weg.
 */
const NORMAL_LABEL = '2020–2025';
function normalOf(nos, key, year = null) {
  const rows = state.summary.filter((r) => nos.includes(r.station_no) && r[key] != null
    && (year == null ? r.year < YEARS.cur : r.year === year));
  return rows.length ? d3.mean(rows, (r) => r[key]) : null;
}

/** Mitte August: 2022 begann es ab diesem Tag wieder zu regnen (siehe Texte und Grafik) */
const TURN_MD = '08-15';

/* ==================================================================
   2) ZAHLEN UND DATEN SCHÖN SCHREIBEN

   Zum Beispiel «16.8 °C», «−17 cm» oder «Do, 9. Juli 2026», auf Schweizer Art.
   Dazu ein paar Helfer, um mit Tagen im Jahr zu rechnen.
   ================================================================== */

// Damit Daten auf Deutsch erscheinen: «Do, 9. Juli 2026» statt «Thu, July 9».
// Darunter: verschiedene Arten, ein Datum zu schreiben.
const locale = d3.timeFormatLocale({
  dateTime: '%A, %e. %B %Y, %X', date: '%d.%m.%Y', time: '%H:%M:%S', periods: ['', ''],
  days: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'],
  shortDays: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
  months: MONTHS, shortMonths: MONTHS_SHORT,
});

const parseDate = d3.utcParse('%Y-%m-%d');

const fmtDateLong = locale.utcFormat('%-d. %B %Y');

const fmtDateTooltip = locale.utcFormat('%a, %-d. %B %Y');

const fmtDayMonth = locale.utcFormat('%-d. %B');

const fmtIsoDate = d3.utcFormat('%Y-%m-%d');

const fmtDotted = d3.utcFormat('%d.%m.%Y');

const fmtDayShort = locale.utcFormat('%-d. %b');

// Zahlen schön schreiben, Schweizer Art: 29'541 statt 29541.
const nf = (digits) => new Intl.NumberFormat('de-CH', { minimumFractionDigits: digits, maximumFractionDigits: digits });

const fmt1 = nf(1).format; // mit einer Stelle nach dem Punkt: 16.8

const fmt0 = nf(0).format; // ohne Nachkommastellen: 37

/** Runden wie in der Anzeige, damit Differenzen genau aufgehen (−33.5 wird −34) */
const roundShown = (v, digits = 0) => (Math.sign(v) * Math.round(Math.abs(v) * 10 ** digits)) / 10 ** digits;

// Mit Vorzeichen: +0.9 oder −17
const fmtSigned = (v, digits = 0) => (v > 0 ? '+' : v < 0 ? '−' : '±') + nf(digits).format(Math.abs(v));

const fmtTemp = (v) => `${fmt1(v)}\u00a0°C`; // «16.8 °C», das °C rutscht nie allein auf die nächste Zeile

const fmtCm = (v) => `${fmtSigned(v)}\u00a0cm`; // «−17 cm»

const fmtMm = (v) => `${fmt0(v)}\u00a0mm`; // «632 mm» (Regen)

const fmtMmDay = (v) => `${fmt1(v)}\u00a0mm`; // «12.4 mm» (Regen an einem Tag)

const longDate = (iso) => fmtDateLong(parseDate(iso));

/**
 * Ein Tag im Jahr («07-14») als Datum. Wir legen beide Jahre auf dasselbe
 * Hilfsjahr 2000, damit der 14. Juli 2022 und der 14. Juli 2026 genau
 * übereinander liegen.
 */
const mdDate = (md) => new Date(Date.UTC(2000, Number(md.slice(0, 2)) - 1, Number(md.slice(3, 5))));

/** Der wievielte Tag im Jahr ist das? (0 = 1. Januar, 365 = 31. Dezember) */
const dayIndex = (md) => d3.utcDay.count(new Date(Date.UTC(2000, 0, 1)), new Date(Date.UTC(2000, Number(md.slice(0, 2)) - 1, Number(md.slice(3, 5)))));

const YEAR_START = new Date(Date.UTC(2000, 0, 1));

/* ==================================================================
   3) BAUSTEINE DER SEITE

   Kleine Helfer, um Teile der Seite zu bauen und zu füllen: Texte in
   Platzhalter setzen, Symbole zeichnen, Knopfgruppen bedienbar machen,
   Meldungen zeigen und Bewegungen beim Hinscrollen starten.
   ================================================================== */

/**
 * Ein kleiner Helfer, um Teile der Webseite zu bauen.
 * Beispiel: el('p', { class: 'note' }, 'Hallo') ergibt <p class="note">Hallo</p>.
 * Texte werden immer als reiner Text eingesetzt, nie als Code (Sicherheit).
 */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Einen Platzhalter im HTML (data-slot="…") mit Text füllen */
function setSlot(name, content) {
  document.querySelectorAll(`[data-slot="${name}"]`).forEach((node) => {
    node.replaceChildren(...[].concat(content).map((c) => (c instanceof Node ? c : document.createTextNode(String(c)))));
  });
}

/**
 * Einen Teil eines Textes zeigen oder verstecken.
 * Im HTML steht z.B. <span data-when="turn">Dann kam die Wende …</span>.
 * showWhen('turn', true) zeigt ihn, showWhen('turn', false) versteckt ihn.
 * So bleiben die Sätze im HTML, und JavaScript entscheidet nur, welcher gilt.
 */
function showWhen(name, show) {
  document.querySelectorAll(`[data-when="${name}"]`).forEach((node) => { node.hidden = !show; });
}

/**
 * Kleine Symbole: Thermometer, Sonne, Welle, Stift.
 * Jedes ist mit ein paar Linien gezeichnet, als Text im Code (keine Bilddateien).
 * Die Farbe bestimmt das CSS.
 */
const ICONS = {
  thermo: ['M10 13.6V5a2 2 0 1 1 4 0v8.6a4 4 0 1 1-4 0Z', 'M12 9.5v6.5'],
  sun: ['M12 7.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Z', 'M12 2v2.2', 'M12 19.8V22', 'M4.9 4.9l1.6 1.6', 'M17.5 17.5l1.6 1.6',
    'M2 12h2.2', 'M19.8 12H22', 'M4.9 19.1l1.6-1.6', 'M17.5 6.5l1.6-1.6'],
  waveDown: ['M2 7.5c2.5-2 4.5-2 7 0s4.5 2 7 0 4.5-2 6 0', 'M12 11v9', 'M8.5 16.5 12 20l3.5-3.5'],
  pen: ['M4 20l1.2-4.4L16.4 4.4a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.4 18.8Z', 'M14.5 6.5l3 3'],
};

/** Ein Symbol als eigenes kleines Bild für den Text */
function icon(name, cls = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** Dasselbe Symbol, aber direkt in eine Grafik hineingezeichnet */
function appendIcon(selection, name, size) {
  const g = selection.append('g').attr('class', 'icon-g')
    .attr('transform', `translate(${-size / 2},${-size / 2}) scale(${size / 24})`);
  for (const d of ICONS[name]) g.append('path').attr('d', d);
  return g;
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Eine kurze Meldung unten am Bildschirm, die nach 8 Sekunden verschwindet */
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => (toast.hidden = true), 8000);
}

/** Einen Hinweis in einer Grafik zeigen, z.B. «keine Daten» (leer = ausblenden) */
function setStatus(id, message) {
  const node = document.getElementById(id);
  node.textContent = message || '';
  node.hidden = !message;
}

/**
 * Eine Knopfgruppe, bei der immer genau ein Knopf aktiv ist
 * (z.B. «Temperatur | Wasserstand»). Geht auch mit den Pfeiltasten.
 */
function setupSegmented(id, dataKey, onChange) {
  const buttons = [...document.querySelectorAll(`#${id} button`)];
  const select = (btn) => {
    if (btn.getAttribute('aria-checked') === 'true') return;
    buttons.forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
    onChange(btn.dataset[dataKey]);
  };
  buttons.forEach((btn, i) => {
    btn.addEventListener('click', () => select(btn));
    btn.addEventListener('keydown', (e) => {
      const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      const next = buttons[(i + dir + buttons.length) % buttons.length];
      next.focus();
      select(next);
    });
  });
}

/** In einer Knopfgruppe einen bestimmten Knopf als aktiv markieren */
function setSegmentedValue(id, dataKey, value) {
  document.querySelectorAll(`#${id} button`).forEach((b) => b.setAttribute('aria-checked', String(b.dataset[dataKey] === String(value))));
}

/**
 * Gibt einem Teil der Seite die Klasse «is-visible», sobald er zu einem
 * Drittel im Bild ist. Das CSS startet dann die Bewegung: Die Becher
 * füllen sich, die Grafiken bauen sich auf (siehe finishChart).
 * Das passiert nur einmal, beim ersten Hinscrollen.
 */
function revealOnScroll(node) {
  if (node.classList.contains('is-visible') || node.dataset.revealWatch) return;
  if (!('IntersectionObserver' in window)) { node.classList.add('is-visible'); return; }
  node.dataset.revealWatch = 'true';
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      node.classList.add('is-visible');
      observer.disconnect();
    }
  }, { threshold: 0.3 });
  observer.observe(node);
}

/* ==================================================================
   4) DAS GEDÄCHTNIS DER SEITE

   Hier steht, welche Daten geladen sind und was gerade ausgewählt ist.
   Dazu Helfer rund um die Flüsse: Name, Farbe, Gruppe (Mittelland oder Alpen).
   ================================================================== */

// Zu einer Stationsnummer die eigenen Angaben von oben finden.
const stationInfo = (no) => STATIONS.find((s) => s.no === no);

/** Der Fluss mit Artikel, für Sätze: «die Thur», «der Rhein». capital = am Satzanfang: «Die Thur». */
const theRiver = (no, capital = false) => {
  const text = `${stationInfo(no).the} ${state.names.get(no).river_name}`;
  return capital ? text[0].toUpperCase() + text.slice(1) : text;
};
/** Der Fluss im Genitiv: «der Thur», «des Rheins» (z.B. «der Pegel des Rheins») */
const ofRiver = (no) => stationInfo(no).of;

/** Die Farbe eines Flusses. Jeder Fluss hat überall dieselbe Farbe. */
const colorOf = (no) => `var(--series-${stationInfo(no)?.color ?? 1})`;

// Ein farbiger Punkt in der Farbe des Flusses (wie in einer Legende).
const keySwatch = (no, cls = 'key') => el('span', { class: cls, style: `background:${colorOf(no)}`, 'aria-hidden': 'true' });

/** Die Messwerte nach Fluss sortieren: ein Stapel pro Station */
function groupByStation(records) {
  const map = new Map();
  for (const r of records) {
    if (!map.has(r.station_no)) map.set(r.station_no, []);
    map.get(r.station_no).push(r);
  }
  return map;
}

// Das Gedächtnis der Seite: Hier steht, welche Daten geladen sind und was
// gerade ausgewählt ist. Klickt man auf einen Knopf, ändert sich ein Wert
// hier, und die passende Grafik wird neu gezeichnet.
const state = {
  recent: null,          // die Messwerte der letzten 365 Tage, nach Fluss sortiert
  latest: null,          // der neuste Messtag
  names: new Map(),      // Fluss- und Ortsname zu jeder Stationsnummer
  cmp: null,             // der fertige Vergleich 2022 gegen 2026
  compare: { parameter: 'WT', smooth: 7 }, // «Jahr gegen Jahr»: Temperatur, 7-Tage-Mittel
  rain: { no: HERO_STATION }, // «Regen und Pegel» auf der Story-Seite: welcher Fluss
  rainGuess: {},               // die eigenen Regen-Schätzungen für 2026, eine pro Fluss (siehe guessOf)
  summary: [],                 // Kennzahlen pro Fluss und Jahr seit 2020 (für den Durchschnitt 2020–2025)
  focus: { hover: null, pinned: null }, // welcher Fluss gerade hervorgehoben ist
  zoom: { no: null, kind: 'cmp' }, // welcher Fluss gross angezeigt wird, und welche Grafik ('cmp' oder 'rain')
  ts: { parameter: 'WT', days: '365', hidden: new Set(), records: null, range: null, request: 0 }, // «Selbst nachschauen»
};

// Sobald die Seite geladen ist: init() starten.

/** Der volle Name eines Flusses, z.B. «Thur – Andelfingen» */
const displayName = (no) => {
  const n = state.names.get(no);
  return n ? `${n.river_name} – ${n.station_name}` : no;
};

// Kleine Helfer für den Vergleich:
// - inGroup: nur die Mittelland- oder nur die Alpenflüsse
// - cutoffLabel: der Stichtag als Text, z.B. «28. September»
// - delta: der Unterschied 2026 minus 2022
const inGroup = (key, cmp = state.cmp) => cmp.stations.filter((s) => s.info.group === key);

const cutoffLabel = (cmp = state.cmp) => fmtDayMonth(parseDate(`${YEARS.cur}-${cmp.cutoff}`));

const delta = (s, k) => s.cur.summary[k] - s.ref.summary[k];

/* ==================================================================
   5) DATEN HOLEN UND AUSRECHNEN

   Holt die Messwerte bei unload.php (also aus unserer eigenen Datenbank)
   und rechnet daraus, was die Grafiken brauchen: den Vergleich 2022 gegen
   2026, geglättete Linien, das Regen-Konto und vieles mehr.
   ================================================================== */

/* ---------- Daten holen ----------------------------------------------- */

// Ein Zwischenspeicher: Was schon einmal geholt wurde, wird nicht nochmals
// geholt. Wer hin- und herklickt, bekommt die Daten beim zweiten Mal sofort.
const cache = new Map();

/**
 * Fragt unload.php nach Daten.
 * Wünsche wie «nur 2022 und 2026» werden an die Adresse angehängt,
 * zum Beispiel: unload.php?years=2022,2026
 */
async function unload(filters = {}) {
  const params = new URLSearchParams();

  for (const [name, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(name, value);
    }
  }

  const url = params.toString() === '' ? ENDPUNKT : `${ENDPUNKT}?${params}`;

  if (cache.has(url)) {
    return cache.get(url);
  }

  let response;

  try {
    response = await fetch(url);
  } catch {
    // Gar keine Antwort, zum Beispiel weil das Internet weg ist.
    throw new Error('Der Server ist nicht erreichbar. Bitte Internetverbindung prüfen.');
  }

  // Eine Antwort kam, aber mit einem Fehler (zum Beispiel «Datenbank nicht
  // erreichbar»). Dann zeigen wir die Meldung von unload.php an.
  if (!response.ok) {
    const answer = await response.json().catch(() => null);
    throw new Error(answer?.error ?? `Der Endpunkt antwortet mit Status ${response.status}.`);
  }

  // Sicherheitsprüfung: Ist die Antwort wirklich Daten (JSON) und keine
  // Fehlerseite? Sonst gäbe es eine unverständliche Fehlermeldung.
  const contentType = response.headers.get('content-type') ?? '';

  if (!contentType.includes('application/json')) {
    throw new Error('Die Antwort ist kein JSON. Öffne unload.php direkt im Browser.');
  }

  const data = await response.json();
  cache.set(url, data); // für das nächste Mal merken

  return data;
}

/* ---------- 2022 und 2026 vergleichen --------------------------------- */

/**
 * Rechnet für jeden Fluss die wichtigsten Zahlen beider Jahre aus.
 *
 * Fair ist der Vergleich nur, wenn beide Jahre gleich lang sind. 2026 ist
 * noch nicht vorbei. Deshalb zählen wir in beiden Jahren nur vom 1. Januar
 * bis zum «Stichtag», dem letzten Tag, für den es 2026 schon Daten gibt.
 */
function buildCompare(records) {
  const byNo = groupByStation(records);
  const curDates = records.filter((r) => r.date.startsWith(String(YEARS.cur))).map((r) => r.date);
  const cutoff = curDates.length ? d3.max(curDates).slice(5) : '12-31';

  // Die Zahlen eines Jahres: Durchschnitt, heisse Tage, Wasserstand, Regen, geprüfte Tage.
  const summarize = (recs) => {
    const upTo = recs.filter((r) => r.date.slice(5) <= cutoff);
    const wt = upTo.map((r) => r.water_temperature_c).filter((v) => v != null);
    const w = upTo.map((r) => r.water_level_deviation_cm).filter((v) => v != null);
    const rain = upTo.map((r) => r.precipitation_mm).filter((v) => v != null);
    return {
      // Regen: alles zusammengezählt, und an wie vielen Tagen gemessen wurde.
      rain_sum: d3.sum(rain),
      rain_days: rain.length,
      wt_mean: wt.length ? d3.mean(wt) : null,
      days_ge_20: wt.filter((v) => v >= 20).length,
      days_ge_25: wt.filter((v) => v >= 25).length,
      w_mean: w.length ? d3.mean(w) : null,
      // Tage, deren Werte das BAFU schon kontrolliert hat.
      checked: upTo.filter((r) => r.release_state >= 2).length,
      count: upTo.length,
    };
  };

  // Für jeden Fluss: die Werte von 2022 und 2026 und ihre Zahlen.
  const stations = STATIONS.filter((s) => byNo.has(s.no)).map((s) => {
    const recs = byNo.get(s.no);
    const ref = recs.filter((r) => r.date.startsWith(String(YEARS.ref)));
    const cur = recs.filter((r) => r.date.startsWith(String(YEARS.cur)));
    return { no: s.no, info: s, ref: { records: ref, summary: summarize(ref) }, cur: { records: cur, summary: summarize(cur) } };
  }).filter((s) => s.ref.records.length && s.cur.records.length);

  return { cutoff, stations };
}

/* ---------- Linien aus den Messwerten --------------------------------- */

/**
 * Macht aus den Messwerten eines Jahres Punkte für eine Linie.
 *
 * - Beide Jahre kommen auf dasselbe Hilfsjahr, damit sie übereinander liegen.
 * - «7-Tage-Mittel»: Jeder Punkt ist der Durchschnitt dieses Tages und der
 *   sechs Tage davor. Das macht die Linie ruhiger. Fehlen zu viele Tage,
 *   bleibt eine Lücke.
 * - Fehlt ein Tag, reisst die Linie ab. Wir erfinden keine Werte.
 */
function yearPoints(records, year, param, smooth) {
  const field = FIELD[param];
  const day = 864e5;
  const pts = records.filter((r) => r[field] != null).map((r) => {
    const [, mm, dd] = r.date.split('-').map(Number);
    return { real: Date.UTC(year, mm - 1, dd), x: new Date(Date.UTC(2000, mm - 1, dd)), md: r.date.slice(5), raw: r[field] };
  });
  let start = 0;
  pts.forEach((p, i) => {
    if (smooth <= 1) { p.value = p.raw; return; }
    while (pts[start].real < p.real - (smooth - 1) * day) start++;
    const win = pts.slice(start, i + 1);
    p.value = win.length >= Math.ceil(smooth / 2) + 1 ? d3.mean(win, (w) => w.raw) : null;
  });
  const out = [];
  pts.forEach((p, i) => {
    if (i > 0 && p.real - pts[i - 1].real > day) out.push({ x: p.x, value: null }); // hier fehlt ein Tag: Lücke
    out.push(p);
  });
  return out;
}

/* ---------- Regen und Pegel ------------------------------------------- */

/*
 * Warum steht ein Fluss tief? Oft, weil es zu wenig geregnet hat.
 * Diese Grafiken zeigen 2022 und 2026 gleichzeitig, in zwei Teilen:
 *
 *   oben    das «Regen-Konto»: der Regen seit dem 1. Januar, Tag für Tag
 *           zusammengezählt. Je weiter die zwei Linien auseinandergehen,
 *           desto grösser der Unterschied zwischen den Jahren.
 *   unten   der Pegel des Flusses in beiden Jahren.
 *
 * Wie bei «Wer hat mehr geschwitzt?» ist 2022 grau und 2026 weiss. Die
 * Fläche dazwischen ist orange, wo 2026 weniger Regen fiel bzw. der Fluss
 * tiefer stand, und blau, wo es umgekehrt war.
 *
 * Auf der Story-Seite gibt es dazu zwei «Messbecher». Sie zeigen den
 * Stand des Regen-Kontos am Stichtag, also die Endpunkte der Linien oben.
 */

/** Gibt es überhaupt schon Regendaten? (Vor dem ersten Regen-Import nicht.) */
const hasRain = (cmp = state.cmp) => cmp.stations.some((s) => s.ref.summary.rain_days > 0 && s.cur.summary.rain_days > 0);

/**
 * Um wie viel Prozent hat es 2026 mehr oder weniger geregnet als 2022?
 * Für mehrere Flüsse zusammen: Wir zählen den Regen aller Stationen
 * zusammen und vergleichen die beiden Summen. Ohne Regendaten: null.
 */
function rainChange(stations) {
  const withRain = stations.filter((s) => s.ref.summary.rain_days > 0 && s.cur.summary.rain_days > 0);
  if (!withRain.length) return null;
  const ref = d3.sum(withRain, (s) => s.ref.summary.rain_sum);
  const cur = d3.sum(withRain, (s) => s.cur.summary.rain_sum);
  return ref > 0 ? ((cur - ref) / ref) * 100 : null;
}

/**
 * Das «Regen-Konto» eines Jahres: Am 1. Januar steht darauf der Regen
 * dieses Tages, und jeden Tag kommt der neue Regen dazu. Am Stichtag
 * steht dort die ganze Summe bis dahin.
 * Ein Tag ohne Messung bringt nichts dazu (wir erfinden keinen Regen).
 */
function rainPoints(records) {
  let total = 0;
  return records
    .filter((r) => r.date.slice(5) <= state.cmp.cutoff)
    .map((r) => {
      if (r.precipitation_mm != null) total += r.precipitation_mm;
      const md = r.date.slice(5);
      return { x: mdDate(md), md, value: total };
    });
}

/** Den Regen in einem Abschnitt des Jahres zusammenzählen, z.B. vom 15. August ('08-15') bis zum Stichtag */
const rainBetween = (records, fromMd, toMd = state.cmp.cutoff) =>
  d3.sum(records, (r) => (r.date.slice(5) >= fromMd && r.date.slice(5) <= toMd ? r.precipitation_mm ?? 0 : 0));

/** Der Tag mit dem tiefsten Wasserstand eines Jahres, bis zum Stichtag */
const lowestLevel = (records) => d3.least(
  records.filter((r) => r.water_level_deviation_cm != null && r.date.slice(5) <= state.cmp.cutoff),
  (r) => r.water_level_deviation_cm);

/** Der Pegel eines Jahres als Linie (7-Tage-Mittel), nur bis zum Stichtag */
const levelPoints = (records, year) => yearPoints(records, year, 'W', 7).filter((p) => p.x <= mdDate(state.cmp.cutoff));

/**
 * Wie hoch müssen die Achsen gehen? Wir schauen über beide Jahre (und über
 * alle mitgegebenen Flüsse), damit alle Grafiken dieselbe Skala haben.
 */
function rainScales(stations) {
  const rainMax = d3.max(stations, (s) => Math.max(s.ref.summary.rain_sum, s.cur.summary.rain_sum)) ?? 10;
  const levels = stations.flatMap((s) => [...levelPoints(s.ref.records, YEARS.ref), ...levelPoints(s.cur.records, YEARS.cur)])
    .map((p) => p.value).filter((v) => v != null);
  const [lo, hi] = d3.extent(levels);
  return { rainMax: Math.max(10, rainMax), lvlMin: Math.min(0, lo ?? 0), lvlMax: Math.max(0, hi ?? 0) };
}

/* ==================================================================
   6) GEMEINSAME GRAFIKEN (BEIDE SEITEN)

   Gezeichnet wird mit D3.js. Hier stehen die gemeinsamen Teile: Linien,
   das Fenster beim Darüberfahren (Tooltip), die senkrechte Linie, die der
   Maus folgt, die eingefärbte Fläche zwischen 2022 und 2026 und die beiden
   grossen Grafiktypen «Jahr gegen Jahr» und «Regen und Pegel».
   ================================================================== */

/*
 * Kleine Helfer für alle Grafiken, damit derselbe Code nicht mehrmals dasteht:
 * - valueLine: eine Linie durch Punkte. Fehlt ein Wert (null), reisst die Linie ab.
 *   xKey sagt, wo beim Punkt das Datum steht ('x' oder 'date').
 * - lastValue: der letzte Punkt einer Linie, der einen Wert hat (für die Jahreszahl am Ende).
 * - tooltipRow: eine Zeile im Fenster beim Darüberfahren: Farbpunkt, Name, Wert.
 * - reducedMotion: Hat jemand am Computer «Bewegung reduzieren» eingestellt?
 */
const valueLine = (x, y, xKey = 'x') => d3.line().defined((p) => p.value != null).x((p) => x(p[xKey])).y((p) => y(p.value));

const lastValue = (pts) => [...pts].reverse().find((p) => p.value != null);

const tooltipRow = (name, color, value) => el('div', { class: 'tooltip__row' },
  el('span', { class: 'tooltip__key', style: `background:${color}` }),
  el('span', { class: 'tooltip__name' }, name),
  el('span', { class: 'tooltip__value' }, value));

/**
 * Der Rahmen einer Grafik, für alle Grafiken gleich: altes Bild entfernen,
 * Grösse messen, den Rand für die Beschriftung abziehen und ein neues Bild
 * (SVG) mit einer verschobenen Zeichenfläche g anlegen.
 * Gibt null zurück, wenn die Grafik noch unsichtbar oder zu klein ist.
 */
function chartFrame(chart, margin, { minW = 50, minH = 50 } = {}) {
  d3.select(chart).selectAll('svg').remove();
  const width = chart.clientWidth;
  const height = chart.clientHeight;
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  if (innerW < minW || innerH < minH) return null;
  const svg = d3.select(chart).append('svg').attr('width', width).attr('height', height).attr('aria-hidden', 'true');
  const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
  return { svg, g, width, height, innerW, innerH, margin };
}

/** Die Monate als Achse unten. every: jeden wievielten Monat beschriften. */
function drawMonthAxis(g, x, innerH, every = 1) {
  g.append('g').attr('class', 'axis axis--x').attr('transform', `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(d3.utcMonth.every(every)).tickSizeOuter(0).tickFormat(locale.utcFormat('%b')))
    .call((a) => a.selectAll('.tick line').attr('y2', 3));
}

/** Die Werte als Achse links, mit feinen Hilfslinien quer durch die Grafik. */
function drawValueAxis(g, y, innerW, ticks, format) {
  g.append('g').attr('class', 'axis axis--y')
    .call(d3.axisLeft(y).ticks(ticks).tickSize(-innerW).tickFormat(format))
    .call((a) => a.selectAll('.tick text').attr('x', -6));
}

/** Eine waagrechte Hilfslinie mit Beschriftung, z.B. bei 25 °C. */
function drawRefLine(g, y, value, innerW, label, { x = 4, anchor = 'start' } = {}) {
  g.append('line').attr('class', 'refline').attr('x1', 0).attr('x2', innerW).attr('y1', y(value)).attr('y2', y(value));
  g.append('text').attr('class', 'refline-label').attr('x', x).attr('y', y(value) - 6).attr('text-anchor', anchor).text(label);
}

/**
 * Der letzte Schritt jeder Grafik:
 * 1. Beschriftungen in der Grafik bekommen einen dunklen Rand, damit man sie
 *    auch über Linien gut lesen kann («paint-order»: zuerst der Rand, dann die Schrift).
 * 2. Die Grafik baut sich langsam von links nach rechts auf, sobald man zu
 *    ihr scrollt. Das macht das CSS (.reveal), ausgelöst von revealOnScroll.
 *    Zeichnet man die Grafik später neu (z.B. nach einem Klick), erscheint sie sofort.
 * reveal: false = ohne Aufbau, z.B. in der grossen Ansicht.
 */
function finishChart(chart, { reveal = true } = {}) {
  chart.querySelectorAll('.year-label, .refline-label, .annotation, .hero-sun text').forEach((t) => t.setAttribute('paint-order', 'stroke'));
  if (reveal) {
    chart.classList.add('reveal');
    revealOnScroll(chart);
  }
}

/** Die Legende: grau = 2022, weiss = 2026, rot = 2026 wärmer, blau = 2026 kühler */
function diffLegend() {
  const isW = state.compare.parameter === 'W';
  return [
    el('span', {}, el('span', { class: 'swatch swatch--line', style: 'background:var(--year-ref)' }), String(YEARS.ref)),
    el('span', {}, el('span', { class: 'swatch swatch--line', style: 'background:var(--ink)' }), String(YEARS.cur)),
    el('span', {}, el('span', { class: 'swatch', style: 'background:var(--signal)' }), isW ? `${YEARS.cur} tiefer` : `${YEARS.cur} wärmer`),
    el('span', {}, el('span', { class: 'swatch', style: 'background:var(--cool)' }), isW ? `${YEARS.cur} höher` : `${YEARS.cur} kühler`),
  ];
}

/**
 * Die Farben für die Temperatur in der Grafik ganz oben:
 * 0 °C dunkelblau, 8 °C blau, 16 °C fast weiss, ab 24 °C rot.
 */
const tempColor = d3.scaleLinear()
  .domain([0, 8, 16, 24])
  .range(['#1d4c93', '#4a8bd6', '#e4e0d6', '#ff4d1c'])
  .interpolate(d3.interpolateLab)
  .clamp(true);

/** Der Tag mit dem höchsten Tagesmittel der Wassertemperatur */
const hottestDay = (records) => d3.greatest(records.filter((r) => r.water_temperature_c != null), (r) => r.water_temperature_c);

let clipId = 0;

/**
 * Färbt die Fläche zwischen der Linie von 2022 und der von 2026 ein.
 * - higher: so wird gefärbt, wo 2026 über 2022 liegt (z.B. 'diff--warm')
 * - lower: so wird gefärbt, wo 2026 unter 2022 liegt
 * - top, bottom: wo die Grafik oben und unten aufhört
 * Dafür zeichnen wir die Fläche zweimal und schneiden je den oberen bzw.
 * den unteren Teil weg (mit sogenannten «Clip-Pfaden», wie mit einer Schere).
 */
function drawDiff(g, defs, { x, y, refPts, curPts, top, bottom, higher, lower }) {
  // Für jeden Tag 2026 den Wert von 2022 am selben Datum danebenlegen.
  const refByMd = new Map(refPts.filter((p) => p.value != null).map((p) => [p.md, p.value]));
  const joined = curPts.map((p) => ({ x: p.x, cur: p.value, ref: p.value == null ? null : refByMd.get(p.md) ?? null }));
  const id = ++clipId;
  defs.append('clipPath').attr('id', `clip-above-${id}`).append('path')
    .attr('d', d3.area().defined((d) => d.cur != null).x((d) => x(d.x)).y0(top).y1((d) => y(d.cur))(joined));
  defs.append('clipPath').attr('id', `clip-below-${id}`).append('path')
    .attr('d', d3.area().defined((d) => d.cur != null).x((d) => x(d.x)).y0(bottom).y1((d) => y(d.cur))(joined));
  const between = d3.area().defined((d) => d.cur != null && d.ref != null)
    .x((d) => x(d.x)).y0((d) => y(d.ref)).y1((d) => y(d.cur))(joined);
  // Teil unter der weissen Linie: 2026 lag höher als 2022.
  g.append('path').attr('class', higher).attr('clip-path', `url(#clip-below-${id})`).attr('d', between);
  // Teil über der weissen Linie: 2026 lag tiefer als 2022.
  g.append('path').attr('class', lower).attr('clip-path', `url(#clip-above-${id})`).attr('d', between);
}

/**
 * Die Grafik für einen Fluss: 2022 als graue Linie, 2026 als weisse Linie.
 * Die Fläche dazwischen ist eingefärbt:
 * - rot, wo 2026 wärmer war (bzw. tiefer lag): Das stützt unsere These.
 * - blau, wo es umgekehrt war.
 */
function drawMultiple(chart, s, { yMin, yMax, isW, f, large = false }) {
  const margin = large ? { top: 14, right: 44, bottom: 28, left: 46 } : { top: 10, right: 34, bottom: 24, left: 36 };
  const frame = chartFrame(chart, margin);
  if (!frame) return; // noch nicht sichtbar
  const { svg, g, width, innerW, innerH } = frame;

  const x = d3.scaleUtc().domain([YEAR_START, new Date(Date.UTC(2000, 11, 31))]).range([0, innerW]);
  const y = d3.scaleLinear().domain([yMin, yMax]).nice().range([innerH, 0]);

  drawMonthAxis(g, x, innerH, width < 330 ? 3 : width > 700 ? 1 : 2);
  drawValueAxis(g, y, innerW, large ? 8 : 4, (v) => (isW ? fmtSigned(v) : fmt0(v)));
  g.append('line').attr('class', 'baseline').attr('x1', 0).attr('x2', innerW).attr('y1', y(0)).attr('y2', y(0));

  // Anmerkung bei der Temperatur: die 25-°C-Grenze für Äschen, falls sie in der Grafik liegt.
  if (!isW && y.domain()[1] >= 25) drawRefLine(g, y, 25, innerW, large ? '25 °C: kritisch für Äschen' : '25 °C');

  // Die gepunktete Linie beim Stichtag: Bis hierhin wird verglichen.
  const [mm, dd] = state.cmp.cutoff.split('-').map(Number);
  const cx = x(new Date(Date.UTC(2000, mm - 1, dd)));
  g.append('line').attr('class', 'cutoff-line').attr('x1', cx).attr('x2', cx).attr('y1', 0).attr('y2', innerH);

  // Die Fläche zwischen 2022 und 2026 einfärben (siehe drawDiff).
  // Temperatur: höher = wärmer = orange. Wasserstand: tiefer = orange.
  drawDiff(g, svg.append('defs'), { x, y, refPts: s.refPts, curPts: s.curPts, top: 0, bottom: innerH,
    higher: isW ? 'diff--cool' : 'diff--warm', lower: isW ? 'diff--warm' : 'diff--cool' });

  const line = valueLine(x, y);
  g.append('path').attr('class', 'line--ref').attr('d', line(s.refPts));
  g.append('path').attr('class', 'line--cur').attr('d', line(s.curPts));

  // Die Jahreszahl direkt ans Ende jeder Linie schreiben (statt einer Legende).
  drawYearLabels(g, x, y, s.refPts, s.curPts);

  // Mit der Maus darüber: Eine senkrechte Linie zeigt den Tag, ein Fenster die Werte.
  const refBy = new Map(s.refPts.filter((p) => p.value != null).map((p) => [+p.x, p]));
  const curBy = new Map(s.curPts.filter((p) => p.value != null).map((p) => [+p.x, p]));
  const days = [...new Set([...refBy.keys(), ...curBy.keys()])].sort((a, b) => a - b);
  const shown = (v) => roundShown(v, isW ? 0 : 1); // so gerundet wie angezeigt, damit die Differenz aufgeht

  attachCrosshair({
    chart, g, innerW, innerH, margin,
    dockable: false, // das Werte-Fenster schwebt über der Grafik und verschiebt nichts
    positions: days.map((d) => x(d)),
    render(i, hover) {
      const d = days[i];
      const pr = refBy.get(d);
      const pc = curBy.get(d);
      const dots = [pr && { p: pr, fill: 'var(--year-ref)' }, pc && { p: pc, fill: 'var(--ink)' }].filter(Boolean);
      hover.selectAll('circle').data(dots).join('circle').attr('class', 'hover-dot').attr('r', 4.5)
        .style('fill', (o) => o.fill).attr('cx', x(d)).attr('cy', (o) => y(o.p.value));
      const row = (label, color, p) => tooltipRow(label, color, p ? f(p.value) : 'kein Wert');
      const diff = pr && pc ? roundShown(shown(pc.value) - shown(pr.value), isW ? 0 : 1) : null;
      return el('div', {},
        el('div', { class: 'tooltip__date' }, `${state.names.get(s.no).river_name}, ${fmtDayMonth(new Date(d))}`),
        row(String(YEARS.ref), 'var(--year-ref)', pr),
        row(String(YEARS.cur), 'var(--bg)', pc), // dunkler Punkt, weil das Fenster hell ist
        diff != null ? tooltipRow('Differenz', 'transparent', isW ? fmtCm(diff) : `${fmtSigned(diff, 1)} °C`) : null);
    },
    label: (i) => fmtDayMonth(new Date(days[i])),
  });
  finishChart(chart, { reveal: !large }); // in der grossen Ansicht sofort ganz zeigen
}

/** Die Legende: grau = 2022, weiss = 2026, orange = 2026 trockener bzw. tiefer, blau = umgekehrt */
function rainLegend() {
  return [
    el('span', {}, el('span', { class: 'swatch swatch--line', style: 'background:var(--year-ref)' }), String(YEARS.ref)),
    el('span', {}, el('span', { class: 'swatch swatch--line', style: 'background:var(--ink)' }), String(YEARS.cur)),
    el('span', {}, el('span', { class: 'swatch', style: 'background:var(--signal)' }), `${YEARS.cur} weniger Regen bzw. tiefer`),
    el('span', {}, el('span', { class: 'swatch', style: 'background:var(--cool)' }), `${YEARS.cur} mehr Regen bzw. höher`),
  ];
}

/**
 * Die Jahreszahlen 2022 und 2026 ans Ende ihrer Linien schreiben (statt einer
 * Legende). Liegen sie zu nah beieinander, rücken sie etwas auseinander,
 * damit man beide lesen kann.
 */
function drawYearLabels(g, x, y, refPts, curPts) {
  const lr = lastValue(refPts);
  const lc = lastValue(curPts);
  let yr = lr && y(lr.value);
  let yc = lc && y(lc.value);
  if (lr && lc && Math.abs(yr - yc) < 12) {
    const mid = (yr + yc) / 2;
    [yr, yc] = yr <= yc ? [mid - 6, mid + 6] : [mid + 6, mid - 6];
  }
  if (lr) g.append('text').attr('class', 'year-label year-label--ref').attr('x', x(lr.x) + 4).attr('y', yr).attr('dy', '0.35em').text(YEARS.ref);
  if (lc) g.append('text').attr('class', 'year-label').attr('x', x(lc.x) + 4).attr('y', yc).attr('dy', '0.35em').text(YEARS.cur);
}

/**
 * Ein Teil der Grafik «Regen und Pegel»: Überschrift, Achse, die zwei Linien
 * 2022 und 2026, die eingefärbte Fläche dazwischen und die Jahreszahlen.
 * Der Regen oben und der Pegel unten werden genau gleich gezeichnet,
 * deshalb gibt es dafür nur diese eine Funktion.
 * In beiden Teilen gilt: 2026 höher = blau, 2026 tiefer = orange.
 */
function drawPanel(g, defs, { x, y, refPts, curPts, top, bottom, innerW, label, ticks, format, baseline = false }) {
  g.append('text').attr('class', 'panel-label').attr('x', 0).attr('y', top - 10).text(label);
  drawValueAxis(g, y, innerW, ticks, format);
  if (baseline) g.append('line').attr('class', 'baseline').attr('x1', 0).attr('x2', innerW).attr('y1', y(0)).attr('y2', y(0));
  drawDiff(g, defs, { x, y, refPts, curPts, top, bottom, higher: 'diff--cool', lower: 'diff--warm' });
  const line = valueLine(x, y);
  g.append('path').attr('class', 'line--ref').attr('d', line(refPts));
  g.append('path').attr('class', 'line--cur').attr('d', line(curPts));
  drawYearLabels(g, x, y, refPts, curPts);
}

/**
 * Die Anmerkungen in der Grafik «Regen und Pegel»:
 * - ein heller Streifen ab 15. August, als es 2022 wieder regnete
 *   (in der grossen Grafik mit den Regenmengen beider Jahre dazu)
 * - der tiefste Tageswert von 2026 als Punkt mit Beschriftung (nur in der
 *   grossen Grafik). Es ist derselbe Wert wie im Text unter der Grafik. Weil
 *   die Linie ein 7-Tage-Mittel ist, liegt der Punkt oft etwas unter der Linie.
 */
function drawRainNotes(g, s, { x, yLevel, innerW, innerH, rainH, compact }) {
  const turnX = x(mdDate(TURN_MD));
  if (turnX < innerW) {
    g.insert('rect', ':first-child').attr('class', 'turn-band').attr('x', turnX).attr('width', innerW - turnX).attr('y', 0).attr('height', innerH);
    if (!compact) {
      g.append('text').attr('class', 'annotation').attr('x', innerW - 4).attr('y', rainH - 8).attr('text-anchor', 'end')
        .text(`ab 15. Aug.: ${YEARS.ref} ${fmt0(rainBetween(s.ref.records, TURN_MD))}, ${YEARS.cur} ${fmtMm(rainBetween(s.cur.records, TURN_MD))}`);
    }
  }

  const lowest = lowestLevel(s.cur.records);
  if (compact || !lowest) return;
  const lx = x(mdDate(lowest.date.slice(5)));
  const ly = Math.min(innerH, yLevel(lowest.water_level_deviation_cm));
  const left = lx > innerW - 190; // rechts kein Platz? Dann steht der Text links vom Punkt
  g.append('circle').attr('class', 'annotation-dot').attr('cx', lx).attr('cy', ly).attr('r', 4.5);
  g.append('text').attr('class', 'annotation').attr('x', lx + (left ? -10 : 10)).attr('y', ly).attr('dy', '0.35em')
    .attr('text-anchor', left ? 'end' : 'start').text(`tiefster Tageswert ${YEARS.cur}: ${fmtCm(lowest.water_level_deviation_cm)}`);
}

/**
 * Mit der Maus darüber: Punkte auf allen vier Linien und ein Fenster mit den
 * Werten des Tages, für den Regen und für den Pegel, jeweils mit Differenz.
 */
function attachRainTooltip(chart, g, s, { x, yRain, yLevel, innerW, innerH, margin, lines }) {
  const byX = (pts) => new Map(pts.filter((p) => p.value != null).map((p) => [+p.x, p]));
  const series = [
    { map: byX(lines.rainRef), y: yRain, fill: 'var(--year-ref)' },
    { map: byX(lines.rainCur), y: yRain, fill: 'var(--ink)' },
    { map: byX(lines.lvlRef), y: yLevel, fill: 'var(--year-ref)' },
    { map: byX(lines.lvlCur), y: yLevel, fill: 'var(--ink)' },
  ];
  const days = d3.utcDay.range(YEAR_START, d3.utcDay.offset(mdDate(state.cmp.cutoff), 1));
  const names = state.names.get(s.no);

  attachCrosshair({
    chart, g, innerW, innerH, margin,
    dockable: false,
    positions: days.map((d) => x(d)),
    render(i, hover) {
      const d = days[i];
      const [rr, rc, lr, lc] = series.map((ser) => ser.map.get(+d));
      const dots = series.map((ser, k) => ({ p: [rr, rc, lr, lc][k], ser })).filter((o) => o.p);
      hover.selectAll('circle').data(dots).join('circle').attr('class', 'hover-dot').attr('r', 4.5)
        .style('fill', (o) => o.ser.fill).attr('cx', x(d)).attr('cy', (o) => o.ser.y(o.p.value));
      // Die Differenz aus den gerundeten Werten, damit sie genau aufgeht.
      const rainDiff = rr && rc ? Math.round(rc.value) - Math.round(rr.value) : null;
      const lvlDiff = lr && lc ? roundShown(roundShown(lc.value) - roundShown(lr.value)) : null;
      return el('div', {},
        el('div', { class: 'tooltip__date' }, `${names.river_name}, bis ${fmtDayMonth(d)}`),
        el('div', { class: 'tooltip__section' }, `Regen seit 1. Januar${names.rain_station ? ` (${names.rain_station})` : ''}`),
        tooltipRow(String(YEARS.ref), 'var(--year-ref)', rr ? fmtMm(rr.value) : 'kein Wert'),
        tooltipRow(String(YEARS.cur), 'var(--bg)', rc ? fmtMm(rc.value) : 'kein Wert'), // dunkler Punkt, weil das Fenster hell ist
        rainDiff != null ? tooltipRow('Differenz', 'transparent', `${fmtSigned(rainDiff)} mm`) : null,
        el('div', { class: 'tooltip__section' }, 'Pegel an diesem Tag'),
        tooltipRow(String(YEARS.ref), 'var(--year-ref)', lr ? fmtCm(lr.value) : 'kein Wert'),
        tooltipRow(String(YEARS.cur), 'var(--bg)', lc ? fmtCm(lc.value) : 'kein Wert'),
        lvlDiff != null ? tooltipRow('Differenz', 'transparent', fmtCm(lvlDiff)) : null);
    },
    label: (i) => fmtDayMonth(days[i]),
  });
}

/**
 * Die Grafik «Regen und Pegel» für einen Fluss, mit beiden Jahren:
 * oben das Regen-Konto (Regen seit 1. Januar zusammengezählt), unten der Pegel.
 *
 * - rainMax, lvlMin, lvlMax: die Skalen (siehe rainScales).
 * - compact: kleine Version für die Datenseite.
 */
function drawRain(chart, s, { rainMax, lvlMin, lvlMax, compact = false }) {
  const small = chart.clientWidth < 560; // Handy?
  const margin = { top: 20, right: compact ? 34 : 44, bottom: 24, left: compact ? 40 : 48 };
  const frame = chartFrame(chart, margin, { minW: 60, minH: 120 });
  if (!frame) return; // noch nicht sichtbar
  const { svg, g, innerW, innerH } = frame;

  // Die Fläche aufteilen: oben das Regen-Konto, dann ein Abstand, darunter der Pegel.
  const gap = compact ? 34 : 42;
  const rainH = Math.round((innerH - gap) * 0.45);
  const levelTop = rainH + gap;

  // Die vier Linien: Regen und Pegel, je 2022 und 2026.
  const lines = {
    rainRef: rainPoints(s.ref.records), rainCur: rainPoints(s.cur.records),
    lvlRef: levelPoints(s.ref.records, YEARS.ref), lvlCur: levelPoints(s.cur.records, YEARS.cur),
  };

  // Die Umrechnungen von Werten in Pixel: x = Datum, yRain = Regen, yLevel = Pegel.
  const x = d3.scaleUtc().domain([YEAR_START, mdDate(state.cmp.cutoff)]).range([0, innerW]);
  const yRain = d3.scaleLinear().domain([0, rainMax]).nice().range([rainH, 0]);
  const yLevel = d3.scaleLinear().domain([lvlMin, lvlMax]).nice().range([innerH, levelTop]);

  const defs = svg.append('defs');

  // Oben: das Regen-Konto. Unten: der Pegel.
  drawPanel(g, defs, { x, y: yRain, refPts: lines.rainRef, curPts: lines.rainCur, top: 0, bottom: rainH, innerW,
    label: compact || small ? 'Regen seit 1. Januar, mm' : 'Regen seit 1. Januar, Tag für Tag zusammengezählt, in mm',
    ticks: compact ? 3 : 4, format: (v) => fmt0(v) });
  drawPanel(g, defs, { x, y: yLevel, refPts: lines.lvlRef, curPts: lines.lvlCur, top: levelTop, bottom: innerH, innerW,
    label: compact ? 'Pegel, cm' : small ? 'Pegel in cm, 7-Tage-Mittel' : 'Pegel, Abweichung vom Mittel in cm, 7-Tage-Mittel',
    ticks: compact ? 3 : 5, format: (v) => fmtSigned(v), baseline: true });
  drawRainNotes(g, s, { x, yLevel, innerW, innerH, rainH, compact });

  drawMonthAxis(g, x, innerH, small || compact ? 2 : 1);

  attachRainTooltip(chart, g, s, { x, yRain, yLevel, innerW, innerH, margin, lines });
  finishChart(chart, { reveal: chart.id !== 'zoom-chart' }); // in der grossen Ansicht sofort ganz zeigen
}

/* ---------- Was beim Darüberfahren und Scrollen passiert -------------- */

const DOCK_BELOW = 560; // so schmal (Handy): Werte unter der Grafik statt darüber

/**
 * Das kleine Fenster mit den Werten (der «Tooltip»), das beim Darüberfahren
 * erscheint. Bei «Selbst nachschauen» stehen die Werte auf dem Handy unter
 * der Grafik, weil das Fenster dort sonst die ganze Grafik verdecken würde.
 */
function getTooltip(chart, { dockable = false } = {}) {
  let node = [...chart.children].find((c) => c.classList.contains('tooltip'));
  if (!node) {
    node = el('div', { class: 'tooltip', role: 'status', 'aria-live': 'polite' });
    chart.append(node);
  }
  let dock = null;
  if (dockable) {
    dock = chart.nextElementSibling?.classList.contains('tooltip-dock') ? chart.nextElementSibling : null;
    if (!dock) {
      dock = el('div', { class: 'tooltip-dock', 'aria-live': 'polite' });
      chart.after(dock);
    }
  }
  const docked = () => dock && chart.clientWidth < DOCK_BELOW;
  const hint = () => dock.replaceChildren(el('p', { class: 'tooltip-dock__hint' }, 'Tippe auf die Grafik oder wische seitwärts, um die Werte zu sehen.'));
  if (dock) {
    dock.hidden = !docked();
    if (!dock.childElementCount) hint();
  }

  return {
    show(content, px, py) {
      if (docked()) {
        dock.replaceChildren(content);
        return;
      }
      node.replaceChildren(content);
      node.classList.add('is-visible');
      const cw = chart.clientWidth;
      const tw = node.offsetWidth;
      const th = node.offsetHeight;
      // Das Fenster neben den Punkt setzen, aber nie über den Rand hinaus.
      let left = px + 16;
      if (left + tw > cw) left = px - tw - 16;
      if (left < 0) left = Math.max(0, Math.min(cw - tw, px - tw / 2));
      const top = Math.max(-th / 2, Math.min(py - th / 2, chart.clientHeight - th / 2));
      node.style.transform = `translate(${left}px, ${top}px)`;
    },
    hide() {
      node.classList.remove('is-visible');
      if (docked()) hint();
    },
  };
}

/**
 * Die senkrechte Linie, die der Maus oder dem Finger folgt und beim
 * nächsten Tag einrastet. Geht auch mit der Tastatur: Pfeiltasten links und
 * rechts (mit Shift eine Woche), Esc schliesst.
 */
function attachCrosshair({ chart, g, innerW, innerH, margin, positions, render, label, dockable = true }) {
  const tooltip = getTooltip(chart, { dockable });
  const hover = g.append('g').style('display', 'none');
  const rule = hover.append('line').attr('class', 'crosshair').attr('y1', 0).attr('y2', innerH);
  const dots = hover.append('g');
  let index = null;

  const show = (i) => {
    index = Math.max(0, Math.min(positions.length - 1, i));
    const px = positions[index];
    hover.style('display', null);
    rule.attr('x1', px).attr('x2', px);
    tooltip.show(render(index, dots), px + margin.left, margin.top + innerH / 3);
    chart.setAttribute('aria-valuetext', label(index));
  };
  const hide = () => {
    hover.style('display', 'none');
    tooltip.hide();
    index = null;
  };
  const nearest = (event) => {
    const [mx] = d3.pointer(event, g.node());
    return d3.leastIndex(positions, (p) => Math.abs(p - mx));
  };

  // Eine unsichtbare Fläche über der Grafik fängt die Maus ab, damit man
  // nicht genau auf die dünne Linie zielen muss.
  g.append('rect').attr('width', innerW).attr('height', innerH).attr('fill', 'transparent')
    .style('cursor', 'crosshair')
    .on('pointermove pointerdown', (event) => show(nearest(event)))
    .on('pointerleave', (event) => { if (event.pointerType === 'mouse') hide(); });

  chart.onkeydown = (event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const step = event.shiftKey ? 7 : 1;
      show(index == null ? positions.length - 1 : index + (event.key === 'ArrowRight' ? step : -step));
    } else if (event.key === 'Escape') {
      hide();
    }
  };
  chart.onblur = hide;

  // Auf dem Handy: Tippt man neben die Grafik, verschwindet das Fenster.
  chart.hideCrosshair = hide;
  if (!chart.dataset.outsideListener) {
    chart.dataset.outsideListener = 'true';
    document.addEventListener('pointerdown', (event) => {
      if (!chart.contains(event.target)) chart.hideCrosshair();
    }, { passive: true });
  }
}

/* ==================================================================
   7) EINEN FLUSS HERVORHEBEN

   Fährt man mit der Maus über einen Fluss, wird alles andere blass.
   Ein Klick hält die Hervorhebung fest.
   ================================================================== */

/* ----- Einen Fluss auf der ganzen Seite hervorheben ----- */

/**
 * Fährt man mit der Maus über einen Fluss, wird er auf der ganzen Seite
 * hervorgehoben, und alle anderen Flüsse werden blass: in den Zahlen, in der
 * Liste, in den Grafiken und im Urteil.
 * Ein Klick hält die Hervorhebung fest. Ein zweiter Klick oder die Taste Esc
 * hebt sie wieder auf.
 *
 * Wie das geht: Alles, was zu einem Fluss gehört, ist im HTML mit seiner
 * Stationsnummer markiert (data-station="2044").
 */
function setupFocus() {
  // Maus über etwas Markiertem: diesen Fluss hervorheben.
  document.addEventListener('pointerover', (event) => {
    if (event.pointerType !== 'mouse') return;
    const target = event.target.closest('.focusable[data-station]');
    const no = target ? target.dataset.station : null;
    if (no !== state.focus.hover) {
      state.focus.hover = no;
      applyFocus();
    }
  });
  // Klick: festhalten oder loslassen.
  document.addEventListener('click', (event) => {
    const target = event.target.closest('.focusable[data-pin]');
    if (target && !event.target.closest('a, input')) togglePin(target.dataset.station);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.focus.pinned) togglePin(null);
  });
  document.getElementById('focus-pill').addEventListener('click', () => togglePin(null));
}

/** Einen Fluss festhalten, oder loslassen, wenn er schon festgehalten ist */
function togglePin(no) {
  state.focus.pinned = no === state.focus.pinned ? null : no;
  applyFocus();
}

/**
 * Die Hervorhebung anzeigen: Alles vom gewählten Fluss bleibt kräftig,
 * alles andere wird blass. Unten erscheint ein Knopf zum Aufheben.
 */
function applyFocus() {
  const active = state.focus.hover ?? state.focus.pinned;
  document.querySelectorAll('[data-station]').forEach((node) => {
    node.classList.toggle('is-dim', active != null && node.dataset.station !== active);
    node.classList.toggle('is-focus', active != null && node.dataset.station === active);
  });
  const pill = document.getElementById('focus-pill');
  if (state.focus.pinned && state.names.has(state.focus.pinned)) {
    pill.replaceChildren(keySwatch(state.focus.pinned), `${displayName(state.focus.pinned)} hervorgehoben`, el('span', { 'aria-hidden': 'true' }, '✕'));
    pill.setAttribute('aria-label', `Hervorhebung von ${displayName(state.focus.pinned)} aufheben`);
    pill.hidden = false;
  } else {
    pill.hidden = true;
  }
}

/* ==================================================================
   8) NUR DIE HAUPTSEITE (INDEX.HTML)

   Die Geschichte von oben nach unten: die Thur ganz oben, «Schätz mal!»,
   die drei grossen Zahlen, das Regen-Schätzspiel, das Urteil und die Karte
   am Schluss. Die Texte stehen im HTML; hier werden nur die Zahlen aus den
   Daten eingesetzt.
   ================================================================== */

/* ---------- «Schätz mal!»: die Kurve selbst zeichnen ------------------ */

/**
 * Man sieht die Temperatur von 2022 und den Januar 2026. Den Rest von 2026
 * zeichnet man selbst mit Maus oder Finger. Dann deckt man die echte Kurve
 * auf und sieht, wie gut man geschätzt hat.
 * Gezeichnet wird ein Punkt pro Woche.
 */
function setupDraw() {
  const ml = inGroup('mittelland');
  if (!ml.length) return;
  // Wir nehmen den Mittellandfluss mit dem grössten Unterschied bei den Tagen über 25 °C.
  const s = [...ml].sort((a, b) => delta(b, 'days_ge_25') - delta(a, 'days_ge_25'))[0];
  const start = new Date(Date.UTC(2000, 1, 1));
  const cutoff = mdDate(state.cmp.cutoff);
  const slots = d3.utcDay.range(start, cutoff, 7);
  if (+slots[slots.length - 1] !== +cutoff) slots.push(cutoff);

  // Was gezeichnet wurde, merken: ein Wert pro Woche, am Anfang alles leer.
  state.draw = { s, start, slots, guess: slots.map(() => null), revealed: false, last: null };
  setSlot('draw-river', theRiver(s.no));

  // Die drei Knöpfe: «Auflösen», «Direkt zur Lösung», «Nochmals zeichnen».
  const reveal = document.getElementById('draw-reveal');
  const skip = document.getElementById('draw-skip');
  const reset = document.getElementById('draw-reset');
  reveal.addEventListener('click', () => revealDraw());
  skip.addEventListener('click', () => revealDraw());
  reset.addEventListener('click', () => {
    state.draw.guess = slots.map(() => null);
    state.draw.revealed = false;
    document.getElementById('draw-result').replaceChildren();
    renderDraw();
  });
  renderDraw();
}

/** Die Zeichenfläche zeichnen (und nach jedem Strich neu) */
function renderDraw() {
  const d = state.draw;
  if (!d) return;
  const chart = document.getElementById('draw-chart');
  const small = chart.clientWidth < 560; // Handy?
  const frame = chartFrame(chart, { top: 16, right: small ? 14 : 24, bottom: 28, left: small ? 30 : 40 }, { minW: 80, minH: 80 });
  if (!frame) return;
  const { g, innerW, innerH } = frame;

  // Die Linien von 2022 und 2026 (7-Tage-Mittel) und die Umrechnungen:
  // x = Datum (links Januar, rechts Stichtag), y = Temperatur (unten 0 °C).
  const cutoff = d.slots[d.slots.length - 1];
  const ref = yearPoints(d.s.ref.records, YEARS.ref, 'WT', 7).filter((p) => p.x <= cutoff);
  const cur = yearPoints(d.s.cur.records, YEARS.cur, 'WT', 7);
  const top = d3.max([...ref, ...cur], (p) => p.value) ?? 25;
  const x = d3.scaleUtc().domain([YEAR_START, cutoff]).range([0, innerW]);
  const y = d3.scaleLinear().domain([0, Math.max(28, Math.ceil(top + 2))]).range([innerH, 0]);
  const line = valueLine(x, y).curve(d3.curveBasis);

  drawDrawBackground(g, d, { x, y, innerW, innerH, small });

  // Die graue Linie von 2022 mit Jahreszahl.
  g.append('path').attr('class', 'draw__ref').attr('d', line(ref));
  const refLast = lastValue(ref);
  if (refLast) g.append('text').attr('class', 'year-label year-label--ref').attr('x', x(refLast.x) - 4).attr('y', y(refLast.value) + 18).attr('text-anchor', 'end').text(YEARS.ref);

  // Der Januar 2026 ist schon gezeichnet, als Startpunkt.
  const known = cur.filter((p) => p.x == null || p.x < d.start);
  const anchor = lastValue(known);
  g.append('path').attr('class', 'draw__real').attr('d', line(known));

  // Die eigene, orange Linie und der Hinweis «Zeichne hier weiter» mit Stift.
  const guessPath = g.append('path').attr('class', `draw__guess${d.revealed ? ' is-done' : ''}`);
  const hint = g.append('g').attr('class', 'draw__hint-g')
    .attr('transform', `translate(${x(d.start) + 16},${anchor ? y(anchor.value) : innerH / 2})`);
  appendIcon(hint.append('g').attr('class', 'draw__hint-icon').attr('transform', 'translate(13,-17)'), 'pen', 26);
  hint.append('text').attr('class', 'draw__hint').attr('x', 32).attr('y', -12).text(small ? 'Hier weiterzeichnen' : 'Zeichne hier weiter, wie warm es 2026 war');

  const update = () => updateDrawGuess(d, { guessPath, hint, x, y, anchor });
  if (d.revealed) {
    revealRealLine(g, d, cur, { x, y, line });
  } else {
    enableDrawing(g, d, { x, y, innerW, innerH, update });
  }
  update();
  finishChart(chart);
}

/** Der Hintergrund der Zeichenfläche: hellblaue Zone, Achsen und die 25-°C-Linie */
function drawDrawBackground(g, d, { x, y, innerW, innerH, small }) {
  // Die hellblaue Fläche, in der man zeichnen darf.
  g.append('rect').attr('class', 'draw__zone').attr('x', x(d.start)).attr('width', innerW - x(d.start)).attr('height', innerH).attr('rx', 10);
  drawMonthAxis(g, x, innerH, small ? 2 : 1);
  drawValueAxis(g, y, innerW, small ? 4 : 6, (v) => `${fmt0(v)}°`);
  // Anmerkung: ab 25 °C wird es für Äschen gefährlich (siehe Text bei «Die Zahlen»).
  // Die Beschriftung steht links, wo die Kurve noch tief liegt.
  drawRefLine(g, y, 25, innerW, small ? '25 °C: kritisch' : '25 °C: ab hier wird es für Äschen gefährlich');
}

/**
 * Nach jedem Strich: die eigene Linie neu zeichnen und die Knöpfe anpassen.
 * «Auflösen» geht erst, wenn mindestens 60 % der Wochen gezeichnet sind.
 */
function updateDrawGuess(d, { guessPath, hint, x, y, anchor }) {
  const pts = [anchor && { x: anchor.x, value: anchor.value }, ...d.slots.map((slot, i) => ({ x: slot, value: d.guess[i] }))].filter(Boolean);
  guessPath.attr('d', valueLine(x, y).curve(d3.curveMonotoneX)(pts));
  const filled = d.guess.filter((v) => v != null).length;
  hint.style('display', filled || d.revealed ? 'none' : null);
  const reveal = document.getElementById('draw-reveal');
  reveal.disabled = d.revealed || filled < d.slots.length * 0.6;
  reveal.hidden = d.revealed;
  document.getElementById('draw-skip').hidden = d.revealed || filled > 0;
  document.getElementById('draw-reset').hidden = !d.revealed && filled === 0;
}

/** Aufgelöst: Die echte Linie von 2026 zeichnet sich langsam von links nach rechts. */
function revealRealLine(g, d, cur, { x, y, line }) {
  const rest = cur.filter((p) => p.x == null || p.x >= d3.utcDay.offset(d.start, -7));
  const real = g.append('path').attr('class', 'draw__real').attr('d', line(rest));
  const length = real.node().getTotalLength();
  if (!reducedMotion()) {
    real.attr('stroke-dasharray', `${length} ${length}`).attr('stroke-dashoffset', length)
      .transition().duration(1600).ease(d3.easeCubicOut).attr('stroke-dashoffset', 0)
      .on('end', () => real.attr('stroke-dasharray', null));
  }
  const curLast = lastValue(cur);
  if (curLast) g.append('text').attr('class', 'year-label').attr('x', x(curLast.x) - 4).attr('y', y(curLast.value) - 10).attr('text-anchor', 'end').text(YEARS.cur);
}

/**
 * Noch nicht aufgelöst: Man zeichnet mit gedrückter Maus oder mit dem Finger.
 * Wo die Maus ist, wird der Wert für die nächstgelegene Woche gesetzt.
 */
function enableDrawing(g, d, { x, y, innerW, innerH, update }) {
  const setAt = (event) => {
    const [mx, my] = d3.pointer(event, g.node());
    const i = d3.leastIndex(d.slots, (slot) => Math.abs(x(slot) - mx));
    const value = Math.max(0, Math.min(y.domain()[1], y.invert(my)));
    // Wer schnell zieht, überspringt Wochen. Die Lücke füllen wir mit einer geraden Linie.
    if (d.last != null && Math.abs(i - d.last.i) > 1) {
      const [a, b] = d.last.i < i ? [d.last, { i, value }] : [{ i, value }, d.last];
      for (let k = a.i + 1; k < b.i; k++) d.guess[k] = a.value + ((b.value - a.value) * (k - a.i)) / (b.i - a.i);
    }
    d.guess[i] = value;
    d.last = { i, value };
    update();
  };
  g.append('rect').attr('x', x(d.start) - 12).attr('width', innerW - x(d.start) + 12).attr('height', innerH)
    .attr('fill', 'transparent')
    .on('pointerdown', (event) => { event.target.setPointerCapture(event.pointerId); d.last = null; setAt(event); })
    .on('pointermove', (event) => { if ((event.buttons || event.pointerType === 'touch') && d.last) setAt(event); })
    .on('pointerup pointercancel', () => { d.last = null; });
}

/**
 * Die echte Kurve zeigen und sagen, wie gut man geschätzt hat:
 * Wir vergleichen jede gezeichnete Woche mit dem echten Wert und rechnen
 * aus, wie viele Grad man im Schnitt daneben lag.
 */
function revealDraw() {
  const d = state.draw;
  d.revealed = true;
  renderDraw();

  const cur = yearPoints(d.s.cur.records, YEARS.cur, 'WT', 7).filter((p) => p.value != null);
  const actual = (slot) => d3.least(cur, (p) => Math.abs(p.x - slot));
  const errors = d.slots.map((slot, i) => (d.guess[i] == null ? null : Math.abs(d.guess[i] - actual(slot).value))).filter((v) => v != null);
  const river = state.names.get(d.s.no).river_name;
  const dT = delta(d.s, 'wt_mean');
  const facts = [
    `${theRiver(d.s.no, true)} war ${YEARS.cur} bis ${cutoffLabel()} im Schnitt `,
    el('strong', {}, `${fmt1(Math.abs(dT))}\u00a0°C ${dT >= 0 ? 'wärmer' : 'kühler'}`),
    ` als ${YEARS.ref} und an `, el('strong', {}, `${fmt0(d.s.cur.summary.days_ge_25)}\u00a0Tagen`),
    ` über 25\u00a0°C warm (${YEARS.ref}: ${fmt0(d.s.ref.summary.days_ge_25)}\u00a0Tage).`,
  ];
  // Ein Lob je nach Treffsicherheit: unter 1 Grad, unter 2 Grad, mehr.
  let praise = [];
  if (errors.length) {
    const mean = d3.mean(errors);
    const word = mean < 1 ? 'Stark geschätzt!' : mean < 2 ? 'Gar nicht schlecht.' : `${theRiver(d.s.no, true)} hat dich überrascht.`;
    praise = [`${word} Du lagst im Schnitt `, el('strong', {}, `${fmt1(mean)}\u00a0°C`), ' daneben. '];
  }
  document.getElementById('draw-result').replaceChildren(...praise, ...facts);
}

/** Ein kleiner Fisch, gezeichnet mit einer Linie: Kopf rechts, Schwanz links */
const FISH_PATH = 'M9 0c-3-4.5-9-5-13-1.2L-8-4v8l4-2.8C0 5 6 4.5 9 0Z';

/**
 * Die Grafik ganz oben: Die Thur fliesst zweimal durchs Bild,
 * oben 2022, unten 2026.
 *
 * - Die Farbe zeigt die Wassertemperatur, Tag für Tag:
 *   blau = kalt, weiss = mittel, rot = warm.
 * - Die Sonne zeigt den heissesten Tag.
 * - Die Fische sind Dekoration. Sie schwimmen mit dem Fluss.
 * - Fährt man mit der Maus darüber, sieht man Datum und Temperatur.
 */
function renderStripes() {
  const s = state.cmp.stations.find((c) => c.no === HERO_STATION) || state.cmp.stations[0];
  const figure = document.getElementById('stripes');
  const rowsBox = document.getElementById('stripes-rows');
  if (!s) { rowsBox.replaceChildren(); return; }

  // Die Beschriftung unter der Grafik.
  const names = state.names.get(s.no);
  setSlot('ramp-min', '0 °C');
  setSlot('ramp-max', '24 °C');
  document.getElementById('stripes-caption').textContent =
    `Wassertemperatur ${ofRiver(s.no)} in ${names.station_name} pro Tag, bis ${cutoffLabel()}.`;

  const width = rowsBox.clientWidth;
  if (width < 100) return; // noch nicht sichtbar
  const small = width < 560; // Handy?
  // Was beide Flüsse gemeinsam brauchen: Grösse und Umrechnung Tag im Jahr → Position.
  const ctx = {
    width, small, height: small ? 84 : 112,
    x: d3.scaleLinear().domain([0, 366]).range([0, width]),
    tooltip: getTooltip(figure), figure, riverName: names.river_name,
  };

  // Zwei Flüsse zeichnen: oben 2022, unten 2026 (um eine halbe Welle verschoben).
  rowsBox.replaceChildren(
    drawHeroRiver(YEARS.ref, s.ref.records, 0, ctx),
    drawHeroRiver(YEARS.cur, s.cur.records, Math.PI, ctx));
  renderHeroFacts(s);

  // Die Flüsse von links nach rechts «einfliessen» lassen.
  requestAnimationFrame(() => requestAnimationFrame(() => figure.classList.add('is-drawn')));
  finishChart(rowsBox, { reveal: false }); // die Flüsse oben haben ihre eigene Bewegung
}

/**
 * Ein Fluss der Grafik ganz oben, für ein Jahr. Er schlängelt sich in Wellen
 * durchs Bild, und seine Farbe zeigt Tag für Tag die Wassertemperatur.
 * phase verschiebt die Welle, damit die zwei Flüsse nicht gleich aussehen.
 */
function drawHeroRiver(year, records, phase, ctx) {
  const { width, height, x } = ctx;
  const days = records.filter((r) => r.water_temperature_c != null);
  const river = {
    thick: height * 0.34, // wie breit der Fluss ist
    // die Mitte des Flusses an jeder Stelle: eine Sinuskurve um 62 % der Höhe
    cy: (px) => height * 0.62 + height * 0.1 * Math.sin((px / width) * Math.PI * 5 + phase),
    end: x(d3.max(days, (r) => dayIndex(r.date.slice(5))) + 1), // 2026 endet beim letzten Messtag
    id: `hero-${year}`,
  };
  const xs = [...d3.range(0, river.end, 4), river.end];

  const svg = d3.create('svg').attr('class', 'stripes__svg').attr('width', width).attr('height', height)
    .attr('role', 'img').attr('aria-label', `Wassertemperatur ${year}, ${ctx.riverName}: ${days.length} Tage`);
  // Der Farbverlauf: Für jeden Tag ein Farbpunkt, je nach Temperatur.
  const defs = svg.append('defs');
  defs.append('linearGradient').attr('id', `${river.id}-color`).attr('gradientUnits', 'userSpaceOnUse')
    .attr('x1', 0).attr('x2', width).attr('y1', 0).attr('y2', 0)
    .selectAll('stop').data(days).join('stop')
    .attr('offset', (r) => (dayIndex(r.date.slice(5)) + 0.5) / 366)
    .attr('stop-color', (r) => tempColor(r.water_temperature_c));

  // Den Fluss selbst zeichnen, mit dem Farbverlauf füllen und mit Glanz auf dem Wasser.
  const area = d3.area().x((p) => p).y0((p) => river.cy(p) - river.thick / 2).y1((p) => river.cy(p) + river.thick / 2).curve(d3.curveBasis);
  svg.append('path').attr('class', 'hero-river').attr('d', area(xs)).attr('fill', `url(#${river.id}-color)`);
  svg.append('path').attr('class', 'hero-river__shine')
    .attr('d', d3.line().x((p) => p).y((p) => river.cy(p) - river.thick * 0.2).curve(d3.curveBasis)(xs.filter((p) => p < river.end - 12)));

  addFish(svg, defs, xs, river, ctx);
  addHottestSun(svg, days, river, ctx);
  addRiverTooltip(svg, days, river, ctx);

  return el('div', { class: `stripes__row${year === YEARS.cur ? ' stripes__row--cur' : ''}` },
    el('span', { class: 'stripes__year' }, String(year)), svg.node());
}

/**
 * Drei Fische schwimmen der Mitte des Flusses entlang, versetzt gestartet.
 * Hat jemand am Computer «Bewegung reduzieren» eingestellt, gibt es keine Fische.
 */
function addFish(svg, defs, xs, river, { small }) {
  if (reducedMotion()) return;
  defs.append('path').attr('id', `${river.id}-path`).attr('d', d3.line().x((p) => p).y(river.cy).curve(d3.curveBasis)(xs));
  const duration = small ? 16 : 26;
  [0, 0.36, 0.71].forEach((offset, k) => {
    svg.append('path').attr('class', 'hero-fish').attr('d', FISH_PATH).attr('transform', `scale(${k === 1 ? 0.8 : 1})`)
      .append('animateMotion').attr('dur', `${duration}s`).attr('repeatCount', 'indefinite').attr('rotate', 'auto')
      .attr('begin', `-${(offset * duration).toFixed(1)}s`)
      .append('mpath').attr('href', `#${river.id}-path`);
  });
}

/** Die Sonne über dem heissesten Tag, mit der Temperatur daneben */
function addHottestSun(svg, days, river, { x, width, small }) {
  const hot = hottestDay(days.filter((r) => r.date.slice(5) <= state.cmp.cutoff));
  if (!hot) return;
  const hx = x(dayIndex(hot.date.slice(5)) + 0.5);
  const right = hx > width - (small ? 150 : 190); // Kein Platz mehr rechts? Dann steht der Text links.
  const sun = svg.append('g').attr('class', 'hero-sun')
    .attr('transform', `translate(${hx},${Math.max(13, river.cy(hx) - river.thick / 2 - 22)})`);
  appendIcon(sun, 'sun', 24);
  sun.append('text').attr('x', right ? -18 : 18).attr('dy', '0.35em').attr('text-anchor', right ? 'end' : 'start')
    .text(`Heissester Tag: ${fmtTemp(hot.water_temperature_c)}`);
}

/** Mit der Maus darüber: Ein Punkt erscheint auf dem Fluss, dazu Datum und Temperatur. */
function addRiverTooltip(svg, days, river, { x, tooltip, figure }) {
  const dot = svg.append('circle').attr('class', 'hero-dot').attr('r', 5).style('display', 'none');
  const byDay = new Map(days.map((r) => [dayIndex(r.date.slice(5)), r]));
  const hide = () => { tooltip.hide(); dot.style('display', 'none'); };
  svg.on('pointermove', (event) => {
    const r = byDay.get(Math.floor(x.invert(d3.pointer(event)[0])));
    if (!r) { hide(); return; }
    const px = x(dayIndex(r.date.slice(5)) + 0.5);
    dot.style('display', null).attr('cx', px).attr('cy', river.cy(px));
    const box = event.currentTarget.getBoundingClientRect();
    const fb = figure.getBoundingClientRect();
    tooltip.show(el('div', {},
      el('div', { class: 'tooltip__date' }, fmtDateTooltip(parseDate(r.date))),
      el('div', {}, `${r.river_name}: `, el('strong', {}, fmtTemp(r.water_temperature_c)))),
    px + box.left - fb.left, box.top - fb.top + river.cy(px) - 40);
  }).on('pointerleave', hide);
}

/** Der Satz unter den Flüssen: an wie vielen Tagen über 20 °C, 2026 und 2022 */
function renderHeroFacts(s) {
  const box = document.getElementById('stripes-facts');
  const cur = s.cur.summary.days_ge_20;
  const ref = s.ref.summary.days_ge_20;
  box.replaceChildren(icon('sun'),
    el('span', {}, `${YEARS.cur} war ${theRiver(s.no)} an `, el('strong', {}, `${fmt0(cur)}\u00a0Tagen`),
      ` über 20\u00a0°C warm, ${YEARS.ref} an ${fmt0(ref)}.`));
}

/* ---------- Zahlen in den Texten der Story ---------------------------- */

/**
 * Die Texte der Story enthalten einige Zahlen. Sie stehen nicht fest im
 * HTML, sondern werden hier aus den Daten berechnet. So stimmt der Text auch
 * nach jedem neuen Import.
 * - Einstieg: bis zu welchem Tag die Daten von 2026 reichen
 * - «Die Zahlen»: an wie vielen Tagen ein Mittellandfluss 25 °C oder mehr hatte
 */
function renderStoryText() {
  setSlot('cutoff-label', cutoffLabel());

  // Der Mittellandfluss mit den meisten Tagen ab 25 °C im Jahr 2026.
  const s = [...inGroup('mittelland')].sort((a, b) => b.cur.summary.days_ge_25 - a.cur.summary.days_ge_25)[0];
  if (!s) return;
  const cur = s.cur.summary.days_ge_25;
  const ref = s.ref.summary.days_ge_25;
  const normal = normalOf([s.no], 'days_ge_25');
  setSlot('hot-river', theRiver(s.no, true));
  setSlot('hot-days-cur', fmt0(cur));
  setSlot('hot-days-ref', fmt0(ref));
  // Welcher Schluss-Satz gilt: mehr, gleich viele oder weniger Tage als 2022?
  showWhen('hot-more', cur > ref);
  showWhen('hot-equal', cur === ref);
  showWhen('hot-less', cur < ref);
  // Der Vergleich mit dem Durchschnitt 2020–2025, falls vorhanden.
  showWhen('hot-normal', normal != null);
  if (normal != null) setSlot('hot-days-normal', fmt0(normal));
}

/* ---------- Die drei grossen Zahlen ----------------------------------- */

/**
 * Drei Karten mit je einer grossen Zahl: heisse Tage, wärmer, tiefer.
 * Für jede Karte nehmen wir den Mittellandfluss mit dem deutlichsten
 * Unterschied, und zwar drei verschiedene Flüsse.
 * Den Regen gibt es hier absichtlich nicht: Den schätzt man erst in
 * Abschnitt 3, und die Zahl hier würde die Lösung verraten.
 */
function renderStats() {
  const box = document.getElementById('stats');
  const ml = inGroup('mittelland');
  if (!ml.length) { box.replaceChildren(el('p', { class: 'muted' }, 'Keine Vergleichsdaten.')); return; }
  const cutoff = cutoffLabel();
  setSlot('stats-lead', `Limmat, Thur und Rhein, jeweils vom 1. Januar bis ${cutoff}. Gross die Zahl für ${YEARS.cur}, darunter ${YEARS.ref} und der Schnitt der Jahre ${NORMAL_LABEL}.`);

  // Den passenden Fluss aussuchen, ohne einen Fluss zweimal zu nehmen.
  const used = new Set();
  const pick = (score) => {
    const ranked = [...ml].sort((x, y) => score(y) - score(x));
    const choice = ranked.find((s) => !used.has(s.no)) || ranked[0];
    used.add(choice.no);
    return choice;
  };
  const hot = pick((s) => delta(s, 'days_ge_25'));
  const warmest = pick((s) => delta(s, 'wt_mean'));
  const lowest = pick((s) => -delta(s, 'w_mean'));

  // Der Vergleich mit dem Durchschnitt 2020–2025, falls vorhanden.
  const normal = (s, key, f) => {
    const v = normalOf([s.no], key);
    return v == null ? '' : ` · Schnitt ${NORMAL_LABEL}: ${f(v)}`;
  };

  // Eine Karte: Symbol, Fluss, grosse Zahl, Erklärung, Vergleich mit 2022.
  const tile = (s, symbol, number, unit, label, ref) => el('article', { class: 'stat focusable', 'data-station': s.no, 'data-pin': '' },
    icon(symbol, 'icon stat__icon'),
    el('div', { class: 'stat__river' }, keySwatch(s.no), displayName(s.no)),
    el('span', { class: 'stat__value' }, number, el('small', {}, unit)),
    el('p', { class: 'stat__label' }, label),
    el('p', { class: 'stat__ref' }, ref));

  box.replaceChildren(
    tile(hot, 'sun', fmt0(hot.cur.summary.days_ge_25), 'Tage',
      'mit einem Tagesmittel von 25\u00a0°C oder mehr',
      `${YEARS.ref}: ${fmt0(hot.ref.summary.days_ge_25)} Tage${normal(hot, 'days_ge_25', (v) => `${fmt0(v)} Tage`)}`),
    tile(warmest, 'thermo', fmtSigned(delta(warmest, 'wt_mean'), 1), '°C',
      `wärmer als ${YEARS.ref}, im Mittel über alle Tage`,
      `${fmtTemp(warmest.ref.summary.wt_mean)} → ${fmtTemp(warmest.cur.summary.wt_mean)}${normal(warmest, 'water_temperature_mean_c', fmtTemp)}`),
    tile(lowest, 'waveDown', fmtSigned(delta(lowest, 'w_mean')), 'cm',
      `tieferer Wasserstand als ${YEARS.ref}, im Mittel`,
      `${fmtCm(lowest.ref.summary.w_mean)} → ${fmtCm(lowest.cur.summary.w_mean)}${normal(lowest, 'water_level_deviation_mean_cm', fmtCm)}`),
  );
  applyFocus();
}

/* ----- Regen und Pegel auf der Story-Seite ----- */

/**
 * Einmal beim Start: die Knöpfe für die drei Mittellandflüsse bauen und
 * dann alles zeichnen. Ohne Regendaten erscheint ein kurzer Hinweis.
 */
function setupRain() {
  const box = document.getElementById('rain-river-switch');
  if (!box) return;
  const ml = inGroup('mittelland');
  if (!ml.some((s) => s.no === state.rain.no)) state.rain.no = ml[0]?.no;
  box.replaceChildren(...ml.map((s) => el('button', {
    type: 'button', role: 'radio', 'aria-checked': String(s.no === state.rain.no), 'data-no': s.no,
  }, state.names.get(s.no).river_name)));
  // Jeder Fluss hat seine eigene Schätzung. Beim Wechseln bleibt sie gespeichert.
  setupSegmented('rain-river-switch', 'no', (no) => { state.rain.no = no; renderRain(); });
  renderRain();
}

/**
 * Die Schätzung für einen Fluss. Gibt es noch keine, wird eine leere angelegt:
 * - value: die geschätzten Millimeter (null = noch nicht geschätzt)
 * - revealed: schon aufgelöst?
 * - animate: soll der Becher gleich von der Schätzung zum echten Wert gleiten?
 */
function guessOf(no) {
  if (!state.rainGuess[no]) state.rainGuess[no] = { value: null, revealed: false, animate: false };
  return state.rainGuess[no];
}

/**
 * Titel, Einleitung, Messbecher und Grafik für den gewählten Fluss.
 *
 * Zuerst wird geschätzt: Man sieht nur den Regen von 2022 und füllt den
 * Becher von 2026 selbst. Titel und Einleitung verraten das Ergebnis
 * noch nicht, und die Grafik ist verschwommen. Erst nach «Auflösen»
 * erscheint alles (siehe revealRainGuess).
 */
function renderRain() {
  const chart = document.getElementById('rain-chart');
  if (!chart || !state.cmp) return;
  const ml = inGroup('mittelland');
  const s = ml.find((c) => c.no === state.rain.no);
  if (!s || !hasRain()) {
    document.getElementById('rain-gauges').replaceChildren(el('p', { class: 'muted' }, 'Für den Regen sind noch keine Daten gespeichert.'));
    return;
  }
  const names = state.names.get(s.no);
  const guess = guessOf(s.no);

  // Auf den Fluss-Knöpfen ein Häkchen bei allen Flüssen, die schon aufgelöst sind.
  document.querySelectorAll('#rain-river-switch button').forEach((button) => {
    const solved = guessOf(button.dataset.no).revealed;
    button.textContent = `${state.names.get(button.dataset.no).river_name}${solved ? ' ✓' : ''}`;
  });

  if (!guess.revealed) {
    // Noch nicht aufgelöst: Frage statt Ergebnis.
    setSlot('rain-title', `Wie viel Regen fiel ${YEARS.cur}?`);
    setSlot('rain-lead', [
      `Im Hitzesommer-Jahr ${YEARS.ref} fielen in ${names.rain_station ?? 'der Region'} vom 1. Januar bis ${cutoffLabel()} `,
      el('strong', {}, fmtMm(s.ref.summary.rain_sum)), ` Regen, im Gebiet ${ofRiver(s.no)}. Und ${YEARS.cur}? `,
      'Zieh den rechten Messbecher auf deine Schätzung.',
    ]);
  } else {
    // Aufgelöst: Titel und Text zeigen nur das Ergebnis dieses Flusses, damit
    // die anderen Flüsse noch nicht verraten werden. Der Titel hängt vom
    // Ergebnis ab, damit er auch dann stimmt, wenn sich die Daten ändern.
    const change = rainChange([s]);
    const shown = roundShown(change);
    setSlot('rain-title', change <= -10 ? 'Der Regen fehlte' : change >= 10 ? 'Am Regen lag es nicht' : 'Etwa gleich viel Regen');

    // Erst wenn alle drei Flüsse aufgelöst sind, kommt die Zahl fürs ganze Mittelland.
    const allSolved = ml.every((c) => guessOf(c.no).revealed);
    const total = roundShown(rainChange(ml));
    setSlot('rain-lead', [
      `Vom 1. Januar bis ${cutoffLabel()} fielen in ${names.rain_station ?? 'der Region'} ${YEARS.cur} ${fmtMm(s.cur.summary.rain_sum)} Regen, `,
      el('strong', {}, shown === 0 ? 'gleich viel' : `${fmt0(Math.abs(shown))}\u00a0% ${shown < 0 ? 'weniger' : 'mehr'}`),
      ` als im Hitzesommer-Jahr ${YEARS.ref}. `,
      allSolved
        ? [`Im ganzen Gebiet von Limmat, Thur und Rhein waren es `,
          el('strong', {}, total === 0 ? 'gleich viel' : `${fmt0(Math.abs(total))}\u00a0% ${total < 0 ? 'weniger' : 'mehr'}`), '. ',
          'Weniger Regen heisst weniger Wasser für die Flüsse. Ganz aufgehen muss die Rechnung aber nicht: Auch Seen, Schneeschmelze und Verdunstung reden mit.']
        : 'Probier auch die anderen Flüsse.',
    ].flat());
  }

  // Die Grafik bleibt verschwommen, bis aufgelöst ist.
  document.querySelector('.rain__main').classList.toggle('is-locked', !guess.revealed);
  renderGauges(s);
  drawRainChart();
  renderRainTurn(s);
}

/**
 * Der Text unter der Grafik, sobald ein Fluss aufgelöst ist: Was zeigt das
 * Regen-Konto? Wann liefen die Jahre auseinander, und wann stand der Fluss
 * am tiefsten? Alle Zahlen kommen aus den Daten dieses Flusses.
 */
function renderRainTurn(s) {
  const box = document.getElementById('rain-turn');
  if (!box) return;
  box.hidden = !guessOf(s.no).revealed;
  if (box.hidden) return;

  const early = [rainBetween(s.ref.records, '01-01', '08-14'), rainBetween(s.cur.records, '01-01', '08-14')];
  const late = [rainBetween(s.ref.records, TURN_MD), rainBetween(s.cur.records, TURN_MD)];
  const lowRef = lowestLevel(s.ref.records);
  const lowCur = lowestLevel(s.cur.records);

  setSlot('turn-station', state.names.get(s.no).rain_station ?? 'der Region');
  setSlot('turn-early-ref', fmtMm(early[0]));
  setSlot('turn-early-cur', fmtMm(early[1]));
  setSlot('turn-late-ref', fmtMm(late[0]));
  setSlot('turn-late-cur', fmtMm(late[1]));
  // Von einer «Wende» sprechen wir nur, wenn 2022 ab Mitte August deutlich mehr Regen fiel.
  const turn = late[0] > late[1] * 1.3;
  showWhen('turn', turn);
  showWhen('no-turn', !turn);

  showWhen('turn-level', Boolean(lowRef && lowCur));
  if (!lowRef || !lowCur) return;
  setSlot('turn-river', theRiver(s.no));
  setSlot('low-ref-date', fmtDayMonth(parseDate(lowRef.date)));
  setSlot('low-ref', fmtCm(lowRef.water_level_deviation_cm));
  setSlot('low-cur-date', fmtDayMonth(parseDate(lowCur.date)));
  setSlot('low-cur', fmtCm(lowCur.water_level_deviation_cm));
  // Lag der tiefste Punkt 2026 erst im Herbst, 2022 aber noch im Sommer: Der Fluss hat sich 2026 nicht erholt.
  showWhen('no-recovery', lowCur.date.slice(5) >= '09-01' && lowRef.date.slice(5) < '09-01');
}

/**
 * Wie hoch ist ein ganzer Becher? Etwas mehr als der Regen von 2022, damit
 * man beim Schätzen auch «mehr als 2022» wählen kann. Nur wenn 2026 noch
 * viel mehr Regen fiel, wird der Becher grösser.
 */
const gaugeMax = (s) => Math.max(s.ref.summary.rain_sum * 1.6, s.cur.summary.rain_sum * 1.05) || 1;

/**
 * Die zwei Messbecher: Wie viel Regen ist bis zum Stichtag gefallen?
 * Vor dem Auflösen ist der Becher von 2026 leer und lässt sich mit der
 * Maus, dem Finger oder den Pfeiltasten füllen.
 */
function renderGauges(s) {
  const box = document.getElementById('rain-gauges');
  const names = state.names.get(s.no);
  const guess = guessOf(s.no);
  const ref = s.ref.summary.rain_sum;
  const cur = s.cur.summary.rain_sum;
  const max = gaugeMax(s);
  const pct = (v) => `${Math.min(100, (v / max) * 100)}%`;

  // Ein Becher: Zahl oben, Glas in der Mitte, Jahr unten.
  const gauge = (year, value, extra = {}) => el('div', { class: `gauge ${year === YEARS.cur ? 'gauge--cur' : 'gauge--ref'}` },
    el('span', { class: 'gauge__value' }, value == null ? '?' : fmt0(value), value == null ? null : el('small', {}, 'mm')),
    el('span', { class: 'gauge__tube', 'aria-hidden': 'true', ...extra.tube },
      el('span', { class: 'gauge__fill', style: `--fill:${value == null ? '0%' : pct(value)}` }),
      extra.marker ?? null),
    el('span', { class: 'gauge__year' }, String(year)));

  const title = el('p', { class: 'gauges__title' }, `Regen in ${names.rain_station ?? 'der Region'}`, el('small', {}, `1. Januar bis ${cutoffLabel()}`));

  if (!guess.revealed) {
    // Schätzen: Der Becher von 2026 ist ein Schieberegler.
    const curGauge = gauge(YEARS.cur, guess.value, {
      tube: { 'aria-hidden': 'false', role: 'slider', tabindex: '0', class: 'gauge__tube gauge__tube--input',
        'aria-label': `Deine Schätzung für ${YEARS.cur} in Millimetern`,
        'aria-valuemin': '0', 'aria-valuemax': String(Math.round(max)), 'aria-valuenow': String(guess.value ?? 0) },
    });
    curGauge.classList.add('is-guess');
    const reveal = el('button', { type: 'button', class: 'btn btn--primary' }, 'Auflösen');
    reveal.disabled = guess.value == null;
    reveal.addEventListener('click', () => revealRainGuess(s));
    const skip = el('button', { type: 'button', class: 'tip__skip' }, 'Direkt zur Lösung');
    skip.addEventListener('click', () => revealRainGuess(s));

    box.replaceChildren(title,
      el('div', { class: 'gauges__row' }, gauge(YEARS.ref, ref), curGauge),
      el('p', { class: 'gauges__hint' }, guess.value == null ? '↑ Becher von unten nach oben ziehen' : 'Passt? Dann auflösen.'),
      el('div', { class: 'gauges__actions' }, reveal, skip));
    setupGuessInput(curGauge, s, max);
  } else {
    // Aufgelöst: echter Wert, dazu ein Strich bei der eigenen Schätzung.
    const mine = guess.value != null; // hat man geschätzt oder direkt aufgelöst?
    const marker = mine ? el('span', { class: 'gauge__marker', style: `--at:${pct(guess.value)}` }, el('small', {}, 'Dein Tipp')) : null;
    const change = ref > 0 ? roundShown(((cur - ref) / ref) * 100) : null;
    box.replaceChildren(title,
      el('div', { class: 'gauges__row' }, gauge(YEARS.ref, ref), gauge(YEARS.cur, cur, { marker })),
      change != null ? el('p', { class: 'gauges__delta' }, el('strong', {}, `${fmtSigned(change)} %`), ` ${YEARS.cur} gegenüber ${YEARS.ref}`) : null,
      mine ? el('p', { class: 'gauges__result', 'aria-live': 'polite' }, guessFeedback(guess.value, cur)) : null);
  }

  // Gerade aufgelöst: Der Becher startet bei der eigenen Schätzung und
  // steigt oder sinkt dann auf den echten Wert.
  if (guess.revealed && guess.animate) {
    guess.animate = false;
    const fill = box.querySelector('.gauge--cur .gauge__fill');
    if (guess.value != null) {
      fill.style.setProperty('--fill', pct(guess.value));
      requestAnimationFrame(() => requestAnimationFrame(() => fill.style.setProperty('--fill', pct(cur))));
    }
  }

  // Die Becher füllen sich langsam, sobald man hinscrollt (das CSS macht die Bewegung).
  revealOnScroll(box);
}

/**
 * Den Becher von 2026 bedienbar machen:
 * - Maus oder Finger: drücken und nach oben oder unten ziehen.
 * - Tastatur: Pfeil hoch/runter (10 mm), Bild hoch/runter (50 mm).
 * Die Schätzung wird auf 10 mm gerundet.
 */
function setupGuessInput(gaugeNode, s, max) {
  const tube = gaugeNode.querySelector('.gauge__tube');
  const fill = gaugeNode.querySelector('.gauge__fill');
  const label = gaugeNode.querySelector('.gauge__value');
  const box = document.getElementById('rain-gauges');

  const set = (value) => {
    const v = Math.max(0, Math.min(max, Math.round(value / 10) * 10));
    const guess = guessOf(s.no);
    const first = guess.value == null;
    guess.value = v;
    fill.style.setProperty('--fill', `${(v / max) * 100}%`);
    label.replaceChildren(fmt0(v), el('small', {}, 'mm'));
    tube.setAttribute('aria-valuenow', String(v));
    tube.setAttribute('aria-valuetext', fmtMm(v));
    // Nach der ersten Schätzung: «Auflösen» freigeben und den Hinweis ändern.
    if (first) {
      box.querySelector('.btn--primary').disabled = false;
      box.querySelector('.gauges__hint').textContent = 'Passt? Dann auflösen.';
    }
  };
  // Wo im Glas ist die Maus? Unten = 0 mm, oben = voll.
  const fromPointer = (event) => {
    const r = tube.getBoundingClientRect();
    set(((r.bottom - event.clientY) / r.height) * max);
  };

  tube.addEventListener('pointerdown', (event) => {
    tube.setPointerCapture(event.pointerId);
    box.classList.add('is-dragging'); // während des Ziehens ohne Verzögerung füllen
    fromPointer(event);
  });
  tube.addEventListener('pointermove', (event) => { if (tube.hasPointerCapture(event.pointerId)) fromPointer(event); });
  tube.addEventListener('pointerup', () => box.classList.remove('is-dragging'));
  tube.addEventListener('pointercancel', () => box.classList.remove('is-dragging'));
  tube.addEventListener('keydown', (event) => {
    const step = { ArrowUp: 10, ArrowRight: 10, ArrowDown: -10, ArrowLeft: -10, PageUp: 50, PageDown: -50 }[event.key];
    if (!step) return;
    event.preventDefault();
    set((guessOf(s.no).value ?? 0) + step);
  });
}

/** Auflösen: Ergebnis zeigen, Titel und Grafik freigeben */
function revealRainGuess(s) {
  const guess = guessOf(s.no);
  guess.revealed = true;
  guess.animate = true;
  document.getElementById('rain-gauges').classList.add('is-visible');
  renderRain();
}

/** Wie gut war die Schätzung? Ein Satz mit Lob und den echten Zahlen. */
function guessFeedback(value, actual) {
  const off = Math.abs(value - actual);
  const rel = actual > 0 ? off / actual : 1;
  const word = rel < 0.1 ? 'Volltreffer!' : rel < 0.25 ? 'Gar nicht schlecht.' : 'Daneben – das hat dich überrascht.';
  return [`${word} Du hast `, el('strong', {}, fmtMm(value)), ' geschätzt, es waren ',
    el('strong', {}, fmtMm(actual)), `. Das sind ${fmtMm(off)} ${value > actual ? 'zu viel' : value < actual ? 'zu wenig' : 'Unterschied'}.`];
}

/** Nur die Grafik neu zeichnen (z.B. wenn das Fenster die Grösse ändert) */
function drawRainChart() {
  const chart = document.getElementById('rain-chart');
  const s = state.cmp && inGroup('mittelland').find((c) => c.no === state.rain.no);
  if (!chart || !s || !hasRain()) return;
  const names = state.names.get(s.no);
  document.getElementById('rain-legend').replaceChildren(...rainLegend());
  document.getElementById('rain-note').textContent =
    `Oben: Regen in ${names.rain_station ?? 'der Region'} (MeteoSchweiz), vom 1. Januar an zusammengezählt. ` +
    'Je weiter die Linien auseinandergehen, desto grösser der Unterschied. ' +
    `Unten: Pegel ${ofRiver(s.no)} in ${names.station_name} (BAFU), 7-Tage-Mittel, Abweichung vom mittleren Pegel seit 2020.`;
  drawRain(chart, s, rainScales([s]));
}

/* ---------- Das Urteil: Stimmt die These? ----------------------------- */

// War ein Fluss 2026 wärmer bzw. tiefer? Wir entscheiden mit den angezeigten,
// gerundeten Zahlen. «+0.0 °C» zählt also nicht als wärmer.
const isWarmer = (s) => roundShown(delta(s, 'wt_mean'), 1) > 0;

const isLower = (s) => roundShown(delta(s, 'w_mean')) < 0;

/**
 * Das Urteil: «Ja», wenn alle drei Mittellandflüsse wärmer UND tiefer waren.
 * «Teilweise», wenn wenigstens etwas davon zutrifft. Sonst «Nein».
 * Dazu ein Satz, der das Urteil begründet.
 */
function verdictOf(cmp) {
  const ml = inGroup('mittelland', cmp);
  const cutoff = cutoffLabel(cmp);
  const both = ml.filter((s) => isWarmer(s) && isLower(s)).length;
  if (both === ml.length) {
    return { word: 'Ja', cls: 'is-yes',
      lead: `Limmat, Thur und Rhein waren ${YEARS.cur} bis ${cutoff} im Mittel wärmer und lagen tiefer als im Hitzesommer ${YEARS.ref}.` };
  }
  if (ml.some((s) => isWarmer(s) || isLower(s))) {
    return { word: 'Teilweise', cls: 'is-partial',
      lead: `${both} von ${ml.length} Mittelland-Flüssen waren ${YEARS.cur} wärmer und tiefer als ${YEARS.ref}.` };
  }
  return { word: 'Nein', cls: 'is-no',
    lead: `Keiner der Mittelland-Flüsse war ${YEARS.cur} bis ${cutoff} wärmer und tiefer als ${YEARS.ref}.` };
}

/** Das Urteil anzeigen: das grosse Wort und die Tabelle mit allen sechs Flüssen */
function renderVerdict(cmp = state.cmp) {
  const box = document.getElementById('verdict');
  const ml = inGroup('mittelland', cmp);
  const al = inGroup('alpen', cmp);
  if (!ml.length) { box.replaceChildren(el('p', { class: 'muted' }, 'Keine Vergleichsdaten.')); return; }
  const cutoff = cutoffLabel(cmp);
  const warm = isWarmer;
  const low = isLower;
  const { word, cls, lead } = verdictOf(cmp);
  renderVerdictMeaning(cmp, word);

  const pct = (s) => (s.cur.summary.count ? `${fmt0((s.cur.summary.checked / s.cur.summary.count) * 100)} %` : '–');
  // Der Regen gehört nicht zur These, hilft aber beim Erklären: wie viel Prozent mehr oder weniger als 2022.
  const rain = (s) => {
    const change = rainChange([s]);
    return change == null ? '–' : `${fmtSigned(roundShown(change))} %`;
  };
  // Ein voller Kreis heisst «ja», ein leerer «nein». Daneben steht es auch als Wort,
  // damit es nicht nur an der Farbe hängt (wichtig z.B. bei Farbenblindheit).
  const cell = (ok, yes, no, value) => el('td', {}, el('span', { class: 'cell' },
    el('span', { class: `sq${ok ? ' is-yes' : ''}`, 'aria-hidden': 'true' }), el('b', {}, ok ? yes : no), el('small', {}, value)));
  const row = (s, control) => el('tr', { class: `focusable${control ? ' is-control' : ''}`, 'data-station': s.no, 'data-pin': '' },
    el('th', { scope: 'row' }, keySwatch(s.no), displayName(s.no)),
    cell(warm(s), 'wärmer', 'nicht wärmer', `${fmtSigned(delta(s, 'wt_mean'), 1)} °C`),
    cell(low(s), 'tiefer', 'nicht tiefer', fmtCm(delta(s, 'w_mean'))),
    el('td', { class: 'matrix__rain' }, rain(s)),
    el('td', {}, pct(s)));

  box.replaceChildren(
    el('div', { class: 'verdict__answer' },
      el('span', { class: `verdict__word ${cls}` }, word, el('sup', {}, '*')),
      el('p', { class: 'verdict__lead' }, lead)),
    el('div', { class: 'table-scroll' }, el('table', { class: 'matrix' },
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col' }, 'Fluss'),
        el('th', { scope: 'col' }, `Temperatur vs. ${YEARS.ref}`),
        el('th', { scope: 'col' }, `Pegel vs. ${YEARS.ref}`),
        el('th', { scope: 'col' }, `Regen vs. ${YEARS.ref}`),
        el('th', { scope: 'col' }, `Geprüfte Tage ${YEARS.cur}`))),
      el('tbody', {},
        el('tr', { class: 'group-row' }, el('th', { colspan: '5', scope: 'rowgroup' }, 'Mittelland · These')),
        ml.map((s) => row(s, false)),
        al.length ? el('tr', { class: 'group-row' }, el('th', { colspan: '5', scope: 'rowgroup' }, 'Alpen · Kontrollgruppe')) : null,
        al.map((s) => row(s, true))))),
    el('p', { class: 'verdict__footnote' }, el('sup', {}, '* '),
      `Verglichen werden die Mittelwerte vom 1. Januar bis ${cutoff}. Viele Werte von ${YEARS.cur} sind vom BAFU noch nicht geprüft, und das Jahr ist nicht vorbei. `,
      'Die Alpenflüsse gehören nicht zur These. Sie zeigen, dass Schmelzwasser anders auf einen heissen Sommer reagiert. ',
      'Der Regen (MeteoSchweiz) zählt nicht fürs Urteil, er hilft nur beim Erklären.'));
  applyFocus();
}

/**
 * Der erste Satz der Einordnung unter dem Urteil. Er passt sich dem Urteil an
 * und erwähnt den Spätsommer nur, wenn die Daten das hergeben.
 */
function renderVerdictMeaning(cmp, word) {
  const ml = inGroup('mittelland', cmp);
  const nos = ml.map((s) => s.no);

  // Der erste Satz passt zum Urteil: Ja, Teilweise oder Nein.
  for (const w of ['Ja', 'Teilweise', 'Nein']) showWhen(`verdict-${w}`, w === word);

  // Den Spätsommer erwähnen wir nur, wenn 2022 ab Mitte August deutlich mehr Regen fiel.
  const lateRef = d3.sum(ml, (s) => rainBetween(s.ref.records, TURN_MD));
  const lateCur = d3.sum(ml, (s) => rainBetween(s.cur.records, TURN_MD));
  showWhen('verdict-turn', lateRef > lateCur * 1.3);

  // Der zweite Massstab: der Durchschnitt der Jahre 2020 bis 2025 im Mittelland.
  const temp = [normalOf(nos, 'water_temperature_mean_c'), normalOf(nos, 'water_temperature_mean_c', YEARS.cur)];
  const level = [normalOf(nos, 'water_level_deviation_mean_cm'), normalOf(nos, 'water_level_deviation_mean_cm', YEARS.cur)];
  const rain = [normalOf(nos, 'precipitation_sum_mm'), normalOf(nos, 'precipitation_sum_mm', YEARS.cur)];
  const complete = [...temp, ...level, ...rain].every((v) => v != null);
  showWhen('normal', complete);
  if (!complete) return;
  setSlot('normal-temp', fmtTemp(temp[0]));
  setSlot('normal-temp-cur', fmtTemp(temp[1]));
  setSlot('normal-level', fmtCm(level[0]));
  setSlot('normal-level-cur', fmtCm(level[1]));
  const rainChangePct = roundShown(((rain[1] - rain[0]) / rain[0]) * 100);
  setSlot('normal-rain', `${fmt0(Math.abs(rainChangePct))}\u00a0% ${rainChangePct < 0 ? 'weniger' : 'mehr'}`);

  // War 2026 bisher das wärmste, tiefste und trockenste Jahr seit 2020? Dann sagen wir das.
  const years = [...new Set(state.summary.map((r) => r.year))].filter((y) => y < YEARS.cur);
  const extreme = years.length > 0 && years.every((y) =>
    normalOf(nos, 'water_temperature_mean_c', y) < temp[1]
    && normalOf(nos, 'water_level_deviation_mean_cm', y) > level[1]
    && normalOf(nos, 'precipitation_sum_mm', y) > rain[1]);
  showWhen('normal-extreme', extreme);
}

/* ----- Zuerst tippen, dann das Urteil ----- */

/**
 * Bevor man das Urteil sieht, tippt man selbst: Ja, Teilweise oder Nein.
 * Danach erscheint das echte Urteil, und die Seite sagt, ob der Tipp stimmte.
 * Wer nicht tippen mag, klickt auf «Ohne Tipp zum Ergebnis».
 */
function setupTip() {
  const tip = document.getElementById('verdict-tip');
  const body = document.getElementById('verdict-body');
  const feedback = document.getElementById('tip-feedback');
  tip.querySelectorAll('[data-tip]').forEach((button) => button.addEventListener('click', () => {
    const guess = button.dataset.tip;
    const { word } = verdictOf(state.cmp);
    tip.hidden = true;
    body.hidden = false;
    if (guess) {
      const right = guess === word;
      feedback.className = `tip-feedback${right ? ' is-right' : ''}`;
      feedback.textContent = right ? `Dein Tipp «${guess}» stimmt!` : `Dein Tipp war «${guess}». Die Daten sagen «${word}».`;
      feedback.hidden = false;
    }
    body.focus();
  }));
}

/* ----- Die Karte «Alle Daten ansehen» am Ende der Story ----- */

/**
 * Fährt man mit der Maus über die Karte, folgt ihr ein weicher Lichtschein.
 * Hier merken wir uns nur, wo die Maus gerade ist (in Prozent der Karte).
 * Das Zeichnen des Scheins übernimmt das CSS (.more::before).
 */
function setupMoreGlow() {
  const card = document.querySelector('.more');
  if (!card) return;
  card.addEventListener('pointermove', (event) => {
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${((event.clientX - r.left) / r.width) * 100}%`);
    card.style.setProperty('--my', `${((event.clientY - r.top) / r.height) * 100}%`);
  });
}

/* ==================================================================
   9) NUR DIE DATENSEITE (DATEN.HTML)

   Die sechs Messstellen, «Wer hat mehr geschwitzt?», «Regen und Pegel» pro
   Fluss, die grosse Ansicht («Gross ↗»), «Alle Jahre im Vergleich» und
   «Selbst nachschauen» mit allen Daten seit 2020.
   ================================================================== */

/* ---------- Alle Jahre im Vergleich ----------------------------------- */

/**
 * Die Tabelle «Wie aussergewöhnlich ist 2026?»: jedes Jahr seit 2020 in einer
 * Zeile, mit dem Durchschnitt der drei Mittellandflüsse. Jedes Jahr zählt nur
 * vom 1. Januar bis zum selben Stichtag wie 2026 (so liefert es unload.php).
 *
 * In jeder Zelle steht die Zahl und ein kleiner Balken. Der Balken zeigt, wo
 * das Jahr zwischen dem tiefsten (kurzer Balken) und dem höchsten Wert aller
 * Jahre (langer Balken) liegt. So sieht man Ausreisser auf einen Blick.
 */
function renderYears() {
  const table = document.getElementById('years-table');
  if (!table || !state.summary.length) return;
  const nos = inGroup('mittelland').map((s) => s.no);
  const years = [...new Set(state.summary.map((r) => r.year))].sort();

  // Die vier Spalten: welche Kennzahl, wie sie geschrieben wird.
  const columns = [
    { key: 'water_temperature_mean_c', label: 'Wassertemperatur', f: fmtTemp },
    { key: 'days_ge_25', label: 'Tage ab 25 °C pro Fluss', f: (v) => fmt1(v) },
    { key: 'water_level_deviation_mean_cm', label: 'Pegel', f: fmtCm },
    { key: 'precipitation_sum_mm', label: 'Regen', f: fmtMm },
  ];
  const rows = years.map((year) => ({ year, values: columns.map((c) => normalOf(nos, c.key, year)) }));
  const normal = columns.map((c) => normalOf(nos, c.key));

  // Für jede Spalte: der tiefste und der höchste Wert aller Jahre (für die Balken).
  const extent = columns.map((c, k) => d3.extent(rows, (r) => r.values[k]));
  // data-label: die Spaltenüberschrift. Auf dem Handy steht sie vor jedem Wert,
  // weil die Tabelle dort als Karten untereinander erscheint (siehe CSS).
  const cell = (v, k) => {
    if (v == null) return el('td', { 'data-label': columns[k].label }, '–');
    const [lo, hi] = extent[k];
    const share = hi > lo ? (v - lo) / (hi - lo) : 1;
    return el('td', { 'data-label': columns[k].label }, el('span', { class: 'years__value' }, columns[k].f(v)),
      el('span', { class: 'years__bar', style: `--share:${(0.08 + share * 0.92) * 100}%`, 'aria-hidden': 'true' }));
  };

  setSlot('years-caption', `Mittelland (Durchschnitt von Limmat, Thur und Rhein), jeweils 1. Januar bis ${cutoffLabel()}`);
  table.replaceChildren(
    table.querySelector('caption'),
    el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Jahr'), columns.map((c) => el('th', { scope: 'col' }, c.label)))),
    el('tbody', {}, rows.map((r) => el('tr', { class: r.year === YEARS.cur ? 'is-cur' : r.year === YEARS.ref ? 'is-ref' : '' },
      el('th', { scope: 'row' }, String(r.year), r.year === YEARS.ref ? el('small', {}, 'Hitzesommer') : null),
      r.values.map(cell)))),
    el('tfoot', {}, el('tr', {}, el('th', { scope: 'row' }, `Schnitt ${NORMAL_LABEL}`),
      normal.map((v, k) => el('td', { 'data-label': columns[k].label }, v == null ? '–' : columns[k].f(v))))));
}

/* ---------- Die sechs Messstellen ------------------------------------- */

/**
 * Die Liste der sechs Flüsse, aufgeteilt in Mittelland und Alpen.
 * Pro Fluss: Name, ein Satz dazu, eine kleine Kurve und die neusten Werte.
 */
function renderStationGroups() {
  const box = document.getElementById('station-groups');
  box.replaceChildren(...GROUPS.map((group) => el('div', { class: 'station-group' },
    el('p', { class: 'station-group__title' }, group.title),
    el('ul', { class: 'station-list' }, STATIONS.filter((s) => s.group === group.key && state.names.has(s.no)).map((s) => {
      const n = state.names.get(s.no);
      const recent = state.recent.get(s.no) || [];
      // Der neuste Tag mit einem Wert.
      const last = [...recent].reverse().find((r) => r.water_temperature_c != null || r.water_level_deviation_cm != null);
      return el('li', { class: 'station focusable', 'data-station': s.no, 'data-pin': '' },
        el('div', {},
          el('div', { class: 'station__name' }, keySwatch(s.no), el('span', { class: 'station__river' }, n.river_name)),
          el('div', { class: 'station__site' }, `${n.station_name} · Nr. ${s.no}`),
          n.rain_station ? el('div', { class: 'station__site' }, `Regen: ${n.rain_station}`) : null),
        el('p', { class: 'station__role' }, s.role),
        el('div', { class: 'station__spark', 'data-spark': s.no, 'aria-hidden': 'true' }),
        el('div', { class: 'station__now' },
          el('span', {}, el('strong', {}, last?.water_temperature_c != null ? fmtTemp(last.water_temperature_c) : '–'), 'Wasser'),
          el('span', {}, el('strong', {}, last?.water_level_deviation_cm != null ? fmtCm(last.water_level_deviation_cm) : '–'), 'Pegel'),
          el('span', {}, el('strong', {}, last ? fmtDayShort(parseDate(last.date)) : '–'), 'Stand')));
    })))),
    el('p', { class: 'note' }, `Linien: Wassertemperatur ${YEARS.ref} grau, ${YEARS.cur} farbig (7-Tage-Mittel). Werte rechts: letztes Tagesmittel.`));
  drawSparklines();
  applyFocus();
}

/** Die kleinen Kurven in der Liste: Temperatur 2022 grau, 2026 in der Farbe des Flusses */
function drawSparklines() {
  if (!state.cmp) return;
  document.querySelectorAll('[data-spark]').forEach((node) => {
    const s = state.cmp.stations.find((c) => c.no === node.dataset.spark);
    const frame = chartFrame(node, { top: 2, right: 0, bottom: 2, left: 0 }, { minW: 40, minH: 10 });
    if (!s || !frame) return;
    const { g: svg, innerW, innerH } = frame;
    const ref = yearPoints(s.ref.records, YEARS.ref, 'WT', 7);
    const cur = yearPoints(s.cur.records, YEARS.cur, 'WT', 7);
    const x = d3.scaleUtc().domain([YEAR_START, new Date(Date.UTC(2000, 11, 31))]).range([0, innerW]);
    const y = d3.scaleLinear().domain([0, 28]).range([innerH, 0]);
    const line = valueLine(x, y).curve(d3.curveMonotoneX);
    svg.append('path').attr('d', line(ref)).attr('fill', 'none').attr('stroke', 'var(--year-ref)').attr('stroke-width', 1.25);
    svg.append('path').attr('d', line(cur)).attr('fill', 'none').attr('stroke', colorOf(s.no)).attr('stroke-width', 2);
    finishChart(node);
  });
}

/** Die Linien 2022 und 2026 für alle Flüsse, je nach gewählten Knöpfen */
function cmpSeries() {
  const { parameter, smooth } = state.compare;
  return state.cmp.stations.map((s) => ({
    ...s,
    refPts: yearPoints(s.ref.records, YEARS.ref, parameter, smooth),
    curPts: yearPoints(s.cur.records, YEARS.cur, parameter, smooth),
  }));
}

/**
 * Wie hoch und tief muss die Achse gehen? Immer inklusive 0, damit kleine
 * Unterschiede nicht künstlich gross aussehen.
 */
function seriesExtent(series) {
  const values = series.flatMap((s) => [...s.refPts, ...s.curPts].map((p) => p.value)).filter((v) => v != null);
  const [lo, hi] = d3.extent(values);
  return [Math.min(0, lo ?? 0), Math.max(0, hi ?? 0)];
}

/** Ein Knopf wurde gedrückt (z.B. «Wasserstand»): alle Grafiken neu zeichnen */
function setCompareOption(key, value) {
  state.compare[key] = value;
  for (const id of ['cmp-param-switch', 'zoom-param-switch']) setSegmentedValue(id, 'param', state.compare.parameter);
  for (const id of ['cmp-smooth-switch', 'zoom-smooth-switch']) setSegmentedValue(id, 'smooth', state.compare.smooth);
  renderMultiples();
  renderZoom();
}

/**
 * «Jahr gegen Jahr»: sechs kleine Grafiken, eine pro Fluss.
 * Alle haben dieselbe Skala, damit man sie fair vergleichen kann.
 */
function renderMultiples() {
  if (!state.cmp) return;
  const { parameter, smooth } = state.compare;
  const isW = parameter === 'W';
  const f = isW ? fmtCm : fmtTemp;
  const cutoff = cutoffLabel();
  const container = document.getElementById('cmp-multiples');

  document.getElementById('cmp-title').textContent = `${PARAM_INFO[parameter].label}, ${smooth > 1 ? 'gleitendes 7-Tage-Mittel' : 'Tagesmittel'}`;
  document.getElementById('cmp-unit').textContent = PARAM_INFO[parameter].axis;
  document.getElementById('cmp-legend').replaceChildren(...diffLegend());
  document.getElementById('cmp-note').textContent =
    `Die gepunktete Linie markiert den ${cutoff}, bis hierhin reichen die Daten von ${YEARS.cur}. Alle Grafiken haben dieselbe Skala.` +
    (smooth > 1 ? ' Das 7-Tage-Mittel glättet kurze Schwankungen; im Tooltip stehen die geglätteten Werte.' : '');

  const series = cmpSeries();
  const [yMin, yMax] = seriesExtent(series); // alle Grafiken gleich hoch skaliert: fairer Vergleich

  container.replaceChildren(...GROUPS.map((group) => el('div', { class: 'multiples__group' },
    el('p', { class: 'multiples__group-title' }, group.title),
    el('div', { class: 'multiples__grid' }, series.filter((s) => s.info.group === group.key).map((s) => {
      const a = isW ? s.ref.summary.w_mean : s.ref.summary.wt_mean;
      const b = isW ? s.cur.summary.w_mean : s.cur.summary.wt_mean;
      const zoomBtn = el('button', { type: 'button', class: 'zoom-open', 'aria-label': `${displayName(s.no)} vergrössern` }, 'Gross ↗');
      zoomBtn.addEventListener('click', () => openZoom(s.no, 'cmp'));
      return el('div', { class: 'multiple focusable', 'data-station': s.no },
        el('div', { class: 'multiple__head' }, el('p', { class: 'multiple__title' }, keySwatch(s.no), displayName(s.no)), zoomBtn),
        el('p', { class: 'multiple__sub' }, a != null && b != null
          ? [`Mittel ${isW ? fmtSigned(a) : fmt1(a)} → `, el('strong', {}, f(b))] : 'keine Daten'),
        el('div', { class: 'chart chart--multiple', role: 'group', tabindex: '0',
          'aria-label': `${displayName(s.no)}: ${PARAM_INFO[parameter].label} ${YEARS.ref} und ${YEARS.cur}. Pfeiltasten wechseln den Tag.` }));
    })))));

  for (const s of series) {
    drawMultiple(container.querySelector(`.multiple[data-station="${s.no}"] .chart--multiple`), s, { yMin, yMax, isW, f });
  }
  applyFocus();
}

/* ----- Die grosse Ansicht eines Flusses («Gross ↗», auch als Vollbild) ----- */

const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

function setupZoom() {
  const dialog = document.getElementById('zoom');
  const inner = dialog.querySelector('.zoom__inner');
  const fsBtn = document.getElementById('zoom-fullscreen');

  document.getElementById('zoom-close').addEventListener('click', () => dialog.close());
  document.getElementById('zoom-prev').addEventListener('click', () => stepZoom(-1));
  document.getElementById('zoom-next').addEventListener('click', () => stepZoom(1));
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); }); // Klick daneben schliesst das Fenster
  dialog.addEventListener('close', () => {
    if (fullscreenElement()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    state.zoom.no = null;
  });

  // Den Knopf «Vollbild» nur zeigen, wenn der Browser das kann (das iPhone kann es nicht).
  const canFullscreen = Boolean(inner.requestFullscreen || inner.webkitRequestFullscreen)
    && (document.fullscreenEnabled || document.webkitFullscreenEnabled);
  fsBtn.hidden = !canFullscreen;
  fsBtn.addEventListener('click', () => {
    if (fullscreenElement()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (inner.requestFullscreen || inner.webkitRequestFullscreen).call(inner);
  });
  const onFullscreenChange = () => {
    const active = Boolean(fullscreenElement());
    fsBtn.setAttribute('aria-pressed', String(active));
    fsBtn.textContent = active ? 'Vollbild beenden' : 'Vollbild';
    requestAnimationFrame(renderZoom);
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
}

/** Einen Fluss gross zeigen. kind: 'cmp' = Jahresvergleich, 'rain' = Regen und Pegel */
function openZoom(no, kind = state.zoom.kind) {
  state.zoom.no = no;
  state.zoom.kind = kind;
  const dialog = document.getElementById('zoom');
  if (!dialog.open) dialog.showModal();
  renderZoom();
}

function stepZoom(dir) {
  const order = GROUPS.flatMap((g) => state.cmp.stations.filter((s) => s.info.group === g.key).map((s) => s.no));
  const i = order.indexOf(state.zoom.no);
  openZoom(order[(i + dir + order.length) % order.length]);
}

/** Die grosse Grafik eines Flusses, mit einer Skala nur für diesen Fluss */
function renderZoom() {
  if (!state.zoom.no || !state.cmp) return;
  // Die Knöpfe «Temperatur/Wasserstand» und «7-Tage-Mittel» gibt es nur beim Jahresvergleich.
  const rain = state.zoom.kind === 'rain';
  document.getElementById('zoom-param-switch').hidden = rain;
  document.getElementById('zoom-smooth-switch').hidden = rain;
  if (rain) {
    renderRainZoom();
    return;
  }
  const s = cmpSeries().find((c) => c.no === state.zoom.no);
  if (!s) return;
  const { parameter, smooth } = state.compare;
  const isW = parameter === 'W';
  const f = isW ? fmtCm : fmtTemp;
  const a = isW ? s.ref.summary.w_mean : s.ref.summary.wt_mean;
  const b = isW ? s.cur.summary.w_mean : s.cur.summary.wt_mean;

  document.getElementById('zoom-title').replaceChildren(keySwatch(s.no), `${displayName(s.no)}: ${PARAM_INFO[parameter].label}`);
  document.getElementById('zoom-legend').replaceChildren(...diffLegend());
  document.getElementById('zoom-sub').replaceChildren(...(a != null && b != null
    ? [`Mittel 1. Januar bis ${cutoffLabel()}: ${YEARS.ref} ${f(a)} → ${YEARS.cur} `, el('strong', {}, f(b))] : []));
  document.getElementById('zoom-note').textContent =
    `${PARAM_INFO[parameter].axis}, ${smooth > 1 ? 'gleitendes 7-Tage-Mittel' : 'Tagesmittel'}. ` +
    `Gepunktete Linie: ${cutoffLabel()}. In dieser Ansicht ist die Skala an diesen Fluss angepasst.`;

  const [yMin, yMax] = seriesExtent([s]);
  drawMultiple(document.getElementById('zoom-chart'), s, { yMin, yMax, isW, f, large: true });
}

/* ----- Regen und Pegel auf der Datenseite: eine Grafik pro Fluss ----- */

/**
 * Sechs kleine Grafiken, eine pro Fluss, alle mit derselben Skala.
 * Oben in jeder Grafik steht, wie viel Regen 2022 und 2026 gefallen ist.
 * Mit «Gross ↗» öffnet sich ein Fluss in der grossen Ansicht.
 */
function renderRainMultiples() {
  const container = document.getElementById('rain-multiples');
  if (!container || !state.cmp) return;
  if (!hasRain()) {
    container.replaceChildren(el('p', { class: 'muted' }, 'Für den Regen sind noch keine Daten gespeichert.'));
    return;
  }
  const stations = state.cmp.stations;
  const scales = rainScales(stations); // dieselbe Skala für alle: fairer Vergleich

  document.getElementById('rainm-legend').replaceChildren(...rainLegend());
  document.getElementById('rain-multiples-note').textContent =
    `Regen an je einer Wetterstation von MeteoSchweiz, vom 1. Januar bis ${cutoffLabel()} zusammengezählt. ` +
    'Pegel als 7-Tage-Mittel (BAFU). Alle Grafiken haben dieselbe Skala.';

  container.replaceChildren(...GROUPS.map((group) => el('div', { class: 'multiples__group' },
    el('p', { class: 'multiples__group-title' }, group.title),
    el('div', { class: 'multiples__grid' }, stations.filter((s) => s.info.group === group.key).map((s) => {
      const n = state.names.get(s.no);
      const ref = s.ref.summary.rain_sum;
      const cur = s.cur.summary.rain_sum;
      const change = ref > 0 ? roundShown(((cur - ref) / ref) * 100) : null;
      const zoomBtn = el('button', { type: 'button', class: 'zoom-open', 'aria-label': `Regen und Pegel ${displayName(s.no)} vergrössern` }, 'Gross ↗');
      zoomBtn.addEventListener('click', () => openZoom(s.no, 'rain'));
      return el('div', { class: 'multiple focusable', 'data-station': s.no },
        el('div', { class: 'multiple__head' }, el('p', { class: 'multiple__title' }, keySwatch(s.no), displayName(s.no)), zoomBtn),
        el('p', { class: 'multiple__sub' }, `Regen ${n.rain_station ?? ''}: ${fmt0(ref)} → `, el('strong', {}, fmtMm(cur)),
          change != null ? ` (${fmtSigned(change)} %)` : ''),
        el('div', { class: 'chart chart--rain-small', role: 'group', tabindex: '0',
          'aria-label': `${displayName(s.no)}: Regen und Pegel ${YEARS.ref} und ${YEARS.cur}. Pfeiltasten wechseln den Tag.` }));
    })))));

  for (const s of stations) {
    drawRain(container.querySelector(`.multiple[data-station="${s.no}"] .chart--rain-small`), s, { ...scales, compact: true });
  }
  applyFocus();
}

/** Die grosse Ansicht von «Regen und Pegel», mit einer Skala nur für diesen Fluss */
function renderRainZoom() {
  const s = state.cmp.stations.find((c) => c.no === state.zoom.no);
  if (!s) return;
  const n = state.names.get(s.no);
  document.getElementById('zoom-title').replaceChildren(keySwatch(s.no), `${displayName(s.no)}: Regen und Pegel`);
  document.getElementById('zoom-legend').replaceChildren(...rainLegend());
  document.getElementById('zoom-sub').replaceChildren(
    `Regen in ${n.rain_station ?? 'der Region'}, 1. Januar bis ${cutoffLabel()}: ${YEARS.ref} ${fmtMm(s.ref.summary.rain_sum)} → ${YEARS.cur} `,
    el('strong', {}, fmtMm(s.cur.summary.rain_sum)));
  document.getElementById('zoom-note').textContent =
    'Oben: Regen seit 1. Januar zusammengezählt (MeteoSchweiz). Unten: Pegel, 7-Tage-Mittel, Abweichung vom mittleren Pegel (BAFU). ' +
    'In dieser Ansicht ist die Skala an diesen Fluss angepasst.';
  drawRain(document.getElementById('zoom-chart'), s, rainScales([s]));
}

/* ---------- Selbst nachschauen: alle Daten seit 2020 ------------------ */

/** Die Knöpfe mit den Flussnamen: Ein Klick blendet einen Fluss ein oder aus */
function renderLegend() {
  const legend = document.getElementById('ts-legend');
  const chips = STATIONS.filter((s) => state.names.has(s.no)).map((s) => {
    const chip = el('button', { type: 'button', class: 'chip focusable', 'data-station': s.no, 'aria-pressed': 'true', style: `--c:${colorOf(s.no)}` },
      el('span', { class: 'chip__key', 'aria-hidden': 'true' }), displayName(s.no));
    chip.addEventListener('click', () => {
      const hidden = state.ts.hidden;
      hidden.has(s.no) ? hidden.delete(s.no) : hidden.add(s.no);
      chip.setAttribute('aria-pressed', String(!hidden.has(s.no)));
      loadTimeseries(); // die passenden Daten neu holen
    });
    return chip;
  });
  const all = el('button', { type: 'button', class: 'chip chip--ghost' }, 'Alle zeigen');
  all.addEventListener('click', () => {
    state.ts.hidden.clear();
    chips.forEach((c) => c.setAttribute('aria-pressed', 'true'));
    loadTimeseries();
  });
  legend.replaceChildren(...chips, all);
}

/**
 * Holt genau die Daten, die gerade ausgewählt sind: welche Flüsse,
 * Temperatur oder Wasserstand, welcher Zeitraum.
 */
async function loadTimeseries() {
  const ts = state.ts;
  if (!state.latest) return;
  const visible = STATIONS.filter((s) => state.names.has(s.no) && !ts.hidden.has(s.no));
  const chart = document.getElementById('ts-chart');

  if (!visible.length) {
    ts.records = null;
    d3.select(chart).select('svg').remove();
    setStatus('ts-status', 'Wähle oben mindestens einen Fluss aus.');
    renderSummaryTable();
    return;
  }

  const to = state.latest;
  const from = ts.days === 'all' ? null : fmtIsoDate(d3.utcDay.offset(parseDate(to), -(Number(ts.days) - 1)));

  const request = ++ts.request;
  chart.classList.add('is-loading'); // die alte Grafik bleibt blass sichtbar, bis die neue da ist
  try {
    // Beim Regen gibt es keinen Filter «parameter»: Er hängt an jedem Datensatz dran.
    const records = await unload({ stations: visible.map((s) => s.no).join(','), parameter: ts.parameter === 'N' ? null : ts.parameter, from, to });
    if (request !== ts.request) return; // inzwischen wurde schon wieder etwas anderes gewählt
    ts.records = records;
    ts.range = { from: from ?? d3.min(records, (r) => r.date), to };
    setStatus('ts-status', records.length ? '' : 'Für diese Auswahl sind keine Messwerte gespeichert.');
    renderTimeseries();
  } catch (err) {
    if (request !== ts.request) return;
    setStatus('ts-status', `Die Messwerte konnten nicht geladen werden: ${err.message}`);
    showToast(err.message);
  } finally {
    if (request === ts.request) chart.classList.remove('is-loading');
  }
}

/** Aus den Daten eine Linie pro Fluss machen. Fehlt ein Tag, bleibt eine Lücke. */
function toSeries(records, parameter) {
  const field = FIELD[parameter];
  const byNo = groupByStation(records);
  return STATIONS.filter((s) => byNo.has(s.no)).map((s) => {
    const points = [];
    let prev = null;
    for (const r of byNo.get(s.no)) {
      const date = parseDate(r.date);
      if (prev && d3.utcDay.count(prev, date) > 1) points.push({ date: d3.utcDay.offset(prev, 1), value: null });
      points.push({ date, value: r[field], release: r.release_state, rainStation: r.precipitation_station });
      prev = date;
    }
    return { no: s.no, points };
  });
}

function renderTimeseries() {
  const ts = state.ts;
  const info = PARAM_INFO[ts.parameter];
  setTimeseriesTexts(ts.parameter, info);

  const chart = document.getElementById('ts-chart');
  if (!ts.records || !ts.records.length) return;
  const series = toSeries(ts.records, ts.parameter);
  renderSummaryTable(series);

  const allValues = series.flatMap((s) => s.points.map((p) => p.value)).filter((v) => v != null);
  if (!allValues.length) {
    d3.select(chart).select('svg').remove();
    setStatus('ts-status', 'Für diese Auswahl sind keine Messwerte gespeichert.');
    return;
  }

  const small = chart.clientWidth < 560;
  const frame = chartFrame(chart, { top: 12, right: small ? 8 : 16, bottom: 28, left: small ? 38 : 48 });
  if (!frame) return;
  const { svg, g, innerW, innerH, margin } = frame;
  // Diese Grafik ist für Bildschirmleser beschriftet (die anderen haben eine Tabelle oder einen Text daneben).
  svg.attr('aria-hidden', null).attr('role', 'img')
    .attr('aria-label', `${info.label} von ${series.map((s) => displayName(s.no)).join(', ')}, ${longDate(ts.range.from)} bis ${longDate(ts.range.to)}`);

  // x = Datum, y = Wert. Die Achse beginnt immer bei 0. Beim Wasserstand heisst 0: genau durchschnittlich.
  const from = parseDate(ts.range.from);
  const to = parseDate(ts.range.to);
  const span = d3.utcDay.count(from, to);
  const x = d3.scaleUtc().domain([from, to]).range([0, innerW]);
  const [lo, hi] = d3.extent(allValues);
  const y = d3.scaleLinear().domain([Math.min(0, lo), Math.max(0, hi)]).nice().range([innerH, 0]);

  // Die Daten unten: je nach Zeitraum Tage, Monate oder Jahre.
  g.append('g').attr('class', 'axis axis--x').attr('transform', `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(innerW / (small ? 70 : 90)))).tickSizeOuter(0).tickFormat(timeTickFormat(span)))
    .call((a) => a.selectAll('.tick line').attr('y2', 4));
  drawValueAxis(g, y, innerW, small ? 5 : 7, (v) => (ts.parameter === 'W' ? fmtSigned(v) : fmt0(v)));

  // Die Null-Linie und je nach Messgrösse eine Hilfslinie.
  g.append('line').attr('class', 'baseline').attr('x1', 0).attr('x2', innerW).attr('y1', y(0)).attr('y2', y(0));
  if (ts.parameter === 'W') {
    g.append('text').attr('class', 'refline-label').attr('x', innerW).attr('y', y(0) - 5).attr('text-anchor', 'end').text('mittlerer Pegel');
  } else if (ts.parameter === 'WT' && hi >= 20) {
    drawRefLine(g, y, 20, innerW, '20 °C');
  }

  drawSeriesLines(g, series, { x, y, showDots: span <= 31 });
  attachSeriesTooltip(chart, g, series, { x, y, innerW, innerH, margin, parameter: ts.parameter });
  applyFocus();
  finishChart(chart);
}

/** Titel, Einheit und Erklärung über und unter der Grafik «Selbst nachschauen» */
function setTimeseriesTexts(parameter, info) {
  document.getElementById('ts-title').textContent = `${info.label}, ${parameter === 'N' ? 'Summe pro Tag' : 'Tagesmittel'}`;
  document.getElementById('ts-unit').textContent = info.axis;
  document.getElementById('ts-note').textContent = {
    W: 'Wasserstände liegen je nach Ort auf ganz unterschiedlicher Höhe. Die Grafik zeigt deshalb, wie viele Zentimeter ein Fluss über oder unter seinem eigenen mittleren Pegel seit 2020 stand.',
    WT: 'Tagesmittel der Wassertemperatur. Gestrichelte Linie: 20 °C.',
    N: 'Regen pro Tag an der Wetterstation von MeteoSchweiz im Gebiet des Flusses. Für lange Zeiträume eignet sich die Grafik «Regen und Pegel» weiter oben besser.',
  }[parameter];
}

/** Eine Linie pro Fluss in seiner Farbe. Bei kurzen Zeiträumen zusätzlich jeden Tag als Punkt. */
function drawSeriesLines(g, series, { x, y, showDots }) {
  const line = valueLine(x, y, 'date');
  const lines = g.append('g');
  for (const s of series) {
    lines.append('path').attr('class', 'series-line').attr('data-station', s.no).style('stroke', colorOf(s.no)).attr('d', line(s.points));
    if (showDots) {
      lines.selectAll(null).data(s.points.filter((p) => p.value != null)).join('circle')
        .attr('class', 'series-dot').attr('r', 3.5).style('fill', colorOf(s.no))
        .attr('cx', (p) => x(p.date)).attr('cy', (p) => y(p.value));
    }
  }
}

/** Mit der Maus darüber: alle Flüsse an diesem Tag, der wärmste bzw. höchste zuoberst. */
function attachSeriesTooltip(chart, g, series, { x, y, innerW, innerH, margin, parameter }) {
  const dates = [...new Set(series.flatMap((s) => s.points.filter((p) => p.value != null).map((p) => +p.date)))].sort((a, b) => a - b);
  const byDate = series.map((s) => new Map(s.points.filter((p) => p.value != null).map((p) => [+p.date, p])));
  const f = { W: fmtCm, WT: fmtTemp, N: fmtMmDay }[parameter];

  attachCrosshair({
    chart, g, innerW, innerH, margin,
    positions: dates.map((d) => x(d)),
    render(i, hover) {
      const date = dates[i];
      const rows = series.map((s, k) => ({ s, p: byDate[k].get(date) })).filter((r) => r.p);
      hover.selectAll('circle').data(rows).join('circle').attr('class', 'hover-dot').attr('r', 5)
        .style('fill', (r) => colorOf(r.s.no)).attr('cx', x(date)).attr('cy', (r) => y(r.p.value));
      rows.sort((a, b) => b.p.value - a.p.value);
      return el('div', {},
        el('div', { class: 'tooltip__date' }, fmtDateTooltip(new Date(date))),
        rows.map(({ s, p }) => tooltipRow(
          [state.names.get(s.no).river_name, el('small', {}, parameter === 'N'
            ? `Regen in ${p.rainStation ?? '–'}`
            : `${state.names.get(s.no).station_name} · ${RELEASE_LABEL[p.release] ?? 'ohne Status'}`)],
          colorOf(s.no), f(p.value))));
    },
    label: (i) => fmtDateLong(new Date(dates[i])),
  });
}

/** Wie das Datum unter der Grafik steht: «3. Juli», «Jul» oder «2024», je nach Zeitraum */
function timeTickFormat(spanDays) {
  const day = locale.utcFormat('%-d. %b');
  const month = locale.utcFormat('%b');
  const monthYear = locale.utcFormat('%b %Y');
  const year = locale.utcFormat('%Y');
  return (d) => {
    if (spanDays <= 62) return day(d);
    if (spanDays <= 800) return d.getUTCMonth() === 0 ? monthYear(d) : month(d);
    return d.getUTCMonth() === 0 ? year(d) : month(d);
  };
}

/**
 * Dieselben Zahlen als Tabelle: tiefster Wert, Durchschnitt, höchster Wert.
 * Für alle, die keine Maus benutzen oder lieber Zahlen lesen.
 */
function renderSummaryTable(series = []) {
  const table = document.getElementById('ts-table');
  const f = { W: fmtCm, WT: fmtTemp, N: fmtMmDay }[state.ts.parameter];
  const head = el('thead', {}, el('tr', {},
    ['Fluss', 'Tiefster Wert', 'Mittel', 'Höchster Wert', 'Tage mit Wert'].map((h) => el('th', { scope: 'col' }, h))));
  const body = el('tbody', {}, series.map((s) => {
    const vals = s.points.filter((p) => p.value != null);
    if (!vals.length) return el('tr', {}, el('td', {}, displayName(s.no)), el('td', { colspan: '4' }, 'keine Werte'));
    const min = d3.least(vals, (p) => p.value);
    const max = d3.greatest(vals, (p) => p.value);
    return el('tr', {},
      el('td', {}, el('span', { class: 'key', style: `background:${colorOf(s.no)}` }), displayName(s.no)),
      el('td', {}, `${f(min.value)} (${fmtDateLong(min.date)})`),
      el('td', {}, f(d3.mean(vals, (p) => p.value))),
      el('td', {}, `${f(max.value)} (${fmtDateLong(max.date)})`),
      el('td', {}, fmt0(vals.length)));
  }));
  table.replaceChildren(head, body);
}

/* ==================================================================
   10) START

   Was beim Öffnen der Seite passiert, und was bei Grössenänderung
   und beim Scrollen passiert.
   ================================================================== */

/**
 * Das passiert beim Öffnen der Seite:
 * 1. Knöpfe bereit machen
 * 2. Daten holen
 * 3. Alle Grafiken zeichnen
 *
 * Die Story-Seite braucht nur die Jahre 2022 und 2026. Die Datenseite holt
 * zusätzlich die letzten 365 Tage (für die Liste der Messstellen).
 */
async function init() {
  setupProgress();
  setupFocus();
  if (PAGE === 'daten') {
    setupSegmented('cmp-param-switch', 'param', (v) => setCompareOption('parameter', v));
    setupSegmented('cmp-smooth-switch', 'smooth', (v) => setCompareOption('smooth', Number(v)));
    setupSegmented('zoom-param-switch', 'param', (v) => setCompareOption('parameter', v));
    setupSegmented('zoom-smooth-switch', 'smooth', (v) => setCompareOption('smooth', Number(v)));
    setupSegmented('param-switch', 'param', (v) => { state.ts.parameter = v; loadTimeseries(); });
    setupSegmented('range-switch', 'days', (v) => { state.ts.days = v; loadTimeseries(); });
    setupZoom();
  }

  let recent = [];
  let compare;
  try {
    // Drei Fragen gleichzeitig: die Jahre 2022 und 2026, die Zusammenfassung pro
    // Jahr (für den Durchschnitt 2020–2025) und, nur auf der Datenseite, die
    // letzten 365 Tage. Klappt die Zusammenfassung nicht, geht es ohne sie weiter.
    [compare, state.summary, recent] = await Promise.all([
      unload({ years: `${YEARS.ref},${YEARS.cur}` }),
      unload({ summary: 1 }).catch(() => []),
      PAGE === 'daten' ? unload() : [],
    ]);
  } catch (err) {
    fatal(err);
    return;
  }
  if (!compare.length) {
    fatal(new Error('In der Datenbank sind noch keine Messwerte vorhanden. Bitte zuerst den Import (etl/load.php) ausführen.'));
    return;
  }

  // Die Daten ins Gedächtnis der Seite legen.
  state.recent = groupByStation(recent);
  state.latest = d3.max([...recent, ...compare], (r) => r.date);
  for (const r of [...recent, ...compare]) {
    if (!state.names.has(r.station_no)) {
      state.names.set(r.station_no, { river_name: r.river_name, station_name: r.station_name, rain_station: r.precipitation_station });
    }
  }
  state.cmp = buildCompare(compare);

  // Jetzt alle Teile der Seite zeichnen, von oben nach unten.
  if (PAGE === 'story') {
    renderStripes();
    renderStoryText();
    setupDraw();
    renderStats();
    setupRain();
    renderVerdict();
    setupTip();
    setupMoreGlow();
  } else {
    renderStationGroups();
    renderYears();
    renderMultiples();
    renderRainMultiples();
    renderLegend();
    loadTimeseries();
  }
  renderFacts();
  setupResize();
}

/** Wenn gar nichts geladen werden kann: eine klare Meldung statt einer leeren Seite */
function fatal(err) {
  showToast(err.message);
  const msg = `Die Daten sind momentan nicht verfügbar: ${err.message}`;
  // Überall, wo sonst eine Grafik stünde, die Meldung zeigen (nur was es auf dieser Seite gibt).
  for (const id of ['stripes-rows', 'stats', 'rain-gauges', 'station-groups', 'cmp-multiples', 'rain-multiples', 'verdict']) {
    document.getElementById(id)?.replaceChildren(el('p', { class: 'muted' }, msg));
  }
  if (document.getElementById('ts-status')) setStatus('ts-status', msg);
}

/** Datenstand (oben auf beiden Seiten) sowie Zeitraum und geprüfte Werte bei «So sind wir vorgegangen» eintragen */
function renderFacts() {
  setSlot('data-stand', fmtDotted(parseDate(state.latest)));
  setSlot('fact-range', `1. Januar 2020 bis ${longDate(state.latest)}`);
  const checked = d3.sum(state.cmp.stations, (s) => s.cur.summary.checked);
  const total = d3.sum(state.cmp.stations, (s) => s.cur.summary.count);
  if (total) setSlot('fact-checked', `Von den Tagen ${YEARS.cur} sind erst ${fmt0((checked / total) * 100)}\u00a0% vollständig geprüft`);
}

/**
 * Wird das Fenster breiter oder schmaler (oder das Handy gedreht), werden
 * alle Grafiken passend neu gezeichnet. Die Daten müssen dafür nicht neu
 * geholt werden.
 */
function setupResize() {
  let frame = null;
  let lastWidth = window.innerWidth;
  const redraw = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (PAGE === 'story') {
        renderStripes();
        renderDraw();
        drawRainChart();
      } else {
        drawSparklines();
        renderMultiples();
        renderRainMultiples();
        renderZoom();
        renderTimeseries();
      }
    });
  };
  window.addEventListener('resize', () => {
    if (window.innerWidth === lastWidth) return; // nur die Höhe hat sich geändert (Handy beim Scrollen): nichts tun
    lastWidth = window.innerWidth;
    redraw();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && window.innerWidth !== lastWidth) {
      lastWidth = window.innerWidth;
      redraw();
    }
  });
}

/** Die dünne orange Linie ganz oben: Sie zeigt, wie weit man schon gelesen hat */
function setupProgress() {
  const bar = document.getElementById('progress-bar');
  let ticking = false;
  const update = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.transform = `scaleX(${max > 0 ? Math.min(1, window.scrollY / max) : 0})`;
    ticking = false;
  };
  window.addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }, { passive: true });
  update();
}

// Sobald die Seite geladen ist: init() starten.
document.addEventListener('DOMContentLoaded', init);
