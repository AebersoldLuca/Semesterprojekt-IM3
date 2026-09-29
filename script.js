/**
 * DataStory «Heisser als der Hitzesommer» – das Frontend.
 *
 * Aufgebaut wie das Beispielprojekt Hitzesommer aus dem Unterricht:
 *
 *   Holen      unload.php fragen – nie die BAFU-API direkt
 *   Umformen   Datensätze nach Station gruppieren, 2022 und 2026 vergleichen
 *   Zeichnen   Temperatur-Streifen, eine Grafik pro Fluss, Zeitverlauf (D3)
 *   Reagieren  Schalter ändern den Zustand und zeichnen neu
 *
 * Jeder Datensatz aus unload.php hat genau die Felder des Datenvertrags:
 *
 *   station_no, river_name, station_name, date,
 *   water_temperature_c, water_level_deviation_cm, release_state
 *
 * Hypothese der Story: «2026 waren die Flüsse im Mittelland bisher wärmer
 * und führten weniger Wasser als im Hitzesommer 2022.»
 *
 * Aufbau dieser Datei:
 *
 *    0) Einstellungen und Hilfsfunktionen
 *    1) Holen: unload.php
 *    2) Start und Zustand
 *    3) Umformen: Vergleich 2022/2026
 *    4) Einstieg: Temperatur-Streifen
 *    5) Auf einen Blick: Kennzahlen
 *    6) Stationen
 *    7) Jahr gegen Jahr (Grafik je Fluss, Vergrössern/Vollbild)
 *    8) Urteil
 *    9) Explorer: Zeitverlauf aller Flüsse
 *   10) Tooltip, Crosshair, Resize, Lesefortschritt
 */

'use strict';

/* ---------- 0) Einstellungen und Hilfsfunktionen ----------------- */

// Alles, was man beim Anpassen als Erstes sucht, steht zuoberst.

const ENDPUNKT = 'unload.php';

/** Die zwei verglichenen Jahre der Hypothese */
const YEARS = { ref: 2022, cur: 2026 };

/** Station für die Temperatur-Streifen im Einstieg (Thur, Andelfingen) */
const HERO_STATION = '2044';

/**
 * Redaktionelle Angaben zu den Stationen (keine Messdaten):
 * Gruppe für die Hypothese, Farbe (Reihenfolge der validierten Palette) und
 * ein Satz zur Rolle in der Story. Namen und Werte kommen aus unload.php.
 */
const STATIONS = [
  { no: '2243', group: 'mittelland', color: 2, role: 'Abfluss des Zürichsees: Das Wasser war zuvor im See, dessen Oberfläche sich im Sommer stark erwärmt.' },
  { no: '2044', group: 'mittelland', color: 4, role: 'Fluss aus der Ostschweiz ohne grossen See und ohne grosse Gletscher im Einzugsgebiet.' },
  { no: '2091', group: 'mittelland', color: 6, role: 'Der Rhein unterhalb der Aaremündung. Hier fliesst das Wasser eines grossen Teils der Nordschweiz vorbei.' },
  { no: '2019', group: 'alpen', color: 1, role: 'Die junge Aare im Berner Oberland, noch vor dem Brienzersee. Gespeist von Gletschern und Schneeschmelze.' },
  { no: '2009', group: 'alpen', color: 3, role: 'Die Rhône kurz vor dem Genfersee, mit dem Wasser aus den Walliser Alpen.' },
  { no: '2068', group: 'alpen', color: 5, role: 'Alpensüdseite: der Ticino kurz vor dem Lago Maggiore.' },
];
const GROUPS = [
  { key: 'mittelland', title: 'Mittelland · These' },
  { key: 'alpen', title: 'Alpen · Kontrollgruppe' },
];

/** Feld des Datenvertrags je Messgrösse */
const FIELD = { WT: 'water_temperature_c', W: 'water_level_deviation_cm' };

const PARAM_INFO = {
  WT: { label: 'Wassertemperatur', axis: 'in °C' },
  W:  { label: 'Wasserstand', axis: 'Abweichung vom mittleren Pegel in cm' },
};

const RELEASE_LABEL = { 1: 'provisorisch', 2: 'validiert', 3: 'definitiv', null: 'ohne Status' };

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

// Deutsches (Schweizer) Datumsformat für D3
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

const nf = (digits) => new Intl.NumberFormat('de-CH', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmt1 = nf(1).format;
const fmt0 = nf(0).format;
const fmtSigned = (v, digits = 0) => (v > 0 ? '+' : v < 0 ? '−' : '±') + nf(digits).format(Math.abs(v));
const fmtTemp = (v) => `${fmt1(v)} °C`;
const fmtCm = (v) => `${fmtSigned(v)} cm`;
const longDate = (iso) => fmtDateLong(parseDate(iso));

const stationInfo = (no) => STATIONS.find((s) => s.no === no);
/** Farbe folgt der Station, nie ihrem Rang → CSS-Variable */
const colorOf = (no) => `var(--series-${stationInfo(no)?.color ?? 1})`;

/** Kleines DOM-Hilfsmittel. Texte immer per textContent (nie innerHTML mit Daten). */
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

function setSlot(name, content) {
  document.querySelectorAll(`[data-slot="${name}"]`).forEach((node) => {
    node.replaceChildren(...[].concat(content).map((c) => (c instanceof Node ? c : document.createTextNode(String(c)))));
  });
}

const keySwatch = (no, cls = 'key') => el('span', { class: cls, style: `background:${colorOf(no)}`, 'aria-hidden': 'true' });

/** Datensätze nach Station gruppieren (Reihenfolge wie von unload.php: nach Datum) */
function groupByStation(records) {
  const map = new Map();
  for (const r of records) {
    if (!map.has(r.station_no)) map.set(r.station_no, []);
    map.get(r.station_no).push(r);
  }
  return map;
}

/* ---------- 1) Holen: unload.php -------------------------------- */

// Jede Adresse wird nur einmal gefragt. Wer im Explorer hin- und herschaltet,
// bekommt die Daten beim zweiten Mal sofort.
const cache = new Map();

/**
 * Fragt den eigenen Endpunkt. Die Filter aus dem Datenvertrag (stations,
 * parameter, years, from, to) werden an die URL gehängt und dort zu einem
 * WHERE im SQL.
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
    // fetch() wirft nur, wenn gar keine Antwort kommt – zum Beispiel ohne Netz.
    throw new Error('Der Server ist nicht erreichbar. Bitte Internetverbindung prüfen.');
  }

  // fetch() wirft keinen Fehler, wenn der Server mit 400 oder 500 antwortet –
  // es ist ja eine Antwort angekommen. unload.php schickt dann eine Meldung
  // als JSON mit, die wir anzeigen.
  if (!response.ok) {
    const answer = await response.json().catch(() => null);
    throw new Error(answer?.error ?? `Der Endpunkt antwortet mit Status ${response.status}.`);
  }

  // Fängt den Fall ab, dass der Server das PHP nicht ausgeführt hat. Ohne die
  // Prüfung meldet der Browser «Unexpected token '<'».
  const contentType = response.headers.get('content-type') ?? '';

  if (!contentType.includes('application/json')) {
    throw new Error('Die Antwort ist kein JSON. Öffne unload.php direkt im Browser.');
  }

  const data = await response.json();
  cache.set(url, data);

  return data;
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => (toast.hidden = true), 8000);
}

function setStatus(id, message) {
  const node = document.getElementById(id);
  node.textContent = message || '';
  node.hidden = !message;
}

/* ---------- 2) Start und Zustand ---------------------------------- */

const state = {
  recent: null,          // Map station_no → Datensätze der letzten 365 Tage
  latest: null,          // jüngster Messtag (YYYY-MM-DD)
  names: new Map(),      // station_no → { river_name, station_name } (aus den Daten)
  cmp: null,             // Vergleich 2022/2026
  compare: { parameter: 'WT', smooth: 7 },
  zoom: { no: null },
  ts: { parameter: 'WT', days: '365', hidden: new Set(), records: null, range: null, request: 0 },
};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  setupProgress();
  setupSegmented('cmp-param-switch', 'param', (v) => setCompareOption('parameter', v));
  setupSegmented('cmp-smooth-switch', 'smooth', (v) => setCompareOption('smooth', Number(v)));
  setupSegmented('zoom-param-switch', 'param', (v) => setCompareOption('parameter', v));
  setupSegmented('zoom-smooth-switch', 'smooth', (v) => setCompareOption('smooth', Number(v)));
  setupSegmented('param-switch', 'param', (v) => { state.ts.parameter = v; loadTimeseries(); });
  setupSegmented('range-switch', 'days', (v) => { state.ts.days = v; loadTimeseries(); });
  setupZoom();

  let recent;
  let compare;
  try {
    // Zwei Abfragen: die letzten 365 Tage (ohne Filter) und die beiden Vergleichsjahre
    [recent, compare] = await Promise.all([unload(), unload({ years: `${YEARS.ref},${YEARS.cur}` })]);
  } catch (err) {
    fatal(err);
    return;
  }
  if (!recent.length) {
    fatal(new Error('In der Datenbank sind noch keine Messwerte vorhanden. Bitte zuerst den Import (etl/load.php) ausführen.'));
    return;
  }

  state.recent = groupByStation(recent);
  state.latest = d3.max(recent, (r) => r.date);
  for (const r of [...recent, ...compare]) {
    if (!state.names.has(r.station_no)) state.names.set(r.station_no, { river_name: r.river_name, station_name: r.station_name });
  }
  state.cmp = buildCompare(compare);

  renderStripes();
  renderStats();
  renderStationGroups();
  renderMultiples();
  renderVerdict();
  renderFacts();
  renderLegend();
  loadTimeseries();
  setupResize();
}

/** Wenn gar nichts geladen werden kann: klare Meldung statt leerer Seite. */
function fatal(err) {
  showToast(err.message);
  const msg = `Die Daten sind momentan nicht verfügbar: ${err.message}`;
  setStatus('ts-status', msg);
  for (const id of ['stripes-rows', 'stats', 'station-groups', 'cmp-multiples', 'verdict']) {
    document.getElementById(id).replaceChildren(el('p', { class: 'muted' }, msg));
  }
}

/** Segmented Control (Radiogruppe) mit Tastatursteuerung */
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

/** Radiogruppe von aussen auf einen Wert setzen (ohne onChange auszulösen) */
function setSegmentedValue(id, dataKey, value) {
  document.querySelectorAll(`#${id} button`).forEach((b) => b.setAttribute('aria-checked', String(b.dataset[dataKey] === String(value))));
}

/** «Thur – Andelfingen» aus river_name und station_name der Daten */
const displayName = (no) => {
  const n = state.names.get(no);
  return n ? `${n.river_name} – ${n.station_name}` : no;
};

/* ---------- 3) Umformen: Vergleich 2022/2026 ---------------------- */

/**
 * Datensätze beider Jahre → Kennzahlen pro Station. Fair verglichen wird
 * immer derselbe Zeitraum: 1. Januar bis zum Stichtag (letzter Messtag 2026).
 */
function buildCompare(records) {
  const byNo = groupByStation(records);
  const curDates = records.filter((r) => r.date.startsWith(String(YEARS.cur))).map((r) => r.date);
  const cutoff = curDates.length ? d3.max(curDates).slice(5) : '12-31';

  const summarize = (recs) => {
    const upTo = recs.filter((r) => r.date.slice(5) <= cutoff);
    const wt = upTo.map((r) => r.water_temperature_c).filter((v) => v != null);
    const w = upTo.map((r) => r.water_level_deviation_cm).filter((v) => v != null);
    return {
      wt_mean: wt.length ? d3.mean(wt) : null,
      days_ge_20: wt.filter((v) => v >= 20).length,
      days_ge_25: wt.filter((v) => v >= 25).length,
      w_mean: w.length ? d3.mean(w) : null,
      // Tage, an denen der Datensatz vom BAFU geprüft ist (validiert/definitiv). Laut Datenvertrag
      // gilt ein Datensatz nur dann als geprüft, wenn beide Messwerte geprüft sind.
      checked: upTo.filter((r) => r.release_state >= 2).length,
      count: upTo.length,
    };
  };

  const stations = STATIONS.filter((s) => byNo.has(s.no)).map((s) => {
    const recs = byNo.get(s.no);
    const ref = recs.filter((r) => r.date.startsWith(String(YEARS.ref)));
    const cur = recs.filter((r) => r.date.startsWith(String(YEARS.cur)));
    return { no: s.no, info: s, ref: { records: ref, summary: summarize(ref) }, cur: { records: cur, summary: summarize(cur) } };
  }).filter((s) => s.ref.records.length && s.cur.records.length);

  return { cutoff, stations };
}

const inGroup = (key) => state.cmp.stations.filter((s) => s.info.group === key);
const cutoffLabel = () => fmtDayMonth(parseDate(`${YEARS.cur}-${state.cmp.cutoff}`));
const delta = (s, k) => s.cur.summary[k] - s.ref.summary[k];

/* ---------- 4) Einstieg: Temperatur-Streifen --------------------- */

/** Kalendertag «MM-DD» → Position im neutralen Schaltjahr 2000 (0 … 365) */
const dayIndex = (md) => d3.utcDay.count(new Date(Date.UTC(2000, 0, 1)), new Date(Date.UTC(2000, Number(md.slice(0, 2)) - 1, Number(md.slice(3, 5)))));

/**
 * Jeder Streifen = ein Tag, Farbe = Wassertemperatur (kalt blau → warm rot).
 * Oben 2022, unten 2026 – alles echte Tagesmittel aus der Datenbank.
 */
function renderStripes() {
  const s = state.cmp.stations.find((c) => c.no === HERO_STATION) || state.cmp.stations[0];
  const figure = document.getElementById('stripes');
  const rowsBox = document.getElementById('stripes-rows');
  if (!s) { rowsBox.replaceChildren(); return; }

  const all = [...s.ref.records, ...s.cur.records].map((r) => r.water_temperature_c).filter((v) => v != null);
  const [lo, hi] = d3.extent(all);
  // Divergierende Skala mit neutraler Mitte: kalt ↔ warm
  const color = d3.scaleLinear().domain([lo, (lo + hi) / 2, hi]).range(['#1f5fb4', '#e9e5da', '#d6453d']).interpolate(d3.interpolateLab);
  setSlot('ramp-min', `${fmt0(lo)} °C`);
  setSlot('ramp-max', `${fmt0(hi)} °C`);
  const names = state.names.get(s.no);
  document.getElementById('stripes-caption').textContent =
    `Wassertemperatur der ${names.river_name} in ${names.station_name}. Ein Streifen pro Tag, ${YEARS.cur} bis ${cutoffLabel()}.`;

  const tooltip = getTooltip(figure);
  const rows = [[YEARS.ref, s.ref.records], [YEARS.cur, s.cur.records]].map(([year, recs]) => {
    const svg = d3.create('svg').attr('class', 'stripes__svg').attr('viewBox', '0 0 366 1')
      .attr('preserveAspectRatio', 'none').attr('role', 'img')
      .attr('aria-label', `Wassertemperatur ${year}, ${names.river_name}: ${recs.length} Tage`);
    svg.selectAll('rect').data(recs.filter((r) => r.water_temperature_c != null)).join('rect')
      // In Nicht-Schaltjahren fehlt der 29. Februar – der 28. deckt ihn mit ab, damit keine Lücke entsteht
      .attr('x', (r) => dayIndex(r.date.slice(5))).attr('y', 0).attr('height', 1)
      .attr('width', (r) => (r.date.endsWith('-02-28') && year % 4 !== 0 ? 2.05 : 1.05))
      .attr('fill', (r) => color(r.water_temperature_c));

    // Hover: Tag und Temperatur anzeigen
    const byDay = new Map(recs.map((r) => [dayIndex(r.date.slice(5)), r]));
    svg.on('pointermove', (event) => {
      const box = event.currentTarget.getBoundingClientRect();
      const r = byDay.get(Math.floor(((event.clientX - box.left) / box.width) * 366));
      if (!r || r.water_temperature_c == null) { tooltip.hide(); return; }
      const fb = figure.getBoundingClientRect();
      tooltip.show(el('div', {},
        el('div', { class: 'tooltip__date' }, fmtDateTooltip(parseDate(r.date))),
        el('div', {}, `${r.river_name}: `, el('strong', {}, fmtTemp(r.water_temperature_c)))),
      event.clientX - fb.left, box.top - fb.top - 30);
    }).on('pointerleave', () => tooltip.hide());

    return el('div', { class: `stripes__row${year === YEARS.cur ? ' stripes__row--cur' : ''}` },
      el('span', { class: 'stripes__year' }, String(year)), svg.node());
  });
  rowsBox.replaceChildren(...rows);

  // Aufbau-Animation starten, sobald die Streifen im DOM sind
  requestAnimationFrame(() => requestAnimationFrame(() => figure.classList.add('is-drawn')));
}

/* ---------- 5) Auf einen Blick: Kennzahlen ----------------------- */

function renderStats() {
  const box = document.getElementById('stats');
  const ml = inGroup('mittelland');
  if (!ml.length) { box.replaceChildren(el('p', { class: 'muted' }, 'Keine Vergleichsdaten.')); return; }
  const cutoff = cutoffLabel();
  setSlot('stats-lead', `Limmat, Thur und Rhein, jeweils vom 1. Januar bis ${cutoff}. Links ${YEARS.cur}, darunter der Wert von ${YEARS.ref}.`);

  // Pro Kennzahl der Fluss mit dem deutlichsten Unterschied – möglichst drei verschiedene Flüsse
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

  const tile = (s, number, unit, label, ref) => el('article', { class: 'stat' },
    el('div', { class: 'stat__river' }, keySwatch(s.no), displayName(s.no)),
    el('span', { class: 'stat__value' }, number, el('small', {}, unit)),
    el('p', { class: 'stat__label' }, label),
    el('p', { class: 'stat__ref' }, ref));

  box.replaceChildren(
    tile(hot, fmt0(hot.cur.summary.days_ge_25), 'Tage',
      'mit einem Tagesmittel von 25 °C oder mehr',
      `${YEARS.ref} im selben Zeitraum: ${fmt0(hot.ref.summary.days_ge_25)} Tage`),
    tile(warmest, fmtSigned(delta(warmest, 'wt_mean'), 1), '°C',
      `wärmer als ${YEARS.ref}, im Mittel über alle Tage`,
      `${fmtTemp(warmest.ref.summary.wt_mean)} → ${fmtTemp(warmest.cur.summary.wt_mean)}`),
    tile(lowest, fmtSigned(delta(lowest, 'w_mean')), 'cm',
      `tieferer Wasserstand als ${YEARS.ref}, im Mittel`,
      `${fmtCm(lowest.ref.summary.w_mean)} → ${fmtCm(lowest.cur.summary.w_mean)} ggü. mittlerem Pegel`),
  );
}

/* ---------- 6) Stationen ----------------------------------------- */

function renderStationGroups() {
  const box = document.getElementById('station-groups');
  box.replaceChildren(...GROUPS.map((group) => el('div', { class: 'station-group' },
    el('p', { class: 'station-group__title' }, group.title),
    el('ul', { class: 'station-list' }, STATIONS.filter((s) => s.group === group.key && state.names.has(s.no)).map((s) => {
      const n = state.names.get(s.no);
      const recent = state.recent.get(s.no) || [];
      const last = [...recent].reverse().find((r) => r.water_temperature_c != null || r.water_level_deviation_cm != null);
      return el('li', { class: 'station' },
        el('div', {},
          el('div', { class: 'station__name' }, keySwatch(s.no), el('span', { class: 'station__river' }, n.river_name)),
          el('div', { class: 'station__site' }, `${n.station_name} · Nr. ${s.no}`)),
        el('p', { class: 'station__role' }, s.role),
        el('div', { class: 'station__spark', 'data-spark': s.no, 'aria-hidden': 'true' }),
        el('div', { class: 'station__now' },
          el('span', {}, el('strong', {}, last?.water_temperature_c != null ? fmtTemp(last.water_temperature_c) : '–'), 'Wasser'),
          el('span', {}, el('strong', {}, last?.water_level_deviation_cm != null ? fmtCm(last.water_level_deviation_cm) : '–'), 'Pegel'),
          el('span', {}, el('strong', {}, last ? fmtDayShort(parseDate(last.date)) : '–'), 'Stand')));
    })))),
    el('p', { class: 'note' }, `Linien: Wassertemperatur ${YEARS.ref} grau, ${YEARS.cur} farbig (7-Tage-Mittel). Werte rechts: letztes Tagesmittel.`));
  drawSparklines();
}

/** Mini-Verlauf der Wassertemperatur (2022 grau, 2026 in Stationsfarbe) */
function drawSparklines() {
  if (!state.cmp) return;
  document.querySelectorAll('[data-spark]').forEach((node) => {
    const s = state.cmp.stations.find((c) => c.no === node.dataset.spark);
    node.replaceChildren();
    const width = node.clientWidth;
    const height = node.clientHeight;
    if (!s || width < 40) return;
    const ref = yearPoints(s.ref.records, YEARS.ref, 'WT', 7);
    const cur = yearPoints(s.cur.records, YEARS.cur, 'WT', 7);
    const x = d3.scaleUtc().domain([new Date(Date.UTC(2000, 0, 1)), new Date(Date.UTC(2000, 11, 31))]).range([0, width]);
    const y = d3.scaleLinear().domain([0, 28]).range([height - 2, 2]);
    const line = d3.line().defined((p) => p.value != null).x((p) => x(p.x)).y((p) => y(p.value)).curve(d3.curveMonotoneX);
    const svg = d3.select(node).append('svg').attr('width', width).attr('height', height);
    svg.append('path').attr('d', line(ref)).attr('fill', 'none').attr('stroke', 'var(--year-ref)').attr('stroke-width', 1.25);
    svg.append('path').attr('d', line(cur)).attr('fill', 'none').attr('stroke', colorOf(s.no)).attr('stroke-width', 2);
  });
}

/* ---------- 7) Jahr gegen Jahr ------------------------------------ */

/**
 * Datensätze eines Jahres → Punkte für die Grafik. Die x-Position ist der
 * Kalendertag in einem neutralen Schaltjahr (2000), damit beide Jahre
 * übereinanderliegen. Optional gleitendes Mittel über die letzten 7 Tage
 * (mindestens 5 Werte im Fenster, sonst Lücke). Nichts wird aufgefüllt.
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
    if (i > 0 && p.real - pts[i - 1].real > day) out.push({ x: p.x, value: null }); // Lücke
    out.push(p);
  });
  return out;
}

/** Linien beider Jahre für alle Stationen (aktuelle Messgrösse und Glättung) */
function cmpSeries() {
  const { parameter, smooth } = state.compare;
  return state.cmp.stations.map((s) => ({
    ...s,
    refPts: yearPoints(s.ref.records, YEARS.ref, parameter, smooth),
    curPts: yearPoints(s.cur.records, YEARS.cur, parameter, smooth),
  }));
}

/** Wertebereich der Linien, immer inkl. 0 (keine abgeschnittene Achse) */
function seriesExtent(series) {
  const values = series.flatMap((s) => [...s.refPts, ...s.curPts].map((p) => p.value)).filter((v) => v != null);
  const [lo, hi] = d3.extent(values);
  return [Math.min(0, lo ?? 0), Math.max(0, hi ?? 0)];
}

/** Messgrösse / Glättung ändern – gilt für die Übersicht und die vergrösserte Ansicht */
function setCompareOption(key, value) {
  state.compare[key] = value;
  for (const id of ['cmp-param-switch', 'zoom-param-switch']) setSegmentedValue(id, 'param', state.compare.parameter);
  for (const id of ['cmp-smooth-switch', 'zoom-smooth-switch']) setSegmentedValue(id, 'smooth', state.compare.smooth);
  renderMultiples();
  renderZoom();
}

/** Legende: Linien und Bedeutung der eingefärbten Fläche */
function diffLegend() {
  const isW = state.compare.parameter === 'W';
  return [
    el('span', {}, el('span', { class: 'swatch swatch--line', style: 'background:var(--year-ref)' }), String(YEARS.ref)),
    el('span', {}, el('span', { class: 'swatch swatch--line', style: 'background:var(--ink)' }), String(YEARS.cur)),
    el('span', {}, el('span', { class: 'swatch', style: 'background:var(--signal)' }), isW ? `${YEARS.cur} tiefer` : `${YEARS.cur} wärmer`),
    el('span', {}, el('span', { class: 'swatch', style: 'background:var(--cool)' }), isW ? `${YEARS.cur} höher` : `${YEARS.cur} kühler`),
  ];
}

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
  const [yMin, yMax] = seriesExtent(series); // gemeinsame Skala → ehrlicher Vergleich

  container.replaceChildren(...GROUPS.map((group) => el('div', { class: 'multiples__group' },
    el('p', { class: 'multiples__group-title' }, group.title),
    el('div', { class: 'multiples__grid' }, series.filter((s) => s.info.group === group.key).map((s) => {
      const a = isW ? s.ref.summary.w_mean : s.ref.summary.wt_mean;
      const b = isW ? s.cur.summary.w_mean : s.cur.summary.wt_mean;
      const zoomBtn = el('button', { type: 'button', class: 'zoom-open', 'aria-label': `${displayName(s.no)} vergrössern` }, 'Gross ↗');
      zoomBtn.addEventListener('click', () => openZoom(s.no));
      return el('div', { class: 'multiple' },
        el('div', { class: 'multiple__head' }, el('p', { class: 'multiple__title' }, keySwatch(s.no), displayName(s.no)), zoomBtn),
        el('p', { class: 'multiple__sub' }, a != null && b != null
          ? [`Mittel ${isW ? fmtSigned(a) : fmt1(a)} → `, el('strong', {}, f(b))] : 'keine Daten'),
        el('div', { class: 'chart chart--multiple', tabindex: '0', 'data-station': s.no,
          'aria-label': `${displayName(s.no)}: ${PARAM_INFO[parameter].label} ${YEARS.ref} und ${YEARS.cur}. Pfeiltasten wechseln den Tag.` }));
    })))));

  for (const s of series) {
    drawMultiple(container.querySelector(`.chart--multiple[data-station="${s.no}"]`), s, { yMin, yMax, isW, f });
  }
}

let clipId = 0;

/**
 * Grafik eines Flusses: 2022 (grau), 2026 (weiss) und die Fläche dazwischen.
 * Warm eingefärbt, wo 2026 die Hypothese stützt (wärmer bzw. tiefer), kühl,
 * wo 2026 dagegen spricht. Technik: «Difference chart» mit zwei Clip-Pfaden.
 */
function drawMultiple(chart, s, { yMin, yMax, isW, f, large = false }) {
  d3.select(chart).selectAll('svg').remove();
  const width = chart.clientWidth;
  const height = chart.clientHeight;
  const m = large ? { top: 14, right: 44, bottom: 28, left: 46 } : { top: 10, right: 34, bottom: 24, left: 36 };
  const innerW = width - m.left - m.right;
  const innerH = height - m.top - m.bottom;
  if (innerW < 50 || innerH < 50) return; // Grafik (noch) nicht sichtbar

  const x = d3.scaleUtc().domain([new Date(Date.UTC(2000, 0, 1)), new Date(Date.UTC(2000, 11, 31))]).range([0, innerW]);
  const y = d3.scaleLinear().domain([yMin, yMax]).nice().range([innerH, 0]);

  const svg = d3.select(chart).append('svg').attr('width', width).attr('height', height).attr('aria-hidden', 'true');
  const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);

  g.append('g').attr('class', 'axis axis--x').attr('transform', `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(d3.utcMonth.every(width < 330 ? 3 : width > 700 ? 1 : 2)).tickSizeOuter(0).tickFormat(locale.utcFormat('%b')))
    .call((a) => a.selectAll('.tick line').attr('y2', 3));
  g.append('g').attr('class', 'axis axis--y')
    .call(d3.axisLeft(y).ticks(large ? 8 : 4).tickSize(-innerW).tickFormat((v) => (isW ? fmtSigned(v) : fmt0(v))))
    .call((a) => a.selectAll('.tick text').attr('x', -6));
  g.append('line').attr('class', 'baseline').attr('x1', 0).attr('x2', innerW).attr('y1', y(0)).attr('y2', y(0));

  // Stichtag: bis hierhin wird verglichen
  const [mm, dd] = state.cmp.cutoff.split('-').map(Number);
  const cx = x(new Date(Date.UTC(2000, mm - 1, dd)));
  g.append('line').attr('class', 'cutoff-line').attr('x1', cx).attr('x2', cx).attr('y1', 0).attr('y2', innerH);

  // Differenzfläche: pro Tag des aktuellen Jahres der Wert von 2022 am selben Kalendertag
  const refByMd = new Map(s.refPts.filter((p) => p.value != null).map((p) => [p.md, p.value]));
  const joined = s.curPts.map((p) => ({ x: p.x, cur: p.value, ref: p.value == null ? null : refByMd.get(p.md) ?? null }));
  const id = ++clipId;
  const defs = svg.append('defs');
  defs.append('clipPath').attr('id', `clip-above-${id}`).append('path')
    .attr('d', d3.area().defined((d) => d.cur != null).x((d) => x(d.x)).y0(0).y1((d) => y(d.cur))(joined));
  defs.append('clipPath').attr('id', `clip-below-${id}`).append('path')
    .attr('d', d3.area().defined((d) => d.cur != null).x((d) => x(d.x)).y0(innerH).y1((d) => y(d.cur))(joined));
  const between = d3.area().defined((d) => d.cur != null && d.ref != null)
    .x((d) => x(d.x)).y0((d) => y(d.ref)).y1((d) => y(d.cur))(joined);
  // Unterhalb der 2026-Linie liegt 2022 tiefer → 2026 höher
  g.append('path').attr('class', isW ? 'diff--cool' : 'diff--warm').attr('clip-path', `url(#clip-below-${id})`).attr('d', between);
  // Oberhalb der 2026-Linie liegt 2022 höher → 2026 tiefer
  g.append('path').attr('class', isW ? 'diff--warm' : 'diff--cool').attr('clip-path', `url(#clip-above-${id})`).attr('d', between);

  const line = d3.line().defined((p) => p.value != null).x((p) => x(p.x)).y((p) => y(p.value));
  g.append('path').attr('class', 'line--ref').attr('d', line(s.refPts));
  g.append('path').attr('class', 'line--cur').attr('d', line(s.curPts));

  // Direkte Beschriftung am Linienende
  const lastOf = (pts) => [...pts].reverse().find((p) => p.value != null);
  const lr = lastOf(s.refPts);
  const lc = lastOf(s.curPts);
  if (lr) g.append('text').attr('class', 'year-label year-label--ref').attr('x', x(lr.x) + 4).attr('y', y(lr.value)).attr('dy', '0.35em').text(YEARS.ref);
  if (lc) g.append('text').attr('class', 'year-label').attr('x', x(lc.x) + 4).attr('y', y(lc.value)).attr('dy', '0.35em').text(YEARS.cur);

  // Crosshair über alle Kalendertage mit mindestens einem Wert
  const refBy = new Map(s.refPts.filter((p) => p.value != null).map((p) => [+p.x, p]));
  const curBy = new Map(s.curPts.filter((p) => p.value != null).map((p) => [+p.x, p]));
  const days = [...new Set([...refBy.keys(), ...curBy.keys()])].sort((a, b) => a - b);
  const shown = (v) => (isW ? Math.round(v) : Math.round(v * 10) / 10); // Differenz aus angezeigten Werten

  attachCrosshair({
    chart, g, innerW, innerH, margin: m,
    dockable: false, // Werte immer als schwebendes Fenster im Vordergrund – nichts darunter verschiebt sich
    positions: days.map((d) => x(d)),
    render(i, hover) {
      const d = days[i];
      const pr = refBy.get(d);
      const pc = curBy.get(d);
      const dots = [pr && { p: pr, fill: 'var(--year-ref)' }, pc && { p: pc, fill: 'var(--ink)' }].filter(Boolean);
      hover.selectAll('circle').data(dots).join('circle').attr('class', 'hover-dot').attr('r', 4.5)
        .style('fill', (o) => o.fill).attr('cx', x(d)).attr('cy', (o) => y(o.p.value));
      const row = (label, key, p) => el('div', { class: 'tooltip__row' },
        el('span', { class: 'tooltip__key', style: `background:${key}` }),
        el('span', { class: 'tooltip__name' }, label),
        el('span', { class: 'tooltip__value' }, p ? f(p.value) : 'kein Wert'));
      const diff = pr && pc ? shown(pc.value) - shown(pr.value) : null;
      return el('div', {},
        el('div', { class: 'tooltip__date' }, `${state.names.get(s.no).river_name}, ${fmtDayMonth(new Date(d))}`),
        row(String(YEARS.ref), 'var(--year-ref)', pr),
        row(String(YEARS.cur), 'var(--bg)', pc), // Tooltip ist hell → dunkler Schlüssel
        diff != null ? el('div', { class: 'tooltip__row' }, el('span', {}), el('span', { class: 'tooltip__name' }, 'Differenz'),
          el('span', { class: 'tooltip__value' }, isW ? fmtCm(diff) : `${fmtSigned(diff, 1)} °C`)) : null);
    },
    label: (i) => fmtDayMonth(new Date(days[i])),
  });
}

/* ----- Vergrösserte Ansicht (Dialog + Vollbild) ----- */

const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

function setupZoom() {
  const dialog = document.getElementById('zoom');
  const inner = dialog.querySelector('.zoom__inner');
  const fsBtn = document.getElementById('zoom-fullscreen');

  document.getElementById('zoom-close').addEventListener('click', () => dialog.close());
  document.getElementById('zoom-prev').addEventListener('click', () => stepZoom(-1));
  document.getElementById('zoom-next').addEventListener('click', () => stepZoom(1));
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); }); // Klick daneben schliesst
  dialog.addEventListener('close', () => {
    if (fullscreenElement()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    state.zoom.no = null;
  });

  // Vollbild nur anbieten, wo der Browser es für Elemente unterstützt (z.B. nicht auf dem iPhone)
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

function openZoom(no) {
  state.zoom.no = no;
  const dialog = document.getElementById('zoom');
  if (!dialog.open) dialog.showModal();
  renderZoom();
}

function stepZoom(dir) {
  const order = GROUPS.flatMap((g) => state.cmp.stations.filter((s) => s.info.group === g.key).map((s) => s.no));
  const i = order.indexOf(state.zoom.no);
  openZoom(order[(i + dir + order.length) % order.length]);
}

/** Grosse Grafik eines Flusses – mit eigener, an diesen Fluss angepasster Skala */
function renderZoom() {
  if (!state.zoom.no || !state.cmp) return;
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

/* ---------- 8) Urteil -------------------------------------------- */

function renderVerdict() {
  const box = document.getElementById('verdict');
  const ml = inGroup('mittelland');
  const al = inGroup('alpen');
  if (!ml.length) { box.replaceChildren(el('p', { class: 'muted' }, 'Keine Vergleichsdaten.')); return; }
  const cutoff = cutoffLabel();
  const warm = (s) => delta(s, 'wt_mean') > 0;
  const low = (s) => delta(s, 'w_mean') < 0;
  const both = ml.filter((s) => warm(s) && low(s)).length;

  let word; let cls; let lead;
  if (both === ml.length) {
    word = 'Ja'; cls = 'is-yes';
    lead = `Limmat, Thur und Rhein waren ${YEARS.cur} bis ${cutoff} im Mittel wärmer und lagen tiefer als im Hitzesommer ${YEARS.ref}.`;
  } else if (ml.some((s) => warm(s) || low(s))) {
    word = 'Teilweise'; cls = 'is-partial';
    lead = `${both} von ${ml.length} Mittelland-Flüssen waren ${YEARS.cur} wärmer und tiefer als ${YEARS.ref}.`;
  } else {
    word = 'Nein'; cls = 'is-no';
    lead = `Keiner der Mittelland-Flüsse war ${YEARS.cur} bis ${cutoff} wärmer und tiefer als ${YEARS.ref}.`;
  }

  const pct = (s) => (s.cur.summary.count ? `${fmt0((s.cur.summary.checked / s.cur.summary.count) * 100)} %` : '–');
  // Gefülltes Quadrat = erfüllt, leeres = nicht erfüllt; der Text daneben sagt dasselbe (nie nur Farbe)
  const cell = (ok, yes, no, value) => el('td', {}, el('span', { class: 'cell' },
    el('span', { class: `sq${ok ? ' is-yes' : ''}`, 'aria-hidden': 'true' }), el('b', {}, ok ? yes : no), el('small', {}, value)));
  const row = (s, control) => el('tr', { class: control ? 'is-control' : '' },
    el('th', { scope: 'row' }, keySwatch(s.no), displayName(s.no)),
    cell(warm(s), 'wärmer', 'nicht wärmer', `${fmtSigned(delta(s, 'wt_mean'), 1)} °C`),
    cell(low(s), 'tiefer', 'nicht tiefer', fmtCm(delta(s, 'w_mean'))),
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
        el('th', { scope: 'col' }, `Geprüfte Tage ${YEARS.cur}`))),
      el('tbody', {},
        el('tr', { class: 'group-row' }, el('th', { colspan: '4', scope: 'rowgroup' }, 'Mittelland · These')),
        ml.map((s) => row(s, false)),
        al.length ? el('tr', { class: 'group-row' }, el('th', { colspan: '4', scope: 'rowgroup' }, 'Alpen · Kontrollgruppe')) : null,
        al.map((s) => row(s, true))))),
    el('p', { class: 'verdict__footnote' }, el('sup', {}, '* '),
      `Verglichen werden die Mittelwerte vom 1. Januar bis ${cutoff}. Viele Werte von ${YEARS.cur} sind vom BAFU noch nicht geprüft, und das Jahr ist nicht vorbei. `,
      'Die Alpenflüsse gehören nicht zur These. Sie zeigen, dass Schmelzwasser anders auf einen heissen Sommer reagiert.'));
}

/** Methodik: Angaben aus den geladenen Daten */
function renderFacts() {
  setSlot('data-stand', fmtDotted(parseDate(state.latest)));
  setSlot('fact-range', `1. Januar 2020 bis ${longDate(state.latest)}`);
  const checked = d3.sum(state.cmp.stations, (s) => s.cur.summary.checked);
  const total = d3.sum(state.cmp.stations, (s) => s.cur.summary.count);
  if (total) setSlot('fact-checked', `${fmt0((checked / total) * 100)} % der Tage vollständig vom BAFU geprüft`);
}

/* ---------- 9) Explorer: Zeitverlauf aller Flüsse ----------------- */

/** Legende = Filter: Chips zum Ein- und Ausblenden der Flüsse */
function renderLegend() {
  const legend = document.getElementById('ts-legend');
  const chips = STATIONS.filter((s) => state.names.has(s.no)).map((s) => {
    const chip = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'true', style: `--c:${colorOf(s.no)}` },
      el('span', { class: 'chip__key', 'aria-hidden': 'true' }), displayName(s.no));
    chip.addEventListener('click', () => {
      const hidden = state.ts.hidden;
      hidden.has(s.no) ? hidden.delete(s.no) : hidden.add(s.no);
      chip.setAttribute('aria-pressed', String(!hidden.has(s.no)));
      loadTimeseries(); // Filter → neue Abfrage an unload.php
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

/** Holt die Tagesmittel für Auswahl, Messgrösse und Zeitraum aus unload.php */
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
  chart.classList.add('is-loading'); // alte Grafik bleibt sichtbar, bis neue Daten da sind
  try {
    const records = await unload({ stations: visible.map((s) => s.no).join(','), parameter: ts.parameter, from, to });
    if (request !== ts.request) return; // inzwischen neuere Anfrage gestartet
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

/** Datensätze → Linien pro Station. Fehlende Tage werden als Lücke eingefügt, nicht aufgefüllt. */
function toSeries(records, parameter) {
  const field = FIELD[parameter];
  const byNo = groupByStation(records);
  return STATIONS.filter((s) => byNo.has(s.no)).map((s) => {
    const points = [];
    let prev = null;
    for (const r of byNo.get(s.no)) {
      const date = parseDate(r.date);
      if (prev && d3.utcDay.count(prev, date) > 1) points.push({ date: d3.utcDay.offset(prev, 1), value: null });
      points.push({ date, value: r[field], release: r.release_state });
      prev = date;
    }
    return { no: s.no, points };
  });
}

function renderTimeseries() {
  const ts = state.ts;
  const info = PARAM_INFO[ts.parameter];
  document.getElementById('ts-title').textContent = `${info.label}, Tagesmittel`;
  document.getElementById('ts-unit').textContent = info.axis;
  document.getElementById('ts-note').textContent = ts.parameter === 'W'
    ? 'Wasserstände liegen je nach Ort auf ganz unterschiedlicher Höhe. Die Grafik zeigt deshalb, wie viele Zentimeter ein Fluss über oder unter seinem eigenen mittleren Pegel seit 2020 stand.'
    : 'Tagesmittel der Wassertemperatur. Gestrichelte Linie: 20 °C.';

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

  const width = chart.clientWidth;
  const height = chart.clientHeight;
  const small = width < 560;
  const m = { top: 12, right: small ? 8 : 16, bottom: 28, left: small ? 38 : 48 };
  const innerW = width - m.left - m.right;
  const innerH = height - m.top - m.bottom;
  if (innerW < 50 || innerH < 50) return;

  const from = parseDate(ts.range.from);
  const to = parseDate(ts.range.to);
  const x = d3.scaleUtc().domain([from, to]).range([0, innerW]);
  // Achse inkl. 0 (keine abgeschnittene Achse); beim Wasserstand ist 0 = mittlerer Pegel
  const [lo, hi] = d3.extent(allValues);
  const y = d3.scaleLinear().domain([Math.min(0, lo), Math.max(0, hi)]).nice().range([innerH, 0]);

  const svg = d3.select(chart).selectAll('svg').data([null]).join('svg')
    .attr('width', width).attr('height', height).attr('role', 'img')
    .attr('aria-label', `${info.label} von ${series.map((s) => displayName(s.no)).join(', ')}, ${longDate(ts.range.from)} bis ${longDate(ts.range.to)}`);
  svg.selectAll('*').remove();
  const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);

  const span = d3.utcDay.count(from, to);
  const xTicks = Math.max(2, Math.floor(innerW / (small ? 70 : 90)));
  g.append('g').attr('class', 'axis axis--x').attr('transform', `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(xTicks).tickSizeOuter(0).tickFormat(timeTickFormat(span)))
    .call((a) => a.selectAll('.tick line').attr('y2', 4));
  g.append('g').attr('class', 'axis axis--y')
    .call(d3.axisLeft(y).ticks(small ? 5 : 7).tickSize(-innerW).tickFormat((v) => (ts.parameter === 'W' ? fmtSigned(v) : fmt0(v))))
    .call((a) => a.selectAll('.tick text').attr('x', -8));

  g.append('line').attr('class', 'baseline').attr('x1', 0).attr('x2', innerW).attr('y1', y(0)).attr('y2', y(0));
  if (ts.parameter === 'W') {
    g.append('text').attr('class', 'refline-label').attr('x', innerW).attr('y', y(0) - 5).attr('text-anchor', 'end').text('mittlerer Pegel');
  } else if (hi >= 20) {
    g.append('line').attr('class', 'refline').attr('x1', 0).attr('x2', innerW).attr('y1', y(20)).attr('y2', y(20));
    g.append('text').attr('class', 'refline-label').attr('x', 4).attr('y', y(20) - 5).text('20 °C');
  }

  const line = d3.line().defined((p) => p.value != null).x((p) => x(p.date)).y((p) => y(p.value));
  const lines = g.append('g');
  for (const s of series) {
    lines.append('path').attr('class', 'series-line').style('stroke', colorOf(s.no)).attr('d', line(s.points));
    if (span <= 31) { // bei kurzen Zeiträumen einzelne Tage als Punkte zeigen
      lines.selectAll(null).data(s.points.filter((p) => p.value != null)).join('circle')
        .attr('class', 'series-dot').attr('r', 3.5).style('fill', colorOf(s.no))
        .attr('cx', (p) => x(p.date)).attr('cy', (p) => y(p.value));
    }
  }

  const dates = [...new Set(series.flatMap((s) => s.points.filter((p) => p.value != null).map((p) => +p.date)))].sort((a, b) => a - b);
  const byDate = series.map((s) => new Map(s.points.filter((p) => p.value != null).map((p) => [+p.date, p])));
  const f = ts.parameter === 'W' ? fmtCm : fmtTemp;

  attachCrosshair({
    chart, g, innerW, innerH, margin: m,
    positions: dates.map((d) => x(d)),
    render(i, hover) {
      const date = dates[i];
      const rows = series.map((s, k) => ({ s, p: byDate[k].get(date) })).filter((r) => r.p);
      hover.selectAll('circle').data(rows).join('circle').attr('class', 'hover-dot').attr('r', 5)
        .style('fill', (r) => colorOf(r.s.no)).attr('cx', x(date)).attr('cy', (r) => y(r.p.value));
      rows.sort((a, b) => b.p.value - a.p.value);
      return el('div', {},
        el('div', { class: 'tooltip__date' }, fmtDateTooltip(new Date(date))),
        rows.map(({ s, p }) => el('div', { class: 'tooltip__row' },
          el('span', { class: 'tooltip__key', style: `background:${colorOf(s.no)}` }),
          el('span', { class: 'tooltip__name' }, state.names.get(s.no).river_name,
            el('small', {}, `${state.names.get(s.no).station_name} · ${RELEASE_LABEL[p.release] ?? 'ohne Status'}`)),
          el('span', { class: 'tooltip__value' }, f(p.value)))));
    },
    label: (i) => fmtDateLong(new Date(dates[i])),
  });
}

/** Achsenbeschriftung abhängig von der Länge des Zeitraums */
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

/** Tabellenansicht: Kennzahlen des gewählten Zeitraums (Zugänglichkeit, ohne Hover) */
function renderSummaryTable(series = []) {
  const table = document.getElementById('ts-table');
  const f = state.ts.parameter === 'W' ? fmtCm : fmtTemp;
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

/* ---------- 10) Tooltip, Crosshair, Resize, Animationen ----------- */

const DOCK_BELOW = 560; // unter dieser Grafikbreite: Werte-Panel unter der Explorer-Grafik

/**
 * Ein Tooltip pro Grafik. Nur die Explorer-Grafik («dockable») zeigt ihre
 * Werte auf schmalen Bildschirmen in einem Panel unter der Grafik, weil ihr
 * Tooltip bis zu sechs Zeilen hat und sonst die ganze Grafik verdecken würde.
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
      // Tooltip links/rechts vom Punkt, nie über den Rand hinaus
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
 * Crosshair: Eine vertikale Linie folgt Maus/Finger und rastet am nächsten
 * Datenpunkt ein. Tastatur: Pfeiltasten links/rechts (mit Shift: 7 Tage), Esc schliesst.
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

  // Transparente Fläche als Trefferzone – grösser als die Linien selbst
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

  // Touch: Tippen ausserhalb der Grafik schliesst den Tooltip (Listener nur einmal pro Grafik)
  chart.hideCrosshair = hide;
  if (!chart.dataset.outsideListener) {
    chart.dataset.outsideListener = 'true';
    document.addEventListener('pointerdown', (event) => {
      if (!chart.contains(event.target)) chart.hideCrosshair();
    }, { passive: true });
  }
}

/**
 * Grafiken neu zeichnen (ohne neue Datenabfrage), wenn sich die Breite ändert
 * oder die Seite sichtbar wird – ein Hintergrund-Tab hat beim Laden die Breite 0.
 */
function setupResize() {
  let frame = null;
  let lastWidth = window.innerWidth;
  const redraw = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      drawSparklines();
      renderMultiples();
      renderZoom();
      renderTimeseries();
    });
  };
  window.addEventListener('resize', () => {
    if (window.innerWidth === lastWidth) return; // mobile Adressleiste ändert nur die Höhe
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

/** Lesefortschritt oben am Bildschirm */
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
