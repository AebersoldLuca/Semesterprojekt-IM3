/* ==================================================================
   DataStory «Sechs Flüsse, sechs Temperamente» – Frontend
   ------------------------------------------------------------------
   Datenfluss:  MySQL → unload.php → JSON → script.js → D3-Grafiken

   Dieses Script ruft AUSSCHLIESSLICH unload.php auf (eigene Datenbank).
   Die BAFU-API wird im Frontend nie verwendet.

   Aufbau:
     0) Konfiguration & Hilfsfunktionen
     1) Datenabruf (unload.php)
     2) Start & Zustand
     3) Story-Texte (Hero, Stationen, Erkenntnisse, Methodik)
     4) Hauptgrafik: Zeitverlauf
     5) Jahresgang
     6) Badetage-Tabelle
     7) Jahresvergleich
     8) Tooltip, Resize, Animationen
   ================================================================== */

'use strict';

/* ---------- 0) Konfiguration & Hilfsfunktionen ------------------- */

const UNLOAD_URL = 'unload.php';

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
  insights: null,        // aus type=insights
  ts: { parameter: 'WT', days: '365', hidden: new Set(), data: null, request: 0 },
  season: { parameter: 'WT', data: null },
  ytd: { parameter: 'WT' },
};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  setupReveal();
  setupSegmented('param-switch', 'param', (v) => { state.ts.parameter = v; renderTimeseries(); });
  setupSegmented('range-switch', 'days', (v) => { state.ts.days = v; loadTimeseries(); });
  setupSegmented('season-param-switch', 'param', (v) => { state.season.parameter = v; loadSeasonal(); });
  setupSegmented('ytd-param-switch', 'param', (v) => { state.ytd.parameter = v; renderYtd(); });

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

  renderStationList();
  renderLegend();
  renderMeta();
  loadTimeseries();
  loadSeasonal();

  try {
    state.insights = await unload({ type: 'insights' });
    renderInsights();
    renderHeatTable();
    renderYtd();
    renderStationNow();
  } catch (err) {
    document.getElementById('insights').replaceChildren(el('p', { class: 'muted' }, err.message));
  }

  setupResize();
}

/** Wenn gar nichts geladen werden kann: klare Meldung statt leerer Seite. */
function fatal(err) {
  showToast(err.message);
  const msg = `Die Daten sind momentan nicht verfügbar: ${err.message}`;
  setStatus('ts-status', msg);
  setStatus('season-status', msg);
  document.getElementById('station-list').replaceChildren(el('li', { class: 'station-list__placeholder' }, msg));
  document.getElementById('insights').replaceChildren(el('p', { class: 'muted' }, msg));
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

/* ---------- 3) Story-Texte --------------------------------------- */

function stationByNo(no) {
  return state.stations.find((s) => s.station_no === no);
}

function renderStationList() {
  const list = document.getElementById('station-list');
  list.replaceChildren(...state.stations.map((s) => el('li', { class: 'station', style: `--c:${colorOf(s)}`, 'data-station': s.station_no },
    el('div', { class: 'station__river' }, s.river_name),
    el('div', { class: 'station__site' }, `${s.name} · ${s.catchment_name ?? ''} · BAFU ${s.station_no}`),
    el('p', { class: 'station__role' }, s.story_role ?? ''),
    el('div', { class: 'station__now' }, el('span', {}, 'Aktuelle Werte werden geladen …')),
  )));
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

/** Erkenntnisse – jede Zahl stammt aus type=insights (also aus MySQL). */
function renderInsights() {
  const ins = state.insights;
  const st = ins.stations.map((s) => ({ ...s, meta: stationByNo(s.station_no) })).filter((s) => s.meta);
  const withWT = st.filter((s) => s.WT.max);

  // --- Hero: wärmstes Tagesmittel vs. kältester Fluss ----------------
  const warm = withWT.reduce((a, b) => (b.WT.max.value > a.WT.max.value ? b : a));
  const cold = withWT.reduce((a, b) => (b.WT.max.value < a.WT.max.value ? b : a));
  setSlot('hero-warm-value', fmtTemp(warm.WT.max.value));
  setSlot('hero-warm-label', [keySwatch(warm.meta, 'key'), `${warm.display_name}: wärmstes Tagesmittel aller sechs Flüsse (${longDate(warm.WT.max.date)})`]);
  setSlot('hero-cold-value', fmtTemp(cold.WT.max.value));
  setSlot('hero-cold-label', [keySwatch(cold.meta, 'key'), `${cold.display_name}: wärmer wurde dieser Fluss nie (${longDate(cold.WT.max.date)})`]);

  const cards = [];

  // --- Karte 1: Unterschied im Sommer ------------------------------
  const seasonWT = st.filter((s) => s.WT.season);
  if (seasonWT.length > 1) {
    const hot = seasonWT.reduce((a, b) => (b.WT.season.high > a.WT.season.high ? b : a));
    const cool = seasonWT.reduce((a, b) => (b.WT.season.high < a.WT.season.high ? b : a));
    const diff = hot.WT.season.high - cool.WT.season.high;
    cards.push(insightCard(
      `${fmt0(diff)} Grad`, 'Unterschied im Hochsommer',
      [keySwatch(hot.meta), `${hot.display_name} ist im ${MONTHS[hot.WT.season.high_month - 1]} im Mittel ${fmtTemp(hot.WT.season.high)} warm, `,
        keySwatch(cool.meta), `${cool.display_name} in ihrem wärmsten Monat (${MONTHS[cool.WT.season.high_month - 1]}) nur ${fmtTemp(cool.WT.season.high)}. `,
        `Grundlage: Monatsmittel der Jahre ${ins.complete_years[0]}–${ins.complete_years[1]}.`],
    ));
  }

  // --- Karte 2: Grösster Pegelbereich ------------------------------
  const seasonW = st.filter((s) => s.W.season);
  if (seasonW.length > 1) {
    const big = seasonW.reduce((a, b) => (b.W.season.amplitude > a.W.season.amplitude ? b : a));
    const flat = seasonW.reduce((a, b) => (b.W.season.amplitude < a.W.season.amplitude ? b : a));
    cards.push(insightCard(
      `${fmt0(big.W.season.amplitude)} cm`, 'So stark hebt und senkt sich der Pegel übers Jahr',
      [keySwatch(big.meta), `${big.display_name}: Im ${MONTHS[big.W.season.high_month - 1]} steht der Fluss im Mittel ${fmtCm(big.W.season.high)} über, im ${MONTHS[big.W.season.low_month - 1]} ${fmtCm(big.W.season.low).replace('−', '')} unter dem mittleren Pegel. `,
        keySwatch(flat.meta), `${flat.display_name} schwankt im Monatsmittel nur um ${fmt0(flat.W.season.amplitude)} cm.`],
    ));
  }

  // --- Karte 3: Tage über 20 °C ------------------------------------
  const lastComplete = ins.complete_years ? ins.complete_years[1] : null;
  if (lastComplete) {
    const rows = st.map((s) => ({ s, y: s.WT.by_year.find((y) => y.year === lastComplete) })).filter((r) => r.y);
    const top = rows.reduce((a, b) => (b.y.days_ge_20 > a.y.days_ge_20 ? b : a));
    const none = rows.filter((r) => r.y.days_ge_20 === 0).map((r) => r.s.river_name);
    cards.push(insightCard(
      `${fmt0(top.y.days_ge_20)} Tage`, `mit mindestens 20 °C im Jahr ${lastComplete}`,
      [keySwatch(top.s.meta), `${top.s.display_name} lag ${lastComplete} an ${fmt0(top.y.days_ge_20)} Tagen im Tagesmittel bei 20 °C oder mehr. `,
        none.length ? `${listJoin(none)} erreichte${none.length > 1 ? 'n' : ''} diesen Wert ${lastComplete} an keinem einzigen Tag.` : ''],
    ));
  }

  // --- Karte 4: das laufende Jahr im Vergleich ---------------------
  const currentYear = Number(ins.latest_date.slice(0, 4));
  const cutoff = longDate(ins.latest_date).replace(/ \d{4}$/, '');
  const rank = (s, key, dir) => {
    const years = s.ytd.filter((y) => y[key] != null);
    const cur = years.find((y) => y.year === currentYear);
    if (!cur || years.length < 3) return null;
    const better = years.filter((y) => (dir === 'max' ? y[key] > cur[key] : y[key] < cur[key])).length;
    return { rank: better + 1, of: years.length };
  };
  const warmest = st.filter((s) => rank(s, 'WT', 'max')?.rank === 1);
  const lowest = st.filter((s) => rank(s, 'W', 'min')?.rank === 1);
  const yearsCount = st[0]?.ytd.length ?? 0;
  cards.push(insightCard(
    `${warmest.length} von ${st.length}`, `Flüssen so warm wie nie seit ${st[0]?.ytd[0]?.year ?? ''}`,
    [`Vergleicht man jeweils den 1. Januar bis ${cutoff}, war das Wasser ${currentYear} bei `,
      warmest.length ? listJoin(warmest.map((s) => s.river_name)) : 'keinem Fluss',
      ` im Mittel wärmer als in allen ${yearsCount - 1} Vorjahren. `,
      lowest.length ? `Den tiefsten mittleren Pegel dieses Zeitraums hatten ${currentYear} ${listJoin(lowest.map((s) => s.river_name))}. ` : '',
      'Das ist eine Beobachtung über wenige Jahre – kein Beleg für einen Trend.'],
  ));

  document.getElementById('insights').replaceChildren(...cards);

  // Einleitungstexte
  setSlot('ytd-intro', `Jedes Jahr wird nur vom 1. Januar bis ${cutoff} gemittelt – so lässt sich ${currentYear} fair mit den Vorjahren vergleichen. Farbig: ${currentYear}, grau: frühere Jahre.`);
  document.getElementById('ytd-title').textContent = `Wie aussergewöhnlich ist ${currentYear}?`;
}

function insightCard(number, title, body) {
  return el('article', { class: 'insight reveal is-visible' },
    el('div', { class: 'insight__number' }, number),
    el('h3', {}, title),
    el('p', {}, body));
}

function listJoin(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} und ${items[items.length - 1]}`;
}

/* ---------- 4) Hauptgrafik: Zeitverlauf -------------------------- */

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

  // Statische Legende für den Jahresgang
  document.getElementById('season-legend').replaceChildren(...state.stations.map((s) =>
    el('span', { class: 'chip', style: `--c:${colorOf(s)}` }, el('span', { class: 'chip__key' }), s.display_name)));
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

/* ---------- 5) Jahresgang ---------------------------------------- */

async function loadSeasonal() {
  const chart = document.getElementById('season-chart');
  chart.classList.add('is-loading');
  try {
    state.season.data = await unload({ type: 'seasonal', parameter: state.season.parameter });
    setStatus('season-status', '');
    renderSeasonal();
  } catch (err) {
    setStatus('season-status', `Der Jahresgang konnte nicht geladen werden: ${err.message}`);
  } finally {
    chart.classList.remove('is-loading');
  }
}

function renderSeasonal() {
  const data = state.season.data;
  if (!data) return;
  const param = data.parameter;
  const isW = param === 'W';
  const chart = document.getElementById('season-chart');
  const [y0, y1] = data.years;

  document.getElementById('season-title').textContent = isW ? 'Monatsmittel des Wasserstands' : 'Monatsmittel der Wassertemperatur';
  document.getElementById('season-unit').textContent = isW ? 'Abweichung vom mittleren Pegel in cm' : 'in °C';
  document.getElementById('season-note').textContent =
    `Mittel der Monatsmittel aller vollständigen Jahre ${y0}–${y1}. Im Tooltip: Spanne zwischen dem tiefsten und höchsten Monatsmittel dieser Jahre.`;

  const series = data.stations.map((s) => ({ station: stationByNo(s.station_no), months: s.months })).filter((s) => s.station);
  const values = series.flatMap((s) => s.months.map((m) => m.mean)).filter((v) => v != null);

  const width = chart.clientWidth;
  const height = chart.clientHeight;
  const small = width < 560;
  const m = { top: 12, right: small ? 8 : 16, bottom: 28, left: small ? 38 : 48 };
  const innerW = width - m.left - m.right;
  const innerH = height - m.top - m.bottom;
  if (innerW < 50 || innerH < 50) return; // Grafik (noch) nicht sichtbar, z.B. Tab im Hintergrund

  const x = d3.scalePoint().domain(d3.range(1, 13)).range([0, innerW]).padding(0.3);
  const y = d3.scaleLinear().domain([Math.min(0, d3.min(values)), Math.max(0, d3.max(values))]).nice().range([innerH, 0]);

  const svg = d3.select(chart).selectAll('svg').data([null]).join('svg')
    .attr('width', width).attr('height', height).attr('role', 'img')
    .attr('aria-label', `Jahresgang ${isW ? 'Wasserstand' : 'Wassertemperatur'}, Monatsmittel ${y0}–${y1}`);
  svg.selectAll('*').remove();
  const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);

  g.append('g').attr('class', 'axis axis--x').attr('transform', `translate(0,${innerH})`)
    .call(d3.axisBottom(x).tickSizeOuter(0).tickFormat((mm) => (small ? MONTHS_SHORT[mm - 1][0] : MONTHS_SHORT[mm - 1])))
    .call((a) => a.selectAll('.tick line').attr('y2', 4));
  g.append('g').attr('class', 'axis axis--y')
    .call(d3.axisLeft(y).ticks(6).tickSize(-innerW).tickFormat((v) => (isW ? fmtSigned(v) : fmt0(v))))
    .call((a) => a.selectAll('.tick text').attr('x', -8));
  g.append('line').attr('class', 'baseline').attr('x1', 0).attr('x2', innerW).attr('y1', y(0)).attr('y2', y(0));
  if (isW) g.append('text').attr('class', 'refline-label').attr('x', innerW).attr('y', y(0) - 5).attr('text-anchor', 'end').text('mittlerer Pegel');

  const line = d3.line().defined((d) => d.mean != null).x((d) => x(d.month)).y((d) => y(d.mean)).curve(d3.curveMonotoneX);
  for (const s of series) {
    g.append('path').attr('class', 'series-line').style('stroke', colorOf(s.station)).attr('d', line(s.months));
    g.selectAll(null).data(s.months.filter((d) => d.mean != null)).join('circle')
      .attr('class', 'series-dot').attr('r', 3).style('fill', colorOf(s.station))
      .attr('cx', (d) => x(d.month)).attr('cy', (d) => y(d.mean));
  }

  const f = isW ? fmtCm : fmtTemp;
  attachCrosshair({
    chart, g, innerW, innerH, margin: m,
    positions: d3.range(1, 13).map((mm) => x(mm)),
    render(i, hover) {
      const month = i + 1;
      const rows = series.map((s) => ({ s, d: s.months[i] })).filter((r) => r.d.mean != null).sort((a, b) => b.d.mean - a.d.mean);
      hover.selectAll('circle').data(rows).join('circle').attr('class', 'hover-dot').attr('r', 5)
        .style('fill', (r) => colorOf(r.s.station)).attr('cx', x(month)).attr('cy', (r) => y(r.d.mean));
      return el('div', {},
        el('div', { class: 'tooltip__date' }, `${MONTHS[i]} (Mittel ${y0}–${y1})`),
        rows.map(({ s, d }) => el('div', { class: 'tooltip__row' },
          el('span', { class: 'tooltip__key', style: `background:${colorOf(s.station)}` }),
          el('span', { class: 'tooltip__name' }, s.station.river_name, el('small', {}, s.station.name)),
          el('span', { class: 'tooltip__value' }, f(d.mean), el('small', {}, `${f(d.min)} bis ${f(d.max)}`)))));
    },
    label: (i) => MONTHS[i],
  });

  renderSeasonFindings(series, isW, y0, y1);
}

/** Textliche Beobachtungen zum Jahresgang – berechnet aus den geladenen Monatsmitteln */
function renderSeasonFindings(series, isW, y0, y1) {
  const box = document.getElementById('season-findings');
  const stats = series.map((s) => {
    const valid = s.months.filter((d) => d.mean != null);
    if (!valid.length) return null;
    const hi = d3.greatest(valid, (d) => d.mean);
    const lo = d3.least(valid, (d) => d.mean);
    return { s, hi, lo, amp: hi.mean - lo.mean };
  }).filter(Boolean);
  if (stats.length < 2) { box.replaceChildren(); return; }

  const byAmp = [...stats].sort((a, b) => b.amp - a.amp);
  const p = [];
  if (!isW) {
    const hot = d3.greatest(stats, (t) => t.hi.mean);
    const cold = d3.least(stats, (t) => t.hi.mean);
    p.push(el('p', {}, 'Im wärmsten Monat erreicht ', keySwatch(hot.s.station), `${hot.s.station.display_name} im Mittel ${fmtTemp(hot.hi.mean)} (${MONTHS[hot.hi.month - 1]}), `,
      keySwatch(cold.s.station), `${cold.s.station.display_name} dagegen nur ${fmtTemp(cold.hi.mean)} (${MONTHS[cold.hi.month - 1]}).`));
    p.push(el('p', {}, `Am stärksten schwankt die Temperatur übers Jahr bei ${byAmp[0].s.station.display_name} (${fmt1(byAmp[0].amp)} Grad zwischen ${MONTHS[byAmp[0].lo.month - 1]} und ${MONTHS[byAmp[0].hi.month - 1]}), am wenigsten bei ${byAmp[byAmp.length - 1].s.station.display_name} (${fmt1(byAmp[byAmp.length - 1].amp)} Grad). `,
      'Flüsse, die direkt aus einem See kommen, führen im Sommer das an der Seeoberfläche erwärmte Wasser ab; Schmelzwasser aus den Alpen bleibt dagegen kalt. Die Daten zeigen dieses Muster – sie beweisen aber nicht, welcher Faktor im Einzelfall entscheidend ist.'));
  } else {
    const summer = stats.filter((t) => t.hi.month >= 5 && t.hi.month <= 8);
    const other = stats.filter((t) => !(t.hi.month >= 5 && t.hi.month <= 8));
    p.push(el('p', {}, `Am grössten ist der Unterschied zwischen Hoch- und Niedrigwasser-Monat bei ${byAmp[0].s.station.display_name}: ${fmt0(byAmp[0].amp)} cm zwischen ${MONTHS[byAmp[0].lo.month - 1]} und ${MONTHS[byAmp[0].hi.month - 1]}. Am flachsten verläuft das Jahr bei ${byAmp[byAmp.length - 1].s.station.display_name} (${fmt0(byAmp[byAmp.length - 1].amp)} cm).`));
    if (summer.length) {
      p.push(el('p', {}, `Zwischen Mai und August am höchsten: ${listJoin(summer.map((t) => `${t.s.station.river_name} (${MONTHS[t.hi.month - 1]})`))}. `,
        other.length ? `Anders ${listJoin(other.map((t) => `${t.s.station.river_name} (höchster Monat: ${MONTHS[t.hi.month - 1]})`))}. ` : '',
        'Ein Hochstand im Frühsommer passt zum bekannten Muster von Flüssen, die von Schnee- und Gletscherschmelze gespeist werden. Wehre und Seeregulierungen beeinflussen die Pegel zusätzlich.'));
    }
  }
  p.push(el('p', { class: 'muted' }, `Grundlage: Monatsmittel der vollständigen Jahre ${y0}–${y1}, berechnet aus der eigenen Datenbank.`));
  box.replaceChildren(...p);
}

/* ---------- 6) Badetage-Tabelle ---------------------------------- */

function renderHeatTable() {
  const ins = state.insights;
  const table = document.getElementById('heat-table');
  const years = [...new Set(ins.stations.flatMap((s) => s.WT.by_year.map((y) => y.year)))].sort();
  const max = d3.max(ins.stations.flatMap((s) => s.WT.by_year.map((y) => y.days_ge_20))) || 1;
  const steps = 6;
  const current = Number(ins.latest_date.slice(0, 4));

  const head = el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Fluss'),
    years.map((y) => el('th', { scope: 'col' }, y === current ? `${y}*` : String(y)))));
  const body = el('tbody', {}, ins.stations.map((s) => {
    const station = stationByNo(s.station_no);
    return el('tr', {},
      el('th', { scope: 'row' }, el('span', { class: 'key', style: `background:${colorOf(station)}` }), s.display_name),
      years.map((y) => {
        const row = s.WT.by_year.find((b) => b.year === y);
        if (!row) return el('td', {}, '–');
        const step = row.days_ge_20 === 0 ? 0 : Math.max(1, Math.ceil((row.days_ge_20 / max) * steps));
        return el('td', {
          class: step >= 4 ? 'heat--dark' : '',
          style: `background:var(--seq-${step})`,
          title: `${s.display_name}, ${y}: ${row.days_ge_20} Tage ≥ 20 °C (von ${row.days} Tagen mit Messwert)`,
        }, fmt0(row.days_ge_20));
      }));
  }));
  table.replaceChildren(head, body);
  document.getElementById('heat-note').textContent =
    `* ${current}: nur bis ${longDate(ins.latest_date)}. Je kräftiger die Farbe, desto mehr Tage. 20 °C ist eine leicht lesbare Schwelle, kein offizieller Grenzwert.`;
}

/* ---------- 7) Jahresvergleich (Punktdiagramm) ------------------- */

function renderYtd() {
  const ins = state.insights;
  if (!ins) return;
  const param = state.ytd.parameter;
  const isW = param === 'W';
  const f = isW ? fmtCm : fmtTemp;
  const current = Number(ins.latest_date.slice(0, 4));
  const cutoff = longDate(ins.latest_date).replace(/ \d{4}$/, '');
  const chart = document.getElementById('ytd-chart');

  document.getElementById('ytd-chart-title').textContent = isW
    ? `Mittlerer Wasserstand, jeweils 1. Januar bis ${cutoff}`
    : `Mittlere Wassertemperatur, jeweils 1. Januar bis ${cutoff}`;
  document.getElementById('ytd-unit').textContent = isW ? 'Abweichung vom mittleren Pegel in cm' : 'in °C';

  const rows = ins.stations.map((s) => ({
    s, station: stationByNo(s.station_no),
    years: s.ytd.filter((y) => y[param] != null).map((y) => ({ year: y.year, v: y[param] })),
  })).filter((r) => r.station && r.years.length);

  const width = chart.clientWidth;
  const small = width < 560;
  const rowH = 44;
  const m = { top: 8, right: small ? 56 : 80, bottom: 28, left: small ? 96 : 170 };
  const innerW = width - m.left - m.right;
  const height = m.top + m.bottom + rows.length * rowH;
  if (innerW < 50) return;

  // Temperaturen der Flüsse liegen weit auseinander → pro Grafik eine gemeinsame Achse
  const all = rows.flatMap((r) => r.years.map((y) => y.v));
  const x = d3.scaleLinear().domain(d3.extent(all)).nice().range([0, innerW]);

  const svg = d3.select(chart).selectAll('svg').data([null]).join('svg')
    .attr('width', width).attr('height', height).attr('role', 'img')
    .attr('aria-label', `Jahresvergleich ${isW ? 'Wasserstand' : 'Wassertemperatur'} pro Fluss, ${current} hervorgehoben`);
  svg.selectAll('*').remove();
  const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);

  g.append('g').attr('class', 'axis axis--y').attr('transform', `translate(0,${rows.length * rowH})`)
    .call(d3.axisBottom(x).ticks(small ? 4 : 7).tickSize(-rows.length * rowH).tickFormat((v) => (isW ? fmtSigned(v) : fmt0(v))))
    .call((a) => a.selectAll('.tick text').attr('dy', '1.2em'));

  const tooltip = getTooltip(chart);
  rows.forEach((r, i) => {
    const cy = i * rowH + rowH / 2;
    const row = g.append('g');
    row.append('text').attr('class', 'ytd-row-label').attr('x', -12).attr('y', cy).attr('dy', '0.35em').attr('text-anchor', 'end')
      .text(small ? r.station.river_name : r.station.display_name);
    const [lo, hi] = d3.extent(r.years, (y) => y.v);
    row.append('line').attr('x1', x(lo)).attr('x2', x(hi)).attr('y1', cy).attr('y2', cy).style('stroke', 'var(--axis)').attr('stroke-width', 1);

    const sorted = [...r.years].sort((a, b) => (a.year === current) - (b.year === current)); // aktuelles Jahr zuoberst
    row.selectAll('circle').data(sorted).join('circle')
      .attr('class', (y) => (y.year === current ? 'ytd-dot' : 'ytd-dot ytd-dot--past'))
      .attr('r', (y) => (y.year === current ? 7 : 5))
      .attr('cx', (y) => x(y.v)).attr('cy', cy)
      .style('fill', (y) => (y.year === current ? colorOf(r.station) : null))
      .on('pointerenter', (event, y) => {
        const higher = r.years.filter((o) => o.v > y.v).length;
        tooltip.show(el('div', {},
          el('div', { class: 'tooltip__date' }, `${r.station.display_name}, ${y.year}`),
          el('div', {}, `${f(y.v)} – Rang ${higher + 1} von ${r.years.length} (höchster Wert = Rang 1)`)),
        x(y.v) + m.left, cy + m.top);
      })
      .on('pointerleave', () => tooltip.hide());

    const cur = r.years.find((y) => y.year === current);
    if (cur) {
      row.append('text').attr('class', 'ytd-value-label').attr('x', innerW + 10).attr('y', cy).attr('dy', '0.35em').text(f(cur.v));
    }
  });

  document.getElementById('ytd-note').textContent = isW
    ? `Punkte: ein Punkt pro Jahr (${rows[0]?.years[0]?.year}–${current}), farbig = ${current}. Rechts: Wert ${current}. Pegel als Abweichung vom mittleren Pegel der Station.`
    : `Punkte: ein Punkt pro Jahr (${rows[0]?.years[0]?.year}–${current}), farbig = ${current}. Rechts: Wert ${current}.`;
}

/* ---------- 8) Tooltip, Crosshair, Resize, Animationen ----------- */

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
function attachCrosshair({ chart, g, innerW, innerH, margin, positions, render, label }) {
  const tooltip = getTooltip(chart, { dockable: true });
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

/** Grafiken bei Grössenänderung neu zeichnen (ohne neue Datenabfrage) */
function setupResize() {
  let frame = null;
  let lastWidth = window.innerWidth;
  const redraw = () => {
    if (window.innerWidth === lastWidth) return; // mobile Adressleiste ändert nur die Höhe
    lastWidth = window.innerWidth;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      renderTimeseries();
      renderSeasonal();
      renderYtd();
    });
  };
  window.addEventListener('resize', redraw);
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
