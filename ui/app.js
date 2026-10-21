"use strict";
/*
 * ASPR Workbench: front end for sim.c.
 * Every number on screen comes from ./sim through ui.py (/api/...).
 * The only things computed here are: replaying the trace to show which page sits in
 * which frame at a given request, sums/percentages of simulator output, and the
 * drawing of charts and tables.
 */

/* ================= constants ================= */

const ALGOS = ["FIFO", "LRU", "LFU", "Optimal", "Adaptive"];
const SHORT = { FIFO: "FIFO", LRU: "LRU", LFU: "LFU", Optimal: "OPT", Adaptive: "ADPT" };
const ALGO_COLOR = { FIFO: "#A9BBD0", LRU: "#829BB8", LFU: "#5F7896", Optimal: "#A6B4A9", Adaptive: "#B8F36B" };
const WORKLOADS = ["sequential", "looping", "random", "bursty", "phased"];
const PATTERNS = ["classic", "sequential", "looping", "random", "bursty", "phased"]; // index = code in sim.c
const PATTERN_SHADE = { sequential: "#34404D", looping: "#3D4A36", random: "#2B302D", bursty: "#4A3D33" };
const SENS_NAMES = ["S0 public", "S1 internal", "S2 confidential", "S3 top secret"];
const DEFAULT_CONFIG = {
  algo: "Adaptive", workload: "phased", frames: 8, length: 1000, seed: 42,
  sensitivity: "default", percent: 15, weights: [0.2, 0.2, 1.0, 0.3],
  security: true, behaviour: true, feedback: true,
};
const METRICS = {
  faults: { label: "Page faults", get: r => r.faults, lower: true, fmt: v => fmt(v) },
  hit_rate: { label: "Hit rate (%)", get: r => r.hit_rate, lower: false, fmt: v => v.toFixed(1) + "%" },
  secret: { label: "S2+S3 pages evicted", get: r => r.evict_s2 + r.evict_s3, lower: true, fmt: v => fmt(v) },
  s3: { label: "S3 pages evicted", get: r => r.evict_s3, lower: true, fmt: v => fmt(v) },
};

/* ================= state ================= */

const S = {
  page: "overview",
  config: clone(DEFAULT_CONFIG),
  traceConfig: null,       // settings of the run that produced S.trace
  trace: null,
  t: 0,
  playing: false,
  timer: null,
  speed: 10,
  inspectCache: {},
  compare: null,
  compareBaseline: "LRU",
  params: null,
  experiments: {},
  expSeed: 42,
  expFilters: { frames: 8, metric: "faults", baseline: "LRU", workload: "phased" },
  ovMetric: "faults",
  tests: null,
  seedSweep: null,
  selectedPage: null,
  inspSort: { key: "score", dir: -1 },
  inspFilter: { sens: [true, true, true, true], ws: "all", prot: "all" },
  evFilter: "all",
  expandedRow: null,
};

/* ================= helpers ================= */

function clone(o) { return JSON.parse(JSON.stringify(o)); }
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (n, d = 0) => Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const sum = a => a.reduce((x, y) => x + y, 0);

function change(value, base) {
  if (base === 0) return value === 0 ? 0 : Infinity;
  return (value - base) / base * 100;
}
function deltaHTML(d, lowerIsBetter = true) {
  if (!isFinite(d)) return '<span class="faint">n/a</span>';
  const text = (d > 0 ? "+" : d < 0 ? "−" : "±") + Math.abs(d).toFixed(1) + "%";
  if (Math.abs(d) < 0.05) return `<span class="muted">${text}</span>`;
  const good = lowerIsBetter ? d < 0 : d > 0;
  return `<span class="${good ? "delta-good" : "delta-bad"}">${text}</span>`;
}
function sensHTML(level) {
  return `<span class="sens" data-l="${level}" title="${SENS_NAMES[level]}">S${level}<span class="bars" aria-hidden="true"><i></i><i></i><i></i></span></span>`;
}
function pageHTML(p) { return `<span class="mono">p${p}</span>`; }

async function api(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`/api/${path}?${qs}`);
  let body;
  try { body = await res.json(); } catch (e) { throw new Error(`/api/${path}: invalid response (${res.status})`); }
  if (!res.ok || body.error) throw new Error(body.error || res.statusText);
  return body;
}
function configParams(c) {
  return {
    algo: c.algo, workload: c.workload, frames: c.frames, length: c.length, seed: c.seed,
    sensitivity: c.sensitivity, percent: c.percent, weights: c.weights.join(","),
    security: c.security ? 1 : 0, behaviour: c.behaviour ? 1 : 0, feedback: c.feedback ? 1 : 0,
  };
}
function simCommand(c) {
  let cmd = `./sim --trace --algo ${c.algo} --workload ${c.workload} --frames ${c.frames} --length ${c.length} --seed ${c.seed}`;
  if (c.sensitivity !== "default") cmd += ` --place ${c.sensitivity} --percent ${c.percent}`;
  if (c.algo === "Adaptive") {
    cmd += ` --weights ${c.weights.join(",")}`;
    if (!c.security) cmd += " --no-security";
    if (!c.behaviour) cmd += " --no-behaviour";
    if (!c.feedback) cmd += " --no-feedback";
  }
  return cmd;
}
function runId(c) {
  let id = `${c.algo.toLowerCase()}/${c.workload}/f${c.frames}/n${c.length}/s${c.seed}/${c.sensitivity}`;
  if (c.sensitivity !== "default") id += c.percent + "%";
  if (c.algo === "Adaptive") {
    if (c.weights.join(",") !== DEFAULT_CONFIG.weights.join(",")) id += "/w" + c.weights.join(",");
    if (!c.security) id += "/-security";
    if (!c.behaviour) id += "/-behaviour";
    if (!c.feedback) id += "/-feedback";
  }
  return id;
}
function setState(state, title) {
  const el = $("#state");
  el.dataset.state = state;
  el.textContent = state.toUpperCase();
  el.title = title || "";
}
function setExpId(text) { $("#exp-id").textContent = text; }
function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function errorBox(msg) { return `<div class="error-box" role="alert">${esc(msg)}</div>`; }

/* ================= tooltip ================= */

const tip = $("#tooltip");
document.addEventListener("mouseover", e => {
  const el = e.target.closest("[data-tip]");
  if (!el) return;
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
});
document.addEventListener("mousemove", e => {
  if (tip.hidden) return;
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  const y = Math.min(e.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
  tip.style.left = x + "px";
  tip.style.top = y + "px";
});
document.addEventListener("mouseout", e => {
  if (e.target.closest("[data-tip]") && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest("[data-tip]"))) tip.hidden = true;
});

/* ================= charts (SVG) ================= */

let svgCount = 0;
function niceStep(max, count = 4) {
  const raw = max / count;
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}
function niceDomain(lo, hi, count = 4) {
  if (hi === lo) hi = lo + 1;
  const step = niceStep(hi - lo, count);
  return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
}
function ticksOf(d) {
  const out = [];
  for (let v = d.lo; v <= d.hi + d.step / 2; v += d.step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}
function shortNum(v) {
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + "k";
  return String(Math.round(v * 100) / 100);
}
function roundedTop(x, y, w, h, r) {
  if (h <= 0) return "";
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

// Vertical bars, one per category, y axis from zero.
function barChart({ title, cats, vals, labels, colors, hatched = [], tips, yMax, yLabel, w = 260, h = 190, fmtV = fmt }) {
  const id = "c" + (++svgCount);
  const m = { t: 26, r: 6, b: 30, l: 40 };
  const iw = w - m.l - m.r, ih = h - m.t - m.b;
  const d = niceDomain(0, Math.max(yMax ?? Math.max(...vals), 1));
  const y = v => m.t + ih - (v / d.hi) * ih;
  const band = iw / cats.length, bw = Math.min(28, band * 0.64);
  let s = `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}: ${cats.map((c, i) => `${c} ${fmtV(vals[i])}`).join(", ")}">`;
  s += `<defs><pattern id="${id}h" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)"><rect width="2.2" height="5" fill="#A6B4A9"/></pattern></defs>`;
  s += `<text class="title" x="0" y="13">${esc(title)}</text>`;
  if (yLabel) s += `<text x="${w}" y="13" text-anchor="end" style="font-size:10px;fill:var(--text-3)">${esc(yLabel)}</text>`;
  for (const v of ticksOf(d)) {
    s += `<g class="tick"><line class="gridline" x1="${m.l}" x2="${w - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 3}" text-anchor="end">${shortNum(v)}</text></g>`;
  }
  cats.forEach((c, i) => {
    const x = m.l + i * band + (band - bw) / 2;
    const top = y(vals[i]);
    const fill = hatched.includes(c) ? `url(#${id}h)` : colors[i];
    const stroke = hatched.includes(c) ? ` stroke="#A6B4A9" stroke-width="1"` : "";
    s += `<g data-tip="${esc(tips ? tips[i] : `${c}: ${fmtV(vals[i])}`)}">`;
    s += `<rect class="hit-area" x="${m.l + i * band}" y="${m.t}" width="${band}" height="${ih}"/>`;
    s += `<path d="${roundedTop(x, top, bw, m.t + ih - top, 3)}" fill="${fill}"${stroke}/>`;
    s += `</g>`;
    s += `<text x="${m.l + i * band + band / 2}" y="${h - m.b + 14}" text-anchor="middle" class="direct">${esc(labels ? labels[i] : c)}</text>`;
  });
  s += `<line class="axis" x1="${m.l}" x2="${w - m.r}" y1="${m.t + ih}" y2="${m.t + ih}"/>`;
  return s + "</svg>";
}

// Lines with points, direct labels at the right end, single y axis.
function lineChart({ title, series, xs, xLabel, yLabel, w = 620, h = 260, logX = false, fmtY = fmt, fmtX = v => v, yLo = 0, yHi }) {
  const m = { t: 26, r: 92, b: 36, l: 48 };
  const iw = w - m.l - m.r, ih = h - m.t - m.b;
  const allY = series.flatMap(s => s.pts.map(p => p[1]));
  const d = niceDomain(Math.min(yLo, ...allY), yHi ?? Math.max(...allY, 1));
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const fx = v => logX ? Math.log2(v) : v;
  const x = v => m.l + (xMax === xMin ? 0 : (fx(v) - fx(xMin)) / (fx(xMax) - fx(xMin)) * iw);
  const y = v => m.t + ih - (v - d.lo) / (d.hi - d.lo) * ih;
  let s = `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">`;
  s += `<text class="title" x="0" y="13">${esc(title)}</text>`;
  for (const v of ticksOf(d)) {
    s += `<g class="tick"><line class="gridline" x1="${m.l}" x2="${m.l + iw}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 3}" text-anchor="end">${shortNum(v)}</text></g>`;
  }
  const xt = xs.length > 12 ? xs.filter((_, i) => i % Math.ceil(xs.length / 8) === 0) : xs;
  for (const v of xt) s += `<g class="tick"><text x="${x(v)}" y="${m.t + ih + 14}" text-anchor="middle">${esc(fmtX(v))}</text></g>`;
  s += `<line class="axis" x1="${m.l}" x2="${m.l + iw}" y1="${m.t + ih}" y2="${m.t + ih}"/>`;
  if (xLabel) s += `<text x="${m.l + iw / 2}" y="${h - 4}" text-anchor="middle" style="font-size:10px;fill:var(--text-3)">${esc(xLabel)}</text>`;
  if (yLabel) s += `<text x="${w}" y="13" text-anchor="end" style="font-size:10px;fill:var(--text-3)">${esc(yLabel)}</text>`;
  // direct labels, pushed apart so they do not overlap
  const ends = series.map(se => ({ se, y: y(se.pts[se.pts.length - 1][1]) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12;
  for (const se of series) {
    const path = se.pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
    s += `<path d="${path}" fill="none" stroke="${se.color}" stroke-width="${se.width || 2}" ${se.dash ? `stroke-dasharray="${se.dash}"` : ""} stroke-linejoin="round"/>`;
    if (se.points !== false) {
      for (const p of se.pts) {
        s += `<g data-tip="${esc(`${se.name}\n${xLabel || "x"}: ${fmtX(p[0])}\n${yLabel || "y"}: ${fmtY(p[1])}`)}"><circle cx="${x(p[0])}" cy="${y(p[1])}" r="9" class="hit-area"/><circle cx="${x(p[0])}" cy="${y(p[1])}" r="3.5" fill="${se.color}" stroke="var(--surface)" stroke-width="2"/></g>`;
      }
    }
  }
  for (const e of ends) {
    s += `<text class="direct" x="${m.l + iw + 8}" y="${e.y + 4}" style="fill:${e.se.color}">${esc(e.se.label || e.se.name)}</text>`;
  }
  return s + "</svg>";
}

// Dots per category (e.g. one dot per seed), with a zero line and a mean mark.
function dotChart({ title, cats, groups, yLabel, w = 520, h = 220, fmtY = v => v.toFixed(1) + "%" }) {
  const m = { t: 26, r: 10, b: 30, l: 48 };
  const iw = w - m.l - m.r, ih = h - m.t - m.b;
  const all = groups.flatMap(g => g.vals.map(v => v.v)).concat([0]);
  const d = niceDomain(Math.min(...all), Math.max(...all));
  const y = v => m.t + ih - (v - d.lo) / (d.hi - d.lo) * ih;
  const band = iw / cats.length;
  let s = `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">`;
  s += `<text class="title" x="0" y="13">${esc(title)}</text>`;
  if (yLabel) s += `<text x="${w}" y="13" text-anchor="end" style="font-size:10px;fill:var(--text-3)">${esc(yLabel)}</text>`;
  for (const v of ticksOf(d)) {
    s += `<g class="tick"><line class="gridline" x1="${m.l}" x2="${w - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 3}" text-anchor="end">${v > 0 ? "+" : ""}${shortNum(v)}%</text></g>`;
  }
  s += `<line x1="${m.l}" x2="${w - m.r}" y1="${y(0)}" y2="${y(0)}" stroke="var(--text-3)" stroke-width="1"/>`;
  groups.forEach((g, i) => {
    const cx = m.l + i * band + band / 2;
    g.vals.forEach((v, j) => {
      const jx = cx + ((j % 5) - 2) * 6;
      s += `<g data-tip="${esc(v.tip)}"><circle cx="${jx}" cy="${y(v.v)}" r="8" class="hit-area"/><circle cx="${jx}" cy="${y(v.v)}" r="4" fill="${v.v > 0 ? "#E99A73" : "#B8F36B"}" fill-opacity="0.9" stroke="var(--surface)" stroke-width="1.5"/></g>`;
    });
    s += `<line x1="${cx - 18}" x2="${cx + 18}" y1="${y(g.mean)}" y2="${y(g.mean)}" stroke="var(--text)" stroke-width="2"/>`;
    s += `<text x="${cx}" y="${h - m.b + 14}" text-anchor="middle" class="direct">${esc(cats[i])}</text>`;
  });
  return s + "</svg>";
}

// Scatter with a text label next to every point.
function scatterChart({ title, pts, xLabel, yLabel, w = 520, h = 240, fmtX, fmtY }) {
  const m = { t: 26, r: 80, b: 36, l: 48 };
  const iw = w - m.l - m.r, ih = h - m.t - m.b;
  const dx = niceDomain(0, Math.max(...pts.map(p => p.x)));
  const dy = niceDomain(0, Math.max(...pts.map(p => p.y)));
  const x = v => m.l + v / dx.hi * iw;
  const y = v => m.t + ih - v / dy.hi * ih;
  let s = `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">`;
  s += `<text class="title" x="0" y="13">${esc(title)}</text>`;
  for (const v of ticksOf(dy)) s += `<g class="tick"><line class="gridline" x1="${m.l}" x2="${m.l + iw}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 3}" text-anchor="end">${shortNum(v)}</text></g>`;
  for (const v of ticksOf(dx)) s += `<g class="tick"><text x="${x(v)}" y="${m.t + ih + 14}" text-anchor="middle">${shortNum(v)}</text></g>`;
  s += `<line class="axis" x1="${m.l}" x2="${m.l + iw}" y1="${m.t + ih}" y2="${m.t + ih}"/>`;
  s += `<text x="${m.l + iw / 2}" y="${h - 4}" text-anchor="middle" style="font-size:10px;fill:var(--text-3)">${esc(xLabel)}</text>`;
  s += `<text x="${w}" y="13" text-anchor="end" style="font-size:10px;fill:var(--text-3)">${esc(yLabel)}</text>`;
  const placed = [];
  for (const p of pts.slice().sort((a, b) => y(a.y) - y(b.y))) {
    s += `<g data-tip="${esc(`${p.label}\n${xLabel}: ${fmtX(p.x)}\n${yLabel}: ${fmtY(p.y)}`)}"><circle cx="${x(p.x)}" cy="${y(p.y)}" r="10" class="hit-area"/><circle cx="${x(p.x)}" cy="${y(p.y)}" r="5" fill="${p.color}" stroke="var(--surface)" stroke-width="2"/></g>`;
    let ly = y(p.y) + 4;
    while (placed.some(q => Math.abs(q.x - x(p.x)) < 70 && Math.abs(q.y - ly) < 12)) ly += 12;
    placed.push({ x: x(p.x), y: ly });
    s += `<text class="direct" x="${x(p.x) + 9}" y="${ly}">${esc(p.label)}</text>`;
  }
  return s + "</svg>";
}

/* ================= router ================= */

const PAGES = {
  overview: pageOverview,
  simulator: pageSimulator,
  experiments: pageExperiments,
  inspector: pageInspector,
  methodology: pageMethodology,
};
const main = $("#main");

// "#simulator?workload=bursty&frames=4&t=600" opens a given run and request
function hashParams() {
  const h = location.hash.slice(1), i = h.indexOf("?");
  return i < 0 ? {} : Object.fromEntries(new URLSearchParams(h.slice(i + 1)));
}
async function ensureRun() {
  const q = hashParams();
  const c = S.config;
  for (const k of ["algo", "workload", "sensitivity"]) if (q[k] !== undefined) c[k] = q[k];
  for (const k of ["frames", "length", "seed", "percent"]) if (q[k] !== undefined) c[k] = parseInt(q[k], 10);
  if (S.page === "simulator") bindConfig();
  if (!S.trace || runId(c) !== runId(S.traceConfig)) await runSim();
  if (S.trace && q.t !== undefined) setT(parseInt(q.t, 10) || 0);
  if (S.trace && q.page !== undefined) { S.selectedPage = parseInt(q.page, 10); onStep(); }
  if (S.trace && q.compare === "1" && S.page === "simulator" && !S.compare) runCompare();
}

function route() {
  const name = (location.hash || "#overview").slice(1).split("?")[0];
  S.page = PAGES[name] ? name : "overview";
  $$(".rail a").forEach(a => { if (a.dataset.page === S.page) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  if (S.page !== "simulator" && S.page !== "inspector") pause();
  tip.hidden = true;
  PAGES[S.page]();
  updateExpId();
}
window.addEventListener("hashchange", route);

function updateExpId() {
  if ((S.page === "simulator" || S.page === "inspector") && S.traceConfig) setExpId(runId(S.traceConfig) + `  ·  t=${S.t}`);
  else if (S.page === "experiments") setExpId(`evaluation/seed-${S.expSeed}`);
  else if (S.page === "overview") setExpId("evaluation/seed-42");
  else setExpId("parameters");
}

/* ================= data loading ================= */

async function loadParams() {
  if (!S.params) S.params = await api("params");
  return S.params;
}
async function loadExperiments(seed) {
  if (!S.experiments[seed]) {
    setState("running", "running ./sim --csv");
    try {
      S.experiments[seed] = await api("experiments", { seed });
      setState("completed");
    } catch (e) {
      setState("error", e.message);
      throw e;
    }
  }
  return S.experiments[seed];
}
function rowsOf(exp, filter) {
  return exp.rows.filter(r => Object.keys(filter).every(k => r[k] === filter[k]));
}
function rowOf(exp, filter) { return rowsOf(exp, filter)[0]; }

/* ================= Overview ================= */

async function pageOverview() {
  main.innerHTML = `<div class="page"><div class="page-head"><div><h1>Research summary</h1>
    <p>Can runtime behaviour and page sensitivity together improve page replacement decisions? Adaptive gives every page one eviction score (recency, frequency, behaviour, working set, sensitivity) and protects top-secret pages that are in use.</p></div></div>
    <div id="ov-body"><div class="empty">Running <code>./sim --csv --seed 42</code> …</div></div></div>`;
  let exp;
  try { exp = await loadExperiments(42); } catch (e) { $("#ov-body").innerHTML = errorBox(e.message); return; }
  if (S.page !== "overview") return;

  const main25 = exp.rows.filter(r => r.experiment === "main" && r.workload !== "classic");
  const tot = (algo, f) => sum(main25.filter(r => r.algorithm === algo).map(f));
  const perEv = r => r.time_us / Math.max(1, r.faults - r.frames);
  const lat = algo => perEv(rowOf(exp, { experiment: "overhead", algorithm: algo }));
  const rowsDef = [
    { name: "Page faults", f: r => r.faults, unit: "", note: "lower is better" },
    { name: "Secret pages evicted (S2+S3)", f: r => r.evict_s2 + r.evict_s3, unit: "" },
    { name: "Top-secret pages evicted (S3)", f: r => r.evict_s3, unit: "" },
  ];
  let table = `<table class="data find-table"><thead><tr><th>Metric</th><th class="num">LRU · baseline</th><th class="num">Adaptive</th><th class="num">Change vs LRU</th><th class="num">Optimal · benchmark</th><th>LRU vs Adaptive (bars from zero)</th></tr></thead><tbody>`;
  for (const d of rowsDef) {
    const l = tot("LRU", d.f), a = tot("Adaptive", d.f), o = tot("Optimal", d.f);
    const mx = Math.max(l, a, o);
    table += `<tr><td>${d.name}</td><td class="num">${fmt(l)}</td><td class="num">${fmt(a)}</td><td class="num">${deltaHTML(change(a, l))}</td><td class="num">${fmt(o)}</td>
      <td class="bars"><div class="mini-bars" data-tip="${esc(`${d.name}\nLRU: ${fmt(l)}\nAdaptive: ${fmt(a)}\nOptimal: ${fmt(o)}`)}"><div class="b" style="width:${l / mx * 100}%;background:${ALGO_COLOR.LRU}"></div><div class="b" style="width:${a / mx * 100}%;background:${ALGO_COLOR.Adaptive}"></div></div></td></tr>`;
  }
  const lL = lat("LRU"), lA = lat("Adaptive");
  table += `<tr><td>Time per eviction decision</td><td class="num">${lL.toFixed(3)} µs</td><td class="num">${lA.toFixed(3)} µs</td><td class="num"><span class="delta-bad">×${(lA / lL).toFixed(0)}</span></td><td class="num">${lat("Optimal").toFixed(3)} µs</td>
    <td class="bars"><div class="mini-bars" data-tip="${esc(`µs per eviction (phased, 8 frames, 20 runs)\nLRU: ${lL.toFixed(3)}\nAdaptive: ${lA.toFixed(3)}`)}"><div class="b" style="width:${lL / lA * 100}%;background:${ALGO_COLOR.LRU}"></div><div class="b" style="width:100%;background:${ALGO_COLOR.Adaptive}"></div></div></td></tr>`;
  table += `</tbody></table>`;

  // weak spots, all computed from the same CSV
  const seedRows = (wl, algo) => rowsOf(exp, { experiment: "seeds", workload: wl, algorithm: algo }).filter(r => r.setting.startsWith("seed-"));
  const bl = seedRows("bursty", "LRU"), ba = seedRows("bursty", "Adaptive");
  const burstyCh = bl.map((r, i) => ({ seed: r.setting.slice(5), d: change(ba[i].faults, r.faults) }));
  const avgB = change(rowOf(exp, { experiment: "seeds", workload: "bursty", setting: "avg-10", algorithm: "Adaptive" }).faults,
    rowOf(exp, { experiment: "seeds", workload: "bursty", setting: "avg-10", algorithm: "LRU" }).faults);
  const worst = burstyCh.reduce((a, b) => (b.d > a.d ? b : a));
  const am = algo => rowOf(exp, { experiment: "amount", workload: "bursty", setting: "50%", algorithm: algo });
  const sec = r => r.evict_s2 + r.evict_s3;
  const abl = s => rowOf(exp, { experiment: "ablation", workload: "random", setting: s, algorithm: "Adaptive" });

  const multiples = () => {
    const m = METRICS[S.ovMetric];
    return WORKLOADS.map(wl => {
      const rs = ALGOS.map(a => rowOf(exp, { experiment: "main", workload: wl, frames: 8, algorithm: a }));
      const vals = rs.map(m.get);
      return barChart({ title: wl, cats: ALGOS, labels: ALGOS.map(a => SHORT[a]), vals, colors: ALGOS.map(a => ALGO_COLOR[a]),
        hatched: ["Optimal"], fmtV: m.fmt, tips: ALGOS.map((a, i) => `${wl} · 8 frames\n${a}${a === "Optimal" ? " (benchmark)" : ""}\n${m.label}: ${m.fmt(vals[i])}`), w: 250, h: 180 });
    }).join("");
  };

  $("#ov-body").innerHTML = `<div class="stack">
    <div class="panel">
      <div class="panel-head"><h2>Measured outcome against LRU</h2><span class="note">5 workloads × 5 memory sizes (3–32 frames), 5,000 requests each, seed 42 · source <code>${esc(exp.meta.command)}</code></span></div>
      <div class="table-wrap">${table}</div>
      <p class="small faint" style="margin-top:8px">Totals of simulator runs, not a guarantee for other workloads. Decision time: phased workload, 8 frames, average of 20 runs, measured with <code>clock()</code> on this machine (it changes a little between runs). Optimal knows future requests and cannot run in a real system; it is shown only as the lower bound for page faults.</p>
    </div>
    <div class="grid-2">
      <div class="panel">
        <div class="panel-head"><h2>Where Adaptive is worse</h2><span class="note">kept visible on purpose</span></div>
        <div class="stack">
          <div class="callout warn"><b>Bursty workloads:</b> ${deltaHTML(avgB)} page faults against LRU on average over seeds 1–10 (8 frames); worst seed ${worst.seed}: ${deltaHTML(worst.d)}. LRU already fits bursty access, and protecting in-use secret pages costs frames.</div>
          <div class="callout warn"><b>Decision time:</b> about ${(lA / lL).toFixed(0)}× slower than LRU per eviction (${lA.toFixed(2)} µs against ${lL.toFixed(2)} µs), mostly from pattern detection over the last 32 requests.</div>
          <div class="callout warn"><b>Many secret pages:</b> with 50% of pages sensitive (bursty, 8 frames), Adaptive has ${deltaHTML(change(am("Adaptive").faults, am("LRU").faults))} faults for only ${deltaHTML(change(sec(am("Adaptive")), sec(am("LRU"))))} secret evictions.</div>
          <div class="callout warn"><b>Feedback on random workloads:</b> the feedback relaxes protection when the fault rate is high, even when protection is not the cause. Random workload, 8 frames: with feedback ${fmt(abl("full").evict_s3)} S3 evictions, without feedback ${fmt(abl("no-feedback").evict_s3)}, for ${fmt(abl("no-feedback").faults - abl("full").faults)} faults of difference.</div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>What the results establish</h2></div>
        <ul class="list">
          <li><b>Established (in simulation):</b> detecting loops and scans lets one policy act like MRU there and like LRU in bursts, which removes most faults LRU makes on looping and sequential workloads.</li>
          <li><b>Established (in simulation):</b> protecting secret pages while they are in use, and releasing them when they are not, cuts secret-page evictions with a small fault cost.</li>
          <li><b>Not established:</b> behaviour on real program traces, multiple processes, or inside a kernel.</li>
          <li><b>Not established:</b> secure memory handling. The simulator counts evictions of sensitive pages; it does not encrypt, zero or swap anything. Sensitivity labels are assigned by us.</li>
        </ul>
        <div class="row" style="margin-top:12px">
          <a class="btn" href="#experiments">Open experiment data</a>
          <a class="btn" href="#methodology">Methodology</a>
          <a class="btn btn-primary" href="#simulator">Run a simulation</a>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Per-workload outcome · 8 frames</h2>
        <div class="seg" id="ov-metric">${["faults", "secret", "s3"].map(k => `<button type="button" data-k="${k}" aria-pressed="${S.ovMetric === k}">${METRICS[k].label}</button>`).join("")}</div></div>
      <div class="multiples" id="ov-mult">${multiples()}</div>
      <div class="legend" style="margin-top:8px"><span><span class="sw" style="background:${ALGO_COLOR.Adaptive}"></span>ADPT = Adaptive</span><span><span class="sw" style="background:${ALGO_COLOR.LRU}"></span>FIFO / LRU / LFU = baselines (steel)</span><span><span class="sw" style="background:repeating-linear-gradient(45deg,#A6B4A9 0 2px,transparent 2px 4px)"></span>OPT = Optimal, benchmark with future knowledge</span></div>
    </div>
  </div>`;
  $$("#ov-metric button").forEach(b => b.onclick = () => {
    S.ovMetric = b.dataset.k;
    $$("#ov-metric button").forEach(x => x.setAttribute("aria-pressed", x === b));
    $("#ov-mult").innerHTML = multiples();
  });
}

/* ================= Simulator ================= */

function configForm(c) {
  const opt = (v, cur, label) => `<option value="${v}"${v === cur ? " selected" : ""}>${label || v}</option>`;
  const isA = c.algo === "Adaptive";
  return `
  <div class="panel-head" style="margin-bottom:4px"><h2>Configuration</h2><span class="note">runs <code>./sim --trace</code></span></div>
  <div class="field"><label for="c-algo">Algorithm</label><select id="c-algo">${ALGOS.map(a => opt(a, c.algo, a === "Optimal" ? "Optimal (benchmark, uses future)" : a === "Adaptive" ? "Adaptive (proposed)" : a)).join("")}</select></div>
  <div class="field"><label for="c-wl">Workload</label><select id="c-wl">${PATTERNS.map(w => opt(w, c.workload, w === "classic" ? "classic (textbook string, 25 requests)" : w)).join("")}</select></div>
  <div class="grid-2" style="gap:8px">
    <div class="field"><label for="c-frames">Frames</label><input id="c-frames" type="number" min="1" max="32" value="${c.frames}"></div>
    <div class="field"><label for="c-len">Requests</label><input id="c-len" type="number" min="10" max="5000" step="10" value="${c.length}"${c.workload === "classic" ? " disabled" : ""}></div>
  </div>
  <div class="field"><label for="c-seed">Seed</label><input id="c-seed" type="number" min="0" max="1000000" value="${c.seed}"><span class="hint">Same seed and settings → same workload and result.</span></div>
  <div class="grid-2" style="gap:8px">
    <div class="field"><label for="c-sens">Sensitivity</label><select id="c-sens">${opt("default", c.sensitivity, "default mix")}${["random", "hot", "warm", "cold"].map(p => opt(p, c.sensitivity, p + " pages")).join("")}</select></div>
    <div class="field"><label for="c-pct">Sensitive %</label><input id="c-pct" type="number" min="0" max="100" value="${c.percent}"${c.sensitivity === "default" ? " disabled" : ""}></div>
  </div>
  <span class="hint small faint">${c.sensitivity === "default" ? "Default mix: 70% S0, 15% S1, 10% S2, 5% S3." : `${c.percent}% of pages sensitive (⅓ S3, rest S2), placed on the ${c.sensitivity === "random" ? "randomly chosen" : c.sensitivity === "hot" ? "most used" : c.sensitivity === "cold" ? "least used" : "middle"} pages; others S0.`}</span>
  <fieldset class="fieldset"${isA ? "" : " disabled"}>
    <legend>Adaptive parameters${isA ? "" : " (Adaptive only)"}</legend>
    <div class="field"><span class="label">Weights wR · wF · wB · wW</span>
      <div class="weights">${c.weights.map((w, i) => `<input type="number" step="0.1" min="0" max="10" value="${w}" data-w="${i}" aria-label="${["wR recency", "wF frequency", "wB behaviour", "wW working set"][i]}">`).join("")}</div></div>
    <label class="check"><input type="checkbox" id="c-sec"${c.security ? " checked" : ""}><span>Security part (S penalty and in-use S3 protection)</span></label>
    <label class="check"><input type="checkbox" id="c-beh"${c.behaviour ? " checked" : ""}><span>Behaviour detection (off → B = 0.5 for every page)</span></label>
    <label class="check"><input type="checkbox" id="c-fb"${c.feedback ? " checked" : ""}><span>Fault-rate feedback on wS</span></label>
  </fieldset>
  <div class="row">
    <button type="submit" class="btn btn-primary" id="c-run">Run</button>
    <button type="button" class="btn" id="c-compare" title="Same workload, every algorithm">Compare algorithms</button>
    <button type="button" class="btn btn-ghost" id="c-reset">Reset</button>
  </div>
  <div id="c-dirty" class="small faint"></div>
  <div class="small faint"><code style="word-break:break-all">${esc(simCommand(c))}</code></div>`;
}

function readConfig() {
  const c = S.config;
  c.algo = $("#c-algo").value;
  c.workload = $("#c-wl").value;
  c.frames = parseInt($("#c-frames").value, 10);
  c.length = parseInt($("#c-len").value, 10);
  c.seed = parseInt($("#c-seed").value, 10);
  c.sensitivity = $("#c-sens").value;
  c.percent = parseInt($("#c-pct").value, 10);
  c.weights = $$("[data-w]").map(i => parseFloat(i.value));
  c.security = $("#c-sec").checked;
  c.behaviour = $("#c-beh").checked;
  c.feedback = $("#c-fb").checked;
}
function validConfig(c) {
  if (!(c.frames >= 1 && c.frames <= 32)) return "Frames must be between 1 and 32.";
  if (!(c.length >= 10 && c.length <= 5000)) return "Requests must be between 10 and 5000.";
  if (!(c.seed >= 0 && c.seed <= 1000000)) return "Seed must be between 0 and 1,000,000.";
  if (!(c.percent >= 0 && c.percent <= 100)) return "Sensitive % must be between 0 and 100.";
  if (c.weights.some(w => !(w >= 0 && w <= 10))) return "Weights must be between 0 and 10.";
  return null;
}
function bindConfig() {
  const form = $("#cfg");
  if (!form) return;
  form.innerHTML = configForm(S.config);
  const refresh = () => { readConfig(); bindConfig(); };
  ["#c-algo", "#c-wl", "#c-sens"].forEach(sel => $(sel).addEventListener("change", refresh));
  $$("input", form).forEach(i => i.addEventListener("change", () => { readConfig(); markDirty(); }));
  form.onsubmit = e => { e.preventDefault(); readConfig(); runSim(); };
  $("#c-compare").onclick = () => { readConfig(); runCompare(); };
  $("#c-reset").onclick = () => { S.config = clone(DEFAULT_CONFIG); bindConfig(); };
  markDirty();
}
function markDirty() {
  const el = $("#c-dirty");
  if (!el) return;
  const err = validConfig(S.config);
  if (err) el.innerHTML = `<span class="delta-bad">${esc(err)}</span>`;
  else if (S.traceConfig && runId(S.config) !== runId(S.traceConfig)) el.textContent = "Settings changed: press Run to apply.";
  else el.textContent = "";
}

async function runSim() {
  const err = validConfig(S.config);
  if (err) { markDirty(); return; }
  pause();
  setState("running", simCommand(S.config));
  if ($("#play")) $("#play").innerHTML = `<div class="small muted">Running <code>${esc(simCommand(S.config))}</code> …</div>`;
  try {
    const tr = await api("run", configParams(S.config));
    prepTrace(tr);
    S.trace = tr;
    S.traceConfig = clone(S.config);
    S.t = 0;
    S.inspectCache = {};
    S.compare = null;
    S.selectedPage = null;
    S.expandedRow = null;
    setState("completed", `${tr.faults} faults, ${tr.hits} hits`);
  } catch (e) {
    setState("error", e.message);
    const target = $("#play") || $("#insp");
    if (target) target.innerHTML = errorBox("Run failed: " + e.message);
    return;
  }
  markDirty();
  if (S.page === "inspector") renderInspector();
  else renderSimAll();
}

async function runCompare() {
  const err = validConfig(S.config);
  if (err) { markDirty(); return; }
  if (!S.trace || runId(S.config) !== runId(S.traceConfig)) await runSim();
  if (!S.trace) return;
  setState("running", "running every algorithm on the same workload");
  $("#compare-panel").innerHTML = `<div class="small muted">Running FIFO, LRU, LFU, Optimal and Adaptive on the same workload …</div>`;
  try {
    S.compare = await api("compare", configParams(S.traceConfig));
    setState("completed");
  } catch (e) {
    setState("error", e.message);
    $("#compare-panel").innerHTML = errorBox(e.message);
    return;
  }
  renderCompare();
}

// precomputes running totals and lists from the C trace
function prepTrace(tr) {
  const n = tr.events.length;
  tr.n = n;
  tr.cumFaults = new Int32Array(n);
  tr.cumSecret = new Int32Array(n);
  tr.evictions = [];
  let f = 0, sc = 0;
  for (let t = 0; t < n; t++) {
    const [hit, , victim, pattern, flags] = tr.events[t];
    if (!hit) f++;
    if (victim >= 0) {
      if (tr.sens[victim] >= 2) sc++;
      tr.evictions.push({ t, page: tr.refs[t], victim, pattern, flags });
    }
    tr.cumFaults[t] = f;
    tr.cumSecret[t] = sc;
  }
}
// page in each frame, last use and uses since loaded, after request t
function replay(tr, t) {
  const frames = new Array(tr.frames).fill(-1);
  const last = {}, freq = {}, loaded = {};
  for (let i = 0; i <= t; i++) {
    const p = tr.refs[i], ev = tr.events[i];
    if (!ev[0]) { frames[ev[1]] = p; freq[p] = 0; loaded[p] = i; }
    last[p] = i;
    freq[p] = (freq[p] || 0) + 1;
  }
  return { frames, last, freq, loaded };
}
function wsAt(tr, t) {
  let w = S.params ? S.params.ws_start : 1;
  for (const fb of tr.feedback) if (fb.t < t) w = fb.new;
  return w;
}

function pageSimulator() {
  main.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Simulator</h1><p>Runs the C simulator with these settings and records every request. Step through the recorded run to see each hit, fault and eviction, and why the page was chosen.</p></div>
      <div class="small faint">Keys: <span class="kbd">←</span> <span class="kbd">→</span> step · <span class="kbd">space</span> play · <span class="kbd">E</span> next eviction · <span class="kbd">S</span> next security event</div></div>
    <div class="sim-layout">
      <form class="panel sim-config" id="cfg" novalidate></form>
      <div class="stack" style="min-width:0">
        <div class="panel" id="play"></div>
        <div class="sim-work">
          <div class="sim-left">
            <div class="panel" id="frames-panel"></div>
            <div class="panel" id="timeline-panel"></div>
          </div>
          <div class="panel" id="decision-panel"></div>
        </div>
        <div class="panel" id="compare-panel"></div>
      </div>
    </div></div>`;
  loadParams().catch(() => {});
  bindConfig();
  renderSimAll();
  ensureRun();
}

function renderSimAll() {
  if (S.page !== "simulator") return;
  if (!S.trace) {
    $("#play").innerHTML = `<div class="row"><span class="muted">No run yet.</span><span class="spacer"></span><span class="small faint">Default: Adaptive · phased · 8 frames · 1,000 requests · seed 42</span></div>`;
    $("#frames-panel").innerHTML = `<div class="empty">Press <b>Run</b> to simulate. Nothing is shown until the simulator has produced output.</div>`;
    $("#timeline-panel").innerHTML = "";
    $("#compare-panel").innerHTML = `<div class="small faint">Compare algorithms runs FIFO, LRU, LFU, Optimal and Adaptive on the same workload and settings.</div>`;
    $("#decision-panel").innerHTML = `<div class="panel-head"><h2>Decision inspector</h2></div><div class="inspector-empty">Explains each eviction once a run exists.</div>`;
    return;
  }
  renderPlaybar();
  renderFrames();
  renderTimeline(true);
  renderCompare();
  renderDecision();
}
function onStep() {
  updateExpId();
  if (S.page === "simulator") {
    renderPlaybar();
    renderFrames();
    renderTimeline(false);
    renderDecision();
  } else if (S.page === "inspector") {
    renderInspector();
  }
}
function setT(t) {
  if (!S.trace) return;
  S.t = Math.max(0, Math.min(S.trace.n - 1, t));
  S.expandedRow = null;
  onStep();
}
function nextWhere(pred) {
  const tr = S.trace;
  for (let t = S.t + 1; t < tr.n; t++) if (pred(tr.events[t], t)) return setT(t);
}
function prevWhere(pred) {
  const tr = S.trace;
  for (let t = S.t - 1; t >= 0; t--) if (pred(tr.events[t], t)) return setT(t);
}
const isEviction = ev => ev[2] >= 0;
const isSecurity = (ev, t) => ev[2] >= 0 && ((ev[4] & 3) || S.trace.sens[ev[2]] === 3);

function play() {
  if (!S.trace) return;
  if (S.t >= S.trace.n - 1) S.t = 0;
  S.playing = true;
  clearInterval(S.timer);
  S.timer = setInterval(() => {
    if (S.t >= S.trace.n - 1) { pause(); return; }
    S.t++;
    onStep();
  }, 1000 / S.speed);
  renderPlaybar();
}
function pause() {
  const was = S.playing;
  S.playing = false;
  clearInterval(S.timer);
  if (was && (S.page === "simulator" || S.page === "inspector")) onStep();
}

function renderPlaybar() {
  const tr = S.trace, t = S.t;
  const secret = tr.cumSecret[t], faults = tr.cumFaults[t];
  const hits = t + 1 - faults;
  const s3 = tr.evictions.filter(e => e.t <= t && tr.sens[e.victim] === 3).length;
  $("#play").innerHTML = `<div class="playbar">
      <button class="btn btn-icon" id="p-first" aria-label="First request">|◀</button>
      <button class="btn btn-icon" id="p-prev-ev" aria-label="Previous eviction" title="Previous eviction">◀E</button>
      <button class="btn btn-icon" id="p-prev" aria-label="Previous request">◀</button>
      <button class="btn btn-icon" id="p-play" aria-label="${S.playing ? "Pause" : "Play"}">${S.playing ? "❚❚" : "▶"}</button>
      <button class="btn btn-icon" id="p-next" aria-label="Next request">▶</button>
      <button class="btn btn-icon" id="p-next-ev" aria-label="Next eviction" title="Next eviction">E▶</button>
      <button class="btn btn-icon" id="p-next-sec" aria-label="Next security event" title="Next security event: security changed the choice, all pages protected, or an S3 page evicted">S▶</button>
      <button class="btn btn-icon" id="p-last" aria-label="Last request">▶|</button>
      <span class="pos">request</span><input type="number" id="p-t" min="0" max="${tr.n - 1}" value="${t}" aria-label="Request number"><span class="pos">of ${fmt(tr.n - 1)}</span>
      <label class="small faint" for="p-speed">speed</label>
      <select id="p-speed" style="width:auto">${[2, 10, 30, 100].map(v => `<option value="${v}"${v === S.speed ? " selected" : ""}>${v}/s</option>`).join("")}</select>
      <span class="spacer"></span>
      <button class="btn btn-ghost" id="p-insp">Open in Memory Inspector →</button>
    </div>
    <div class="counters" style="margin-top:10px">
      <span>faults so far<b>${fmt(faults)}</b></span><span>hits<b>${fmt(hits)}</b></span><span>hit rate<b>${(hits / (t + 1) * 100).toFixed(1)}%</b></span>
      <span>S2+S3 evicted<b>${fmt(secret)}</b></span><span>S3 evicted${S.traceConfig.algo === "Adaptive" ? " (secure)" : ""}<b>${fmt(s3)}</b></span>
      ${S.traceConfig.algo === "Adaptive" ? `<span>wS now<b>${wsAt(tr, t + 1).toFixed(2)}</b></span>` : ""}
      <span class="faint">whole run: ${fmt(tr.faults)} faults · ${fmt(tr.evicted[2] + tr.evicted[3])} secret evictions · ${fmt(tr.time_us, 0)} µs</span>
    </div>`;
  $("#p-first").onclick = () => setT(0);
  $("#p-last").onclick = () => setT(tr.n - 1);
  $("#p-prev").onclick = () => setT(S.t - 1);
  $("#p-next").onclick = () => setT(S.t + 1);
  $("#p-prev-ev").onclick = () => prevWhere(isEviction);
  $("#p-next-ev").onclick = () => nextWhere(isEviction);
  $("#p-next-sec").onclick = () => nextWhere(isSecurity);
  $("#p-play").onclick = () => (S.playing ? pause() : play());
  $("#p-t").onchange = e => setT(parseInt(e.target.value, 10) || 0);
  $("#p-speed").onchange = e => { S.speed = parseInt(e.target.value, 10); if (S.playing) play(); };
  $("#p-insp").onclick = () => { pause(); location.hash = "#inspector"; };
}

function renderFrames() {
  const tr = S.trace, t = S.t, st = replay(tr, t), ev = tr.events[t];
  const page = tr.refs[t];
  let cells = "";
  st.frames.forEach((p, j) => {
    if (p < 0) { cells += `<div class="frame empty"><div class="fid"><span>F${String(j).padStart(2, "0")}</span></div><div class="pid faint">—</div><div class="meta">free</div></div>`; return; }
    const isReq = j === ev[1];
    const cls = isReq ? (ev[0] ? "hit" : "loaded") : "";
    const inWs = t - st.last[p] <= 32;
    const flag = isReq ? (ev[0] ? `<span class="flag hit">HIT</span>` : `<span class="flag in">IN${ev[2] >= 0 ? " ← out p" + ev[2] : ""}</span>`) : "";
    cells += `<div class="frame ${cls}" data-page="${p}" tabindex="0" data-tip="${esc(`frame ${j} · page ${p} (${SENS_NAMES[tr.sens[p]]})\nloaded at request ${st.loaded[p]}\nlast used at request ${st.last[p]} (${t - st.last[p]} requests ago)\nused ${st.freq[p]} times since loaded\n${inWs ? "in" : "outside"} the working set (last 32 requests)`)}">
      <div class="fid"><span>F${String(j).padStart(2, "0")}</span>${sensHTML(tr.sens[p])}</div>
      <div class="pid">p${p}</div>
      <div class="meta"><span>Δt ${t - st.last[p]}</span><span>×${st.freq[p]}</span><span>${inWs ? "WS" : "—"}</span></div>
      ${flag}</div>`;
  });
  const what = ev[0] ? `hit (frame ${ev[1]})` : ev[2] >= 0 ? `fault · evicted p${ev[2]} from frame ${ev[1]}` : `fault · loaded into free frame ${ev[1]}`;
  $("#frames-panel").innerHTML = `<div class="panel-head"><h2>Memory frames after request ${t}</h2>
      <span class="note">request p${page} ${sensHTML(tr.sens[page])} → ${what}</span></div>
    <div class="frames">${cells}</div>
    <div class="legend" style="margin-top:8px"><span>Δt = requests since last use</span><span>× = uses since loaded</span><span>WS = used in the last 32 requests</span><span>S0–S3 = sensitivity (bars, S3 in ember)</span><span>frame outline: ember = just loaded, steel = hit</span></div>`;
  $$(".frame[data-page]").forEach(el => el.onclick = () => { S.selectedPage = +el.dataset.page; pause(); location.hash = "#inspector"; });
}

let overviewSvgFor = null;
function renderTimeline(full) {
  const tr = S.trace, t = S.t;
  const lo = Math.max(0, Math.min(t - 30, tr.n - 48)), hi = Math.min(tr.n, lo + 48);
  let strip = "";
  for (let i = lo; i < hi; i++) {
    const ev = tr.events[i];
    const cls = [ev[0] ? "" : "fault", ev[2] >= 0 ? "evict" : "", ev[2] >= 0 && isSecurity(ev, i) ? "sec" : "", i === t ? "cur" : "", i > t ? "future" : ""].join(" ");
    const tipText = `request ${i}: page ${tr.refs[i]} (${SENS_NAMES[tr.sens[tr.refs[i]]]})\n${ev[0] ? "hit" : "fault"}${ev[2] >= 0 ? ` · evicted p${ev[2]} (S${tr.sens[ev[2]]})` : ""}\npattern detected: ${PATTERNS[ev[3]]}${ev[4] & 2 ? "\nsecurity changed the choice" : ""}${ev[4] & 1 ? "\nall pages protected (fallback)" : ""}`;
    strip += `<div class="cell ${cls}" data-t="${i}" data-tip="${esc(tipText)}">${tr.refs[i]}<span class="k">${ev[0] ? "·" : "F"}</span></div>`;
  }
  if (full || overviewSvgFor !== tr) {
    $("#timeline-panel").innerHTML = `<div class="panel-head"><h2>Request timeline</h2><span class="note">requests ${lo}–${hi - 1} · future requests dimmed</span></div>
      <div class="strip" id="strip">${strip}</div>
      <div class="legend" style="margin:6px 0 12px"><span><span class="sw" style="background:var(--ember)"></span>F = page fault (top bar)</span><span>↧ = eviction</span><span><span class="sw" style="background:#2a1f1a;border:1px solid var(--border)"></span>security event</span><span><span class="sw" style="border:1px solid var(--accent)"></span>current request</span></div>
      <div id="ov-wrap">${overviewSvg(tr)}</div>`;
    overviewSvgFor = tr;
    $("#ov-svg").addEventListener("click", e => {
      const r = e.currentTarget.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width * OV.w;
      if (x >= OV.l && x <= OV.w - OV.r) setT(Math.round((x - OV.l) / (OV.w - OV.l - OV.r) * (tr.n - 1)));
    });
  } else {
    $("#strip").innerHTML = strip;
    $("#timeline-panel .panel-head .note").textContent = `requests ${lo}–${hi - 1} · future requests dimmed`;
  }
  $$("#strip .cell").forEach(c => c.onclick = () => setT(+c.dataset.t));
  const cx = OV.l + t / Math.max(1, tr.n - 1) * (OV.w - OV.l - OV.r);
  const cur = $("#ov-cursor");
  if (cur) { cur.setAttribute("x1", cx); cur.setAttribute("x2", cx); }
}

const OV = { w: 640, h: 132, l: 64, r: 6 };
function overviewSvg(tr) {
  const n = tr.n, iw = OV.w - OV.l - OV.r;
  const x = t => OV.l + t / Math.max(1, n - 1) * iw;
  let s = `<svg id="ov-svg" class="chart" viewBox="0 0 ${OV.w} ${OV.h}" role="img" aria-label="Whole run: detected pattern, fault rate, security events and security weight over the requests" style="cursor:pointer">`;
  const rows = [["pattern", 6], ["fault rate", 28], ["security", 72], ["wS", 92]];
  for (const [label, yy] of rows) s += `<text x="0" y="${yy + 9}" style="font-size:10px;fill:var(--text-3)">${label}</text>`;
  // detected pattern band
  let start = 0;
  for (let t = 1; t <= n; t++) {
    if (t === n || tr.events[t][3] !== tr.events[start][3]) {
      const p = PATTERNS[tr.events[start][3]];
      const x0 = x(start), x1 = x(Math.min(t, n - 1));
      s += `<rect x="${x0}" y="4" width="${Math.max(1, x1 - x0)}" height="14" fill="${PATTERN_SHADE[p] || "#2B302D"}" data-tip="${esc(`requests ${start}–${t - 1}: detected ${p}`)}"/>`;
      if (x1 - x0 > 60) s += `<text x="${x0 + 4}" y="14" style="font-size:10px;fill:var(--text-2);pointer-events:none">${p}</text>`;
      start = t;
    }
  }
  // fault rate per bucket
  const buckets = Math.min(150, n), size = n / buckets;
  for (let b = 0; b < buckets; b++) {
    const a = Math.floor(b * size), z = Math.max(a + 1, Math.floor((b + 1) * size));
    let f = 0;
    for (let t = a; t < z; t++) f += 1 - tr.events[t][0];
    const rate = f / (z - a), hh = rate * 36;
    s += `<rect x="${x(a)}" y="${62 - hh}" width="${Math.max(1, x(z - 1) - x(a) + iw / n - 0.6)}" height="${hh}" fill="#E99A73" fill-opacity="0.75" data-tip="${esc(`requests ${a}–${z - 1}\nfault rate ${(rate * 100).toFixed(0)}%`)}"/>`;
  }
  s += `<line x1="${OV.l}" x2="${OV.w - OV.r}" y1="62" y2="62" class="axis"/>`;
  // security events
  for (const e of tr.evictions) {
    const s3 = tr.sens[e.victim] === 3, changed = e.flags & 2, fallback = e.flags & 1;
    if (!(s3 || changed || fallback)) continue;
    const label = [changed ? "security changed the choice" : "", fallback ? "all pages protected" : "", s3 ? `S3 page p${e.victim} evicted` : ""].filter(Boolean).join("\n");
    s += `<line x1="${x(e.t)}" x2="${x(e.t)}" y1="${fallback ? 66 : 70}" y2="84" stroke="${s3 ? "#E99A73" : "#A6B4A9"}" stroke-width="1" data-tip="${esc(`request ${e.t}\n${label}`)}"/>`;
  }
  // wS step line (Adaptive only)
  if (S.traceConfig && S.traceConfig.algo === "Adaptive") {
    const yw = w => 128 - (w - 0.5) / 1.5 * 30;
    let w = S.params ? S.params.ws_start : 1, d = `M${x(0)},${yw(w)}`;
    for (const fb of tr.feedback) { d += `H${x(fb.t)}V${yw(fb.new)}`; w = fb.new; }
    d += `H${x(n - 1)}`;
    s += `<path d="${d}" fill="none" stroke="#B8F36B" stroke-width="1.5"/>`;
    for (const fb of tr.feedback) if (fb.old !== fb.new) s += `<g data-tip="${esc(`feedback after request ${fb.t}\nfault rate of last 100: ${(fb.fault_rate * 100).toFixed(0)}%\nwS ${fb.old.toFixed(2)} → ${fb.new.toFixed(2)}`)}"><circle cx="${x(fb.t)}" cy="${yw(fb.new)}" r="6" class="hit-area"/><circle cx="${x(fb.t)}" cy="${yw(fb.new)}" r="2.5" fill="#B8F36B"/></g>`;
    s += `<text x="${OV.w - OV.r}" y="${yw(2) - 2}" text-anchor="end" style="font-size:9px;fill:var(--text-3)">2.0</text><text x="${OV.w - OV.r}" y="${yw(0.5) - 2}" text-anchor="end" style="font-size:9px;fill:var(--text-3)">0.5</text>`;
  } else {
    s += `<text x="${OV.l}" y="112" style="font-size:10px;fill:var(--text-3)">no security weight (only Adaptive has one)</text>`;
  }
  s += `<line id="ov-cursor" x1="${OV.l}" x2="${OV.l}" y1="0" y2="${OV.h}" stroke="#B8F36B" stroke-width="1.5" pointer-events="none"/>`;
  return s + "</svg>";
}

// fetches ./sim --inspect for the current request (cached)
async function getInspect(t) {
  const key = runId(S.traceConfig) + "@" + t;
  if (!S.inspectCache[key]) S.inspectCache[key] = api("inspect", { ...configParams(S.traceConfig), t });
  return S.inspectCache[key];
}

function reasonText(algo, snap, victim) {
  const v = snap.frames.find(f => f.frame === snap.victim_frame);
  if (algo === "FIFO") return `FIFO: p${v.page} was loaded earliest (request ${v.loaded}).`;
  if (algo === "LRU") return `LRU: p${v.page} has the oldest last use (request ${v.last}).`;
  if (algo === "LFU") return `LFU: p${v.page} has the fewest uses since loading (${v.freq}); ties go to the least recently used.`;
  if (algo === "Optimal") return `Optimal: p${v.page} is next needed ${v.next_use >= S.trace.n ? "never again" : "at request " + v.next_use}, the furthest in the future. (Benchmark: it reads future requests.)`;
  return `Adaptive: p${v.page} has the highest eviction score (${v.score.toFixed(3)}) among the pages that may be evicted.`;
}

function contribHTML(f, weights, wS) {
  const parts = [
    ["wR·R", weights[0] * f.R], ["wF·F", weights[1] * f.F], ["wB·B", weights[2] * f.B], ["wW·W", weights[3] * f.W],
    ["−wS·S", -(S.traceConfig.security ? wS : 0) * f.S],
  ];
  const lo = Math.min(0, ...parts.map(p => p[1]), -0.5), hi = Math.max(0.5, ...parts.map(p => p[1]));
  const pos = v => (v - lo) / (hi - lo) * 100;
  let s = `<div class="contrib" role="table" aria-label="Score contributions of page ${f.page}">`;
  for (const [label, v] of parts) {
    const a = pos(Math.min(0, v)), b = pos(Math.max(0, v));
    const color = label.startsWith("−") ? "#E99A73" : "#829BB8";
    s += `<span class="lbl">${label}</span><span class="track"><span class="zero" style="left:${pos(0)}%"></span><span class="bar" style="left:${a}%;width:${b - a}%;background:${color}"></span></span><span class="val">${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(3)}</span>`;
  }
  s += `<span class="lbl" style="color:var(--text)">score</span><span></span><span class="val" style="font-weight:600">${f.score.toFixed(3)}</span></div>`;
  return s;
}

async function renderDecision() {
  const tr = S.trace, t = S.t, ev = tr.events[t], page = tr.refs[t], algo = S.traceConfig.algo;
  const box = $("#decision-panel");
  const head = `<div class="panel-head"><h2>Decision inspector · request ${t}</h2><span class="note">${esc(algo)}</span></div>`;
  if (ev[0]) {
    box.innerHTML = head + `<div class="inspector-empty">Hit: p${page} ${sensHTML(tr.sens[page])} is already in frame ${ev[1]}. No replacement decision is made.<br><br>Use <b>E▶</b> to jump to the next eviction.</div>`;
    return;
  }
  if (ev[2] < 0) {
    box.innerHTML = head + `<div class="inspector-empty">Fault: p${page} ${sensHTML(tr.sens[page])} was loaded into free frame ${ev[1]}. Memory was not full yet, so nothing was evicted.</div>`;
    return;
  }
  const summary = `<div class="decision-head">
      <div class="kv"><div class="k">Incoming</div><div class="v">p${page} ${sensHTML(tr.sens[page])}</div></div>
      <div class="kv"><div class="k">Evicted · frame ${ev[1]}</div><div class="v">p${ev[2]} ${sensHTML(tr.sens[ev[2]])}</div></div></div>`;
  if (S.playing) {
    box.innerHTML = head + summary + `<div class="inspector-empty">Pause to load the score breakdown from <code>./sim --inspect ${t}</code>.</div>`;
    return;
  }
  box.innerHTML = head + summary + `<div class="inspector-empty">Loading <code>./sim --inspect ${t}</code> …</div>`;
  let snap;
  try { snap = await getInspect(t); } catch (e) { box.innerHTML = head + summary + errorBox(e.message); return; }
  if (S.t !== t || S.page !== "simulator") return;

  let html = head + summary + `<p class="reason">${esc(reasonText(algo, snap))}</p>`;
  if (algo === "Adaptive") {
    const w = S.traceConfig.weights, wS = snap.wS;
    const notes = [];
    if (snap.fallback) notes.push(`<div class="callout warn"><b>All pages were protected</b> (in-use S3 pages), so the fallback considered every page. This S3 eviction is a secure eviction.</div>`);
    if (snap.no_security_page !== snap.victim_page) notes.push(`<div class="callout warn"><b>Security changed the decision.</b> Without the S penalty and protection, Adaptive would have evicted p${snap.no_security_page} ${sensHTML(tr.sens[snap.no_security_page])}.</div>`);
    else notes.push(`<div class="callout">The security part did not change this choice: the same page has the highest score with or without it.</div>`);
    if (tr.sens[snap.victim_page] === 3 && !snap.fallback) notes.push(`<div class="callout warn">An S3 page left memory (outside the working set, so not protected). Counted as a secure eviction.</div>`);
    html += `<div class="stack" style="gap:6px;margin-bottom:10px">${notes.join("")}</div>`;
    html += `<div class="formula small">score = <span class="hl">${w[0]}</span>·R + <span class="hl">${w[1]}</span>·F + <span class="hl">${w[2]}</span>·B + <span class="hl">${w[3]}</span>·W − <span class="hl">${S.traceConfig.security ? wS.toFixed(2) : "0"}</span>·S</div>`;
    html += `<div class="small faint" style="margin:6px 0">detected pattern: <b class="mono">${snap.behaviour}</b>${S.traceConfig.behaviour ? "" : " (behaviour off → B = 0.5)"} · wS ${wS.toFixed(2)} · rows sorted by score, click a row for its contributions</div>`;
    const rows = snap.frames.slice().sort((a, b) => b.score - a.score);
    html += `<div class="table-wrap"><table class="data compact"><thead><tr><th>Page</th><th>S</th><th class="num">R</th><th class="num">F</th><th class="num">B</th><th class="num">W</th><th class="num">S val</th><th class="num">Score</th><th>Status</th></tr></thead><tbody>`;
    for (const f of rows) {
      const status = f.frame === snap.victim_frame ? `<span class="tag ember">EVICTED</span>` : f.protected ? `<span class="tag steel" title="in-use S3 page, not considered">PROTECTED</span>` : f.page === snap.no_security_page ? `<span class="tag" title="the page Adaptive would evict without the security part">NO-SEC PICK</span>` : "";
      const open = S.expandedRow === f.page || (S.expandedRow === null && f.frame === snap.victim_frame);
      html += `<tr class="clickable${open ? " sel" : ""}" data-p="${f.page}"><td>${pageHTML(f.page)}</td><td>${sensHTML(f.sens)}</td><td class="num">${f.R.toFixed(2)}</td><td class="num">${f.F.toFixed(2)}</td><td class="num">${f.B.toFixed(2)}</td><td class="num">${f.W}</td><td class="num">${f.S.toFixed(2)}</td><td class="num">${f.score.toFixed(3)}</td><td>${status}</td></tr>`;
      if (open) html += `<tr><td colspan="9">${contribHTML(f, w, wS)}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  } else {
    const key = { FIFO: "loaded", LRU: "last", LFU: "freq", Optimal: "next_use" }[algo];
    const label = { FIFO: "loaded at", LRU: "last use", LFU: "uses", Optimal: "next use" }[algo];
    const rows = snap.frames.slice().sort((a, b) => algo === "Optimal" ? b[key] - a[key] : a[key] - b[key] || a.last - b.last);
    html += `<div class="table-wrap"><table class="data compact"><thead><tr><th>Page</th><th>S</th><th class="num">${label}</th><th class="num">loaded</th><th class="num">last use</th><th class="num">uses</th><th>Status</th></tr></thead><tbody>`;
    for (const f of rows) {
      const v = algo === "Optimal" && f.next_use >= tr.n ? "never" : f[key];
      html += `<tr${f.frame === snap.victim_frame ? ' class="sel"' : ""}><td>${pageHTML(f.page)}</td><td>${sensHTML(f.sens)}</td><td class="num">${v}</td><td class="num">${f.loaded}</td><td class="num">${f.last}</td><td class="num">${f.freq}</td><td>${f.frame === snap.victim_frame ? '<span class="tag ember">EVICTED</span>' : ""}</td></tr>`;
    }
    html += `</tbody></table></div><p class="small faint" style="margin-top:6px">${esc(algo)} does not look at sensitivity.</p>`;
  }
  const after = snap.frames.slice().sort((a, b) => a.frame - b.frame).map(f => f.frame === snap.victim_frame ? `<b class="delta-bad">F${f.frame}:p${page}</b>` : `F${f.frame}:p${f.page}`).join("  ");
  html += `<div class="hr" style="margin:12px 0 8px"></div><div class="small faint">Memory after the replacement</div><div class="mono small" style="margin-top:4px;line-height:1.8">${after}</div>`;
  box.innerHTML = html;
  $$("#decision-panel tr.clickable").forEach(r => r.onclick = () => { S.expandedRow = +r.dataset.p; renderDecision(); });
}

function renderCompare() {
  const box = $("#compare-panel");
  if (!box) return;
  if (!S.compare) {
    box.innerHTML = `<div class="row"><span class="small faint">Compare runs FIFO, LRU, LFU, Optimal and Adaptive on this same workload and memory size.</span><span class="spacer"></span><button class="btn" id="cmp-btn" type="button">Compare algorithms</button></div>`;
    $("#cmp-btn").onclick = runCompare;
    return;
  }
  const C = S.compare, base = C[S.compareBaseline], n = S.trace.n;
  const sec = r => r.evicted[2] + r.evicted[3];
  let t = `<table class="data"><thead><tr><th>Algorithm</th><th class="num">Faults</th><th class="num">Hit rate</th><th class="num">S2+S3 evicted</th><th class="num">S3 evicted</th><th class="num">Faults vs ${S.compareBaseline}</th><th class="num">Secret vs ${S.compareBaseline}</th><th class="num">Run time</th></tr></thead><tbody>`;
  for (const a of ALGOS) {
    const r = C[a];
    t += `<tr class="${a === "Adaptive" ? "adaptive" : ""}"><td>${a}${a === "Optimal" ? ' <span class="tag">benchmark</span>' : ""}</td><td class="num">${fmt(r.faults)}</td><td class="num">${(r.hits / n * 100).toFixed(1)}%</td><td class="num">${fmt(sec(r))}</td><td class="num">${fmt(r.evicted[3])}</td><td class="num">${a === S.compareBaseline ? "—" : deltaHTML(change(r.faults, base.faults))}</td><td class="num">${a === S.compareBaseline ? "—" : deltaHTML(change(sec(r), sec(base)))}</td><td class="num">${fmt(r.time_us)} µs</td></tr>`;
  }
  t += `</tbody></table>`;
  const series = ALGOS.map(a => ({ name: a, color: ALGO_COLOR[a], dash: a === "Optimal" ? "5 4" : null, width: a === "Adaptive" ? 2.5 : 1.5, points: false, pts: C[a].cumulative, label: `${SHORT[a]} ${fmt(C[a].faults)}` }));
  box.innerHTML = `<div class="panel-head"><h2>All algorithms on this workload</h2>
      <div class="row"><label class="small faint" for="cmp-base">baseline</label><select id="cmp-base" style="width:auto">${["FIFO", "LRU", "LFU"].map(b => `<option${b === S.compareBaseline ? " selected" : ""}>${b}</option>`).join("")}</select></div></div>
    <div class="note small faint" style="margin-bottom:8px">Same workload, frames and sensitivity labels for every algorithm · ${esc(runId(S.traceConfig).split("/").slice(1).join("/"))}</div>
    <div class="table-wrap">${t}</div>
    <div style="margin-top:12px">${lineChart({ title: "Cumulative page faults over the run", series, xs: [0, n - 1], xLabel: "request", yLabel: "faults so far", w: 1000, h: 260, fmtX: v => fmt(v) })}</div>
    <p class="small faint">Run time is one run measured with <code>clock()</code>; it is noisy for short runs.</p>`;
  $("#cmp-base").onchange = e => { S.compareBaseline = e.target.value; renderCompare(); };
}

/* ================= Memory Inspector ================= */

function pageInspector() {
  main.innerHTML = `<div class="page"><div class="page-head"><div><h1>Memory inspector</h1><p>The pages in memory just before a request, with the values the simulator uses for its decision. Select a page for its history, or an eviction for the state before and after it.</p></div></div><div id="insp"></div></div>`;
  loadParams().catch(() => {});
  if (S.trace) renderInspector();
  else $("#insp").innerHTML = `<div class="empty">Running the default simulation …</div>`;
  ensureRun();
}

async function renderInspector() {
  const box = $("#insp");
  if (!box) return;
  if (!S.trace) {
    box.innerHTML = `<div class="empty">No simulation yet. <a href="#simulator">Run one in the Simulator</a>; the inspector then shows its memory state at any request.</div>`;
    return;
  }
  const tr = S.trace, t = S.t, algo = S.traceConfig.algo;
  const shell = $("#insp-shell");
  if (!shell) {
    box.innerHTML = `<div id="insp-shell" class="stack">
      <div class="panel"><div class="playbar">
        <button class="btn btn-icon" id="i-prev-ev" title="Previous eviction">◀E</button>
        <button class="btn btn-icon" id="i-prev">◀</button>
        <span class="pos">request</span><input type="number" id="i-t" min="0" max="${tr.n - 1}" aria-label="Request number">
        <button class="btn btn-icon" id="i-next">▶</button>
        <button class="btn btn-icon" id="i-next-ev" title="Next eviction">E▶</button>
        <span id="i-ctx" class="small muted"></span>
      </div></div>
      <div class="sim-work" style="grid-template-columns:minmax(0,1fr) 420px">
        <div class="panel" id="i-table"></div>
        <div class="stack"><div class="panel" id="i-page"></div><div class="panel" id="i-events"></div></div>
      </div></div>`;
    $("#i-prev").onclick = () => setT(S.t - 1);
    $("#i-next").onclick = () => setT(S.t + 1);
    $("#i-prev-ev").onclick = () => prevWhere(isEviction);
    $("#i-next-ev").onclick = () => nextWhere(isEviction);
    $("#i-t").onchange = e => setT(parseInt(e.target.value, 10) || 0);
  }
  $("#i-t").value = t;
  const ev = tr.events[t];
  $("#i-ctx").innerHTML = `${esc(runId(S.traceConfig))} · request ${t}: p${tr.refs[t]} ${sensHTML(tr.sens[tr.refs[t]])} → ${ev[0] ? "hit" : ev[2] >= 0 ? `fault, evicts p${ev[2]}` : "fault, free frame"}`;
  renderEventList();
  $("#i-table").innerHTML = `<div class="small muted">Loading <code>./sim --inspect ${t}</code> …</div>`;
  let snap;
  try { snap = await getInspect(t); } catch (e) { $("#i-table").innerHTML = errorBox(e.message); return; }
  if (S.t !== t || S.page !== "inspector") return;
  renderPageTable(snap);
  renderPageDetail(snap);
}

function renderPageTable(snap) {
  const tr = S.trace, algo = S.traceConfig.algo, isA = algo === "Adaptive" && snap.used === S.trace.frames;
  const F = S.inspFilter;
  const cols = [
    ["page", "Page"], ["frame", "Frame"], ["last", "Last access"], ["freq", "Uses"], ["in_ws", "Working set"],
    ...(isA ? [["B", "B"]] : []), ["sens", "Sensitivity"], ...(isA ? [["score", "Score"]] : []), ...(algo === "Optimal" ? [["next_use", "Next use"]] : []), ["prot", "Protection"],
  ];
  const sk = cols.some(c => c[0] === S.inspSort.key) ? S.inspSort.key : "frame";
  const val = (f, k) => k === "prot" ? (f.protected ? 1 : 0) : f[k];
  let rows = snap.frames.filter(f => F.sens[f.sens] && (F.ws === "all" || (F.ws === "in") === !!f.in_ws) && (F.prot === "all" || (F.prot === "yes") === !!f.protected));
  rows.sort((a, b) => (val(a, sk) - val(b, sk)) * S.inspSort.dir || a.frame - b.frame);
  let html = `<div class="panel-head"><h2>Pages in memory before request ${snap.t}</h2><span class="note">pattern detected: <b class="mono">${snap.behaviour}</b>${algo === "Adaptive" ? ` · wS ${snap.wS.toFixed(2)}` : ""} · ${snap.used}/${tr.frames} frames used</span></div>
    <div class="row" style="margin-bottom:10px">
      <span class="small faint">Sensitivity</span>${[0, 1, 2, 3].map(l => `<label class="check"><input type="checkbox" data-sf="${l}"${F.sens[l] ? " checked" : ""}>S${l}</label>`).join("")}
      <span class="small faint" style="margin-left:8px">Working set</span><select id="f-ws" style="width:auto">${["all", "in", "out"].map(v => `<option${F.ws === v ? " selected" : ""}>${v}</option>`).join("")}</select>
      ${algo === "Adaptive" ? `<span class="small faint" style="margin-left:8px">Protected</span><select id="f-prot" style="width:auto">${["all", "yes", "no"].map(v => `<option${F.prot === v ? " selected" : ""}>${v}</option>`).join("")}</select>` : ""}
    </div>
    <div class="table-wrap"><table class="data"><thead><tr>${cols.map(([k, l]) => `<th class="sortable${["frame", "last", "freq", "B", "score", "next_use"].includes(k) ? " num" : ""}" data-k="${k}" ${k === sk ? `aria-sort="${S.inspSort.dir > 0 ? "ascending" : "descending"}"` : ""} tabindex="0">${l}</th>`).join("")}</tr></thead><tbody>`;
  for (const f of rows) {
    const prot = algo !== "Adaptive" ? '<span class="faint">n/a</span>' : f.protected ? '<span class="tag steel">PROTECTED</span>' : f.sens === 3 ? '<span class="tag">not in use</span>' : '<span class="faint">—</span>';
    const victim = f.frame === snap.victim_frame;
    html += `<tr class="clickable${S.selectedPage === f.page ? " sel" : ""}" data-p="${f.page}">
      <td class="mono">p${f.page}${victim ? ' <span class="tag ember">EVICTED</span>' : ""}</td><td class="num">F${f.frame}</td><td class="num">${f.last} <span class="faint">(${snap.t - f.last} ago)</span></td><td class="num">${f.freq}</td><td>${f.in_ws ? "in" : '<span class="faint">out</span>'}</td>
      ${isA ? `<td class="num">${f.B.toFixed(2)}</td>` : ""}<td>${sensHTML(f.sens)}</td>${isA ? `<td class="num">${f.score.toFixed(3)}</td>` : ""}${algo === "Optimal" ? `<td class="num">${f.next_use >= tr.n ? "never" : f.next_use}</td>` : ""}<td>${prot}</td></tr>`;
  }
  if (!rows.length) html += `<tr><td colspan="${cols.length}" class="faint">No pages match the filters.</td></tr>`;
  html += `</tbody></table></div>`;
  if (algo === "Adaptive" && snap.used === tr.frames && !snap.decision) html += `<p class="small faint" style="margin-top:8px">This request ${snap.hit ? "is a hit" : "loads into a free frame"}, so no eviction is made. The scores are what Adaptive computes at this moment; they are only used when a request faults with memory full.</p>`;
  if (algo === "Adaptive" && snap.used < tr.frames) html += `<p class="small faint" style="margin-top:8px">Memory is not full yet, so no scores are computed.</p>`;
  if (snap.decision) {
    const after = snap.frames.slice().sort((a, b) => a.frame - b.frame).map(f => f.frame === snap.victim_frame ? `<b class="delta-bad">F${f.frame}:p${snap.request}</b>` : `F${f.frame}:p${f.page}`).join("  ");
    html += `<div class="hr" style="margin:10px 0"></div><div class="small faint">After request ${snap.t} (p${snap.victim_page} replaced by p${snap.request})</div><div class="mono small" style="line-height:1.8">${after}</div>`;
  }
  $("#i-table").innerHTML = html;
  $$("#i-table th.sortable").forEach(th => {
    const go = () => { const k = th.dataset.k; S.inspSort = { key: k, dir: S.inspSort.key === k ? -S.inspSort.dir : (k === "score" ? -1 : 1) }; renderPageTable(snap); };
    th.onclick = go;
    th.onkeydown = e => { if (e.key === "Enter") go(); };
  });
  $$("[data-sf]").forEach(c => c.onchange = () => { F.sens[+c.dataset.sf] = c.checked; renderPageTable(snap); });
  $("#f-ws").onchange = e => { F.ws = e.target.value; renderPageTable(snap); };
  if ($("#f-prot")) $("#f-prot").onchange = e => { F.prot = e.target.value; renderPageTable(snap); };
  $$("#i-table tr.clickable").forEach(r => r.onclick = () => { S.selectedPage = +r.dataset.p; renderPageTable(snap); renderPageDetail(snap); });
}

function renderPageDetail(snap) {
  const tr = S.trace, p = S.selectedPage, box = $("#i-page");
  if (p === null || p === undefined) {
    box.innerHTML = `<div class="panel-head"><h2>Page detail</h2></div><div class="inspector-empty">Select a page in the table (or a frame in the Simulator).</div>`;
    return;
  }
  const uses = [], outs = [];
  for (let t = 0; t < tr.n; t++) {
    if (tr.refs[t] === p) uses.push({ t, hit: tr.events[t][0] });
    if (tr.events[t][2] === p) outs.push({ t, by: tr.refs[t] });
  }
  const f = snap.frames.find(x => x.page === p);
  let html = `<div class="panel-head"><h2>Page p${p} ${sensHTML(tr.sens[p])}</h2><span class="note">${SENS_NAMES[tr.sens[p]]}</span></div>
    <div class="counters" style="margin-bottom:8px"><span>requests<b>${uses.length}</b></span><span>faults<b>${uses.filter(u => !u.hit).length}</b></span><span>times evicted<b>${outs.length}</b></span></div>`;
  if (f && f.score !== undefined) html += `<div class="small faint">Score breakdown before request ${snap.t}</div>` + contribHTML(f, S.traceConfig.weights, snap.wS);
  else if (!f) html += `<div class="small faint">Not in memory before request ${snap.t}.</div>`;
  const hist = uses.map(u => ({ t: u.t, text: u.hit ? "hit" : "fault, loaded" })).concat(outs.map(o => ({ t: o.t, text: `evicted for p${o.by}` }))).sort((a, b) => a.t - b.t);
  html += `<div class="small faint" style="margin-top:10px">History (whole run)</div><div class="table-wrap" style="max-height:220px;overflow:auto"><table class="data"><tbody>${hist.map(h => `<tr class="clickable${h.t === S.t ? " sel" : ""}" data-t="${h.t}"><td class="num">${h.t}</td><td>${h.text.startsWith("evicted") ? `<span class="delta-bad">${h.text}</span>` : h.text}</td></tr>`).join("")}</tbody></table></div>`;
  box.innerHTML = html;
  $$("#i-page tr.clickable").forEach(r => r.onclick = () => setT(+r.dataset.t));
}

function renderEventList() {
  const tr = S.trace, box = $("#i-events");
  const filters = { all: () => true, security: e => e.flags & 2, fallback: e => e.flags & 1, s3: e => tr.sens[e.victim] === 3 };
  const list = tr.evictions.filter(filters[S.evFilter]);
  box.innerHTML = `<div class="panel-head"><h2>Evictions</h2><span class="note">${fmt(list.length)} of ${fmt(tr.evictions.length)}</span></div>
    <div class="seg" id="ev-f" style="margin-bottom:8px">${[["all", "All"], ["security", "Security changed"], ["fallback", "All protected"], ["s3", "S3 evicted"]].map(([k, l]) => `<button type="button" data-k="${k}" aria-pressed="${S.evFilter === k}">${l}</button>`).join("")}</div>
    <div class="table-wrap" style="max-height:300px;overflow:auto"><table class="data"><thead><tr><th class="num">Request</th><th>In</th><th>Out</th><th>Pattern</th><th>Note</th></tr></thead><tbody>
    ${list.slice(0, 400).map(e => `<tr class="clickable${e.t === S.t ? " sel" : ""}" data-t="${e.t}"><td class="num">${e.t}</td><td>p${e.page} ${sensHTML(tr.sens[e.page])}</td><td>p${e.victim} ${sensHTML(tr.sens[e.victim])}</td><td class="mono small">${PATTERNS[e.pattern]}</td><td class="small">${[e.flags & 2 ? "security" : "", e.flags & 1 ? "all protected" : ""].filter(Boolean).join(", ")}</td></tr>`).join("")}
    ${list.length > 400 ? `<tr><td colspan="5" class="faint">first 400 shown</td></tr>` : ""}${list.length === 0 ? `<tr><td colspan="5" class="faint">${S.traceConfig.algo === "Adaptive" || S.evFilter === "all" || S.evFilter === "s3" ? "none in this run" : "only Adaptive marks security events"}</td></tr>` : ""}
    </tbody></table></div>`;
  $$("#ev-f button").forEach(b => b.onclick = () => { S.evFilter = b.dataset.k; renderEventList(); });
  $$("#i-events tr.clickable").forEach(r => r.onclick = () => setT(+r.dataset.t));
}

/* ================= Experiments ================= */

async function pageExperiments() {
  main.innerHTML = `<div class="page"><div class="page-head"><div><h1>Experiments</h1><p>All six experiments from the report, produced by <code>./sim --csv</code>. Every algorithm gets the same workload, memory size and sensitivity labels.</p></div>
    <form class="row" id="exp-form"><label class="small faint" for="exp-seed">Seed</label><input id="exp-seed" type="number" min="0" max="1000000" value="${S.expSeed}" style="width:110px"><button class="btn btn-primary" type="submit">Run experiments</button></form></div>
    <div id="exp-body"><div class="empty">Running <code>./sim --csv --seed ${S.expSeed}</code> …</div></div></div>`;
  $("#exp-form").onsubmit = e => {
    e.preventDefault();
    const v = parseInt($("#exp-seed").value, 10);
    if (!(v >= 0 && v <= 1000000)) return;
    S.expSeed = v;
    updateExpId();
    pageExperiments();
  };
  let exp;
  try { exp = await loadExperiments(S.expSeed); } catch (e) { $("#exp-body").innerHTML = errorBox(e.message); return; }
  if (S.page !== "experiments") return;
  renderExperiments(exp);
}

function renderExperiments(exp) {
  const F = S.expFilters, M = METRICS[F.metric];
  const seg = (id, items, cur) => `<div class="seg" id="${id}">${items.map(([k, l]) => `<button type="button" data-k="${k}" aria-pressed="${String(k) === String(cur)}">${l}</button>`).join("")}</div>`;
  const get = (wl, f, a) => rowOf(exp, { experiment: "main", workload: wl, frames: f, algorithm: a });

  const mult = WORKLOADS.map(wl => {
    const vals = ALGOS.map(a => M.get(get(wl, F.frames, a)));
    return barChart({ title: wl, cats: ALGOS, labels: ALGOS.map(a => SHORT[a]), vals, colors: ALGOS.map(a => ALGO_COLOR[a]), hatched: ["Optimal"],
      yMax: F.metric === "hit_rate" ? 100 : undefined, fmtV: M.fmt, w: 250, h: 190,
      tips: ALGOS.map((a, i) => `${wl} · ${F.frames} frames\n${a}${a === "Optimal" ? " (benchmark)" : ""}\n${M.label}: ${M.fmt(vals[i])}${a !== F.baseline ? `\nvs ${F.baseline}: ${(change(vals[i], vals[ALGOS.indexOf(F.baseline)])).toFixed(1)}%` : ""}`) });
  }).join("");
  let table = `<table class="data"><thead><tr><th>Workload</th>${ALGOS.map(a => `<th class="num">${a}</th>`).join("")}<th class="num">Adaptive vs ${F.baseline}</th></tr></thead><tbody>`;
  for (const wl of WORKLOADS) {
    const vals = ALGOS.map(a => M.get(get(wl, F.frames, a)));
    table += `<tr><td>${wl}</td>${vals.map((v, i) => `<td class="num"${ALGOS[i] === "Adaptive" ? ' style="color:var(--accent)"' : ""}>${M.fmt(v)}</td>`).join("")}<td class="num">${deltaHTML(change(vals[4], vals[ALGOS.indexOf(F.baseline)]), M.lower)}</td></tr>`;
  }
  table += `</tbody></table>`;

  const frames = [3, 4, 8, 16, 32];
  const memSeries = ALGOS.map(a => ({ name: a, label: SHORT[a], color: ALGO_COLOR[a], dash: a === "Optimal" ? "5 4" : null, width: a === "Adaptive" ? 2.5 : 1.5,
    pts: frames.map(f => [f, M.get(get(F.workload, f, a))]) }));

  // seeds
  const seedVals = (wl, metricFn) => {
    const l = rowsOf(exp, { experiment: "seeds", workload: wl, algorithm: "LRU" }).filter(r => r.setting.startsWith("seed-"));
    const a = rowsOf(exp, { experiment: "seeds", workload: wl, algorithm: "Adaptive" }).filter(r => r.setting.startsWith("seed-"));
    return l.map((r, i) => ({ v: change(metricFn(a[i]), metricFn(r)), tip: `${wl} · ${r.setting}\nLRU ${fmt(metricFn(r))} → Adaptive ${fmt(metricFn(a[i]))}` })).filter(x => isFinite(x.v));
  };
  const dotGroups = fn => WORKLOADS.map(wl => { const vals = seedVals(wl, fn); return { vals, mean: vals.length ? sum(vals.map(v => v.v)) / vals.length : 0 }; });
  const secretFn = r => r.evict_s2 + r.evict_s3;
  let seedTable = `<table class="data"><thead><tr><th>Workload</th><th class="num">LRU faults</th><th class="num">Adaptive faults</th><th class="num">change</th><th class="num">LRU S2+S3</th><th class="num">Adaptive S2+S3</th><th class="num">change</th></tr></thead><tbody>`;
  for (const wl of WORKLOADS) {
    const l = rowOf(exp, { experiment: "seeds", workload: wl, setting: "avg-10", algorithm: "LRU" });
    const a = rowOf(exp, { experiment: "seeds", workload: wl, setting: "avg-10", algorithm: "Adaptive" });
    seedTable += `<tr><td>${wl}</td><td class="num">${fmt(l.faults)}</td><td class="num">${fmt(a.faults)}</td><td class="num">${deltaHTML(change(a.faults, l.faults))}</td><td class="num">${fmt(secretFn(l))}</td><td class="num">${fmt(secretFn(a))}</td><td class="num">${deltaHTML(change(secretFn(a), secretFn(l)))}</td></tr>`;
  }
  seedTable += `</tbody></table>`;

  // placement and share
  let place = `<table class="data"><thead><tr><th>Workload</th><th>Sensitive pages are</th><th class="num">LRU faults</th><th class="num">Adaptive faults</th><th class="num">change</th><th class="num">LRU S2+S3</th><th class="num">Adaptive S2+S3</th><th class="num">change</th></tr></thead><tbody>`;
  for (const wl of ["phased", "bursty", "random"]) for (const pl of ["random", "hot", "warm", "cold"]) {
    const l = rowOf(exp, { experiment: "placement", workload: wl, setting: pl, algorithm: "LRU" });
    const a = rowOf(exp, { experiment: "placement", workload: wl, setting: pl, algorithm: "Adaptive" });
    place += `<tr><td>${pl === "random" ? wl : ""}</td><td>${pl}</td><td class="num">${fmt(l.faults)}</td><td class="num">${fmt(a.faults)}</td><td class="num">${deltaHTML(change(a.faults, l.faults))}</td><td class="num">${fmt(secretFn(l))}</td><td class="num">${fmt(secretFn(a))}</td><td class="num">${deltaHTML(change(secretFn(a), secretFn(l)))}</td></tr>`;
  }
  place += `</tbody></table>`;
  const shares = ["0%", "10%", "25%", "50%"];
  const shareChart = (wl, fn, label) => lineChart({ title: `${wl} · ${label}`, xs: [0, 10, 25, 50], xLabel: "sensitive pages (%)", yLabel: label, w: 380, h: 220, fmtX: v => v + "%",
    series: ["LRU", "Adaptive"].map(a => ({ name: a, label: SHORT[a], color: ALGO_COLOR[a], width: a === "Adaptive" ? 2.5 : 1.5, pts: shares.map((s, i) => [[0, 10, 25, 50][i], fn(rowOf(exp, { experiment: "amount", workload: wl, setting: s, algorithm: a }))]) })) });

  // ablation
  const variants = [["LRU", "-", "LRU (baseline)"], ["Adaptive", "full", "Adaptive, full"], ["Adaptive", "no-security", "without security"], ["Adaptive", "no-behaviour", "without behaviour"], ["Adaptive", "no-feedback", "without feedback"]];
  let abl = `<table class="data"><thead><tr><th>Version</th>${["bursty", "phased", "random"].map(w => `<th class="num">${w} faults</th><th class="num">${w} S2+S3</th>`).join("")}</tr></thead><tbody>`;
  for (const [a, s, label] of variants) {
    abl += `<tr class="${s === "full" ? "adaptive" : ""}"><td>${label}</td>${["bursty", "phased", "random"].map(w => { const r = rowOf(exp, { experiment: "ablation", workload: w, setting: s, algorithm: a }); return `<td class="num">${fmt(r.faults)}</td><td class="num">${fmt(secretFn(r))}</td>`; }).join("")}</tr>`;
  }
  abl += `</tbody></table>`;

  // overhead scatter
  const ov = ALGOS.map(a => { const r = rowOf(exp, { experiment: "overhead", algorithm: a }); return { label: a, x: r.time_us / Math.max(1, r.faults - r.frames), y: r.faults, color: ALGO_COLOR[a] }; });

  $("#exp-body").innerHTML = `<div class="stack">
    <div class="small faint">Source <code>${esc(exp.meta.command)}</code> · generated ${esc(exp.meta.generated)} · ${fmt(exp.meta.requests_per_workload)} requests per workload · ${exp.rows.length} result rows</div>
    <div class="panel">
      <div class="panel-head"><h2>Algorithm comparison · ${M.label} · ${F.frames} frames</h2>
        <div class="row">${seg("f-frames", frames.map(f => [f, f + " frames"]), F.frames)}${seg("f-metric", Object.keys(METRICS).map(k => [k, METRICS[k].label]), F.metric)}
        <label class="small faint" for="f-base">baseline</label><select id="f-base" style="width:auto">${["FIFO", "LRU", "LFU"].map(b => `<option${b === F.baseline ? " selected" : ""}>${b}</option>`).join("")}</select></div></div>
      <div class="multiples">${mult}</div>
      <div class="legend" style="margin:8px 0 12px"><span><span class="sw" style="background:${ALGO_COLOR.Adaptive}"></span>ADPT = Adaptive (proposed)</span><span><span class="sw" style="background:${ALGO_COLOR.LRU}"></span>FIFO / LRU / LFU = baselines</span><span><span class="sw" style="background:repeating-linear-gradient(45deg,#A6B4A9 0 2px,transparent 2px 4px)"></span>OPT = Optimal, benchmark that knows future requests</span><span>bars start at zero</span></div>
      <div class="table-wrap">${table}</div>
    </div>
    <div class="grid-2">
      <div class="panel">
        <div class="panel-head"><h2>Memory size · ${M.label}</h2>${seg("f-wl", WORKLOADS.map(w => [w, w]), F.workload)}</div>
        ${lineChart({ title: `${F.workload} workload`, series: memSeries, xs: frames, xLabel: "frames in memory", yLabel: M.label, logX: true, w: 620, h: 270, fmtY: M.fmt, yHi: F.metric === "hit_rate" ? 100 : undefined })}
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Decision cost against page faults</h2><span class="note">phased · 8 frames · average of 20 runs</span></div>
        ${scatterChart({ title: "time per eviction vs faults", pts: ov, xLabel: "µs per eviction", yLabel: "page faults", w: 620, h: 270, fmtX: v => v.toFixed(3), fmtY: v => fmt(v) })}
        <p class="small faint">Measured with <code>clock()</code> on this machine, unoptimised build; values change a little between runs. Optimal is fast here only because the simulator already knows the future.</p>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Robustness · seeds 1–10 · 8 frames</h2><span class="note">one dot per seed · bar = mean · lime below zero = better than LRU, ember above = worse</span></div>
      <div class="grid-2">${dotChart({ title: "Page faults, Adaptive vs LRU", cats: WORKLOADS, groups: dotGroups(r => r.faults), yLabel: "change vs LRU", w: 620 })}${dotChart({ title: "S2+S3 evictions, Adaptive vs LRU", cats: WORKLOADS, groups: dotGroups(secretFn), yLabel: "change vs LRU", w: 620 })}</div>
      <div class="table-wrap" style="margin-top:8px">${seedTable}</div>
      <p class="small faint" style="margin-top:6px">Averages of the 10 runs (integer division in sim.c). A seed where neither algorithm evicts a secret page shows as 0% (looping: when no secret page is in the loop).</p>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Sensitive pages: where they are and how many</h2><span class="note">8 frames · ⅓ of sensitive pages are S3</span></div>
      <div class="table-wrap">${place}</div>
      <div class="grid-2" style="margin-top:14px;grid-template-columns:repeat(4,minmax(0,1fr))">
        ${shareChart("phased", r => r.faults, "faults")}${shareChart("phased", secretFn, "S2+S3 evicted")}${shareChart("bursty", r => r.faults, "faults")}${shareChart("bursty", secretFn, "S2+S3 evicted")}
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>What each part adds (ablation)</h2><span class="note">8 frames · default sensitivity labels</span></div>
      <div class="table-wrap">${abl}</div>
      <p class="small faint" style="margin-top:6px">Behaviour gives the fault reduction; security gives the secret-page reduction; feedback trades some protection for fewer faults (and on random workloads relaxes protection with almost no fault gain).</p>
    </div>
  </div>`;
  const bindSeg = (id, key, parse = v => v) => $$(`#${id} button`).forEach(b => b.onclick = () => { F[key] = parse(b.dataset.k); renderExperiments(exp); });
  bindSeg("f-frames", "frames", v => parseInt(v, 10));
  bindSeg("f-metric", "metric");
  bindSeg("f-wl", "workload");
  $("#f-base").onchange = e => { F.baseline = e.target.value; renderExperiments(exp); };
}

/* ================= Methodology ================= */

async function pageMethodology() {
  main.innerHTML = `<div class="page"><div class="page-head"><div><h1>Methodology</h1><p>How the simulator and the Adaptive algorithm work, the parameters it uses (read from <code>./sim --params</code>), and how the results were produced and checked.</p></div></div><div id="meth"><div class="empty">Loading parameters …</div></div></div>`;
  let P;
  try { P = await loadParams(); } catch (e) { $("#meth").innerHTML = errorBox(e.message); return; }
  if (S.page !== "methodology") return;
  const w = P.weights;
  $("#meth").innerHTML = `<div class="stack">
    <div class="panel">
      <div class="panel-head"><h2>Eviction score</h2><span class="note">the page with the highest score is evicted, subject to the security rules</span></div>
      <div class="formula">Score(p) = <span class="hl">${w[0]}</span>·R + <span class="hl">${w[1]}</span>·F + <span class="hl">${w[2]}</span>·B + <span class="hl">${w[3]}</span>·W − <span class="hl">wS</span>·S</div>
      <div class="table-wrap" style="margin-top:12px"><table class="data"><thead><tr><th>Part</th><th>Definition in sim.c</th><th>Range</th><th>Direction</th></tr></thead><tbody>
        <tr><td class="mono">R · recency</td><td>1 − (last use − oldest last use) / (newest − oldest), over the pages in memory</td><td class="mono">0–1</td><td>higher → evict (used longest ago)</td></tr>
        <tr><td class="mono">F · frequency</td><td>1 − uses since loaded / highest uses of any page in memory</td><td class="mono">0–1</td><td>higher → evict (rarely used)</td></tr>
        <tr><td class="mono">B · behaviour</td><td>depends on the detected pattern (below)</td><td class="mono">0–1</td><td>higher → evict</td></tr>
        <tr><td class="mono">W · working set</td><td>1 if not used in the last ${P.ws_window} requests, else 0</td><td class="mono">0 or 1</td><td>higher → evict</td></tr>
        <tr><td class="mono">S · sensitivity</td><td>S0/S1 = 0, S2 = 0.5, S3 = 1; multiplied by ${P.cold_secret} when the page is outside the working set</td><td class="mono">0–1</td><td>subtracted → keep secret pages</td></tr>
      </tbody></table></div>
      <p class="small faint" style="margin-top:8px">Weights were chosen by trying several values and keeping the best balance of faults and secret evictions; most changes made less than 1% difference. They can be changed in the Simulator (Adaptive parameters).</p>
    </div>
    <div class="grid-2">
      <div class="panel">
        <div class="panel-head"><h2>Behaviour detection</h2><span class="note">last ${P.window} requests, checked in this order</span></div>
        <ol class="list"><li><b>Looping</b> if 90% of the requests match the one L steps back, for some L ≤ 16.</li><li><b>Sequential</b> if 80% of the requests go to the next page number.</li><li><b>Bursty</b> if at most 16 different pages are used.</li><li><b>Random</b> otherwise.</li></ol>
        <div class="table-wrap" style="margin-top:10px"><table class="data"><thead><tr><th>Pattern</th><th>B(p)</th><th>Acts like</th></tr></thead><tbody>
          <tr><td>sequential</td><td>recency rank (newest = 1)</td><td>MRU</td></tr><tr><td>looping</td><td>1 if outside the loop, else 0.9 × recency rank</td><td>MRU inside the loop</td></tr>
          <tr><td>bursty</td><td>1 − recency rank</td><td>LRU</td></tr><tr><td>random</td><td>0.5 for every page</td><td>no effect</td></tr></tbody></table></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Security rules and feedback</h2></div>
        <ul class="list">
          <li><b>In-use protection:</b> an S3 page used in the last ${P.ws_window} requests is not considered for eviction. If every page in memory is protected, all pages are considered (memory must be freed).</li>
          <li><b>Secure eviction:</b> every evicted S3 page is counted. In a real kernel this is where the page would be encrypted or zeroed before swap; the simulator only counts it.</li>
          <li><b>Feedback:</b> every ${P.feedback_interval} requests, if the fault rate of those requests is above ${P.high_fault_rate * 100}% then wS −${P.ws_step} (min ${P.ws_min}); below ${P.low_fault_rate * 100}% then wS +${P.ws_step} (max ${P.ws_max}). wS starts at ${P.ws_start}. Protection of in-use S3 pages does not depend on wS.</li>
        </ul>
        <div class="callout" style="margin-top:10px">This project studies which pages are evicted and how often sensitive pages leave memory. It is not a memory-security architecture and gives no guarantee that sensitive data is safe.</div>
      </div>
    </div>
    <div class="grid-2">
      <div class="panel">
        <div class="panel-head"><h2>Sensitivity levels</h2><span class="note">assigned by us, reproducible from the seed</span></div>
        <table class="data"><thead><tr><th>Level</th><th>Class</th><th>Examples</th><th class="num">Default share</th><th>Treatment</th></tr></thead><tbody>
          <tr><td>${sensHTML(0)}</td><td>public</td><td>program code, ordinary data</td><td class="num">70%</td><td>normal</td></tr>
          <tr><td>${sensHTML(1)}</td><td>internal</td><td>non-critical app state</td><td class="num">15%</td><td>normal</td></tr>
          <tr><td>${sensHTML(2)}</td><td>confidential</td><td>user data, sessions</td><td class="num">10%</td><td>S = 0.5 penalty</td></tr>
          <tr><td>${sensHTML(3)}</td><td>top secret</td><td>passwords, keys</td><td class="num">5%</td><td>S = 1, protected while in use</td></tr></tbody></table>
        <p class="small faint" style="margin-top:6px">Experiments 2 and 3 instead make a chosen share of pages sensitive (⅓ S3, rest S2), placed on the most used (hot), middle (warm), least used (cold) or random pages.</p>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Workloads and evaluation</h2></div>
        <ul class="list">
          <li><b>Workloads</b> (64 pages, 5,000 requests by default): sequential scan; looping over 12 pages; random; bursty (90% of requests to 6 pages, the group moves every 50 requests); phased (switches pattern every 500 requests and moves in memory); plus the 25-request textbook string.</li>
          <li><b>Memory sizes:</b> 3, 4, 8, 16, 32 frames. <b>Seed</b> 42 by default; experiment 6 uses seeds 1–10.</li>
          <li><b>Baselines:</b> FIFO, LRU, LFU. <b>Optimal</b> reads future requests: it is the lower bound for faults, not a usable policy.</li>
          <li><b>Metrics:</b> page faults, hit rate, evicted pages per level (S2+S3 = secret evictions), time per eviction (<code>clock()</code>).</li>
          <li><b>Experiments:</b> 1 all workloads and memory sizes · 2 placement of sensitive pages · 3 share of sensitive pages · 4 ablation · 5 running time · 6 ten seeds.</li>
        </ul>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Validation</h2><span class="note">27 automatic checks in <code>./sim --test</code> · implementation checks, not a proof of correctness for every workload</span></div>
      <div class="row" style="margin-bottom:10px">
        <label class="small faint" for="t-seed">Seed</label><input id="t-seed" type="number" value="42" min="0" max="1000000" style="width:100px">
        <button class="btn" id="t-run" type="button">Run checks</button>
        <button class="btn" id="t-sweep" type="button">Run on seeds 1–20 and 42</button>
      </div>
      <div class="grid-2"><div id="t-out"></div><div id="t-sweep-out"></div></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Reproduce</h2></div>
      <div class="formula small" style="white-space:pre;line-height:1.7">gcc -o sim sim.c
./sim --test                 # 27 checks
./sim                        # experiment 1
./sim --experiments          # experiments 2–6
./sim --csv > results.csv    # everything as CSV
python3 plot.py              # report graphs
python3 ui.py                # this workbench</div>
      <p class="small faint" style="margin-top:8px"><b>Limitations:</b> synthetic workloads; one process; no disk or encryption cost modelled; labels assigned by us; timings from user space; not tested inside a kernel.</p>
    </div>
  </div>`;
  $("#t-run").onclick = runChecks;
  $("#t-sweep").onclick = runSweep;
  if (S.tests) renderChecks();
  if (S.seedSweep) renderSweep();
}
async function runChecks() {
  const seed = parseInt($("#t-seed").value, 10);
  if (!(seed >= 0 && seed <= 1000000)) return;
  $("#t-out").innerHTML = `<div class="small muted">Running <code>./sim --test --seed ${seed}</code> …</div>`;
  setState("running", "./sim --test");
  try { S.tests = await api("tests", { seed }); setState("completed"); } catch (e) { setState("error", e.message); $("#t-out").innerHTML = errorBox(e.message); return; }
  renderChecks();
}
function renderChecks() {
  const T = S.tests;
  $("#t-out").innerHTML = `<div class="counters" style="margin-bottom:6px"><span>seed<b>${T.seed}</b></span><span>passed<b class="status-pass">${T.passed}</b></span><span>failed<b class="${T.failed ? "status-fail" : ""}">${T.failed}</b></span></div>
    <div class="check-list"><table class="data"><tbody>${T.checks.map(c => `<tr><td class="status-${c.status.toLowerCase()}">${c.status}</td><td class="small">${esc(c.name)}</td></tr>`).join("")}</tbody></table></div>`;
}
async function runSweep() {
  const seeds = [...Array(20).keys()].map(i => i + 1).concat([42]);
  S.seedSweep = [];
  setState("running", "./sim --test on 21 seeds");
  for (const seed of seeds) {
    try { const r = await api("tests", { seed }); S.seedSweep.push({ seed, passed: r.passed, failed: r.failed }); }
    catch (e) { S.seedSweep.push({ seed, error: e.message }); }
    if (S.page === "methodology") renderSweep();
  }
  setState(S.seedSweep.some(r => r.failed || r.error) ? "error" : "completed");
}
function renderSweep() {
  const R = S.seedSweep, ok = R.filter(r => r.failed === 0 && !r.error).length;
  $("#t-sweep-out").innerHTML = `<div class="counters" style="margin-bottom:6px"><span>seeds run<b>${R.length}</b></span><span>all checks passed<b class="status-pass">${ok}</b></span><span>with failures<b>${R.length - ok}</b></span></div>
    <div class="check-list"><table class="data"><thead><tr><th class="num">Seed</th><th class="num">Passed</th><th class="num">Failed</th></tr></thead><tbody>${R.map(r => `<tr><td class="num">${r.seed}</td><td class="num">${r.error ? "—" : r.passed}</td><td class="num ${r.failed || r.error ? "status-fail" : ""}">${r.error ? esc(r.error) : r.failed}</td></tr>`).join("")}</tbody></table></div>`;
}

/* ================= export ================= */

function exportData(kind) {
  const stamp = new Date().toISOString();
  if ((S.page === "simulator" || S.page === "inspector") && S.trace) {
    const c = S.traceConfig, tr = S.trace;
    const name = runId(c).replace(/[^\w.-]+/g, "_");
    if (kind === "json") {
      const { cumFaults, cumSecret, evictions, n, ...raw } = tr;
      return download(name + ".json", JSON.stringify({ meta: { exported: stamp, command: simCommand(c), source: "sim.c via ui.py" }, config: c, compare: S.compare, trace: raw }, null, 1), "application/json");
    }
    let csv = `# exported ${stamp}\n# command: ${simCommand(c)}\n# faults ${tr.faults}, hits ${tr.hits}, evicted S0-S3 ${tr.evicted.join("/")}\n`;
    csv += "request,page,sensitivity,hit,frame,evicted_page,evicted_sensitivity,detected_pattern,security_changed_choice,all_protected\n";
    tr.events.forEach((e, t) => {
      csv += [t, tr.refs[t], tr.sens[tr.refs[t]], e[0], e[1], e[2], e[2] >= 0 ? tr.sens[e[2]] : "", PATTERNS[e[3]], (e[4] & 2) ? 1 : 0, (e[4] & 1) ? 1 : 0].join(",") + "\n";
    });
    return download(name + ".csv", csv, "text/csv");
  }
  const seed = S.page === "experiments" ? S.expSeed : 42;
  const exp = S.experiments[seed];
  if (S.page === "methodology" && S.params) {
    return download("aspr_parameters.json", JSON.stringify({ meta: { exported: stamp, command: "./sim --params" }, params: S.params, tests: S.tests, seed_sweep: S.seedSweep }, null, 1), "application/json");
  }
  if (!exp) return alert("Nothing to export yet: run a simulation or open Experiments first.");
  if (kind === "json") return download(`experiments_seed${seed}.json`, JSON.stringify(exp, null, 1), "application/json");
  const cols = Object.keys(exp.rows[0]);
  let csv = `# exported ${stamp}\n# command: ${exp.meta.command}\n# generated ${exp.meta.generated}\n` + cols.join(",") + "\n";
  for (const r of exp.rows) csv += cols.map(k => r[k]).join(",") + "\n";
  download(`experiments_seed${seed}.csv`, csv, "text/csv");
}
$("#export-json").onclick = () => exportData("json");
$("#export-csv").onclick = () => exportData("csv");

/* ================= keyboard ================= */

document.addEventListener("keydown", e => {
  const typing = e.target.matches("input, select, textarea");
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  const pages = ["overview", "simulator", "experiments", "inspector", "methodology"];
  if (/^[1-5]$/.test(e.key)) { location.hash = "#" + pages[+e.key - 1]; return; }
  if (!S.trace || (S.page !== "simulator" && S.page !== "inspector")) return;
  if (e.key === "ArrowRight") { e.preventDefault(); setT(S.t + 1); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); setT(S.t - 1); }
  else if (e.key === " " && S.page === "simulator") { e.preventDefault(); S.playing ? pause() : play(); }
  else if (e.key === "e" || e.key === "E") nextWhere(isEviction);
  else if (e.key === "s" || e.key === "S") nextWhere(isSecurity);
});

setState("ready");
route();
