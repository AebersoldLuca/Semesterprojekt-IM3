/* ==================================================================
   DataStory «Sechs Flüsse, sechs Temperamente» – Frontend
   ------------------------------------------------------------------
   Datenfluss:  MySQL → unload.php → JSON → script.js → D3-Grafiken

   Dieses Script ruft AUSSCHLIESSLICH unload.php auf (eigene Datenbank).
   Die BAFU-API wird im Frontend nie verwendet.

   Hypothese der Story:
     «2026 waren die Flüsse im Mittelland bisher wärmer und führten weniger
      Wasser als im Hitzesommer 2022.»

   Aufbau:
     0) Konfiguration & Hilfsfunktionen
     1) Datenabruf (unload.php)
     2) Start & Zustand
     3) Story-Texte (Stationen, Methodik)
     4) Hypothese: 2022 vs. 2026 (Grafik je Fluss, Vergrössern/Vollbild, Urteil)
     5) Explorer: Zeitverlauf aller Flüsse
     6) Tooltip, Resize, Animationen
   ================================================================== */

'use strict';

/* ---------- 0) Konfiguration & Hilfsfunktionen ------------------- */

const UNLOAD_URL = 'unload.php';

/** Die zwei verglichenen Jahre der Hypothese */
const YEARS = { ref: 2022, cur: 2026 };

/**
 * Redaktionelle Einteilung der Stationen (BAFU-Nummern):
 * Die Hypothese betrifft das Mittelland, die Alpenflüsse dienen als Vergleich.
 */
const GROUPS = [
  { key: 'mittelland', title: 'Mittelland', stations: ['2243', '2044', '2091'] },
  { key: 'alpen', title: 'Alpen – zum Vergleich', stations: ['2019', '2009', '2068'] },
];

const PARAM_INFO = {
  WT: { label: 'Wassertemperatur', unit: '°C', axis: 'in °C' },
  W:  { label: 'Wasserstand', unit: 'cm', axis: 'Abweichung vom mittleren Pegel in cm' },
};

const RELEASE_LABEL = { 1: 'provisorisch', 2: 'validiert', 3: 'definitiv', null: 'ohne Status' };

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

// Deutsches (Schweizer) Datumsformat für D3-Achsen
const locale = d3.timeFormatLocale({
  dateTime: '%A, %e. %B %Y, %X', date: '%d.%m.%Y', time: '%H:%M:%S', periods: ['', ''],
  days: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'],
  shortDays: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
  months: MONTHS, shortMonths: MONTHS_SHORT,
});
const parseDate = d3.utcParse('%Y-%m-%d');
const fmtDateLong = locale.utcFormat('%-d. %B %Y');
const fmtDateTooltip = locale.utcFormat('%a, %-d. %B %Y');
const fmtIsoDate = d3.utcFormat('%Y-%m-%d');

const nf = (digits) => new Intl.NumberFormat('de-CH', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmt1 = nf(1).format;
const fmt2 = nf(2).format;
const fmt0 = nf(0).format;
const fmtSigned = (v, digits = 0) => (v > 0 ? '+' : v < 0 ? '−' : '±') + nf(digits).format(Math.abs(v));
const fmtTemp = (v) => `${fmt1(v)} °C`;
const fmtCm = (v) => `${fmtSigned(v)} cm`;

/** Farbe folgt der Station (sort_order), nie ihrem Rang → CSS-Variable */
const colorOf = (station) => `var(--series-${station.sort_order})`;

/** Datum «YYYY-MM-DD» → «21. September 2026» */
const longDate = (iso) => fmtDateLong(parseDate(iso));

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

const keySwatch = (station, cls = 'key-inline') => el('span', { class: cls, style: `background:${colorOf(station)}`, 'aria-hidden': 'true' });

/* ---------- 1) Datenabruf: nur unload.php ------------------------ */

const cache = new Map();

/**
 * Ruft unload.php mit den gegebenen Parametern auf und gibt das JSON zurück.
 * Fehler von unload.php (z.B. «Datenbank nicht erreichbar») werden als
 * verständliche Meldung weitergereicht.
 */
async function unload(params) {
  const url = `${UNLOAD_URL}?${new URLSearchParams(params)}`;
  if (cache.has(url)) return cache.get(url);

  let response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    throw new Error('Der Server ist nicht erreichbar. Bitte Internetverbindung prüfen.');
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    /* keine JSON-Antwort */
  }
  if (!response.ok || !data) {
    throw new Error(data?.error || `Die Daten konnten nicht geladen werden (HTTP ${response.status}).`);
  }
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

/* ---------- 2) Start & Zustand ----------------------------------- */

const state = {
  stations: [],          // aus type=stations
  meta: null,            // aus type=meta
  insights: null,        // aus type=insights (aktuelle Werte in den Stationskarten)
  compare: { data: null, parameter: 'WT', smooth: 7 }, // aus type=compare (Hypothese)
  zoom: { no: null },    // Station in der vergrösserten Ansicht
  ts: { parameter: 'WT', days: '365', hidden: new Set(), data: null, request: 0 },
};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  setupReveal();
  setupSegmented('cmp-param-switch', 'param', (v) => setCompareOption('parameter', v));
  setupSegmented('cmp-smooth-switch', 'smooth', (v) => setCompareOption('smooth', Number(v)));
  setupSegmented('zoom-param-switch', 'param', (v) => setCompareOption('parameter', v));
  setupSegmented('zoom-smooth-switch', 'smooth', (v) => setCompareOption('smooth', Number(v)));
  setupZoom();
  setupSegmented('param-switch', 'param', (v) => { state.ts.parameter = v; renderTimeseries(); });
  setupSegmented('range-switch', 'days', (v) => { state.ts.days = v; loadTimeseries(); });

  // Stationen + Metadaten zuerst: sie werden überall gebraucht
  try {
    const [stations, meta] = await Promise.all([unload({ type: 'stations' }), unload({ type: 'meta' })]);
    state.stations = stations.stations;
    state.meta = meta;
  } catch (err) {
    fatal(err);
    return;
  }
  if (!state.stations.length) {
    fatal(new Error('In der Datenbank sind noch keine Stationen vorhanden. Bitte zuerst den Import (etl/load.php) ausführen.'));
    return;
  }

  renderStationGroups();
  renderLegend();
  renderMeta();
  loadCompare();
  loadTimeseries();

  try {
    state.insights = await unload({ type: 'insights' });
    renderStationNow();
  } catch {
    /* Stationskarten zeigen dann einfach keine aktuellen Werte */
  }

  setupResize();
}

/** Wenn gar nichts geladen werden kann: klare Meldung statt leerer Seite. */
function fatal(err) {
  showToast(err.message);
  const msg = `Die Daten sind momentan nicht verfügbar: ${err.message}`;
  setStatus('ts-status', msg);
  for (const id of ['station-groups', 'cmp-multiples', 'verdict']) {
    document.getElementById(id).replaceChildren(el('p', { class: 'muted' }, msg));
  }
}

/** Segmented Control (Radiogruppe) mit Tastatursteuerung */
function setupSegmented(id, dataKey, onChange) {
  const group = document.getElementById(id);
  const buttons = [...group.querySelectorAll('button')];
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

/* ---------- 3) Story-Texte --------------------------------------- */

function stationByNo(no) {
  return state.stations.find((s) => s.station_no === no);
}

/** Stationskarten, gruppiert nach Mittelland / Alpen */
function renderStationGroups() {
  const card = (s) => el('li', { class: 'station', style: `--c:${colorOf(s)}`, 'data-station': s.station_no },
    el('div', { class: 'station__river' }, s.river_name),
    el('div', { class: 'station__site' }, `${s.name} · ${s.catchment_name ?? ''} · BAFU ${s.station_no}`),
    el('p', { class: 'station__role' }, s.story_role ?? ''),
    el('div', { class: 'station__now' }, el('span', {}, 'Aktuelle Werte werden geladen …')));
  document.getElementById('station-groups').replaceChildren(...GROUPS.map((group) => el('div', { class: 'station-group' },
    el('p', { class: 'station-group__title' }, group.title),
    el('ul', { class: 'station-list' }, state.stations.filter((s) => group.stations.includes(s.station_no)).map(card)))));
}

/** Jüngste Werte in den Stationskarten (aus type=insights) */
function renderStationNow() {
  for (const s of state.insights.stations) {
    const box = document.querySelector(`[data-station="${s.station_no}"] .station__now`);
    if (!box) continue;
    const wt = s.WT.latest;
    const w = s.W.latest;
    box.replaceChildren(
      el('span', {}, el('strong', {}, wt ? fmtTemp(wt.value) : '–'), 'Wasser'),
      el('span', {}, el('strong', {}, w ? fmtCm(w.deviation_cm) : '–'), 'vs. mittlerer Pegel'),
      el('span', {}, el('strong', {}, wt ? fmtDateLong(parseDate(wt.date)).replace(/ \d{4}$/, '') : '–'), 'Tagesmittel'),
    );
  }
}

function renderMeta() {
  const m = state.meta;
  const range = `${longDate(m.data_range.from)} bis ${longDate(m.data_range.to)}`;
  setSlot('range-text', `vom ${range}`);
  setSlot('fact-range', range);
  setSlot('fact-count', `${fmt0(m.observations)} Tagesmittel (Wasserstand und Wassertemperatur)`);
  setSlot('fact-aggregation', ['Tagesmittel (', el('code', {}, m.aggregation ?? 'data_1day_mean'), ')']);

  if (m.last_import) {
    const t = new Date(m.last_import.finished_at);
    const when = new Intl.DateTimeFormat('de-CH', { dateStyle: 'long', timeStyle: 'short' }).format(t);
    let text = `${when} Uhr`;
    if (m.last_attempt && m.last_attempt.status === 'failed') {
      text += ' – der letzte Importversuch ist fehlgeschlagen, angezeigt werden die zuletzt gespeicherten Daten.';
    }
    setSlot('fact-import', text);
  } else {
    setSlot('fact-import', 'noch kein erfolgreicher Import');
  }

  // Anteile nach Freigabestatus
  const rs = m.release_states;
  const total = Object.values(rs).reduce((a, b) => a + b, 0) || 1;
  const pct = (n) => (n / total) * 100;
  const pctText = (n) => (n > 0 && pct(n) < 1 ? '< 1 %' : `${fmt0(pct(n))} %`);
  const parts = [['3', 'definitiv'], ['2', 'validiert'], ['1', 'provisorisch'], ['none', 'ohne Status']]
    .filter(([k]) => rs[k])
    .map(([k, label]) => `${pctText(rs[k])} ${label}`);
  setSlot('fact-release', parts.join(' · '));
  const unchecked = (rs['1'] || 0) + (rs.none || 0);
  setSlot('release-share', `${pctText(unchecked)} der gespeicherten Werte`);

  if (m.rejected && m.rejected.count > 0) {
    setSlot('rejected-text', `im gesamten Zeitraum betraf das ${fmt0(m.rejected.count)} Tageswert${m.rejected.count === 1 ? '' : 'e'}; sie erscheinen in der Grafik als Lücke`);
  }

  const years = (parseDate(m.data_range.to) - parseDate(m.data_range.from)) / (365.25 * 864e5);
  setSlot('limits-years', `Rund ${fmt1(years)} Jahre Daten`);
}

function listJoin(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} und ${items[items.length - 1]}`;
}

/* ---------- 4) Hypothese: 2022 vs. 2026 -------------------------- */

/** Liest den Jahresvergleich aus unload.php (type=compare) */
async function loadCompare() {
  try {
    state.compare.data = await unload({ type: 'compare', years: `${YEARS.ref},${YEARS.cur}` });
  } catch (err) {
    const msg = `Der Jahresvergleich konnte nicht geladen werden: ${err.message}`;
    document.getElementById('cmp-multiples').replaceChildren(el('p', { class: 'muted' }, msg));
    document.getElementById('verdict').replaceChildren(el('p', { class: 'muted' }, msg));
    return;
  }
  renderCompareTexts();
  renderMultiples();
  renderVerdict();
}

/** Messgrösse / Glättung ändern – gilt für die Übersicht und die vergrösserte Ansicht */
function setCompareOption(key, value) {
  state.compare[key] = value;
  setSegmentedValue('cmp-param-switch', 'param', state.compare.parameter);
  setSegmentedValue('zoom-param-switch', 'param', state.compare.parameter);
  setSegmentedValue('cmp-smooth-switch', 'smooth', state.compare.smooth);
  setSegmentedValue('zoom-smooth-switch', 'smooth', state.compare.smooth);
  renderMultiples();
  renderZoom();
}

/** Stationen des Vergleichs mit Stammdaten und Kennzahlen beider Jahre */
function cmpStations() {
  return state.compare.data.stations
    .map((s) => ({ ...s, station: stationByNo(s.station_no), ref: s.years[YEARS.ref], cur: s.years[YEARS.cur] }))
    .filter((s) => s.station && s.ref && s.cur);
}

const groupOf = (no) => GROUPS.find((g) => g.stations.includes(no));
const inGroup = (key) => cmpStations().filter((s) => groupOf(s.station_no)?.key === key);

/** Stichtag «MM-DD» → «27. September» */
function cutoffLabel() {
  return longDate(`${YEARS.cur}-${state.compare.data.cutoff}`).replace(/ \d{4}$/, '');
}

/** Hero, Einleitungen und Grenzen – alle Zahlen aus type=compare */
function renderCompareTexts() {
  const cutoff = cutoffLabel();
  setSlot('year-ref', String(YEARS.ref));
  setSlot('year-cur', String(YEARS.cur));

  // Hero: stärkster Anstieg der warmen Tage und tiefster Pegel im Mittelland
  const ml = inGroup('mittelland');
  const warmer = ml.filter((s) => s.cur.summary.days_ge_20 != null && s.ref.summary.days_ge_20 != null);
  if (warmer.length) {
    const top = warmer.reduce((a, b) =>
      (b.cur.summary.days_ge_20 - b.ref.summary.days_ge_20 > a.cur.summary.days_ge_20 - a.ref.summary.days_ge_20 ? b : a));
    setSlot('hero-a-value', `${fmt0(top.cur.summary.days_ge_20)} Tage`);
    setSlot('hero-a-label', [keySwatch(top.station, 'key'),
      `${top.display_name}: Tage mit mindestens 20 °C, 1. Januar bis ${cutoff} ${YEARS.cur}. ${YEARS.ref} waren es ${fmt0(top.ref.summary.days_ge_20)}.`]);
  }
  const lower = ml.filter((s) => s.cur.summary.w_mean_cm != null);
  if (lower.length) {
    const low = lower.reduce((a, b) => (b.cur.summary.w_mean_cm < a.cur.summary.w_mean_cm ? b : a));
    setSlot('hero-b-value', fmtCm(low.cur.summary.w_mean_cm));
    setSlot('hero-b-label', [keySwatch(low.station, 'key'),
      `${low.display_name}: mittlerer Pegel ${YEARS.cur} gegenüber dem Durchschnitt seit 2020. ${YEARS.ref}: ${fmtCm(low.ref.summary.w_mean_cm)}.`]);
  }
}

/**
 * Tageswerte eines Jahres → Punkte für die Grafik. Die x-Position ist der
 * Kalendertag in einem neutralen Schaltjahr (2000), damit beide Jahre
 * übereinanderliegen. Optional gleitendes Mittel über die letzten 7 Tage
 * (mindestens 4 Werte im Fenster, sonst Lücke). Nichts wird aufgefüllt.
 */
function yearPoints(rows, year, col, smooth) {
  const pts = rows
    .filter((r) => r[col] != null)
    .map((r) => {
      const [mm, dd] = r[0].split('-').map(Number);
      return { real: Date.UTC(year, mm - 1, dd), x: new Date(Date.UTC(2000, mm - 1, dd)), md: r[0], raw: r[col] };
    });
  const day = 864e5;
  let start = 0;
  pts.forEach((p, i) => {
    if (smooth <= 1) { p.value = p.raw; return; }
    while (pts[start].real < p.real - (smooth - 1) * day) start++;
    const win = pts.slice(start, i + 1);
    p.value = win.length >= Math.ceil(smooth / 2) + 1 ? d3.mean(win, (w) => w.raw) : null;
  });
  // Lücken: fehlende Tage unterbrechen die Linie
  const out = [];
  pts.forEach((p, i) => {
    if (i > 0 && p.real - pts[i - 1].real > day) out.push({ x: p.x, value: null });
    out.push(p);
  });
  return out;
}

/** Kleine Vielfache: pro Fluss eine Grafik mit 2022 (grau) und 2026 (farbig) */
function renderMultiples() {
  const data = state.compare.data;
  if (!data) return;
  const param = state.compare.parameter;
  const isW = param === 'W';
  const smooth = state.compare.smooth;
  const col = isW ? 2 : 1;
  const f = isW ? fmtCm : fmtTemp;
  const cutoff = cutoffLabel();
  const container = document.getElementById('cmp-multiples');

  document.getElementById('cmp-title').textContent = `${isW ? 'Wasserstand' : 'Wassertemperatur'}, ${smooth > 1 ? 'gleitendes 7-Tage-Mittel' : 'Tagesmittel'}`;
  document.getElementById('cmp-unit').textContent = isW ? 'Abweichung vom mittleren Pegel in cm' : 'in °C';
  document.getElementById('cmp-note').textContent =
    `Senkrechte Linie: ${cutoff} – bis hierhin reichen die Daten von ${YEARS.cur}. Alle Grafiken haben dieselbe Skala.` +
    (smooth > 1 ? ' Das 7-Tage-Mittel glättet kurze Schwankungen; im Tooltip stehen die geglätteten Werte.' : '');

  const series = cmpSeries();

  // Gemeinsame Skala für alle Flüsse → ehrlicher Vergleich zwischen den Grafiken
  const [yMin, yMax] = seriesExtent(series);

  container.replaceChildren(...GROUPS.map((group) => el('div', { class: 'multiples__group' },
    el('p', { class: 'multiples__group-title' }, group.title),
    el('div', { class: 'multiples__grid' }, series.filter((s) => group.stations.includes(s.station_no)).map((s) => {
      const r = s.ref.summary;
      const c = s.cur.summary;
      const a = isW ? r.w_mean_cm : r.wt_mean;
      const b = isW ? c.w_mean_cm : c.wt_mean;
      const zoomBtn = el('button', { type: 'button', class: 'zoom-open', 'aria-label': `${s.display_name} vergrössern` },
        el('span', { 'aria-hidden': 'true' }, '⤢'), ' Vergrössern');
      zoomBtn.addEventListener('click', () => openZoom(s.station_no));
      return el('div', { class: 'multiple' },
        el('div', { class: 'multiple__head' },
          el('p', { class: 'multiple__title' }, keySwatch(s.station, 'key'), s.display_name), zoomBtn),
        el('p', { class: 'multiple__sub' }, a != null && b != null
          ? `Mittel bis ${cutoff}: ${YEARS.ref} ${f(a)} · ${YEARS.cur} ${f(b)}` : 'keine Daten'),
        el('div', { class: 'chart chart--multiple', tabindex: '0', 'data-station': s.station_no,
          'aria-label': `${s.display_name}: ${isW ? 'Wasserstand' : 'Wassertemperatur'} ${YEARS.ref} und ${YEARS.cur}. Pfeiltasten wechseln den Tag.` }));
    })))));

  for (const s of series) {
    const chart = container.querySelector(`.chart--multiple[data-station="${s.station_no}"]`);
    drawMultiple(chart, s, { yMin, yMax, isW, f });
  }
}

/** Linien beider Jahre für alle Stationen (aktuelle Messgrösse und Glättung) */
function cmpSeries() {
  const col = state.compare.parameter === 'W' ? 2 : 1;
  return cmpStations().map((s) => ({
    ...s,
    refPts: yearPoints(s.ref.series, YEARS.ref, col, state.compare.smooth),
    curPts: yearPoints(s.cur.series, YEARS.cur, col, state.compare.smooth),
  }));
}

/** Wertebereich der Linien, immer inkl. 0 (keine abgeschnittene Achse) */
function seriesExtent(series) {
  const values = series.flatMap((s) => [...s.refPts, ...s.curPts].map((p) => p.value)).filter((v) => v != null);
  const [lo, hi] = d3.extent(values);
  return [Math.min(0, lo ?? 0), Math.max(0, hi ?? 0)];
}

function drawMultiple(chart, s, { yMin, yMax, isW, f, large = false }) {
  d3.select(chart).selectAll('svg').remove();
  const width = chart.clientWidth;
  const height = chart.clientHeight;
  const m = large ? { top: 14, right: 44, bottom: 28, left: 46 } : { top: 10, right: 34, bottom: 24, left: 36 };
  const innerW = width - m.left - m.right;
  const innerH = height - m.top - m.bottom;
  if (innerW < 50 || innerH < 50) return;

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
  const [mm, dd] = state.compare.data.cutoff.split('-').map(Number);
  const cx = x(new Date(Date.UTC(2000, mm - 1, dd)));
  g.append('line').attr('class', 'cutoff-line').attr('x1', cx).attr('x2', cx).attr('y1', 0).attr('y2', innerH);

  const line = d3.line().defined((p) => p.value != null).x((p) => x(p.x)).y((p) => y(p.value));
  g.append('path').attr('class', 'line--ref').attr('d', line(s.refPts));
  g.append('path').attr('class', 'series-line').style('stroke', colorOf(s.station)).attr('d', line(s.curPts));

  // Direkte Beschriftung am Linienende
  const lastOf = (pts) => [...pts].reverse().find((p) => p.value != null);
  const lr = lastOf(s.refPts);
  const lc = lastOf(s.curPts);
  if (lr) g.append('text').attr('class', 'year-label year-label--ref').attr('x', x(lr.x) + 4).attr('y', y(lr.value)).attr('dy', '0.35em').text(YEARS.ref);
  if (lc) g.append('text').attr('class', 'year-label').style('fill', colorOf(s.station)).attr('x', x(lc.x) + 4).attr('y', y(lc.value)).attr('dy', '0.35em').text(YEARS.cur);

  // Crosshair über alle Kalendertage, an denen mindestens ein Jahr einen Wert hat
  const refBy = new Map(s.refPts.filter((p) => p.value != null).map((p) => [+p.x, p]));
  const curBy = new Map(s.curPts.filter((p) => p.value != null).map((p) => [+p.x, p]));
  const days = [...new Set([...refBy.keys(), ...curBy.keys()])].sort((a, b) => a - b);
  const fmtDay = locale.utcFormat('%-d. %B');

  attachCrosshair({
    chart, g, innerW, innerH, margin: m,
    dockable: false, // Werte immer als schwebendes Fenster im Vordergrund – nichts darunter verschiebt sich
    positions: days.map((d) => x(d)),
    render(i, hover) {
      const d = days[i];
      const pr = refBy.get(d);
      const pc = curBy.get(d);
      const dots = [pr && { p: pr, fill: 'var(--year-ref)' }, pc && { p: pc, fill: colorOf(s.station) }].filter(Boolean);
      hover.selectAll('circle').data(dots).join('circle').attr('class', 'hover-dot').attr('r', 4.5)
        .style('fill', (o) => o.fill).attr('cx', x(d)).attr('cy', (o) => y(o.p.value));
      const row = (label, key, p) => el('div', { class: 'tooltip__row' },
        el('span', { class: 'tooltip__key', style: `background:${key}` }),
        el('span', { class: 'tooltip__name' }, label),
        el('span', { class: 'tooltip__value' }, p ? f(p.value) : 'kein Wert'));
      // Differenz aus den angezeigten (gerundeten) Werten – so lässt sie sich nachrechnen
      const shown = (v) => (isW ? Math.round(v) : Math.round(v * 10) / 10);
      const diff = pr && pc ? shown(pc.value) - shown(pr.value) : null;
      return el('div', {},
        el('div', { class: 'tooltip__date' }, `${s.station.river_name}, ${fmtDay(new Date(d))}`),
        row(String(YEARS.ref), 'var(--year-ref)', pr),
        row(String(YEARS.cur), colorOf(s.station), pc),
        diff != null ? el('div', { class: 'tooltip__row' }, el('span', {}), el('span', { class: 'tooltip__name' }, 'Differenz'),
          el('span', { class: 'tooltip__value' }, isW ? fmtCm(diff) : `${fmtSigned(diff, 1)} °C`)) : null);
    },
    label: (i) => fmtDay(new Date(days[i])),
  });
}

/* ---------- Vergrösserte Ansicht (Dialog + Vollbild) ------------ */

const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

/** Buttons und Ereignisse der vergrösserten Ansicht einrichten */
function setupZoom() {
  const dialog = document.getElementById('zoom');
  const inner = dialog.querySelector('.zoom__inner');
  const fsBtn = document.getElementById('zoom-fullscreen');

  document.getElementById('zoom-close').addEventListener('click', () => dialog.close());
  document.getElementById('zoom-prev').addEventListener('click', () => stepZoom(-1));
  document.getElementById('zoom-next').addEventListener('click', () => stepZoom(1));
  // Klick auf den abgedunkelten Hintergrund schliesst
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
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
    requestAnimationFrame(renderZoom); // neue Grösse → neu zeichnen
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

/** Zum vorherigen/nächsten Fluss in der Reihenfolge der Gruppen */
function stepZoom(dir) {
  const order = GROUPS.flatMap((g) => g.stations).filter((no) => cmpStations().some((s) => s.station_no === no));
  const i = order.indexOf(state.zoom.no);
  openZoom(order[(i + dir + order.length) % order.length]);
}

/** Grosse Grafik eines Flusses – mit eigener, an diesen Fluss angepasster Skala */
function renderZoom() {
  if (!state.zoom.no || !state.compare.data) return;
  const s = cmpSeries().find((c) => c.station_no === state.zoom.no);
  if (!s) return;
  const isW = state.compare.parameter === 'W';
  const f = isW ? fmtCm : fmtTemp;
  const cutoff = cutoffLabel();
  const a = isW ? s.ref.summary.w_mean_cm : s.ref.summary.wt_mean;
  const b = isW ? s.cur.summary.w_mean_cm : s.cur.summary.wt_mean;

  const title = document.getElementById('zoom-title');
  title.replaceChildren(keySwatch(s.station, 'key'), `${s.display_name}: ${isW ? 'Wasserstand' : 'Wassertemperatur'} ${YEARS.ref} und ${YEARS.cur}`);
  document.getElementById('zoom-sub').textContent = a != null && b != null
    ? `Mittel 1. Januar bis ${cutoff}: ${YEARS.ref} ${f(a)} · ${YEARS.cur} ${f(b)}` : '';
  document.getElementById('zoom-note').textContent =
    `${isW ? 'Abweichung vom mittleren Pegel der Station in cm' : 'Wassertemperatur in °C'}, ${state.compare.smooth > 1 ? 'gleitendes 7-Tage-Mittel' : 'Tagesmittel'}. ` +
    `Grau: ${YEARS.ref}, farbig: ${YEARS.cur}. Senkrechte Linie: ${cutoff}. In dieser Ansicht ist die Skala an diesen Fluss angepasst.`;

  const [yMin, yMax] = seriesExtent([s]);
  drawMultiple(document.getElementById('zoom-chart'), s, { yMin, yMax, isW, f, large: true });
}

/** Urteil zur Hypothese – pro Fluss «wärmer?» und «tieferer Pegel?» */
function renderVerdict() {
  const cutoff = cutoffLabel();
  const ml = inGroup('mittelland');
  const warm = (s) => s.cur.summary.wt_mean > s.ref.summary.wt_mean;
  const low = (s) => s.cur.summary.w_mean_cm < s.ref.summary.w_mean_cm;
  const both = ml.filter((s) => warm(s) && low(s)).length;

  let title;
  let lead;
  if (both === ml.length) {
    title = 'Urteil: Hypothese bestätigt – mit Vorbehalt';
    lead = `Alle drei Mittelland-Flüsse waren ${YEARS.cur} bis ${cutoff} im Mittel wärmer und hatten einen tieferen Wasserstand als im Hitzesommer ${YEARS.ref}.`;
  } else if (both > 0 || ml.some((s) => warm(s) || low(s))) {
    title = 'Urteil: Hypothese teilweise bestätigt';
    lead = `Nur ${both} von ${ml.length} Mittelland-Flüssen waren ${YEARS.cur} sowohl wärmer als auch tiefer als ${YEARS.ref}.`;
  } else {
    title = 'Urteil: Hypothese nicht bestätigt';
    lead = `Keiner der Mittelland-Flüsse war ${YEARS.cur} bis ${cutoff} wärmer und tiefer als ${YEARS.ref}.`;
  }

  const mark = (ok, text) => el('td', { class: ok ? 'yes' : 'no' },
    el('span', { class: `mark mark--${ok ? 'yes' : 'no'}`, 'aria-hidden': 'true' }, ok ? '✓' : '–'), `${ok ? 'ja' : 'nein'} (${text})`);
  const body = [];
  for (const group of GROUPS) {
    body.push(el('tr', { class: 'group-row' }, el('th', { colspan: '4', scope: 'rowgroup' }, group.title)));
    for (const s of inGroup(group.key)) {
      const dT = s.cur.summary.wt_mean - s.ref.summary.wt_mean;
      const dW = s.cur.summary.w_mean_cm - s.ref.summary.w_mean_cm;
      body.push(el('tr', {},
        el('th', { scope: 'row' }, el('span', { class: 'key', style: `background:${colorOf(s.station)}` }), s.display_name),
        mark(warm(s), `${fmtSigned(dT, 1)} °C`),
        mark(low(s), `${fmtSigned(dW)} cm`),
        el('td', {}, s.cur.summary.checked_share != null ? `${fmt0(s.cur.summary.checked_share * 100)} %` : '–')));
    }
  }

  document.getElementById('verdict').replaceChildren(el('div', { class: 'verdict__box' },
    el('h3', {}, title),
    el('p', { class: 'verdict__lead' }, lead),
    el('div', { class: 'table-scroll' }, el('table', {},
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col' }, 'Fluss'),
        el('th', { scope: 'col' }, `Wärmer als ${YEARS.ref}?`),
        el('th', { scope: 'col' }, `Tieferer Pegel als ${YEARS.ref}?`),
        el('th', { scope: 'col' }, `Geprüfte Werte ${YEARS.cur}`))),
      el('tbody', {}, body))),
    el('p', { class: 'figure__note' },
      `Verglichen: Mittelwerte vom 1. Januar bis ${cutoff}. Der Vorbehalt: Ein grosser Teil der Werte von ${YEARS.cur} ist vom BAFU noch nicht geprüft, und das Jahr ist noch nicht zu Ende. `,
      'Die Alpenflüsse gehören nicht zur Hypothese, sie zeigen aber, dass nicht jeder Fluss gleich auf einen heissen, trockenen Sommer reagiert.')));
}

/* ---------- 5) Explorer: Zeitverlauf aller Flüsse ---------------- */

/** Legende = Filter: Chips zum Ein- und Ausblenden der Flüsse */
function renderLegend() {
  const legend = document.getElementById('ts-legend');
  const chips = state.stations.map((s) => {
    const chip = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'true', style: `--c:${colorOf(s)}` },
      el('span', { class: 'chip__key', 'aria-hidden': 'true' }), s.display_name);
    chip.addEventListener('click', () => {
      const hidden = state.ts.hidden;
      hidden.has(s.station_no) ? hidden.delete(s.station_no) : hidden.add(s.station_no);
      chip.setAttribute('aria-pressed', String(!hidden.has(s.station_no)));
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

/** Holt die Tagesmittel für Auswahl + Zeitraum aus unload.php */
async function loadTimeseries() {
  const ts = state.ts;
  const visible = state.stations.filter((s) => !ts.hidden.has(s.station_no));
  const chart = document.getElementById('ts-chart');

  if (!visible.length) {
    ts.data = null;
    d3.select(chart).select('svg').remove();
    setStatus('ts-status', 'Wähle oben mindestens einen Fluss aus.');
    renderSummaryTable();
    return;
  }

  const to = state.meta.data_range.to;
  const from = ts.days === 'all'
    ? state.meta.data_range.from
    : fmtIsoDate(d3.utcDay.offset(parseDate(to), -(Number(ts.days) - 1)));

  const request = ++ts.request;
  chart.classList.add('is-loading'); // alte Grafik bleibt sichtbar, bis neue Daten da sind
  try {
    const data = await unload({
      type: 'observations',
      stations: visible.map((s) => s.station_no).join(','),
      from, to,
    });
    if (request !== ts.request) return; // inzwischen neuere Anfrage gestartet
    ts.data = data;
    setStatus('ts-status', '');
    renderTimeseries();
  } catch (err) {
    if (request !== ts.request) return;
    setStatus('ts-status', `Die Messwerte konnten nicht geladen werden: ${err.message}`);
    showToast(err.message);
  } finally {
    if (request === ts.request) chart.classList.remove('is-loading');
  }
}

/**
 * JSON-Zeilen [date, W, W_release, WT, WT_release] → Punkte für D3.
 * Wasserstand wird als Abweichung vom mittleren Pegel in cm umgerechnet.
 * Fehlende Tage werden als Lücke (value = null) eingefügt, nicht aufgefüllt.
 */
function toSeries(data, parameter) {
  return data.stations.map((st) => {
    const station = stationByNo(st.station_no);
    const rows = data.series[st.station_no] || [];
    const points = [];
    let prev = null;
    for (const r of rows) {
      const date = parseDate(r[0]);
      if (prev && d3.utcDay.count(prev, date) > 1) {
        points.push({ date: d3.utcDay.offset(prev, 1), value: null }); // Lücke
      }
      const w = r[1] != null && st.w_mean_level != null ? (r[1] - st.w_mean_level) * 100 : null;
      points.push({
        date,
        value: parameter === 'W' ? w : r[3],
        wAbs: r[1], wDev: w, wRelease: r[2],
        wt: r[3], wtRelease: r[4],
      });
      prev = date;
    }
    return { station, meta: st, points };
  });
}

function renderTimeseries() {
  const ts = state.ts;
  const info = PARAM_INFO[ts.parameter];
  document.getElementById('ts-title').textContent = `${info.label}, Tagesmittel`;
  document.getElementById('ts-unit').textContent = info.axis;
  document.getElementById('ts-note').textContent = ts.parameter === 'W'
    ? `Wasserstände liegen je nach Ort auf ganz unterschiedlicher Höhe (z.B. rund 570 m ü.M. in Brienzwiler, knapp 200 m ü.M. am Ticino). Die Grafik zeigt deshalb, wie viele Zentimeter ein Fluss über oder unter seinem eigenen mittleren Pegel ${state.meta.data_range.from.slice(0, 4)}–${state.meta.data_range.to.slice(0, 4)} stand. Absolute Werte in m ü.M. stehen im Tooltip.`
    : 'Tagesmittel der Wassertemperatur. Gestrichelte Linie: 20 °C.';

  const chart = document.getElementById('ts-chart');
  if (!ts.data) return;
  const series = toSeries(ts.data, ts.parameter);
  renderSummaryTable(series);

  const allValues = series.flatMap((s) => s.points.map((p) => p.value)).filter((v) => v != null);
  if (!allValues.length) {
    d3.select(chart).select('svg').remove();
    setStatus('ts-status', 'Für diese Auswahl sind keine Messwerte gespeichert.');
    return;
  }

  // --- Masse & Skalen ---
  const width = chart.clientWidth;
  const height = chart.clientHeight;
  const small = width < 560;
  const m = { top: 12, right: small ? 8 : 16, bottom: 28, left: small ? 38 : 48 };
  const innerW = width - m.left - m.right;
  const innerH = height - m.top - m.bottom;
  if (innerW < 50 || innerH < 50) return; // Grafik (noch) nicht sichtbar, z.B. Tab im Hintergrund

  const from = parseDate(ts.data.from);
  const to = parseDate(ts.data.to);
  const x = d3.scaleUtc().domain([from, to]).range([0, innerW]);

  // Temperatur: Achse ab 0 °C (keine abgeschnittene Achse). Wasserstand: Nulllinie = mittlerer Pegel.
  let [yMin, yMax] = d3.extent(allValues);
  if (ts.parameter === 'WT') yMin = Math.min(0, yMin);
  else { yMin = Math.min(0, yMin); yMax = Math.max(0, yMax); }
  const y = d3.scaleLinear().domain([yMin, yMax]).nice().range([innerH, 0]);

  const svg = d3.select(chart).selectAll('svg').data([null]).join('svg')
    .attr('width', width).attr('height', height)
    .attr('role', 'img')
    .attr('aria-label', `${info.label} von ${series.map((s) => s.station.display_name).join(', ')}, ${longDate(ts.data.from)} bis ${longDate(ts.data.to)}`);
  svg.selectAll('*').remove();
  const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);

  // --- Achsen (Gitter als Haarlinien) ---
  const span = d3.utcDay.count(from, to);
  const xTicks = Math.max(2, Math.floor(innerW / (small ? 70 : 90)));
  const xAxis = d3.axisBottom(x).ticks(xTicks).tickSizeOuter(0).tickFormat(timeTickFormat(span));
  g.append('g').attr('class', 'axis axis--x').attr('transform', `translate(0,${innerH})`).call(xAxis)
    .call((a) => a.selectAll('.tick line').attr('y2', 4));

  const yAxis = d3.axisLeft(y).ticks(small ? 5 : 7).tickSize(-innerW)
    .tickFormat((v) => (ts.parameter === 'W' ? fmtSigned(v) : fmt0(v)));
  g.append('g').attr('class', 'axis axis--y').call(yAxis).call((a) => a.selectAll('.tick text').attr('x', -8));

  // Referenzlinien: 0-Linie bzw. 20 °C
  if (ts.parameter === 'W') {
    g.append('line').attr('class', 'baseline').attr('x1', 0).attr('x2', innerW).attr('y1', y(0)).attr('y2', y(0));
    g.append('text').attr('class', 'refline-label').attr('x', innerW).attr('y', y(0) - 5).attr('text-anchor', 'end').text('mittlerer Pegel');
  } else {
    g.append('line').attr('class', 'baseline').attr('x1', 0).attr('x2', innerW).attr('y1', y(0)).attr('y2', y(0));
    if (yMax >= 20) {
      g.append('line').attr('class', 'refline').attr('x1', 0).attr('x2', innerW).attr('y1', y(20)).attr('y2', y(20));
      g.append('text').attr('class', 'refline-label').attr('x', 4).attr('y', y(20) - 5).text('20 °C');
    }
  }

  // --- Linien ---
  const line = d3.line().defined((p) => p.value != null).x((p) => x(p.date)).y((p) => y(p.value));
  const lines = g.append('g');
  for (const s of series) {
    lines.append('path').attr('class', 'series-line').style('stroke', colorOf(s.station)).attr('d', line(s.points));
    if (span <= 31) { // bei kurzen Zeiträumen einzelne Tage als Punkte zeigen
      lines.selectAll(null).data(s.points.filter((p) => p.value != null)).join('circle')
        .attr('class', 'series-dot').attr('r', 3.5).style('fill', colorOf(s.station))
        .attr('cx', (p) => x(p.date)).attr('cy', (p) => y(p.value));
    }
  }

  // --- Crosshair + Tooltip ---
  const dates = [...new Set(series.flatMap((s) => s.points.filter((p) => p.value != null).map((p) => +p.date)))].sort((a, b) => a - b);
  const byDate = series.map((s) => new Map(s.points.filter((p) => p.value != null).map((p) => [+p.date, p])));

  attachCrosshair({
    chart, g, innerW, innerH, margin: m,
    positions: dates.map((d) => x(d)),
    render(i, hover) {
      const date = dates[i];
      const rows = series.map((s, k) => ({ s, p: byDate[k].get(date) })).filter((r) => r.p);
      hover.selectAll('circle').data(rows).join('circle').attr('class', 'hover-dot').attr('r', 5)
        .style('fill', (r) => colorOf(r.s.station)).attr('cx', x(date)).attr('cy', (r) => y(r.p.value));
      rows.sort((a, b) => b.p.value - a.p.value);
      return el('div', {},
        el('div', { class: 'tooltip__date' }, fmtDateTooltip(new Date(date))),
        rows.map(({ s, p }) => tooltipRow(s, p, ts.parameter)));
    },
    label: (i) => fmtDateLong(new Date(dates[i])),
  });
}

/** Tooltip-Zeile: Gewässer, Messstation, beide Messgrössen, Freigabestatus */
function tooltipRow(s, p, parameter) {
  const wt = p.wt != null ? fmtTemp(p.wt) : 'kein Wert';
  const w = p.wDev != null ? `${fmtCm(p.wDev)} (${fmt2(p.wAbs)} m ü.M.)` : 'kein Wert';
  const main = parameter === 'W' ? w.split(' (')[0] : wt;
  const secondary = parameter === 'W' ? `${fmt2(p.wAbs)} m ü.M. · Wasser ${wt}` : `Pegel ${p.wDev != null ? fmtCm(p.wDev) : 'kein Wert'}`;
  const release = RELEASE_LABEL[parameter === 'W' ? p.wRelease : p.wtRelease];
  return el('div', { class: 'tooltip__row' },
    el('span', { class: 'tooltip__key', style: `background:${colorOf(s.station)}` }),
    el('span', { class: 'tooltip__name' }, s.station.river_name, el('small', {}, `${s.station.name} · ${release}`)),
    el('span', { class: 'tooltip__value' }, main, el('small', {}, secondary)));
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
  const param = state.ts.parameter;
  const f = param === 'W' ? fmtCm : fmtTemp;
  const head = el('thead', {}, el('tr', {},
    ['Fluss', 'Tiefster Wert', 'Mittel', 'Höchster Wert', 'Tage mit Wert'].map((h) => el('th', { scope: 'col' }, h))));
  const body = el('tbody', {}, series.map((s) => {
    const vals = s.points.filter((p) => p.value != null);
    if (!vals.length) return el('tr', {}, el('td', {}, s.station.display_name), el('td', { colspan: '4' }, 'keine Werte'));
    const min = d3.least(vals, (p) => p.value);
    const max = d3.greatest(vals, (p) => p.value);
    return el('tr', {},
      el('td', {}, el('span', { class: 'key', style: `background:${colorOf(s.station)}` }), s.station.display_name),
      el('td', {}, `${f(min.value)} (${fmtDateLong(min.date)})`),
      el('td', {}, f(d3.mean(vals, (p) => p.value))),
      el('td', {}, `${f(max.value)} (${fmtDateLong(max.date)})`),
      el('td', {}, fmt0(vals.length)));
  }));
  table.replaceChildren(head, body);
}

/* ---------- 6) Tooltip, Crosshair, Resize, Animationen ----------- */

const DOCK_BELOW = 560; // unter dieser Grafikbreite: Werte-Panel unter der Grafik statt schwebendem Tooltip

/**
 * Ein Tooltip pro Grafik. Auf schmalen Bildschirmen (Touch) würde ein
 * schwebender Tooltip die Linien verdecken – dort werden die Werte in einem
 * Panel direkt unter der Grafik angezeigt («dock»).
 */
function getTooltip(chart, { dockable = false } = {}) {
  let node = chart.querySelector('.tooltip');
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
      const top = Math.max(0, Math.min(py - th / 2, chart.clientHeight - th));
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
 * Datenpunkt ein. Tastatur: Pfeiltasten links/rechts, Esc schliesst.
 */
/**
 * dockable: Auf schmalen Bildschirmen dürfen die Werte in einem Panel unter der
 * Grafik erscheinen (nur für die grosse Explorer-Grafik mit vielen Zeilen).
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
    const content = render(index, dots);
    tooltip.show(content, px + margin.left, margin.top + innerH / 3);
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

  // Touch: Tippen ausserhalb der Grafik schliesst den Tooltip.
  // Der Listener wird nur einmal pro Grafik registriert, ruft aber immer die aktuelle hide()-Funktion auf.
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

/** Dezente Einblend-Animation beim Scrollen */
function setupReveal() {
  const targets = document.querySelectorAll('.section .prose, .figure, .cards, .station-list, .pipeline, .facts');
  if (!('IntersectionObserver' in window)) return;
  targets.forEach((t) => t.classList.add('reveal'));
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add('is-visible');
        io.unobserve(e.target);
      }
    });
  }, { rootMargin: '0px 0px -8% 0px' });
  targets.forEach((t) => io.observe(t));
}
