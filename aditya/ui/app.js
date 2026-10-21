"use strict";
/*
 * Front end for sim.c (served by ui.py).
 * Every number shown comes from ./sim through /api/... . This file only replays the
 * recorded run (which page sits in which frame), adds up / compares simulator
 * output, and draws it.
 */

/* ================= constants ================= */

const ALGOS = ["FIFO", "LRU", "LFU", "Optimal", "Adaptive"];
const COLOR = { FIFO: "var(--c-fifo)", LRU: "var(--c-lru)", LFU: "var(--c-lfu)", Optimal: "var(--c-opt)", Adaptive: "var(--c-adpt)" };
const WORKLOADS = ["sequential", "looping", "random", "bursty", "phased"];
const PATTERNS = ["classic", "sequential", "looping", "random", "bursty", "phased"]; // index = code in sim.c
const WL_LABEL = {
  phased: "Phased (changes over time)", looping: "Looping", sequential: "Sequential scan",
  bursty: "Bursty", random: "Random", classic: "Textbook example (25 requests)",
};
const SENS_NAME = ["S0 public", "S1 internal", "S2 confidential", "S3 top secret"];
const DEFAULT_CONFIG = {
  algo: "Adaptive", workload: "phased", frames: 8, length: 5000, seed: 42,
  sensitivity: "default", percent: 15, weights: [0.2, 0.2, 1.0, 0.3],
  security: true, behaviour: true, feedback: true,
};

/* ================= state ================= */

const S = {
  page: "overview",
  params: null,
  experiments: {},            // by seed
  dataset: {},                // by seed: { workload: trace }
  ovMetric: "faults",
  demo: { config: clone(DEFAULT_CONFIG), runConfig: null, trace: null, t: 0, playing: false, timer: null, speed: 20, cache: {}, open: null, more: false },
  cmp: { workload: "phased", frames: 8, data: null, runFor: null },
  res: { tab: "all", metric: "faults", frames: 8, seed: 42 },
  tests: null,
};

/* ================= helpers ================= */

function clone(o) { return JSON.parse(JSON.stringify(o)); }
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (n, d = 0) => Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const sum = a => a.reduce((x, y) => x + y, 0);
const secret = r => r.evict_s2 + r.evict_s3;

function change(v, base) { return base === 0 ? (v === 0 ? 0 : Infinity) : (v - base) / base * 100; }
function pct(d, lowerIsBetter = true) {
  if (!isFinite(d)) return '<span class="faint">n/a</span>';
  const t = (d > 0 ? "+" : d < 0 ? "−" : "±") + Math.abs(d).toFixed(1) + "%";
  if (Math.abs(d) < 0.05) return `<span class="muted">${t}</span>`;
  return `<span class="${(lowerIsBetter ? d < 0 : d > 0) ? "good" : "bad"}">${t}</span>`;
}
function sens(l) { return `<span class="sens" data-l="${l}" title="${SENS_NAME[l]}">S${l}<span class="bars" aria-hidden="true"><i></i><i></i><i></i></span></span>`; }
function errorBox(m) { return `<div class="error-box" role="alert">${esc(m)}</div>`; }
function setState(state, title) {
  const el = $("#state");
  el.dataset.state = state;
  el.textContent = { ready: "Ready", running: "Running…", completed: "Done", error: "Error" }[state];
  el.title = title || "";
}

async function api(path, params = {}) {
  const res = await fetch(`/api/${path}?${new URLSearchParams(params)}`);
  let body;
  try { body = await res.json(); } catch (e) { throw new Error(`/api/${path} gave no answer (${res.status}). Is ui.py running?`); }
  if (!res.ok || body.error) throw new Error(body.error || res.statusText);
  return body;
}
async function busy(label, fn) {
  setState("running", label);
  try { const r = await fn(); setState("completed", label); return r; }
  catch (e) { setState("error", e.message); throw e; }
}
function cfgParams(c) {
  return {
    algo: c.algo, workload: c.workload, frames: c.frames, length: c.length, seed: c.seed,
    sensitivity: c.sensitivity, percent: c.percent, weights: c.weights.join(","),
    security: c.security ? 1 : 0, behaviour: c.behaviour ? 1 : 0, feedback: c.feedback ? 1 : 0,
  };
}
function cfgKey(c) { return JSON.stringify(cfgParams(c)); }
function command(c) {
  let s = `./sim --trace --algo ${c.algo} --workload ${c.workload} --frames ${c.frames} --length ${c.length} --seed ${c.seed}`;
  if (c.sensitivity !== "default") s += ` --place ${c.sensitivity} --percent ${c.percent}`;
  if (c.algo === "Adaptive") {
    if (c.weights.join() !== DEFAULT_CONFIG.weights.join()) s += ` --weights ${c.weights.join(",")}`;
    if (!c.security) s += " --no-security";
    if (!c.behaviour) s += " --no-behaviour";
    if (!c.feedback) s += " --no-feedback";
  }
  return s;
}
function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function getParams() { if (!S.params) S.params = await api("params"); return S.params; }
async function getExperiments(seed) {
  if (!S.experiments[seed]) S.experiments[seed] = await busy("./sim --csv", () => api("experiments", { seed }));
  return S.experiments[seed];
}
const rowsOf = (exp, f) => exp.rows.filter(r => Object.keys(f).every(k => r[k] === f[k]));
const rowOf = (exp, f) => rowsOf(exp, f)[0];

/* ================= tooltip ================= */

const tip = $("#tooltip");
document.addEventListener("mouseover", e => {
  const el = e.target.closest("[data-tip]");
  if (el) { tip.textContent = el.dataset.tip; tip.hidden = false; }
});
document.addEventListener("mousemove", e => {
  if (tip.hidden) return;
  tip.style.left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8) + "px";
  tip.style.top = Math.min(e.clientY + 14, innerHeight - tip.offsetHeight - 8) + "px";
});
document.addEventListener("mouseout", e => {
  const to = e.relatedTarget;
  if (e.target.closest("[data-tip]") && !(to && to.closest && to.closest("[data-tip]"))) tip.hidden = true;
});

/* ================= charts (SVG) ================= */

let svgId = 0;
function niceDomain(lo, hi, n = 4) {
  if (hi === lo) hi = lo + 1;
  const raw = (hi - lo) / n, p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p, step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
}
function ticks(d) { const t = []; for (let v = d.lo; v <= d.hi + d.step / 2; v += d.step) t.push(Math.round(v * 1e6) / 1e6); return t; }
function short(v) { return Math.abs(v) >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + "k" : String(Math.round(v * 100) / 100); }
function topRounded(x, y, w, h, r) {
  if (h <= 0) return "";
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

// bars from zero, one per category; values printed above the bars when showValues
function barChart({ title, cats, labels, vals, colors, hatched = [], tips, fmtV = fmt, yMax, w = 300, h = 220, showValues = false, yLabel }) {
  const id = "h" + (++svgId);
  const m = { t: showValues ? 40 : 30, r: 6, b: 30, l: 42 };
  const iw = w - m.l - m.r, ih = h - m.t - m.b;
  const d = niceDomain(0, Math.max(yMax ?? Math.max(...vals), 1));
  const y = v => m.t + ih - v / d.hi * ih;
  const band = iw / cats.length, bw = Math.min(36, band * 0.6);
  let s = `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}: ${cats.map((c, i) => `${c} ${fmtV(vals[i])}`).join(", ")}">`;
  s += `<defs><pattern id="${id}" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><rect width="2.6" height="6" style="fill:var(--c-opt)"/></pattern></defs>`;
  s += `<text class="title" x="0" y="15">${esc(title)}</text>`;
  if (yLabel) s += `<text x="${w}" y="15" text-anchor="end" style="font-size:11px;fill:var(--text-3)">${esc(yLabel)}</text>`;
  for (const v of ticks(d)) s += `<g class="tick"><line class="grid" x1="${m.l}" x2="${w - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${short(v)}</text></g>`;
  cats.forEach((c, i) => {
    const x = m.l + i * band + (band - bw) / 2, top = y(vals[i]);
    const fill = hatched.includes(c) ? `url(#${id})` : colors[i];
    s += `<g data-tip="${esc(tips ? tips[i] : `${c}: ${fmtV(vals[i])}`)}"><rect class="hit" x="${m.l + i * band}" y="${m.t - 20}" width="${band}" height="${ih + 20}"/>`;
    s += `<path d="${topRounded(x, top, bw, m.t + ih - top, 4)}" style="fill:${fill};${hatched.includes(c) ? "stroke:var(--c-opt);stroke-width:1" : ""}"/></g>`;
    if (showValues) s += `<text class="val" x="${x + bw / 2}" y="${top - 6}" text-anchor="middle">${esc(fmtV(vals[i]))}</text>`;
    s += `<text class="lab" x="${m.l + i * band + band / 2}" y="${h - m.b + 18}" text-anchor="middle">${esc(labels ? labels[i] : c)}</text>`;
  });
  s += `<line class="axis" x1="${m.l}" x2="${w - m.r}" y1="${m.t + ih}" y2="${m.t + ih}"/>`;
  return s + "</svg>";
}

// lines with labels at their right end
function lineChart({ title, series, xs, xLabel, yLabel, w = 620, h = 280, logX = false, fmtY = fmt, fmtX = v => v, yHi }) {
  const m = { t: 30, r: 96, b: 40, l: 50 };
  const iw = w - m.l - m.r, ih = h - m.t - m.b;
  const ys = series.flatMap(s => s.pts.map(p => p[1]));
  const d = niceDomain(0, yHi ?? Math.max(...ys, 1));
  const x0 = Math.min(...xs), x1 = Math.max(...xs), fx = v => (logX ? Math.log2(v) : v);
  const x = v => m.l + (x1 === x0 ? 0 : (fx(v) - fx(x0)) / (fx(x1) - fx(x0)) * iw);
  const y = v => m.t + ih - (v - d.lo) / (d.hi - d.lo) * ih;
  let s = `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">`;
  s += `<text class="title" x="0" y="15">${esc(title)}</text>`;
  if (yLabel) s += `<text x="${w}" y="15" text-anchor="end" style="font-size:11px;fill:var(--text-3)">${esc(yLabel)}</text>`;
  for (const v of ticks(d)) s += `<g class="tick"><line class="grid" x1="${m.l}" x2="${m.l + iw}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${short(v)}</text></g>`;
  const xt = xs.length > 10 ? xs.filter((_, i) => i % Math.ceil(xs.length / 6) === 0) : xs;
  for (const v of xt) s += `<g class="tick"><text x="${x(v)}" y="${m.t + ih + 16}" text-anchor="middle">${esc(fmtX(v))}</text></g>`;
  s += `<line class="axis" x1="${m.l}" x2="${m.l + iw}" y1="${m.t + ih}" y2="${m.t + ih}"/>`;
  if (xLabel) s += `<text x="${m.l + iw / 2}" y="${h - 4}" text-anchor="middle" style="font-size:11px;fill:var(--text-3)">${esc(xLabel)}</text>`;
  const ends = series.map(se => ({ se, y: y(se.pts[se.pts.length - 1][1]) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  for (const se of series) {
    s += `<path d="${se.pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("")}" style="fill:none;stroke:${se.color};stroke-width:${se.width || 2};${se.dash ? `stroke-dasharray:${se.dash}` : ""}"/>`;
    if (se.points !== false) for (const p of se.pts) {
      s += `<g data-tip="${esc(`${se.name}\n${xLabel || "x"}: ${fmtX(p[0])}\n${yLabel || "y"}: ${fmtY(p[1])}`)}"><circle class="hit" cx="${x(p[0])}" cy="${y(p[1])}" r="10"/><circle cx="${x(p[0])}" cy="${y(p[1])}" r="4" style="fill:${se.color};stroke:var(--surface);stroke-width:2"/></g>`;
    }
  }
  for (const e of ends) s += `<text class="lab" x="${m.l + iw + 8}" y="${e.y + 4}" style="fill:${e.se.color}">${esc(e.se.label || e.se.name)}</text>`;
  return s + "</svg>";
}

// one dot per seed, a bar for the mean, a zero line
function dotChart({ title, cats, groups, w = 620, h = 260 }) {
  const m = { t: 30, r: 10, b: 32, l: 54 };
  const iw = w - m.l - m.r, ih = h - m.t - m.b;
  const all = groups.flatMap(g => g.vals.map(v => v.v)).concat([0]);
  const d = niceDomain(Math.min(...all), Math.max(...all));
  const y = v => m.t + ih - (v - d.lo) / (d.hi - d.lo) * ih;
  const band = iw / cats.length;
  let s = `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">`;
  s += `<text class="title" x="0" y="15">${esc(title)}</text><text x="${w}" y="15" text-anchor="end" style="font-size:11px;fill:var(--text-3)">change against LRU</text>`;
  for (const v of ticks(d)) s += `<g class="tick"><line class="grid" x1="${m.l}" x2="${w - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${v > 0 ? "+" : ""}${short(v)}%</text></g>`;
  s += `<line x1="${m.l}" x2="${w - m.r}" y1="${y(0)}" y2="${y(0)}" style="stroke:var(--text-3)"/>`;
  groups.forEach((g, i) => {
    const cx = m.l + i * band + band / 2;
    g.vals.forEach((v, j) => {
      const jx = cx + ((j % 5) - 2) * 7;
      s += `<g data-tip="${esc(v.tip)}"><circle class="hit" cx="${jx}" cy="${y(v.v)}" r="9"/><circle cx="${jx}" cy="${y(v.v)}" r="4.5" style="fill:${v.v > 0 ? "var(--ember)" : "var(--accent)"};stroke:var(--surface);stroke-width:1.5"/></g>`;
    });
    s += `<line x1="${cx - 20}" x2="${cx + 20}" y1="${y(g.mean)}" y2="${y(g.mean)}" style="stroke:var(--text);stroke-width:2.5"/>`;
    s += `<text class="lab" x="${cx}" y="${h - m.b + 18}" text-anchor="middle">${esc(cats[i])}</text>`;
  });
  return s + "</svg>";
}

// a memory trace: request number on x, page number on y
function traceChart({ title, refs, npages, n, w = 420, h = 200 }) {
  const m = { t: 28, r: 8, b: 28, l: 34 };
  const iw = w - m.l - m.r, ih = h - m.t - m.b;
  const x = i => m.l + i / Math.max(1, n - 1) * iw, y = p => m.t + ih - p / Math.max(1, npages - 1) * ih;
  let s = `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}: page number for each of the first ${n} requests">`;
  s += `<text class="title" x="0" y="15">${esc(title)}</text>`;
  for (const p of [0, Math.round((npages - 1) / 2), npages - 1]) s += `<g class="tick"><line class="grid" x1="${m.l}" x2="${w - m.r}" y1="${y(p)}" y2="${y(p)}"/><text x="${m.l - 6}" y="${y(p) + 4}" text-anchor="end">${p}</text></g>`;
  let dots = "";
  for (let i = 0; i < n; i++) dots += `M${x(i).toFixed(1)},${y(refs[i]).toFixed(1)}h1.6v1.6h-1.6z`;
  s += `<path d="${dots}" style="fill:var(--steel)"/>`;
  s += `<g class="tick"><text x="${m.l}" y="${h - 8}">0</text><text x="${w - m.r}" y="${h - 8}" text-anchor="end">${fmt(n)}</text><text x="${m.l + iw / 2}" y="${h - 8}" text-anchor="middle" style="fill:var(--text-3)">request number →</text></g>`;
  s += `<text x="10" y="${m.t + ih / 2}" transform="rotate(-90 10 ${m.t + ih / 2})" text-anchor="middle" style="font-size:11px;fill:var(--text-3)">page</text>`;
  return s + "</svg>";
}

/* ================= router ================= */

const PAGES = { overview: pageOverview, dataset: pageDataset, demo: pageDemo, compare: pageCompare, results: pageResults, how: pageHow };
const ORDER = ["overview", "dataset", "demo", "compare", "results", "how"];
const main = $("#main");

function hashParams() {
  const h = location.hash.slice(1), i = h.indexOf("?");
  return i < 0 ? {} : Object.fromEntries(new URLSearchParams(h.slice(i + 1)));
}
function route() {
  const name = (location.hash || "#overview").slice(1).split("?")[0];
  S.page = PAGES[name] ? name : "overview";
  $$(".tabs a").forEach(a => (a.dataset.page === S.page ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  if (S.page !== "demo") pause();
  tip.hidden = true;
  window.scrollTo(0, 0);
  PAGES[S.page]();
}
window.addEventListener("hashchange", route);

/* ================= Overview ================= */

async function pageOverview() {
  main.innerHTML = `<div class="page">
    <section class="hero">
      <div>
        <h1>When memory is full, which page should leave?</h1>
        <p class="lead">Classic algorithms (FIFO, LRU, LFU) decide using one thing, such as age. Our <b>Adaptive</b> algorithm also looks at <b>what the program is doing right now</b> and <b>how secret each page is</b>, and gives every page one score. The page with the highest score leaves.</p>
      </div>
      <div id="ov-formula"></div>
    </section>
    <section class="card" id="ov-head"><div class="loading">Running the simulator (./sim --csv) …</div></section>
    <section class="card" id="ov-chart"></section>
    <div class="cta"><a class="btn btn-primary btn-big" href="#demo">Start the live demo →</a><a class="btn btn-big" href="#dataset">What data we use</a></div>
  </div>`;
  getParams().then(P => {
    if (S.page !== "overview") return;
    $("#ov-formula").innerHTML = `<div class="formula">Score = <span class="hl">${P.weights[0]}</span>·R + <span class="hl">${P.weights[1]}</span>·F + <span class="hl">${P.weights[2]}</span>·B + <span class="hl">${P.weights[3]}</span>·W − <span class="hl">w<sub>S</sub></span>·S</div>
      <div class="formula-legend"><b>R</b><span>recency: not used for a long time</span><b>F</b><span>frequency: rarely used</span><b>B</b><span>behaviour: what the current access pattern says</span><b>W</b><span>working set: not used in the last ${P.ws_window} requests</span><b>S</b><span>sensitivity: how secret the page is (keeps it)</span></div>`;
  }).catch(() => {});

  let exp;
  try { exp = await getExperiments(42); } catch (e) { $("#ov-head").innerHTML = errorBox(e.message); return; }
  if (S.page !== "overview") return;

  const main25 = exp.rows.filter(r => r.experiment === "main" && r.workload !== "classic");
  const tot = (a, f) => sum(main25.filter(r => r.algorithm === a).map(f));
  const perEv = a => { const r = rowOf(exp, { experiment: "overhead", algorithm: a }); return r.time_us / Math.max(1, r.faults - r.frames); };
  const nums = [
    ["page faults", r => r.faults], ["secret pages evicted (S2 + S3)", secret], ["top-secret pages evicted (S3)", r => r.evict_s3],
  ].map(([what, f]) => ({ what, l: tot("LRU", f), a: tot("Adaptive", f) }));
  const seedFaults = a => rowOf(exp, { experiment: "seeds", workload: "bursty", setting: "avg-10", algorithm: a }).faults;
  const perSeed = rowsOf(exp, { experiment: "seeds", workload: "bursty", algorithm: "LRU" }).filter(r => r.setting.startsWith("seed-"))
    .map(r => change(rowOf(exp, { experiment: "seeds", workload: "bursty", setting: r.setting, algorithm: "Adaptive" }).faults, r.faults));

  $("#ov-head").innerHTML = `<div class="card-head"><h2>Results: Adaptive against LRU</h2><span class="note">25 tests (5 workloads × 5 memory sizes), 5,000 requests each, seed 42 · simulator results</span></div>
    <div class="headline">
      ${nums.map(n => `<div class="num" data-tip="${esc(`LRU: ${fmt(n.l)}\nAdaptive: ${fmt(n.a)}`)}"><div class="big">−${Math.abs(Math.round(change(n.a, n.l)))}%</div><div class="what">${n.what}</div><div class="vs">${fmt(n.l)} → ${fmt(n.a)}</div></div>`).join("")}
      <div class="cost"><h3>What it costs</h3><ul>
        <li>Each decision is about <b>${Math.round(perEv("Adaptive") / perEv("LRU"))}× slower</b> than LRU (${perEv("Adaptive").toFixed(2)} µs vs ${perEv("LRU").toFixed(2)} µs, measured now)</li>
        <li>Bursty workloads: <b>${pct(change(seedFaults("Adaptive"), seedFaults("LRU")))}</b> faults on average over 10 seeds, worst seed ${pct(Math.max(...perSeed))}</li>
      </ul></div>
    </div>`;

  const drawChart = () => {
    const metric = S.ovMetric === "faults" ? { f: r => r.faults, label: "Page faults" } : { f: secret, label: "Secret pages evicted" };
    const algos = ["LRU", "Optimal", "Adaptive"];
    const charts = WORKLOADS.map(wl => {
      const vals = algos.map(a => metric.f(rowOf(exp, { experiment: "main", workload: wl, frames: 8, algorithm: a })));
      return barChart({ title: wl, cats: algos, vals, colors: algos.map(a => COLOR[a]), hatched: ["Optimal"], showValues: true, w: 240, h: 230,
        tips: algos.map((a, i) => `${wl}, 8 frames\n${a}${a === "Optimal" ? " (knows the future)" : ""}\n${metric.label}: ${fmt(vals[i])}`) });
    }).join("");
    $("#ov-chart").innerHTML = `<div class="card-head"><h2>Per workload, 8 frames · lower is better</h2>
        <div class="seg" id="ov-metric"><button type="button" data-k="faults" aria-pressed="${S.ovMetric === "faults"}">Page faults</button><button type="button" data-k="secret" aria-pressed="${S.ovMetric === "secret"}">Secret pages evicted</button></div></div>
      <div class="multiples">${charts}</div>
      <div class="legend" style="margin-top:12px"><span><span class="sw" style="background:var(--c-adpt)"></span>Adaptive (ours)</span><span><span class="sw" style="background:var(--c-lru)"></span>LRU (most common classic algorithm)</span><span><span class="sw" style="background:repeating-linear-gradient(45deg,var(--c-opt) 0 2px,transparent 2px 5px);border:1px solid var(--c-opt)"></span>Optimal: knows future requests, so it is only a best-possible reference</span></div>`;
    $$("#ov-metric button").forEach(b => (b.onclick = () => { S.ovMetric = b.dataset.k; drawChart(); }));
  };
  drawChart();
}

/* ================= Dataset ================= */

async function getDataset(seed) {
  if (!S.dataset[seed]) {
    S.dataset[seed] = await busy("generating the workloads", async () => {
      const out = {};
      for (const wl of WORKLOADS) out[wl] = await api("run", { algo: "LRU", workload: wl, frames: 8, length: 5000, seed });
      return out;
    });
  }
  return S.dataset[seed];
}

async function pageDataset() {
  main.innerHTML = `<div class="page">
    <div class="page-title"><h1>Dataset: where the data comes from</h1>
      <p>We do not use a downloaded dataset. The simulator <b>generates its own memory-access traces</b>: lists of page requests, like the ones a real program makes. This gives us full control, a known correct answer for every pattern, and the same data for every algorithm.</p></div>
    <div class="two">
      <section class="card">
        <div class="card-head"><h2>What one data point is</h2></div>
        <p class="muted">A <b>workload</b> is a list of <b>5,000 page requests</b> over <b>64 pages</b> (page numbers 0 to 63). Every page also gets a <b>sensitivity label</b> from S0 (public) to S3 (top secret).</p>
        <pre class="cmd" id="ds-sample">loading …</pre>
        <p class="small faint" style="margin-top:8px">First requests of the phased workload, seed 42, straight from the simulator.</p>
      </section>
      <section class="card">
        <div class="card-head"><h2>How we get it</h2></div>
        <ol class="worse">
          <li><b>Generated by the simulator</b> (<code>make_workload()</code> in <code>sim.c</code>) with C's <code>rand()</code>.</li>
          <li><b>Fixed seed</b> (42 by default; 1 to 10 for the robustness test). The same seed always gives exactly the same data, so every result can be reproduced.</li>
          <li><b>Five access patterns</b> that copy how real programs use memory (table below), plus the 25-request textbook example to check the simulator.</li>
          <li><b>Sensitivity labels</b> are assigned by us: 70% S0, 15% S1, 10% S2, 5% S3 at random, or in experiments a chosen share placed on the most used, middle or least used pages.</li>
          <li>Every algorithm is run on the <b>same</b> list, so differences come from the algorithm, not the data.</li>
        </ol>
      </section>
    </div>
    <section class="card" id="ds-patterns"><div class="loading">Generating the five workloads with ./sim …</div></section>
    <section class="card">
      <div class="card-head"><h2>Why generated data, and its limits</h2></div>
      <div class="two" style="gap:32px">
        <ul class="worse">
          <li><b>Known answer:</b> we know which pattern each part of the data has, so we can check the pattern detector (97–100% correct).</li>
          <li><b>Control:</b> we can change one thing at a time: memory size, how many pages are secret, and where the secret pages are.</li>
          <li><b>Reproducible:</b> anyone can regenerate the exact data from the seed.</li>
          <li><b>No real secrets needed:</b> public memory traces do not say which pages hold secret data.</li>
        </ul>
        <ul class="worse">
          <li><b>Limit:</b> the traces are synthetic. Real programs mix patterns in less regular ways.</li>
          <li><b>Limit:</b> sensitivity labels are assigned by us, not by real applications.</li>
          <li><b>Next step:</b> record real traces, for example with Valgrind's Lackey tool (<code>valgrind --tool=lackey --trace-mem=yes</code>), and feed them to the simulator.</li>
        </ul>
      </div>
    </section>
  </div>`;
  let ds;
  try { ds = await getDataset(42); } catch (e) { $("#ds-patterns").innerHTML = errorBox(e.message); return; }
  if (S.page !== "dataset") return;
  const ph = ds.phased;
  $("#ds-sample").textContent = "request:" + ph.refs.slice(0, 16).map((_, i) => String(i).padStart(4)).join("") + "\npage:   " + ph.refs.slice(0, 16).map(p => String(p).padStart(4)).join("") + "\nlabel:  " + ph.refs.slice(0, 16).map(p => ("S" + ph.sens[p]).padStart(4)).join("");

  const rule = {
    sequential: "Goes through all 64 pages in order, again and again (like reading a file).",
    looping: "Repeats the same 12 pages (like a for loop over an array).",
    random: "Any of the 64 pages, chosen at random.",
    bursty: "90% of requests go to a group of 6 pages; the group moves every 50 requests.",
    phased: "Switches between the four patterns every 500 requests, in a different part of memory.",
  };
  let rows = "";
  for (const wl of WORKLOADS) {
    const t = ds[wl], used = new Set(t.refs).size;
    const counts = [0, 1, 2, 3].map(l => t.sens.filter(v => v === l).length);
    rows += `<tr><td><b>${wl}</b></td><td class="muted">${rule[wl]}</td><td class="num">${fmt(t.refs.length)}</td><td class="num">${used}</td><td class="num">${counts.join(" / ")}</td></tr>`;
  }
  const plots = WORKLOADS.map(wl => traceChart({ title: wl, refs: ds[wl].refs, npages: 64, n: 1000, w: 300, h: 200 })).join("");
  $("#ds-patterns").innerHTML = `<div class="card-head"><h2>The five workloads</h2><span class="note">each dot is one request: request number → page number (first 1,000 requests, seed 42)</span></div>
    <div class="multiples">${plots}</div>
    <div class="table-wrap" style="margin-top:20px"><table class="data"><thead><tr><th>Workload</th><th>How it is generated</th><th class="num">Requests</th><th class="num">Pages used</th><th class="num">Pages S0 / S1 / S2 / S3</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="row" style="margin-top:14px"><span class="small faint">Generated by <code>./sim --trace --workload &lt;name&gt; --length 5000 --seed 42</code></span><span class="spacer"></span><button class="btn" id="ds-dl" type="button">Download the dataset (CSV)</button></div>`;
  $("#ds-dl").onclick = () => {
    let csv = `# generated by sim.c (make_workload), seed 42, 5000 requests per workload, 64 pages\nworkload,request,page,sensitivity\n`;
    for (const wl of WORKLOADS) ds[wl].refs.forEach((p, i) => { csv += `${wl},${i},${p},S${ds[wl].sens[p]}\n`; });
    download("dataset_seed42.csv", csv, "text/csv");
  };
}

/* ================= Live demo ================= */

function demoConfigHTML(c) {
  const opt = (v, cur, l) => `<option value="${v}"${String(v) === String(cur) ? " selected" : ""}>${esc(l || v)}</option>`;
  const isA = c.algo === "Adaptive";
  return `<div class="config">
      <div class="field"><label for="d-wl">Workload</label><select id="d-wl">${["phased", "looping", "sequential", "bursty", "random", "classic"].map(w => opt(w, c.workload, WL_LABEL[w])).join("")}</select></div>
      <div class="field" style="min-width:110px"><label for="d-fr">Memory</label><select id="d-fr">${[3, 4, 8, 16, 32].map(f => opt(f, c.frames, f + " frames")).join("")}</select></div>
      <div class="field"><label for="d-al">Algorithm</label><select id="d-al">${["Adaptive", "LRU", "FIFO", "LFU", "Optimal"].map(a => opt(a, c.algo, a === "Adaptive" ? "Adaptive (ours)" : a === "Optimal" ? "Optimal (knows the future)" : a)).join("")}</select></div>
      <button class="btn btn-primary btn-big" id="d-run" type="button">Run</button>
      <span class="spacer"></span>
      <button class="btn-link" id="d-more" type="button" aria-expanded="${S.demo.more}">${S.demo.more ? "Hide" : "More"} settings</button>
    </div>
    <div class="more" ${S.demo.more ? "" : "hidden"}>
      <div class="field"><label for="d-len">Requests</label><input id="d-len" type="number" min="10" max="5000" step="10" value="${c.length}"${c.workload === "classic" ? " disabled" : ""}></div>
      <div class="field"><label for="d-seed">Seed</label><input id="d-seed" type="number" min="0" max="1000000" value="${c.seed}"></div>
      <div class="field"><label for="d-sens">Secret pages</label><select id="d-sens">${opt("default", c.sensitivity, "default mix (70/15/10/5%)")}${["random", "hot", "warm", "cold"].map(p => opt(p, c.sensitivity, `${p === "hot" ? "most used" : p === "cold" ? "least used" : p === "warm" ? "middle" : "random"} pages`)).join("")}</select></div>
      <div class="field"><label for="d-pct">Share secret (%)</label><input id="d-pct" type="number" min="0" max="100" value="${c.percent}"${c.sensitivity === "default" ? " disabled" : ""}></div>
      <div class="field wide"><span class="label">Adaptive weights wR · wF · wB · wW</span><div class="weights">${c.weights.map((w, i) => `<input type="number" step="0.1" min="0" max="10" value="${w}" data-w="${i}" aria-label="${["wR", "wF", "wB", "wW"][i]}"${isA ? "" : " disabled"}>`).join("")}</div></div>
      <div class="field wide"><span class="label">Adaptive parts</span><div class="toggles">
        <label class="check"><input type="checkbox" id="d-sec"${c.security ? " checked" : ""}${isA ? "" : " disabled"}>Security (protect secret pages)</label>
        <label class="check"><input type="checkbox" id="d-beh"${c.behaviour ? " checked" : ""}${isA ? "" : " disabled"}>Behaviour detection</label>
        <label class="check"><input type="checkbox" id="d-fb"${c.feedback ? " checked" : ""}${isA ? "" : " disabled"}>Feedback on the security weight</label></div></div>
    </div>`;
}
function readDemoConfig() {
  const c = S.demo.config;
  c.workload = $("#d-wl").value;
  c.frames = +$("#d-fr").value;
  c.algo = $("#d-al").value;
  c.length = parseInt($("#d-len").value, 10);
  c.seed = parseInt($("#d-seed").value, 10);
  c.sensitivity = $("#d-sens").value;
  c.percent = parseInt($("#d-pct").value, 10);
  c.weights = $$("[data-w]").map(i => parseFloat(i.value));
  c.security = $("#d-sec").checked;
  c.behaviour = $("#d-beh").checked;
  c.feedback = $("#d-fb").checked;
}
function validate(c) {
  if (!(c.length >= 10 && c.length <= 5000)) return "Requests must be between 10 and 5,000.";
  if (!(c.seed >= 0 && c.seed <= 1000000)) return "Seed must be between 0 and 1,000,000.";
  if (!(c.percent >= 0 && c.percent <= 100)) return "Share secret must be between 0 and 100.";
  if (c.weights.some(w => !(w >= 0 && w <= 10))) return "Weights must be between 0 and 10.";
  return null;
}
function bindDemoConfig() {
  $("#d-config").innerHTML = demoConfigHTML(S.demo.config);
  const redraw = () => { readDemoConfig(); bindDemoConfig(); };
  ["#d-wl", "#d-al", "#d-sens"].forEach(s => ($(s).onchange = redraw));
  $("#d-more").onclick = () => { readDemoConfig(); S.demo.more = !S.demo.more; bindDemoConfig(); };
  $("#d-run").onclick = () => { readDemoConfig(); runDemo(); };
}

async function runDemo() {
  const c = S.demo.config, err = validate(c);
  if (err) { $("#d-msg").innerHTML = errorBox(err); return; }
  pause();
  $("#d-msg").innerHTML = "";
  let tr;
  try { tr = await busy(command(c), () => api("run", cfgParams(c))); }
  catch (e) { $("#d-msg").innerHTML = errorBox("The simulator could not run: " + e.message); return; }
  prepTrace(tr);
  Object.assign(S.demo, { trace: tr, runConfig: clone(c), t: 0, cache: {}, open: null });
  const first = tr.events.findIndex(e => e[2] >= 0);
  S.demo.t = first >= 0 ? first : 0;   // start at the first eviction: that is where it gets interesting
  drawDemo();
}

function prepTrace(tr) {
  tr.n = tr.events.length;
  tr.cumFaults = new Int32Array(tr.n);
  tr.cumSecret = new Int32Array(tr.n);
  let f = 0, s = 0;
  tr.events.forEach((e, t) => {
    if (!e[0]) f++;
    if (e[2] >= 0 && tr.sens[e[2]] >= 2) s++;
    tr.cumFaults[t] = f;
    tr.cumSecret[t] = s;
  });
}
function replay(tr, t) {
  const frames = new Array(tr.frames).fill(-1), last = {}, freq = {};
  for (let i = 0; i <= t; i++) {
    const p = tr.refs[i], e = tr.events[i];
    if (!e[0]) { frames[e[1]] = p; freq[p] = 0; }
    last[p] = i;
    freq[p] = (freq[p] || 0) + 1;
  }
  return { frames, last, freq };
}

function pageDemo() {
  main.innerHTML = `<div class="page">
    <div class="page-title"><h1>Live demo</h1><p>Pick a workload and press Run. Then step through the requests and see, at every eviction, which page left and why.</p></div>
    <section class="card" id="d-config"></section>
    <div id="d-msg"></div>
    <section class="card" id="d-player"></section>
    <div class="demo-grid">
      <section class="card" id="d-frames"></section>
      <section class="card" id="d-why"></section>
    </div>
    <div class="row small faint" style="justify-content:center">Keys: ← → step · space play · E next eviction · S next security event</div>
  </div>`;
  bindDemoConfig();
  const q = hashParams();
  const c = S.demo.config;
  for (const k of ["algo", "workload", "sensitivity"]) if (q[k]) c[k] = q[k];
  for (const k of ["frames", "length", "seed", "percent"]) if (q[k]) c[k] = parseInt(q[k], 10);
  if (Object.keys(q).length) bindDemoConfig();
  if (!S.demo.trace || cfgKey(c) !== cfgKey(S.demo.runConfig)) {
    drawDemoEmpty();
    runDemo().then(() => { if (q.t !== undefined) setT(parseInt(q.t, 10) || 0); });
  } else {
    if (q.t !== undefined) S.demo.t = parseInt(q.t, 10) || 0;
    drawDemo();
  }
}
function drawDemoEmpty() {
  $("#d-player").innerHTML = `<div class="loading">Running the simulator …</div>`;
  $("#d-frames").innerHTML = "";
  $("#d-why").innerHTML = "";
}
function drawDemo() {
  if (S.page !== "demo" || !S.demo.trace) return;
  drawPlayer();
  drawFrames();
  drawWhy();
}
function setT(t) {
  const D = S.demo;
  if (!D.trace) return;
  D.t = Math.max(0, Math.min(D.trace.n - 1, t));
  D.open = null;
  drawDemo();
}
const isEviction = e => e[2] >= 0;
const isSecurity = e => e[2] >= 0 && ((e[4] & 3) || S.demo.trace.sens[e[2]] === 3);
function jump(pred, dir = 1) {
  const D = S.demo, tr = D.trace;
  for (let t = D.t + dir; t >= 0 && t < tr.n; t += dir) if (pred(tr.events[t])) return setT(t);
}
function play() {
  const D = S.demo;
  if (!D.trace) return;
  if (D.t >= D.trace.n - 1) D.t = 0;
  D.playing = true;
  clearInterval(D.timer);
  D.timer = setInterval(() => {
    if (D.t >= D.trace.n - 1) return pause();
    D.t++;
    D.open = null;
    drawDemo();
  }, 1000 / D.speed);
  drawPlayer();
}
function pause() {
  const D = S.demo, was = D.playing;
  D.playing = false;
  clearInterval(D.timer);
  if (was && S.page === "demo") drawDemo();
}

function drawPlayer() {
  const D = S.demo, tr = D.trace, t = D.t, c = D.runConfig;
  const faults = tr.cumFaults[t], hits = t + 1 - faults;
  $("#d-player").innerHTML = `<div class="player">
      <div class="btns">
        <button class="btn" id="p-prev" aria-label="Previous request">◀</button>
        <button class="btn btn-primary" id="p-play" aria-label="${D.playing ? "Pause" : "Play"}" style="min-width:96px">${D.playing ? "❚❚ Pause" : "▶ Play"}</button>
        <button class="btn" id="p-next" aria-label="Next request">▶</button>
      </div>
      <input type="range" id="p-range" min="0" max="${tr.n - 1}" value="${t}" aria-label="Request number">
      <div class="pos">request <b>${fmt(t)}</b> / ${fmt(tr.n - 1)}</div>
    </div>
    <div class="row" style="margin-top:14px">
      <button class="btn" id="p-ev">Next eviction ⏭</button>
      <button class="btn" id="p-sec" title="Next moment where the security rule mattered or a top-secret page left">Next security event ⏭</button>
      <span class="spacer"></span>
      <div class="stats" style="margin-top:0">
        <span>Page faults<b>${fmt(faults)}</b></span>
        <span>Hit rate<b>${(hits / (t + 1) * 100).toFixed(1)}%</b></span>
        <span>Secret pages evicted<b>${fmt(tr.cumSecret[t])}</b></span>
      </div>
    </div>
    <div class="small faint" style="margin-top:12px">${esc(c.algo)} · ${esc(WL_LABEL[c.workload])} · ${c.frames} frames · seed ${c.seed} · whole run: ${fmt(tr.faults)} faults, ${fmt(tr.evicted[2] + tr.evicted[3])} secret pages evicted
      <button class="btn-link" id="p-dl" style="margin-left:10px">download this run (CSV)</button></div>`;
  $("#p-prev").onclick = () => setT(D.t - 1);
  $("#p-next").onclick = () => setT(D.t + 1);
  $("#p-play").onclick = () => (D.playing ? pause() : play());
  $("#p-range").oninput = e => { pause(); setT(+e.target.value); };
  $("#p-ev").onclick = () => jump(isEviction);
  $("#p-sec").onclick = () => jump(isSecurity);
  $("#p-dl").onclick = exportRun;
}

function drawFrames() {
  const D = S.demo, tr = D.trace, t = D.t, st = replay(tr, t), ev = tr.events[t];
  const lo = Math.max(0, Math.min(t - 12, tr.n - 24)), hi = Math.min(tr.n, lo + 24);
  let strip = "";
  for (let i = lo; i < hi; i++) {
    const e = tr.events[i];
    strip += `<div class="cell${e[0] ? "" : " fault"}${i === t ? " cur" : ""}${i > t ? " future" : ""}" data-t="${i}" data-tip="${esc(`request ${i}: page ${tr.refs[i]}\n${e[0] ? "hit (already in memory)" : "page fault"}${e[2] >= 0 ? `, evicted page ${e[2]}` : ""}`)}">${tr.refs[i]}</div>`;
  }
  const cells = st.frames.map((p, j) => {
    if (p < 0) return `<div class="frame empty"><div class="top-line"><span>frame ${j}</span></div><div class="pid faint">—</div><div class="info">empty</div></div>`;
    const here = j === ev[1], cls = here ? (ev[0] ? "hit" : "new") : "";
    const badge = here ? (ev[0] ? `<span class="badge">HIT</span>` : `<span class="badge">NEW${ev[2] >= 0 ? ` · replaced p${ev[2]}` : ""}</span>`) : "";
    const ago = t - st.last[p];
    return `<div class="frame ${cls}" data-tip="${esc(`page ${p} · ${SENS_NAME[tr.sens[p]]}\nlast used ${ago} requests ago\nused ${st.freq[p]} times since it was loaded`)}">
      <div class="top-line"><span>frame ${j}</span>${sens(tr.sens[p])}</div><div class="pid">p${p}</div>
      <div class="info">used ${ago === 0 ? "now" : ago + " ago"} · ${st.freq[p]}×</div>${badge}</div>`;
  }).join("");
  $("#d-frames").innerHTML = `<div class="card-head"><h2>Memory after request ${fmt(t)}</h2><span class="note">${tr.frames} frames</span></div>
    <div class="strip" aria-label="Requests around the current one">${strip}</div>
    <div class="frames">${cells}</div>
    <div class="legend" style="margin-top:14px"><span><span class="sw" style="background:var(--ember)"></span>page fault / new page</span><span><span class="sw" style="border:2px solid var(--steel)"></span>hit</span><span>S0–S3 = how secret the page is</span></div>`;
  $$("#d-frames .cell").forEach(c => (c.onclick = () => setT(+c.dataset.t)));
}

async function inspectAt(t) {
  const D = S.demo, key = cfgKey(D.runConfig) + "@" + t;
  if (!D.cache[key]) D.cache[key] = api("inspect", { ...cfgParams(D.runConfig), t });
  return D.cache[key];
}

function contribHTML(f, w, wS, security) {
  const parts = [["recency", w[0] * f.R], ["frequency", w[1] * f.F], ["behaviour", w[2] * f.B], ["working set", w[3] * f.W], ["secrecy", -(security ? wS : 0) * f.S]];
  const lo = Math.min(-0.5, ...parts.map(p => p[1])), hi = Math.max(0.5, ...parts.map(p => p[1]));
  const pos = v => (v - lo) / (hi - lo) * 100;
  return `<div class="contrib">${parts.map(([l, v]) => {
    const a = pos(Math.min(0, v)), b = pos(Math.max(0, v));
    return `<span class="lbl">${l}</span><span class="bar-track"><span class="zero" style="left:${pos(0)}%"></span><span class="bar" style="left:${a}%;width:${b - a}%;background:${v < 0 ? "var(--ember)" : "var(--steel)"}"></span></span><span class="val">${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}</span>`;
  }).join("")}<span class="lbl" style="color:var(--text)">= score</span><span></span><span class="val"><b>${f.score.toFixed(2)}</b></span></div>
  <div class="small faint" style="margin-top:6px">Bars to the right push the page out; the secrecy bar (left) keeps it in.</div>`;
}

async function drawWhy() {
  const D = S.demo, tr = D.trace, t = D.t, ev = tr.events[t], req = tr.refs[t], c = D.runConfig;
  const box = $("#d-why");
  const head = `<div class="card-head"><h2>What happened at request ${fmt(t)}</h2></div>`;
  if (ev[0]) {
    box.innerHTML = head + `<div class="event">p${req} ${sens(tr.sens[req])} <span class="arrow">is already in memory</span></div><p class="why">A <b>hit</b>: nothing has to change. Press <b>Next eviction</b> to jump to the next decision.</p>`;
    return;
  }
  if (ev[2] < 0) {
    box.innerHTML = head + `<div class="event">p${req} ${sens(tr.sens[req])} <span class="arrow">loaded into an empty frame</span></div><p class="why">A <b>page fault</b>, but memory still had a free frame, so nothing was removed.</p>`;
    return;
  }
  const top = `<div class="event">p${req} ${sens(tr.sens[req])} <span class="arrow">came in →</span> <span class="out">p${ev[2]}</span> ${sens(tr.sens[ev[2]])} <span class="arrow">was removed</span></div>`;
  if (D.playing) { box.innerHTML = head + top + `<p class="why faint">Pause to see why.</p>`; return; }
  box.innerHTML = head + top + `<p class="why faint">Asking the simulator (./sim --inspect ${t}) …</p>`;
  let snap;
  try { snap = await inspectAt(t); } catch (e) { box.innerHTML = head + top + errorBox(e.message); return; }
  if (D.t !== t || S.page !== "demo") return;

  const victim = snap.frames.find(f => f.frame === snap.victim_frame);
  let html = head + top;
  if (c.algo === "Adaptive") {
    const patternText = { looping: "a loop, so the page just used is needed last", sequential: "a sequential scan, so the page just read is needed last", bursty: "bursty, so pages not used recently can go", random: "random, so the pattern gives no hint" }[snap.behaviour] || snap.behaviour;
    html += `<p class="why">The last 32 requests look like <b>${esc(c.behaviour ? patternText : "nothing (behaviour detection is switched off)")}</b>. p${victim.page} had the <b>highest score (${victim.score.toFixed(2)})</b> of the pages that are allowed to leave.</p>`;
    if (snap.fallback) html += `<div class="notice">Every page in memory was a protected top-secret page, so one of them had to leave anyway. This counts as a <b>secure eviction</b>.</div>`;
    else if (snap.no_security_page !== snap.victim_page) html += `<div class="notice"><b>The security rule changed this decision.</b> Without it, p${snap.no_security_page} ${sens(tr.sens[snap.no_security_page])} would have been removed.</div>`;
    else if (tr.sens[victim.page] === 3) html += `<div class="notice">A top-secret page left because it was <b>not in use</b> (outside the working set). It counts as a secure eviction.</div>`;
    const rows = snap.frames.slice().sort((a, b) => b.score - a.score);
    const lo = Math.min(...rows.map(r => r.score)), hi = Math.max(...rows.map(r => r.score));
    html += `<div class="rank-head"><span>page</span><span>secret</span><span>score (higher = leaves first)</span><span style="text-align:right">score</span><span></span></div><div class="ranks">`;
    for (const f of rows) {
      const isV = f.frame === snap.victim_frame, open = D.open === f.page || (D.open === null && isV);
      const tag = isV ? `<span class="tag out">REMOVED</span>` : f.protected ? `<span class="tag prot" title="top-secret page in use: not allowed to leave">PROTECTED</span>` : f.page === snap.no_security_page ? `<span class="tag" title="would leave without the security rule">w/o security</span>` : "";
      html += `<div class="rank${isV ? " victim" : ""}${open ? " open" : ""}" data-p="${f.page}" tabindex="0"><span class="p">p${f.page}</span>${sens(f.sens)}<span class="track"><span class="fill" style="width:${hi === lo ? 100 : Math.max(3, (f.score - lo) / (hi - lo) * 100)}%"></span></span><span class="v">${f.score.toFixed(2)}</span>${tag}</div>`;
      if (open) html += `<div class="breakdown">${contribHTML(f, c.weights, snap.wS, c.security)}</div>`;
    }
    html += `</div><p class="small faint" style="margin-top:10px">Click a page to see what its score is made of. Security weight now: w<sub>S</sub> = ${snap.wS.toFixed(2)}.</p>`;
  } else {
    const how = {
      FIFO: [`p${victim.page} was <b>loaded first</b> (request ${victim.loaded}).`, f => `loaded at ${f.loaded}`, (a, b) => a.loaded - b.loaded],
      LRU: [`p${victim.page} was <b>not used for the longest time</b> (last used at request ${victim.last}).`, f => `last used ${snap.t - f.last} ago`, (a, b) => a.last - b.last],
      LFU: [`p${victim.page} was <b>used the fewest times</b> (${victim.freq}) since it was loaded.`, f => `${f.freq} uses`, (a, b) => a.freq - b.freq || a.last - b.last],
      Optimal: [`p${victim.page} is <b>needed again latest</b> (${victim.next_use >= tr.n ? "never" : "at request " + victim.next_use}). Optimal reads the future, so it is only a reference.`, f => (f.next_use >= tr.n ? "never needed again" : `needed at ${f.next_use}`), (a, b) => b.next_use - a.next_use],
    }[c.algo];
    html += `<p class="why">${how[0]}</p><div class="notice calm">${esc(c.algo)} does not look at how secret a page is.</div><div class="ranks">`;
    for (const f of snap.frames.slice().sort(how[2])) {
      const isV = f.frame === snap.victim_frame;
      html += `<div class="rank${isV ? " victim" : ""}" style="grid-template-columns:64px 46px 1fr 104px;cursor:default"><span class="p">p${f.page}</span>${sens(f.sens)}<span class="muted small">${how[1](f)}</span>${isV ? `<span class="tag out">REMOVED</span>` : "<span></span>"}</div>`;
    }
    html += `</div>`;
  }
  box.innerHTML = html;
  $$("#d-why .rank[data-p]").forEach(r => {
    const go = () => { D.open = +r.dataset.p; drawWhy(); };
    r.onclick = go;
    r.onkeydown = e => { if (e.key === "Enter") go(); };
  });
}

function exportRun() {
  const D = S.demo, tr = D.trace, c = D.runConfig;
  let csv = `# exported ${new Date().toISOString()}\n# command: ${command(c)}\n# faults ${tr.faults}, hits ${tr.hits}, evicted S0-S3 ${tr.evicted.join("/")}\n`;
  csv += "request,page,sensitivity,hit,frame,evicted_page,evicted_sensitivity,detected_pattern,security_changed_choice,all_protected\n";
  tr.events.forEach((e, t) => {
    csv += [t, tr.refs[t], tr.sens[tr.refs[t]], e[0], e[1], e[2], e[2] >= 0 ? tr.sens[e[2]] : "", PATTERNS[e[3]], e[4] & 2 ? 1 : 0, e[4] & 1 ? 1 : 0].join(",") + "\n";
  });
  download(`run_${c.algo}_${c.workload}_f${c.frames}_s${c.seed}.csv`, csv, "text/csv");
}

/* ================= Compare ================= */

function pageCompare() {
  const C = S.cmp;
  const opt = (v, cur, l) => `<option value="${v}"${String(v) === String(cur) ? " selected" : ""}>${esc(l)}</option>`;
  main.innerHTML = `<div class="page">
    <div class="page-title"><h1>Compare the algorithms</h1><p>All five algorithms run on exactly the same requests and the same memory size. Lower is better for both charts.</p></div>
    <section class="card"><div class="config">
      <div class="field"><label for="c-wl">Workload</label><select id="c-wl">${WORKLOADS.map(w => opt(w, C.workload, WL_LABEL[w])).join("")}</select></div>
      <div class="field" style="min-width:110px"><label for="c-fr">Memory</label><select id="c-fr">${[3, 4, 8, 16, 32].map(f => opt(f, C.frames, f + " frames")).join("")}</select></div>
      <button class="btn btn-primary btn-big" id="c-run" type="button">Compare</button>
      <span class="spacer"></span><span class="small faint">5,000 requests · seed 42 · default secret-page mix</span>
    </div></section>
    <div id="c-out"></div>
  </div>`;
  $("#c-run").onclick = () => { C.workload = $("#c-wl").value; C.frames = +$("#c-fr").value; runCompare(); };
  if (C.data && C.runFor === C.workload + "/" + C.frames) drawCompare(); else runCompare();
}
async function runCompare() {
  const C = S.cmp;
  $("#c-out").innerHTML = `<div class="loading center">Running all five algorithms …</div>`;
  try {
    C.data = await busy("comparing", () => api("compare", { workload: C.workload, frames: C.frames, length: 5000, seed: 42 }));
    C.runFor = C.workload + "/" + C.frames;
  } catch (e) { $("#c-out").innerHTML = errorBox(e.message); return; }
  if (S.page === "compare") drawCompare();
}
function drawCompare() {
  const C = S.cmp, d = C.data;
  const f = a => d[a].faults, s = a => d[a].evicted[2] + d[a].evicted[3];
  const ch = (a, fn) => change(fn(a), fn("LRU"));
  const sentence = `On the <b>${esc(C.workload)}</b> workload with ${C.frames} frames, Adaptive has <b>${pct(ch("Adaptive", f))}</b> page faults and <b>${pct(ch("Adaptive", s))}</b> secret pages evicted compared with LRU.`;
  const chart = (title, fn) => barChart({ title, cats: ALGOS, vals: ALGOS.map(fn), colors: ALGOS.map(a => COLOR[a]), hatched: ["Optimal"], showValues: true, w: 560, h: 300,
    tips: ALGOS.map(a => `${a}${a === "Optimal" ? " (knows the future)" : ""}\n${title}: ${fmt(fn(a))}${a !== "LRU" ? `\nvs LRU: ${ch(a, fn).toFixed(1)}%` : ""}`) });
  $("#c-out").innerHTML = `<section class="card">
      <p class="takeaway">${sentence}</p>
      <div class="two">${chart("Page faults", f)}${chart("Secret pages evicted (S2 + S3)", s)}</div>
      <div class="legend" style="margin-top:10px"><span><span class="sw" style="background:var(--c-adpt)"></span>Adaptive (ours)</span><span><span class="sw" style="background:var(--c-lru)"></span>classic algorithms</span><span><span class="sw" style="background:repeating-linear-gradient(45deg,var(--c-opt) 0 2px,transparent 2px 5px);border:1px solid var(--c-opt)"></span>Optimal: knows the future, reference only</span></div>
    </section>
    <section class="card"><div class="table-wrap"><table class="data"><thead><tr><th>Algorithm</th><th class="num">Page faults</th><th class="num">Hit rate</th><th class="num">Secret pages evicted</th><th class="num">Top-secret evicted</th><th class="num">Faults vs LRU</th><th class="num">Secret vs LRU</th></tr></thead><tbody>
      ${ALGOS.map(a => `<tr class="${a === "Adaptive" ? "ours" : ""}"><td>${a}${a === "Optimal" ? ' <span class="faint small">(reference)</span>' : ""}</td><td class="num">${fmt(f(a))}</td><td class="num">${(d[a].hits / (d[a].hits + d[a].faults) * 100).toFixed(1)}%</td><td class="num">${fmt(s(a))}</td><td class="num">${fmt(d[a].evicted[3])}</td><td class="num">${a === "LRU" ? "—" : pct(ch(a, f))}</td><td class="num">${a === "LRU" ? "—" : pct(ch(a, s))}</td></tr>`).join("")}
    </tbody></table></div><p class="small faint" style="margin-top:10px">From <code>./sim --trace --workload ${esc(C.workload)} --frames ${C.frames} --length 5000 --seed 42</code> for each algorithm.</p></section>`;
}

/* ================= Results ================= */

async function pageResults() {
  const R = S.res;
  const tabs = [["all", "All 25 tests"], ["seeds", "10 seeds"], ["secret", "Secret pages"], ["parts", "What each part adds"], ["speed", "Speed"], ["worse", "Where it is worse"]];
  main.innerHTML = `<div class="page">
    <div class="page-title"><h1>Results</h1><p>All six experiments from our report, computed by the simulator (<code>./sim --csv --seed ${R.seed}</code>).</p></div>
    <section class="card"><div class="subtabs" role="tablist">${tabs.map(([k, l]) => `<button type="button" role="tab" data-k="${k}" aria-selected="${R.tab === k}">${l}</button>`).join("")}
      <span class="spacer"></span><button class="btn-link" id="r-dl" type="button" style="align-self:center">download all results (CSV)</button></div>
      <div id="r-body"><div class="loading">Running the experiments …</div></div></section>
  </div>`;
  $$(".subtabs button[data-k]").forEach(b => (b.onclick = () => { R.tab = b.dataset.k; pageResults(); }));
  let exp;
  try { exp = await getExperiments(R.seed); } catch (e) { $("#r-body").innerHTML = errorBox(e.message); return; }
  if (S.page !== "results") return;
  $("#r-dl").onclick = () => {
    const cols = Object.keys(exp.rows[0]);
    download(`results_seed${R.seed}.csv`, `# ${exp.meta.command} · generated ${exp.meta.generated}\n` + cols.join(",") + "\n" + exp.rows.map(r => cols.map(k => r[k]).join(",")).join("\n") + "\n", "text/csv");
  };
  ({ all: resAll, seeds: resSeeds, secret: resSecret, parts: resParts, speed: resSpeed, worse: resWorse })[R.tab](exp);
}
function seg(id, items, cur) { return `<div class="seg" id="${id}">${items.map(([k, l]) => `<button type="button" data-k="${k}" aria-pressed="${String(k) === String(cur)}">${l}</button>`).join("")}</div>`; }

function resAll(exp) {
  const R = S.res;
  const M = { faults: ["Page faults", r => r.faults, true], hit: ["Hit rate", r => r.hit_rate, false], secret: ["Secret pages evicted", secret, true] }[R.metric];
  const get = (wl, a) => M[1](rowOf(exp, { experiment: "main", workload: wl, frames: R.frames, algorithm: a }));
  const fv = R.metric === "hit" ? v => v.toFixed(0) + "%" : fmt;
  const charts = WORKLOADS.map(wl => barChart({ title: wl, cats: ALGOS, labels: ["FIFO", "LRU", "LFU", "OPT", "ADPT"], vals: ALGOS.map(a => get(wl, a)), colors: ALGOS.map(a => COLOR[a]), hatched: ["Optimal"], fmtV: fv, yMax: R.metric === "hit" ? 100 : undefined, w: 250, h: 220,
    tips: ALGOS.map(a => `${wl}, ${R.frames} frames\n${a}\n${M[0]}: ${fv(get(wl, a))}`) })).join("");
  $("#r-body").innerHTML = `<p class="takeaway">Adaptive is close to Optimal on <b>looping</b> and <b>sequential</b> workloads, where the classic algorithms fault on every request, and it evicts far fewer secret pages everywhere.</p>
    <div class="row" style="margin-bottom:16px">${seg("r-metric", [["faults", "Page faults"], ["hit", "Hit rate"], ["secret", "Secret pages evicted"]], R.metric)}${seg("r-frames", [3, 4, 8, 16, 32].map(f => [f, f + " frames"]), R.frames)}</div>
    <div class="multiples">${charts}</div>
    <div class="small faint" style="margin:8px 0 18px">ADPT = Adaptive (ours) · OPT = Optimal, knows future requests (hatched, reference only) · ${M[2] ? "lower" : "higher"} is better</div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Workload</th>${ALGOS.map(a => `<th class="num">${a}</th>`).join("")}<th class="num">Adaptive vs LRU</th></tr></thead><tbody>
      ${WORKLOADS.map(wl => `<tr><td>${wl}</td>${ALGOS.map(a => `<td class="num"${a === "Adaptive" ? ' style="font-weight:600"' : ""}>${fv(get(wl, a))}</td>`).join("")}<td class="num">${pct(change(get(wl, "Adaptive"), get(wl, "LRU")), M[2])}</td></tr>`).join("")}
    </tbody></table></div>`;
  $$("#r-metric button").forEach(b => (b.onclick = () => { R.metric = b.dataset.k; resAll(exp); }));
  $$("#r-frames button").forEach(b => (b.onclick = () => { R.frames = +b.dataset.k; resAll(exp); }));
}
function resSeeds(exp) {
  const vals = (wl, fn) => {
    const l = rowsOf(exp, { experiment: "seeds", workload: wl, algorithm: "LRU" }).filter(r => r.setting.startsWith("seed-"));
    const a = rowsOf(exp, { experiment: "seeds", workload: wl, algorithm: "Adaptive" }).filter(r => r.setting.startsWith("seed-"));
    return l.map((r, i) => ({ v: change(fn(a[i]), fn(r)), tip: `${wl}, ${r.setting}\nLRU ${fmt(fn(r))} → Adaptive ${fmt(fn(a[i]))}` })).filter(x => isFinite(x.v));
  };
  const groups = fn => WORKLOADS.map(wl => { const v = vals(wl, fn); return { vals: v, mean: v.length ? sum(v.map(x => x.v)) / v.length : 0 }; });
  const avg = (wl, a) => rowOf(exp, { experiment: "seeds", workload: wl, setting: "avg-10", algorithm: a });
  $("#r-body").innerHTML = `<p class="takeaway">We repeated the 8-frame test with <b>10 different seeds</b> (10 different generated datasets). Adaptive never evicts more secret pages than LRU; only <b>bursty</b> workloads get more faults.</p>
    <div class="two">${dotChart({ title: "Page faults", cats: WORKLOADS, groups: groups(r => r.faults) })}${dotChart({ title: "Secret pages evicted", cats: WORKLOADS, groups: groups(secret) })}</div>
    <div class="small faint" style="margin:8px 0 18px">One dot per seed · bar = average · below zero (green) = better than LRU, above (orange) = worse</div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Workload</th><th class="num">LRU faults</th><th class="num">Adaptive faults</th><th class="num">Change</th><th class="num">LRU secret</th><th class="num">Adaptive secret</th><th class="num">Change</th></tr></thead><tbody>
      ${WORKLOADS.map(wl => { const l = avg(wl, "LRU"), a = avg(wl, "Adaptive"); return `<tr><td>${wl}</td><td class="num">${fmt(l.faults)}</td><td class="num">${fmt(a.faults)}</td><td class="num">${pct(change(a.faults, l.faults))}</td><td class="num">${fmt(secret(l))}</td><td class="num">${fmt(secret(a))}</td><td class="num">${pct(change(secret(a), secret(l)))}</td></tr>`; }).join("")}
    </tbody></table></div>`;
}
function resSecret(exp) {
  const g = (wl, s, a, ex = "placement") => rowOf(exp, { experiment: ex, workload: wl, setting: s, algorithm: a });
  const shares = ["0%", "10%", "25%", "50%"], xs = [0, 10, 25, 50];
  const share = (wl, fn, label) => lineChart({ title: `${wl}: ${label}`, xs, xLabel: "share of secret pages (%)", yLabel: label, w: 560, h: 260, fmtX: v => v + "%",
    series: ["LRU", "Adaptive"].map(a => ({ name: a, color: COLOR[a], width: a === "Adaptive" ? 3 : 2, pts: shares.map((s, i) => [xs[i], fn(g(wl, s, a, "amount"))]) })) });
  const hotL = secret(g("phased", "hot", "LRU")), hotA = secret(g("phased", "hot", "Adaptive"));
  const b50 = a => g("bursty", "50%", a, "amount");
  $("#r-body").innerHTML = `<p class="takeaway">The biggest gain is when secret pages are <b>used a lot</b> (phased: ${fmt(hotL)} → ${fmt(hotA)} secret evictions). When <b>half</b> of all pages are secret, protecting them costs bursty workloads ${pct(change(b50("Adaptive").faults, b50("LRU").faults))} faults for little gain.</p>
    <div class="table-wrap"><table class="data"><thead><tr><th>Workload</th><th>Secret pages are</th><th class="num">LRU faults</th><th class="num">Adaptive faults</th><th class="num">Change</th><th class="num">LRU secret</th><th class="num">Adaptive secret</th><th class="num">Change</th></tr></thead><tbody>
      ${["phased", "bursty", "random"].flatMap(wl => ["hot", "warm", "cold", "random"].map((pl, i) => { const l = g(wl, pl, "LRU"), a = g(wl, pl, "Adaptive"); return `<tr><td>${i ? "" : wl}</td><td>${{ hot: "most used", warm: "middle", cold: "least used", random: "random" }[pl]}</td><td class="num">${fmt(l.faults)}</td><td class="num">${fmt(a.faults)}</td><td class="num">${pct(change(a.faults, l.faults))}</td><td class="num">${fmt(secret(l))}</td><td class="num">${fmt(secret(a))}</td><td class="num">${pct(change(secret(a), secret(l)))}</td></tr>`; })).join("")}
    </tbody></table></div>
    <p class="small faint" style="margin:8px 0 22px">15% of pages secret, 8 frames.</p>
    <div class="two">${share("phased", r => r.faults, "page faults")}${share("phased", secret, "secret pages evicted")}${share("bursty", r => r.faults, "page faults")}${share("bursty", secret, "secret pages evicted")}</div>`;
}
function resParts(exp) {
  const v = [["LRU", "-", "LRU (classic)"], ["Adaptive", "full", "Adaptive, all parts"], ["Adaptive", "no-security", "without security"], ["Adaptive", "no-behaviour", "without behaviour"], ["Adaptive", "no-feedback", "without feedback"]];
  const r = (a, s, wl) => rowOf(exp, { experiment: "ablation", workload: wl, setting: s, algorithm: a });
  const bars = (wl, fn, title) => barChart({ title, cats: v.map(x => x[2]), labels: ["LRU", "all", "−sec", "−beh", "−fb"], vals: v.map(x => fn(r(x[0], x[1], wl))), colors: v.map(x => (x[0] === "LRU" ? "var(--c-lru)" : x[1] === "full" ? "var(--c-adpt)" : "var(--c-lfu)")), showValues: true, w: 560, h: 280 });
  $("#r-body").innerHTML = `<p class="takeaway">Turning one part off at a time shows its job: <b>behaviour</b> removes the faults, <b>security</b> removes the secret evictions, and <b>feedback</b> trades a little secrecy for fewer faults.</p>
    <div class="two">${bars("phased", x => x.faults, "Phased: page faults")}${bars("phased", secret, "Phased: secret pages evicted")}</div>
    <div class="small faint" style="margin:8px 0 18px">all = Adaptive with every part · −sec / −beh / −fb = one part switched off · 8 frames</div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Version</th>${["bursty", "phased", "random"].map(w => `<th class="num">${w} faults</th><th class="num">${w} secret</th>`).join("")}</tr></thead><tbody>
      ${v.map(([a, s, l]) => `<tr class="${s === "full" ? "ours" : ""}"><td>${l}</td>${["bursty", "phased", "random"].map(wl => { const x = r(a, s, wl); return `<td class="num">${fmt(x.faults)}</td><td class="num">${fmt(secret(x))}</td>`; }).join("")}</tr>`).join("")}
    </tbody></table></div>`;
}
function resSpeed(exp) {
  const per = a => { const r = rowOf(exp, { experiment: "overhead", algorithm: a }); return r.time_us / Math.max(1, r.faults - r.frames); };
  $("#r-body").innerHTML = `<p class="takeaway">Adaptive is the slowest per decision: about <b>${per("Adaptive").toFixed(2)} µs</b> against <b>${per("LRU").toFixed(2)} µs</b> for LRU. Most of the time goes into checking the last 32 requests for a pattern.</p>
    <div style="max-width:700px">${barChart({ title: "Time per eviction decision (µs)", cats: ALGOS, vals: ALGOS.map(per), colors: ALGOS.map(a => COLOR[a]), hatched: ["Optimal"], fmtV: v => v.toFixed(3), showValues: true, w: 680, h: 300 })}</div>
    <p class="small faint" style="margin-top:8px">Phased workload, 8 frames, average of 20 runs, measured just now with <code>clock()</code> on this computer. The numbers change a little every time. Optimal looks fast only because the simulator already knows the future.</p>`;
}
function resWorse(exp) {
  const seedF = a => rowOf(exp, { experiment: "seeds", workload: "bursty", setting: "avg-10", algorithm: a }).faults;
  const worst = Math.max(...rowsOf(exp, { experiment: "seeds", workload: "bursty", algorithm: "LRU" }).filter(r => r.setting.startsWith("seed-")).map(r => change(rowOf(exp, { experiment: "seeds", workload: "bursty", setting: r.setting, algorithm: "Adaptive" }).faults, r.faults)));
  const am = a => rowOf(exp, { experiment: "amount", workload: "bursty", setting: "50%", algorithm: a });
  const ab = s => rowOf(exp, { experiment: "ablation", workload: "random", setting: s, algorithm: "Adaptive" });
  const per = a => { const r = rowOf(exp, { experiment: "overhead", algorithm: a }); return r.time_us / Math.max(1, r.faults - r.frames); };
  $("#r-body").innerHTML = `<p class="takeaway">Adaptive is not better everywhere. These are the cases where it loses, all measured by the same simulator.</p>
    <ul class="worse" style="font-size:17px">
      <li><b>Bursty workloads:</b> ${pct(change(seedF("Adaptive"), seedF("LRU")))} page faults against LRU on average over 10 seeds (worst seed ${pct(worst)}). LRU already fits bursty access well, and keeping secret pages in memory takes frames.</li>
      <li><b>Many secret pages:</b> with 50% of pages secret (bursty, 8 frames), ${pct(change(am("Adaptive").faults, am("LRU").faults))} faults for only ${pct(change(secret(am("Adaptive")), secret(am("LRU"))))} secret evictions.</li>
      <li><b>Feedback on random workloads:</b> the feedback lowers protection when there are many faults, even when protection is not the cause: ${fmt(ab("full").evict_s3)} top-secret evictions with feedback against ${fmt(ab("no-feedback").evict_s3)} without, for only ${fmt(ab("no-feedback").faults - ab("full").faults)} fewer faults.</li>
      <li><b>Speed:</b> about ${Math.round(per("Adaptive") / per("LRU"))}× slower per decision than LRU.</li>
      <li><b>Scope:</b> simulation with generated data only; not tested with real program traces or inside a real operating system. The simulator counts secret-page evictions; it does not encrypt or protect memory itself.</li>
    </ul>`;
}

/* ================= How it works ================= */

async function pageHow() {
  main.innerHTML = `<div class="page"><div class="page-title"><h1>How Adaptive decides</h1><p>Four steps, run every time a page has to leave memory.</p></div><section class="card" id="how-body"><div class="loading">Loading parameters …</div></section>
    <section class="card" id="how-checks"></section></div>`;
  let P;
  try { P = await getParams(); } catch (e) { $("#how-body").innerHTML = errorBox(e.message); return; }
  if (S.page !== "how") return;
  const w = P.weights;
  $("#how-body").innerHTML = `<div class="steps">
    <div class="step"><div class="n">1</div><div class="body"><h2>Spot the pattern</h2><p>Look at the last ${P.window} requests and ask three questions, in order.</p>
      <div class="table-wrap"><table class="data pattern-table"><thead><tr><th>Question</th><th>Example</th><th>Pattern</th><th>Best page to remove</th></tr></thead><tbody>
        <tr><td>Does it repeat every few steps?</td><td>1 2 3 1 2 3 1 2 3</td><td><b>looping</b></td><td>the page just used (needed last)</td></tr>
        <tr><td>Does each request go to the next page?</td><td>10 11 12 13 14</td><td><b>sequential</b></td><td>the page just read</td></tr>
        <tr><td>Are only a few pages used (16 or fewer)?</td><td>7 8 7 9 8 7</td><td><b>bursty</b></td><td>the page not used for longest</td></tr>
        <tr><td>None of these</td><td>7 41 3 59 22</td><td><b>random</b></td><td>no hint from the pattern</td></tr></tbody></table></div></div></div>
    <div class="step"><div class="n">2</div><div class="body"><h2>Score every page in memory</h2>
      <div class="formula">Score = <span class="hl">${w[0]}</span>·R + <span class="hl">${w[1]}</span>·F + <span class="hl">${w[2]}</span>·B + <span class="hl">${w[3]}</span>·W − <span class="hl">w<sub>S</sub></span>·S</div>
      <p><b>R</b> high = not used for a long time · <b>F</b> high = rarely used · <b>B</b> = what step 1 recommends · <b>W</b> = 1 if not used in the last ${P.ws_window} requests · <b>S</b> = 0 (S0, S1), 0.5 (S2), 1 (S3), halved when the page is not in use. The page with the <b>highest</b> score leaves.</p></div></div>
    <div class="step"><div class="n">3</div><div class="body"><h2>Protect secret pages that are in use</h2><p>A top-secret (S3) page used in the last ${P.ws_window} requests is <b>not allowed to leave</b>. Only if every page in memory is protected does one leave anyway, as a <b>secure eviction</b> (in a real system it would be encrypted or wiped before going to disk). Secret pages that are no longer used may leave, so they do not block memory forever.</p></div></div>
    <div class="step"><div class="n">4</div><div class="body"><h2>Adjust with feedback</h2><p>Every ${P.feedback_interval} requests: if more than ${Math.round(P.high_fault_rate * 100)}% were page faults, memory is under pressure, so the security weight w<sub>S</sub> goes down by ${P.ws_step}; if fewer than ${Math.round(P.low_fault_rate * 100)}%, it goes up. It stays between ${P.ws_min} and ${P.ws_max} and starts at ${P.ws_start}.</p></div></div>
  </div>`;
  drawChecks();
}
function drawChecks() {
  const T = S.tests;
  $("#how-checks").innerHTML = `<div class="card-head"><h2>Is the simulator correct?</h2><button class="btn btn-primary" id="t-run" type="button">Run the 27 checks</button></div>
    <p class="muted">Textbook answers (FIFO 9 and 10 faults on 1 2 3 4 1 2 5 1 2 3 4 5, which is Belady's anomaly; LRU 10 and 8; Optimal 7 and 6), no algorithm ever beats Optimal, counts add up, pattern detection above 90% correct, an in-use top-secret page is never evicted by Adaptive, and Adaptive evicts fewer secret pages than LRU. These checks passed on 21 different seeds; they check our program, they do not prove it right for every possible workload.</p>
    <div id="t-out" style="margin-top:14px">${T ? `<div class="checks-summary ${T.failed ? "bad" : "good"}">${T.passed} passed, ${T.failed} failed <span class="faint small">(seed ${T.seed})</span></div>
      <details style="margin-top:8px"><summary>Show every check</summary><div class="table-wrap"><table class="data"><tbody>${T.checks.map(c => `<tr><td class="${c.status === "PASS" ? "good" : c.status === "FAIL" ? "bad" : "faint"} mono">${c.status}</td><td>${esc(c.name)}</td></tr>`).join("")}</tbody></table></div></details>` : ""}</div>
    <details style="margin-top:16px"><summary>Commands to reproduce everything</summary><pre class="cmd">gcc -o sim sim.c
./sim --test                 # the 27 checks
./sim                        # experiment 1: all workloads and memory sizes
./sim --experiments          # experiments 2 to 6
./sim --csv > results.csv    # everything as one CSV file
python3 plot.py              # graphs for the report
python3 ui.py                # this app</pre></details>`;
  $("#t-run").onclick = async () => {
    $("#t-out").innerHTML = `<div class="loading">Running ./sim --test …</div>`;
    try { S.tests = await busy("./sim --test", () => api("tests", { seed: 42 })); } catch (e) { $("#t-out").innerHTML = errorBox(e.message); return; }
    if (S.page === "how") drawChecks();
  };
}

/* ================= theme and keys ================= */

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  $("#theme").textContent = t === "dark" ? "Light" : "Dark";
  try { localStorage.setItem("aspr-theme", t); } catch (e) { /* storage unavailable: the theme just resets */ }
}
$("#theme").onclick = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
let savedTheme = "dark";
try { savedTheme = localStorage.getItem("aspr-theme") || "dark"; } catch (e) { /* use dark */ }
if (["light", "dark"].includes(new URLSearchParams(location.search).get("theme"))) savedTheme = new URLSearchParams(location.search).get("theme");
setTheme(savedTheme);

document.addEventListener("keydown", e => {
  if (e.target.matches("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^[1-6]$/.test(e.key)) { location.hash = "#" + ORDER[+e.key - 1]; return; }
  if (S.page !== "demo" || !S.demo.trace) return;
  if (e.key === "ArrowRight") { e.preventDefault(); setT(S.demo.t + 1); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); setT(S.demo.t - 1); }
  else if (e.key === " ") { e.preventDefault(); S.demo.playing ? pause() : play(); }
  else if (e.key === "e" || e.key === "E") jump(isEviction);
  else if (e.key === "s" || e.key === "S") jump(isSecurity);
});

setState("ready");
route();
