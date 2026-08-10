//! Простейшая встроенная страница: поле для модели, кнопка и результаты.
//!
//! Это временный интерфейс на время разработки движка — чтобы сервер можно
//! было не только «покурлить», но и посмотреть расчёт глазами. Позже его
//! заменит полноценный редактор схем из `assets/`.
//!
//! Страница самодостаточна: ни одной внешней ссылки, всё в одном файле.

pub const HTML: &str = r##"<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CRA — анализ надёжности</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; display: flex; flex-direction: column;
         font: 14px/1.5 system-ui, "Segoe UI", sans-serif; }
  header { display: flex; align-items: center; gap: 12px;
           padding: 8px 16px; border-bottom: 1px solid #8884; }
  h1 { margin: 0; font-size: 17px; letter-spacing: .5px; }
  main { flex: 1; display: flex; min-height: 0; }
  #in { flex: 1 1 45%; min-width: 0; border: 0; border-right: 1px solid #8884;
        padding: 12px; resize: none; outline: none; tab-size: 2;
        font: 13px ui-monospace, "Consolas", monospace;
        background: transparent; color: inherit; }
  #out { flex: 1 1 55%; min-width: 0; padding: 12px 16px; overflow: auto; }
  button { font: inherit; padding: 5px 12px; border-radius: 6px;
           border: 1px solid #8886; background: transparent; color: inherit;
           cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .muted { opacity: .65; font-size: 12px; }
  .kpi { font: 700 26px ui-monospace, monospace; margin: 4px 0 2px; }
  h2 { font-size: 14px; margin: 16px 0 4px; opacity: .75; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 3px 8px 3px 0; border-bottom: 1px solid #8883; }
  th { font-weight: 600; opacity: .7; }
  td.n { text-align: right; font-family: ui-monospace, monospace; white-space: nowrap; }
  code { font-family: ui-monospace, monospace; font-size: 12px;
         border: 1px solid #8884; border-radius: 4px; padding: 0 4px; margin-right: 3px; }
  .err { color: #d33; white-space: pre-wrap; font-family: ui-monospace, monospace; }
  .warn { color: #b46309; font-size: 13px; }
  svg { width: 100%; height: 150px; }
  .axis { stroke: currentColor; opacity: .35; }
  .grid { stroke: currentColor; opacity: .15; stroke-dasharray: 2 3; }
  .line { fill: none; stroke: #3b82f6; stroke-width: 2; }
  .dot  { fill: #3b82f6; }
  .tick { font: 10px ui-monospace, monospace; fill: currentColor; opacity: .6; }
</style>
</head>
<body>
<header>
  <h1>CRA</h1>
  <span class="muted">расчёт надёжности · временный интерфейс</span>
  <button id="run">▶ Рассчитать</button>
  <span id="status" class="muted"></span>
</header>
<main>
  <textarea id="in" spellcheck="false"></textarea>
  <div id="out"><p class="muted">Нажмите «Рассчитать» — модель слева уже готова.</p></div>
</main>
<script>
"use strict";
// Пример: насосная станция. Два насоса в параллель плюс задвижка,
// которая изнашивается (Вейбулл). Отказ = оба насоса ИЛИ задвижка.
const EXAMPLE = {
  model: {
    type: "fault_tree",
    top: "station_fails",
    events: [
      { id: "pump_a", dist: { type: "exponential", lambda: 1e-4 } },
      { id: "pump_b", dist: { type: "exponential", lambda: 1e-4 } },
      { id: "valve",  dist: { type: "weibull", shape: 2.0, scale: 20000 } }
    ],
    gates: [
      { id: "pumps",         op: "and", inputs: ["pump_a", "pump_b"] },
      { id: "station_fails", op: "or",  inputs: ["pumps", "valve"] }
    ]
  },
  // Без нуля в начале: вероятности наборов считаются по первому моменту,
  // а при t = 0 они все нулевые и выглядят сломанными.
  times: [1000, 2000, 5000, 10000, 20000],
  options: { cut_sets: true, path_sets: true }
};

const $ = (id) => document.getElementById(id);
$("in").value = JSON.stringify(EXAMPLE, null, 2);

const fmt = (p) => p === 0 ? "0" : (p >= 1e-3 ? p.toFixed(6) : p.toExponential(3));
const el = (tag, txt, cls) => {
  const n = document.createElement(tag);
  if (txt !== undefined) n.textContent = txt;
  if (cls) n.className = cls;
  return n;
};

$("run").addEventListener("click", run);
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run();
});

async function run() {
  let payload;
  try {
    payload = JSON.parse($("in").value);
  } catch (e) {
    return fail("Некорректный JSON: " + e.message);
  }
  $("run").disabled = true;
  $("status").textContent = "расчёт…";
  const t0 = performance.now();
  try {
    const r = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const text = await r.text();
    if (!r.ok) return fail(text || ("HTTP " + r.status));
    render(JSON.parse(text));
    $("status").textContent = Math.round(performance.now() - t0) + " мс";
  } catch (e) {
    fail("Сетевая ошибка: " + e.message);
  } finally {
    $("run").disabled = false;
  }
}

function fail(msg) {
  const out = $("out");
  out.textContent = "";
  out.append(el("div", msg, "err"));
  $("status").textContent = "ошибка";
}

function render(resp) {
  const out = $("out");
  out.textContent = "";

  out.append(el("div", resp.interpretation, "muted"));
  const last = resp.results[resp.results.length - 1];
  out.append(el("div", fmt(last.top_probability), "kpi"));
  out.append(el("div", "в момент t = " + last.time, "muted"));

  if (resp.results.length > 1) {
    out.append(el("h2", "Вероятность во времени"));
    out.append(chart(resp.results));
  }

  out.append(el("h2", "По моментам времени"));
  out.append(table(["Время", "Вероятность"],
    resp.results.map((r) => [String(r.time), fmt(r.top_probability)])));

  sets(out, "Минимальные сечения", resp.cut_sets);
  sets(out, "Минимальные пути", resp.path_sets);

  for (const w of resp.warnings || []) out.append(el("p", "⚠ " + w, "warn"));

  const s = resp.stats;
  out.append(el("div",
    `события: ${s.events} · узлы формулы: ${s.formula_nodes} · ` +
    `модули: ${s.modules} · узлы BDD: ${s.bdd_nodes}`, "muted"));
}

function sets(out, title, rep) {
  if (!rep) return;
  out.append(el("h2", `${title} — ${rep.count}${rep.truncated ? " (усечено)" : ""}`));
  const t = document.createElement("table");
  const head = document.createElement("tr");
  for (const h of ["Порядок", "Элементы", "P"]) head.append(el("th", h));
  t.append(head);
  for (const s of rep.sets.slice(0, 50)) {
    const tr = document.createElement("tr");
    tr.append(el("td", String(s.order), "n"));
    const td = document.createElement("td");
    for (const e of s.events) td.append(el("code", e));
    tr.append(td);
    tr.append(el("td", fmt(s.probability), "n"));
    t.append(tr);
  }
  out.append(t);
}

function table(headers, rows) {
  const t = document.createElement("table");
  const head = document.createElement("tr");
  for (const h of headers) head.append(el("th", h));
  t.append(head);
  for (const row of rows) {
    const tr = document.createElement("tr");
    row.forEach((v, i) => tr.append(el("td", v, i ? "n" : null)));
    t.append(tr);
  }
  return t;
}

// Простой график P(t): оси, сетка по вероятности, ломаная и точки.
function chart(results) {
  const NS = "http://www.w3.org/2000/svg";
  const W = 520, H = 150, L = 52, R = 12, T = 10, B = 24;
  const tmax = Math.max(...results.map((r) => r.time)) || 1;
  const pmax = Math.max(...results.map((r) => r.top_probability), 1e-12);
  const x = (t) => L + (t / tmax) * (W - L - R);
  const y = (p) => H - B - (p / pmax) * (H - T - B);

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  const add = (name, attrs, cls) => {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (cls) n.setAttribute("class", cls);
    svg.append(n);
    return n;
  };

  for (let i = 0; i <= 4; i++) {
    const p = (pmax * i) / 4;
    add("line", { x1: L, x2: W - R, y1: y(p), y2: y(p) }, i ? "grid" : "axis");
    const lbl = add("text", { x: L - 6, y: y(p) + 3, "text-anchor": "end" }, "tick");
    lbl.textContent = fmt(p);
  }
  add("line", { x1: L, x2: L, y1: T, y2: H - B }, "axis");
  for (let i = 0; i <= 4; i++) {
    const t = (tmax * i) / 4;
    const lbl = add("text", { x: x(t), y: H - B + 14, "text-anchor": "middle" }, "tick");
    lbl.textContent = t >= 1e5 ? t.toExponential(0) : String(t);
  }

  let d = "";
  results.forEach((r, i) => { d += (i ? "L" : "M") + x(r.time) + "," + y(r.top_probability); });
  add("path", { d }, "line");
  for (const r of results) {
    add("circle", { cx: x(r.time), cy: y(r.top_probability), r: 3 }, "dot");
  }
  return svg;
}
</script>
</body>
</html>
"##;
