"use strict";
// Веб-интерфейс CRA: визуальный редактор деревьев отказов и СФЦ + вкладка JSON.
// Plain JS + SVG. Без сборки и без внешних библиотек — so it is easy to audit
// and runs offline (важно для Астры).

const SVGNS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Модель данных (что храним в памяти)
//
// graph.nodes: { id, x, y, role, op?, k?, dist?, combine?, top? }
//   role = "event" | "gate"  (дерево)   |  "sfc"  (узел СФЦ / фиктивный)
//   dist = объект распределения, готовый к отправке (null = фиктивный узел СФЦ)
// graph.edges: { parent, child, inverse?, conj? }
//   смысл: `child` — это ВХОД для `parent` (ребёнок питает родителя).
//   рисуем: линия от нижнего порта родителя вниз к ребёнку.
// ---------------------------------------------------------------------------
let graph = { kind: "fault_tree", nodes: [], edges: [] };
let selected = null;           // id выбранного узла
let selEdge = null;            // выбранная связь {parent, child} (или null)
let seq = 0;                   // счётчик для новых id
const view = { tx: 40, ty: 40, s: 1 }; // сдвиг и масштаб холста
const NODE_W = 132, NODE_H = 52;

// ---- схема параметров распределений (числовые поля) ----
const DIST_SCHEMA = {
  fixed:       [["q", "q (вероятность)", 0.01]],
  exponential: [["lambda", "λ (интенсивность)", 1e-4], ["mu", "μ (ремонт, опц.)", "", true]],
  weibull:     [["shape", "форма (k)", 2], ["scale", "масштаб (λ)", 10000]],
  lognormal:   [["mu", "μ", 7], ["sigma", "σ", 0.5]],
  normal:      [["mean", "среднее", 10000], ["std", "ст. отклонение", 2000]],
  uniform:     [["a", "a", 0], ["b", "b", 10000]],
  gamma:       [["shape", "форма", 3], ["rate", "интенсивность", 1e-3]],
};
const DIST_NAMES = {
  fixed: "Постоянная q", exponential: "Экспоненциальное", weibull: "Вейбулла",
  lognormal: "Логнормальное", normal: "Нормальное", uniform: "Равномерное",
  gamma: "Гамма", markov: "Марковский узел",
};
// Transition (clock) distributions for Markov / semi-Markov nodes.
const TR_DIST_SCHEMA = {
  exponential:   [["rate", "λ (интенсивность)", 1e-3]],
  weibull:       [["shape", "форма k", 2], ["scale", "масштаб", 1000]],
  gamma:         [["shape", "форма", 2], ["rate", "интенсивность", 1e-3]],
  lognormal:     [["mu", "μ", 6], ["sigma", "σ", 0.5]],
  normal:        [["mean", "среднее", 1000], ["std", "ст. отклонение", 200]],
  deterministic: [["delay", "задержка d", 100]],
};
const TR_DIST_NAMES = {
  exponential: "Экспоненциальное (марковский)", weibull: "Вейбулла",
  gamma: "Гамма", lognormal: "Логнормальное", normal: "Нормальное",
  deterministic: "Детерминированное (Дирак δ)",
};
function trDefaultDist(type) {
  const d = { type };
  for (const [k, , def] of TR_DIST_SCHEMA[type]) d[k] = def;
  return d;
}
function trDistShort(d) {
  if (!d) return "?";
  switch (d.type) {
    case "exponential": return "λ=" + fmtNum(d.rate);
    case "weibull": return "W k=" + fmtNum(d.shape) + " s=" + fmtNum(d.scale);
    case "gamma": return "Γ " + fmtNum(d.shape) + "," + fmtNum(d.rate);
    case "lognormal": return "LN " + fmtNum(d.mu) + "," + fmtNum(d.sigma);
    case "normal": return "N " + fmtNum(d.mean) + "," + fmtNum(d.std);
    case "deterministic": return "δ d=" + fmtNum(d.delay);
    default: return d.type;
  }
}
// Migrate a Markov dist so every transition carries a `dist` object
// (older graphs / imports may use the `rate` shorthand).
function normalizeMarkovDist(d) {
  for (const tr of d.transitions || []) {
    if (!tr.dist) tr.dist = { type: "exponential", rate: tr.rate != null ? tr.rate : 1e-3 };
    delete tr.rate;
  }
}

const OP_LABEL = { and: "И  &", or: "ИЛИ  ≥1", not: "НЕ", xor: "XOR  =1",
  atleast: "K из N", nand: "И-НЕ", nor: "ИЛИ-НЕ" };
const OP_SYM = { and: "&", or: "≥1", not: "1", xor: "=1", atleast: "≥k", nand: "&̄", nor: "≥1̄" };

// ---- palette definitions per model kind ----
const PALETTE = {
  fault_tree: [
    { label: "Событие", make: () => ({ role: "event", dist: { type: "exponential", lambda: 1e-4 } }) },
    { label: "Элемент И", make: () => ({ role: "gate", op: "and" }) },
    { label: "Элемент ИЛИ", make: () => ({ role: "gate", op: "or" }) },
    { label: "K из N", make: () => ({ role: "gate", op: "atleast", k: 2 }) },
    { label: "Элемент НЕ", make: () => ({ role: "gate", op: "not" }) },
    { label: "XOR", make: () => ({ role: "gate", op: "xor" }) },
  ],
  sfc: [
    { label: "Узел (элемент)", make: () => ({ role: "sfc", dist: { type: "fixed", q: 0.1 } }) },
    { label: "Фиктивный узел", make: () => ({ role: "sfc", dist: null }) },
  ],
};

// ===========================================================================
// Хранение (localStorage): не потерять схему
// ===========================================================================
function save() {
  try { localStorage.setItem("cra.graph", JSON.stringify(graph)); } catch (e) {}
}
function load() {
  try {
    const s = localStorage.getItem("cra.graph");
    if (s) { graph = JSON.parse(s); seq = graph.nodes.reduce((m, n) => Math.max(m, idNum(n.id)), 0); }
  } catch (e) {}
}
function idNum(id) { const m = /(\d+)$/.exec(id); return m ? +m[1] : 0; }

// ===========================================================================
// Геометрия (перевод координат экрана в координаты холста и т.п.)
// ===========================================================================
// Экран -> мир: учитываем сдвиг (tx,ty) и масштаб (s) холста.
function screenToWorld(sx, sy) {
  const r = $("canvas").getBoundingClientRect();
  return { x: (sx - r.left - view.tx) / view.s, y: (sy - r.top - view.ty) / view.s };
}
function nodeById(id) { return graph.nodes.find((n) => n.id === id); }
function childrenEdges(id) { return graph.edges.filter((e) => e.parent === id); }
function canHaveInputs(n) { return n.role === "gate" || n.role === "sfc"; }
function bottomPort(n) { return { x: n.x + NODE_W / 2, y: n.y + NODE_H }; }
function topCenter(n) { return { x: n.x + NODE_W / 2, y: n.y }; }

// ===========================================================================
// Отрисовка (rendering)
// ===========================================================================
// Перерисовать всё: связи, узлы, и сразу сохранить в localStorage.
function render() {
  $("viewport").setAttribute("transform", `translate(${view.tx},${view.ty}) scale(${view.s})`);
  renderEdges();
  renderNodes();
  save();
}

function renderNodes() {
  const layer = $("nodes-layer");
  layer.textContent = "";
  for (const n of graph.nodes) {
    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute("class", "node " + n.role + (selected === n.id ? " selected" : "") + (n.top ? " top" : ""));
    g.setAttribute("transform", `translate(${n.x},${n.y})`);
    g.dataset.id = n.id;

    const rect = document.createElementNS(SVGNS, "rect");
    rect.setAttribute("class", "body");
    rect.setAttribute("width", NODE_W); rect.setAttribute("height", NODE_H);
    rect.setAttribute("rx", 8);
    g.appendChild(rect);

    const t1 = text(NODE_W / 2, 20, n.id, "title");
    t1.setAttribute("text-anchor", "middle");
    t1.setAttribute("font-weight", "600");
    g.appendChild(t1);

    const t2 = text(NODE_W / 2, 38, nodeSubtitle(n), "sub");
    t2.setAttribute("text-anchor", "middle");
    g.appendChild(t2);

    if (n.top) {
      const b = text(NODE_W / 2, -6, "▲ вершина", "top-badge");
      b.setAttribute("text-anchor", "middle");
      g.appendChild(b);
    }

    if (canHaveInputs(n)) {
      const port = document.createElementNS(SVGNS, "circle");
      port.setAttribute("class", "port");
      port.setAttribute("cx", NODE_W / 2); port.setAttribute("cy", NODE_H);
      port.setAttribute("r", 6);
      port.dataset.port = n.id;
      g.appendChild(port);
    }
    layer.appendChild(g);
  }
}

function nodeSubtitle(n) {
  if (n.role === "gate") {
    return OP_LABEL[n.op] + (n.op === "atleast" ? " (k=" + (n.k || 2) + ")" : "");
  }
  return distShort(n.dist);
}
function distShort(d) {
  if (!d) return "фиктивный";
  switch (d.type) {
    case "fixed": return "q=" + fmtNum(d.q);
    case "exponential": return "λ=" + fmtNum(d.lambda) + (d.mu != null && d.mu !== "" ? " μ=" + fmtNum(d.mu) : "");
    case "weibull": return "Вейбулл " + fmtNum(d.shape) + "," + fmtNum(d.scale);
    case "lognormal": return "логнорм " + fmtNum(d.mu) + "," + fmtNum(d.sigma);
    case "normal": return "норм " + fmtNum(d.mean) + "," + fmtNum(d.std);
    case "uniform": return "равн [" + fmtNum(d.a) + "," + fmtNum(d.b) + "]";
    case "gamma": return "гамма " + fmtNum(d.shape) + "," + fmtNum(d.rate);
    case "markov": return "Марков (" + (d.states ? d.states.length : 0) + " сост.)";
    default: return d.type;
  }
}
function fmtNum(x) {
  if (x === "" || x == null) return "?";
  const n = +x;
  if (!isFinite(n)) return String(x);
  if (n !== 0 && (Math.abs(n) < 1e-3 || Math.abs(n) >= 1e5)) return n.toExponential(1);
  return String(n);
}

function text(x, y, str, cls) {
  const t = document.createElementNS(SVGNS, "text");
  t.setAttribute("x", x); t.setAttribute("y", y);
  if (cls) t.setAttribute("class", cls);
  t.textContent = str;
  return t;
}

function renderEdges() {
  const layer = $("edges-layer");
  layer.textContent = "";
  for (const e of graph.edges) {
    const p = nodeById(e.parent), c = nodeById(e.child);
    if (!p || !c) continue;
    const a = bottomPort(p), b = topCenter(c);
    const d = edgePath(a, b);

    const hit = document.createElementNS(SVGNS, "path");
    hit.setAttribute("class", "edge-hit");
    hit.setAttribute("d", d);
    hit.dataset.edge = e.parent + ">" + e.child;
    layer.appendChild(hit);

    const sfc = graph.kind === "sfc";
    const isSel = selEdge && selEdge.parent === e.parent && selEdge.child === e.child;
    const kindCls = sfc ? (e.conj ? " conj" : " disj") : "";
    const path = document.createElementNS(SVGNS, "path");
    path.setAttribute("class", "edge" + (e.inverse ? " inverse" : "") + kindCls + (isSel ? " selected" : ""));
    path.setAttribute("d", d);
    layer.appendChild(path);

    // Canonical СФЦ arc badge: & (conjunctive) / ≥1 (disjunctive), + ¬ if inverse.
    if (sfc) {
      const badge = (e.conj ? "&" : "≥1") + (e.inverse ? " ¬" : "");
      const mid = text((a.x + b.x) / 2, (a.y + b.y) / 2 - 3, badge, "edge-label" + (e.conj ? " conj" : " disj"));
      mid.setAttribute("text-anchor", "middle");
      layer.appendChild(mid);
    } else if (e.inverse) {
      const mid = text((a.x + b.x) / 2, (a.y + b.y) / 2 - 3, "¬", "edge-label");
      mid.setAttribute("text-anchor", "middle");
      layer.appendChild(mid);
    }
  }
}
function edgePath(a, b) {
  const dy = Math.max(24, Math.abs(b.y - a.y) / 2);
  return `M${a.x},${a.y} C${a.x},${a.y + dy} ${b.x},${b.y - dy} ${b.x},${b.y}`;
}

// ===========================================================================
// Node / edge operations
// ===========================================================================
function addNode(spec, wx, wy) {
  seq += 1;
  const n = Object.assign({ id: "n" + seq, x: wx, y: wy }, spec.make());
  graph.nodes.push(n);
  select(n.id);
  render();
}
function deleteNode(id) {
  graph.nodes = graph.nodes.filter((n) => n.id !== id);
  graph.edges = graph.edges.filter((e) => e.parent !== id && e.child !== id);
  if (selected === id) select(null);
  render();
}
function deleteEdge(parent, child) {
  graph.edges = graph.edges.filter((e) => !(e.parent === parent && e.child === child));
  if (selEdge && selEdge.parent === parent && selEdge.child === child) { selEdge = null; renderInspector(); }
  render();
}
function addEdge(parent, child) {
  if (parent === child) return;
  if (graph.edges.some((e) => e.parent === parent && e.child === child)) return;
  if (reaches(child, parent)) { setStatus("нельзя: возникнет цикл", "err"); return; }
  const p = nodeById(parent);
  if (p.role === "gate" && p.op === "not" && childrenEdges(parent).length >= 1) {
    setStatus("НЕ принимает только один вход", "err"); return;
  }
  // Canonical СФЦ default: disjunctive (ИЛИ) arc, direct output.
  const e = { parent, child };
  if (graph.kind === "sfc") e.conj = false;
  graph.edges.push(e);
  render();
}
// does `from` reach `to` following parent->child?
function reaches(from, to) {
  const seen = new Set(); const st = [from];
  while (st.length) {
    const v = st.pop();
    if (v === to) return true;
    if (seen.has(v)) continue; seen.add(v);
    for (const e of childrenEdges(v)) st.push(e.child);
  }
  return false;
}
function edgeByPair(parent, child) {
  return graph.edges.find((x) => x.parent === parent && x.child === child);
}

function select(id) {
  selected = id;
  selEdge = null;
  renderInspector();
  renderNodes();
  renderEdges();
}
function selectEdge(parent, child) {
  selEdge = { parent, child };
  selected = null;
  renderInspector();
  renderNodes();
  renderEdges();
}

// ===========================================================================
// Работа мышью: двигать холст, таскать узел, тянуть связь, выбирать
// ===========================================================================
const canvas = $("canvas");
let drag = null; // {mode, ...}

canvas.addEventListener("mousedown", (ev) => {
  const portId = ev.target.dataset && ev.target.dataset.port;
  const nodeG = ev.target.closest && ev.target.closest(".node");
  const edgeId = ev.target.dataset && ev.target.dataset.edge;

  if (portId) {
    const n = nodeById(portId);
    const start = bottomPort(n);
    drag = { mode: "connect", from: portId, start };
    ev.preventDefault();
    return;
  }
  if (nodeG) {
    const id = nodeG.dataset.id;
    const n = nodeById(id);
    const w = screenToWorld(ev.clientX, ev.clientY);
    drag = { mode: "node", id, dx: w.x - n.x, dy: w.y - n.y, moved: false };
    nodeG.classList.add("dragging");
    ev.preventDefault();
    return;
  }
  if (edgeId) {
    // Click on an edge: select it (edit type/output in the inspector).
    const [p, c] = edgeId.split(">");
    selectEdge(p, c);
    return;
  }
  // Empty space: pan.
  drag = { mode: "pan", sx: ev.clientX, sy: ev.clientY, tx: view.tx, ty: view.ty, moved: false };
});

window.addEventListener("mousemove", (ev) => {
  if (!drag) return;
  if (drag.mode === "pan") {
    view.tx = drag.tx + (ev.clientX - drag.sx);
    view.ty = drag.ty + (ev.clientY - drag.sy);
    if (Math.abs(ev.clientX - drag.sx) + Math.abs(ev.clientY - drag.sy) > 3) drag.moved = true;
    render();
  } else if (drag.mode === "node") {
    const w = screenToWorld(ev.clientX, ev.clientY);
    const n = nodeById(drag.id);
    n.x = w.x - drag.dx; n.y = w.y - drag.dy; drag.moved = true;
    render();
  } else if (drag.mode === "connect") {
    const w = screenToWorld(ev.clientX, ev.clientY);
    const tmp = $("temp-layer");
    tmp.textContent = "";
    const path = document.createElementNS(SVGNS, "path");
    path.setAttribute("class", "temp-edge");
    path.setAttribute("d", edgePath(drag.start, w));
    tmp.appendChild(path);
  }
});

window.addEventListener("mouseup", (ev) => {
  if (!drag) return;
  if (drag.mode === "connect") {
    $("temp-layer").textContent = "";
    const nodeG = ev.target.closest && ev.target.closest(".node");
    if (nodeG) addEdge(drag.from, nodeG.dataset.id);
  } else if (drag.mode === "node") {
    document.querySelectorAll(".node.dragging").forEach((e) => e.classList.remove("dragging"));
    if (!drag.moved) select(drag.id);   // click without move = select
    render();
  } else if (drag.mode === "pan") {
    if (!drag.moved) select(null);       // click empty = deselect
  }
  drag = null;
});

canvas.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
  const r = canvas.getBoundingClientRect();
  const mx = ev.clientX - r.left, my = ev.clientY - r.top;
  // zoom around cursor
  const wx = (mx - view.tx) / view.s, wy = (my - view.ty) / view.s;
  view.s = Math.min(3, Math.max(0.2, view.s * factor));
  view.tx = mx - wx * view.s; view.ty = my - wy * view.s;
  render();
}, { passive: false });

canvas.addEventListener("keydown", (ev) => {
  if (ev.key === "Delete" || ev.key === "Backspace") {
    if (selected) { ev.preventDefault(); deleteNode(selected); }
    else if (selEdge) { ev.preventDefault(); deleteEdge(selEdge.parent, selEdge.child); }
  }
});

function fitView() {
  if (!graph.nodes.length) { view.tx = 40; view.ty = 40; view.s = 1; render(); return; }
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const n of graph.nodes) {
    minx = Math.min(minx, n.x); miny = Math.min(miny, n.y);
    maxx = Math.max(maxx, n.x + NODE_W); maxy = Math.max(maxy, n.y + NODE_H);
  }
  const r = canvas.getBoundingClientRect();
  const s = Math.min(2, Math.max(0.3, Math.min((r.width - 80) / (maxx - minx), (r.height - 80) / (maxy - miny))));
  view.s = s;
  view.tx = (r.width - (maxx - minx) * s) / 2 - minx * s;
  view.ty = (r.height - (maxy - miny) * s) / 2 - miny * s;
  render();
}

// ===========================================================================
// Инспектор (панель свойств справа)
// ===========================================================================
function renderInspector() {
  const body = $("inspector-body");
  body.textContent = "";
  if (selEdge) { renderEdgeInspector(body); return; }
  const n = selected ? nodeById(selected) : null;
  if (!n) { body.innerHTML = '<p class="hint">Выберите узел или связь, чтобы задать параметры.</p>'; return; }

  body.appendChild(el("h3", {}, (n.role === "gate" ? "Логический элемент" : n.role === "sfc" ? "Узел СФЦ" : "Событие")));

  // id
  body.appendChild(field("Идентификатор", inputEl("text", n.id, (v) => {
    v = v.trim();
    if (!v || nodeById(v) && v !== n.id) { setStatus("id пустой или занят", "err"); return; }
    const old = n.id;
    for (const e of graph.edges) { if (e.parent === old) e.parent = v; if (e.child === old) e.child = v; }
    n.id = v; if (selected === old) selected = v;
    render();
  })));

  // gate op / k
  if (n.role === "gate") {
    body.appendChild(field("Операция", selectEl(Object.keys(OP_LABEL).map((o) => [o, OP_LABEL[o]]), n.op, (v) => {
      n.op = v; renderInspector(); render();
    })));
    if (n.op === "atleast") {
      body.appendChild(field("k (порог)", inputEl("number", n.k || 2, (v) => { n.k = Math.max(1, +v || 1); render(); })));
    }
  }

  // distribution (events + sfc nodes)
  if (n.role === "event" || n.role === "sfc") {
    if (n.role === "sfc") {
      body.appendChild(fieldRow(checkboxEl(!!n.dist, (on) => {
        n.dist = on ? { type: "fixed", q: 0.1 } : null; renderInspector(); render();
      }), "Есть элемент (не фиктивный)"));
    }
    if (n.dist) buildDistEditor(body, n);
    if (n.role === "sfc" && childrenEdges(n.id).length > 0) {
      body.appendChild(el("p", { class: "meta" },
        "Тип входов (И / ИЛИ) задаётся на каждой дуге — выделите связь."));
    }
  }

  // top marker
  body.appendChild(fieldRow(checkboxEl(!!n.top, (on) => {
    graph.nodes.forEach((x) => (x.top = false));
    n.top = on; render();
  }), graph.kind === "sfc" ? "Вершина (критерий)" : "Вершинное событие"));

  const del = el("button", { class: "del" }, "Удалить узел");
  del.onclick = () => deleteNode(n.id);
  body.appendChild(del);
}

// Canonical СФЦ arc editor: kind (conjunctive/disjunctive) + output (direct/inverse).
function renderEdgeInspector(body) {
  const e = edgeByPair(selEdge.parent, selEdge.child);
  if (!e) { selEdge = null; body.innerHTML = '<p class="hint">Связь удалена.</p>'; return; }
  body.appendChild(el("h3", {}, "Связь (дуга)"));
  body.appendChild(el("div", { class: "meta" }, `${e.child} → ${e.parent}`));
  if (graph.kind === "sfc") {
    body.appendChild(field("Тип дуги", selectEl(
      [["disj", "Дизъюнктивная (ИЛИ)"], ["conj", "Конъюнктивная (И)"]],
      e.conj ? "conj" : "disj", (v) => { e.conj = v === "conj"; render(); renderInspector(); })));
    body.appendChild(field("Выход", selectEl(
      [["direct", "Прямой"], ["inverse", "Инверсный (¬)"]],
      e.inverse ? "inverse" : "direct", (v) => { e.inverse = v === "inverse"; render(); renderInspector(); })));
    body.appendChild(el("p", { class: "meta" },
      "Функция вершины: y = x · И(конъюнктивные) · ИЛИ(дизъюнктивные)."));
  } else {
    body.appendChild(el("p", { class: "meta" }, "Связь — вход логического элемента."));
  }
  const del = el("button", { class: "del" }, "Удалить связь");
  del.onclick = () => deleteEdge(e.parent, e.child);
  body.appendChild(del);
}

function buildDistEditor(body, n) {
  body.appendChild(field("Распределение", selectEl(
    Object.keys(DIST_NAMES).map((t) => [t, DIST_NAMES[t]]), n.dist.type, (v) => {
      n.dist = defaultDist(v); renderInspector(); render();
    })));
  if (n.dist.type === "markov") { buildMarkovEditor(body, n); return; }
  for (const [key, label, def, opt] of DIST_SCHEMA[n.dist.type]) {
    const cur = n.dist[key] != null ? n.dist[key] : "";
    body.appendChild(field(label, inputEl("text", cur, (v) => {
      v = v.trim();
      if (v === "" && opt) { delete n.dist[key]; }
      else { const num = +v; if (isFinite(num)) n.dist[key] = num; }
      render();
    })));
  }
}
function defaultDist(type) {
  if (type === "markov") return { type: "markov", states: ["ok", "fail"],
    transitions: [{ from: "ok", to: "fail", rate: 1e-3 }], failed: ["fail"], steady: false };
  const d = { type };
  for (const [k, , def, opt] of DIST_SCHEMA[type]) if (!opt) d[k] = def;
  return d;
}

function buildMarkovEditor(body, n) {
  const d = n.dist;
  normalizeMarkovDist(d);
  mkEnsurePos(d);
  // Read-only preview of the chain right in the inspector.
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("class", "mk-preview");
  body.appendChild(svg);
  mkDrawPreview(svg, d);

  const summary = el("div", { class: "meta" },
    `${(d.states || []).length} состояний · ${(d.transitions || []).length} переходов · ` +
    `отказ: ${(d.failed || []).join(", ") || "—"}` + (d.steady ? " · стационарный" : ""));
  body.appendChild(summary);

  const open = el("button", { class: "mk-open" }, "🗺 Открыть диаграмму переходов");
  open.onclick = () => openMarkov(n);
  body.appendChild(open);
}

// ===========================================================================
// Редактор марковской диаграммы (окно) + превью в инспекторе
// ===========================================================================
const MK_R = 30;            // state circle radius
const MK = { node: null, dist: null, sel: null, drag: null };

function mkEnsurePos(d) {
  d._pos = d._pos || {};
  const states = d.states || [];
  const missing = states.filter((s) => !d._pos[s]);
  if (missing.length) {
    const cx = 300, cy = 200, R = Math.min(150, 60 + states.length * 12);
    states.forEach((s, i) => {
      if (!d._pos[s]) {
        const a = (i / Math.max(1, states.length)) * 2 * Math.PI - Math.PI / 2;
        d._pos[s] = { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
      }
    });
  }
  // Drop positions of states that no longer exist.
  for (const k of Object.keys(d._pos)) if (!states.includes(k)) delete d._pos[k];
}

function mkInitialProb(d, name) {
  const i = (d.states || []).indexOf(name);
  if (d.initial && d.initial.length === d.states.length) return d.initial[i] || 0;
  return i === 0 ? 1 : 0;   // backend default: all mass on first state
}

// Geometry of a transition arrow between two states (trimmed to circles,
// curved aside when the reverse transition also exists).
function mkTransGeom(d, tr) {
  const a = d._pos[tr.from], b = d._pos[tr.to];
  if (!a || !b) return null;
  let dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const hasReverse = (d.transitions || []).some((t) => t.from === tr.to && t.to === tr.from);
  const off = hasReverse ? 16 : 0;              // perpendicular offset
  const px = -uy * off, py = ux * off;
  const sx = a.x + ux * MK_R + px, sy = a.y + uy * MK_R + py;
  const ex = b.x - ux * MK_R + px, ey = b.y - uy * MK_R + py;
  const mx = (sx + ex) / 2 + px, my = (sy + ey) / 2 + py;
  // Slight quadratic curve through the offset midpoint.
  const cx = mx, cy = my;
  return { d: `M${sx},${sy} Q${cx},${cy} ${ex},${ey}`, lx: cx, ly: cy - 4 };
}

function mkDrawInto(edgesG, statesG, d, interactive) {
  edgesG.textContent = ""; statesG.textContent = "";
  for (const tr of d.transitions || []) {
    const g = mkTransGeom(d, tr); if (!g) continue;
    if (interactive) {
      const hit = document.createElementNS(SVGNS, "path");
      hit.setAttribute("class", "mk-tr-hit"); hit.setAttribute("d", g.d);
      hit.dataset.tr = tr.from + ">" + tr.to; edgesG.appendChild(hit);
    }
    const p = document.createElementNS(SVGNS, "path");
    const selected = MK.sel && MK.sel.type === "trans" && MK.sel.from === tr.from && MK.sel.to === tr.to;
    p.setAttribute("class", "mk-tr" + (selected ? " selected" : "")); p.setAttribute("d", g.d);
    edgesG.appendChild(p);
    const lbl = text(g.lx, g.ly, trDistShort(tr.dist), "mk-tr-label");
    edgesG.appendChild(lbl);
  }
  for (const s of d.states || []) {
    const pos = d._pos[s]; if (!pos) continue;
    const failed = (d.failed || []).includes(s);
    const initial = mkInitialProb(d, s) > 0;
    const selected = MK.sel && MK.sel.type === "state" && MK.sel.name === s;
    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute("class", "mk-state" + (failed ? " failed" : "") + (initial ? " initial" : "") + (selected ? " selected" : ""));
    g.setAttribute("transform", `translate(${pos.x},${pos.y})`);
    g.dataset.state = s;
    const c = document.createElementNS(SVGNS, "circle");
    c.setAttribute("class", "circle"); c.setAttribute("r", MK_R);
    g.appendChild(c);
    g.appendChild(text(0, 4, s, null));
    if (initial) { const b = text(0, -MK_R - 5, "↧ старт", "init-badge"); g.appendChild(b); }
    if (interactive) {
      const port = document.createElementNS(SVGNS, "circle");
      port.setAttribute("class", "mk-port"); port.setAttribute("r", 6);
      port.setAttribute("cx", MK_R); port.setAttribute("cy", 0);
      port.dataset.mkport = s; g.appendChild(port);
    }
    statesG.appendChild(g);
  }
}

function mkDrawPreview(svg, d) {
  // Compute bounds and set a viewBox so the whole chain fits, read-only.
  svg.innerHTML = '<g class="e"></g><g class="s"></g>';
  const states = d.states || [];
  if (!states.length) { svg.innerHTML = '<text x="10" y="24" font-size="12" fill="#888">нет состояний</text>'; return; }
  mkDrawInto(svg.querySelector(".e"), svg.querySelector(".s"), d, false);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const s of states) { const p = d._pos[s]; minx = Math.min(minx, p.x); miny = Math.min(miny, p.y); maxx = Math.max(maxx, p.x); maxy = Math.max(maxy, p.y); }
  const pad = MK_R + 16;
  svg.setAttribute("viewBox", `${minx - pad} ${miny - pad} ${maxx - minx + 2 * pad} ${maxy - miny + 2 * pad}`);
}

// ---- modal open/close ----
function openMarkov(node) {
  MK.node = node; MK.dist = node.dist; MK.sel = null;
  normalizeMarkovDist(MK.dist);
  mkEnsurePos(MK.dist);
  $("mk-node-id").textContent = node.id;
  $("mk-steady").checked = !!MK.dist.steady;
  $("mk-modal").classList.remove("hidden");
  mkRefreshInitialSelect();
  mkRender();
  $("mk-tmax").value = "";
  mkPlotStatus("");
  mkPlot(); // auto-draw q(t) for the current node
}
function closeMarkov() { $("mk-modal").classList.add("hidden"); renderInspector(); render(); }

function mkRefreshInitialSelect() {
  const sel = $("mk-initial");
  const cur = mkCurrentInitialState();
  sel.innerHTML = "";
  sel.appendChild(el("option", { value: "__default" }, "первое (по умолчанию)"));
  for (const s of MK.dist.states || []) sel.appendChild(el("option", { value: s }, s));
  sel.value = cur || "__default";
}
function mkCurrentInitialState() {
  const d = MK.dist;
  if (!d.initial) return null;
  const i = d.initial.findIndex((x) => x >= 0.999);
  return i >= 0 ? d.states[i] : null;
}

function mkRender() {
  mkDrawInto($("mk-edges"), $("mk-states"), MK.dist, true);
  mkRenderSide();
  save();
}

function mkRenderSide() {
  const side = $("mk-side"); side.textContent = "";
  const d = MK.dist;
  if (!MK.sel) { side.appendChild(el("p", { class: "hint" }, "Выберите состояние или переход, либо добавьте состояние.")); return; }
  if (MK.sel.type === "state") {
    const name = MK.sel.name;
    side.appendChild(el("h3", {}, "Состояние"));
    side.appendChild(field("Имя", inputEl("text", name, (v) => mkRenameState(name, v.trim()))));
    side.appendChild(fieldRow(checkboxEl((d.failed || []).includes(name), (on) => {
      d.failed = d.failed || [];
      if (on && !d.failed.includes(name)) d.failed.push(name);
      if (!on) d.failed = d.failed.filter((x) => x !== name);
      mkRender();
    }), "Отказовое состояние"));
    const del = el("button", { class: "del" }, "Удалить состояние");
    del.onclick = () => mkDeleteState(name);
    side.appendChild(del);
  } else {
    const tr = (d.transitions || []).find((t) => t.from === MK.sel.from && t.to === MK.sel.to);
    if (!tr) { MK.sel = null; return mkRenderSide(); }
    if (!tr.dist) tr.dist = trDefaultDist("exponential");
    side.appendChild(el("h3", {}, "Переход"));
    side.appendChild(el("div", { class: "meta" }, `${tr.from} → ${tr.to}`));
    side.appendChild(field("Распределение времени", selectEl(
      Object.keys(TR_DIST_NAMES).map((t) => [t, TR_DIST_NAMES[t]]), tr.dist.type, (v) => {
        tr.dist = trDefaultDist(v); mkRender();
      })));
    for (const [key, label, def] of TR_DIST_SCHEMA[tr.dist.type]) {
      const cur = tr.dist[key] != null ? tr.dist[key] : def;
      side.appendChild(field(label, inputEl("text", cur, (v) => {
        const x = +v; if (isFinite(x)) tr.dist[key] = x; mkRender();
      })));
    }
    if (tr.dist.type !== "exponential") {
      side.appendChild(el("p", { class: "meta" }, "Неэкспоненциальный переход → узел считается как полумарковский процесс."));
    }
    const del = el("button", { class: "del" }, "Удалить переход");
    del.onclick = () => { d.transitions = d.transitions.filter((t) => t !== tr); MK.sel = null; mkRender(); };
    side.appendChild(del);
  }
}

function mkUniqueState() {
  const d = MK.dist; let i = d.states.length + 1;
  let name = "s" + i;
  while (d.states.includes(name)) { i++; name = "s" + i; }
  return name;
}
function mkAddState() {
  const d = MK.dist; const name = mkUniqueState();
  d.states.push(name);
  d._pos[name] = { x: 300 + (Math.random() * 80 - 40), y: 200 + (Math.random() * 80 - 40) };
  if (d.initial) d.initial.push(0);
  MK.sel = { type: "state", name };
  mkRefreshInitialSelect(); mkRender();
}
function mkRenameState(oldName, newName) {
  const d = MK.dist;
  if (!newName || (d.states.includes(newName) && newName !== oldName)) { setStatus("имя пустое или занято", "err"); return; }
  d.states = d.states.map((s) => (s === oldName ? newName : s));
  d._pos[newName] = d._pos[oldName]; if (newName !== oldName) delete d._pos[oldName];
  for (const t of d.transitions || []) { if (t.from === oldName) t.from = newName; if (t.to === oldName) t.to = newName; }
  d.failed = (d.failed || []).map((s) => (s === oldName ? newName : s));
  MK.sel = { type: "state", name: newName };
  mkRefreshInitialSelect(); mkRender();
}
function mkDeleteState(name) {
  const d = MK.dist;
  const i = d.states.indexOf(name);
  d.states = d.states.filter((s) => s !== name);
  delete d._pos[name];
  d.transitions = (d.transitions || []).filter((t) => t.from !== name && t.to !== name);
  d.failed = (d.failed || []).filter((s) => s !== name);
  if (d.initial && i >= 0) { d.initial.splice(i, 1); if (d.initial.every((x) => x === 0)) delete d.initial; }
  MK.sel = null;
  mkRefreshInitialSelect(); mkRender();
}
function mkAddTransition(from, to) {
  if (from === to) { setStatus("переход в себя недопустим", "err"); return; }
  const d = MK.dist;
  if ((d.transitions || []).some((t) => t.from === from && t.to === to)) {
    MK.sel = { type: "trans", from, to }; mkRender(); return;
  }
  d.transitions = d.transitions || [];
  d.transitions.push({ from, to, dist: trDefaultDist("exponential") });
  MK.sel = { type: "trans", from, to };
  mkRender();
}

// ---- живой график q(t) (считает тот же бэкенд) ----
const MKCHART = { pts: [], xmax: 0, geom: null };

function jsClockScale(dist) {
  switch (dist.type) {
    case "exponential": return 1 / (dist.rate || 1e-9);
    case "weibull": return dist.scale;
    case "gamma": return dist.shape / (dist.rate || 1e-9);
    case "lognormal": return Math.exp(dist.mu);
    case "normal": return dist.mean;
    case "deterministic": return dist.delay;
    default: return 100;
  }
}
function mkSuggestTmax() {
  let m = 0;
  for (const tr of MK.dist.transitions || []) if (tr.dist) m = Math.max(m, jsClockScale(tr.dist));
  return m > 0 ? m * 3 : 1000;
}
function mkPlotStatus(s) { $("mk-plot-status").textContent = s; }

async function mkPlot() {
  const d = MK.dist;
  if (!(d.states || []).length) return mkPlotStatus("нет состояний");
  if (!(d.failed || []).length) return mkPlotStatus("не отмечены отказовые состояния");
  let xmax = +$("mk-tmax").value;
  if (!isFinite(xmax) || xmax <= 0) { xmax = mkSuggestTmax(); $("mk-tmax").value = fmtNum(xmax); }
  const N = 60;
  const times = [];
  for (let i = 0; i < N; i++) times.push((xmax * i) / (N - 1));
  const req = { model: { type: "fault_tree", top: "x", events: [{ id: "x", dist: cleanDist(d) }], gates: [] }, times };
  mkPlotStatus("расчёт…");
  try {
    const r = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) });
    const data = await r.json();
    if (!r.ok) return mkPlotStatus(data.error || "HTTP " + r.status);
    const pts = data.results.map((x) => ({ t: x.time, q: x.top_probability }));
    drawQChart(pts, xmax);
    mkPlotStatus("q(" + fmtNum(xmax) + ") = " + fmtP(pts[pts.length - 1].q));
  } catch (e) { mkPlotStatus("ошибка: " + e.message); }
}

function drawQChart(pts, xmax) {
  const svg = $("mk-chart-svg");
  const rect = svg.getBoundingClientRect();
  const W = rect.width, H = rect.height;
  if (W < 10 || H < 10) { setTimeout(() => drawQChart(pts, xmax), 40); return; }
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.textContent = "";
  const L = 46, R = 50, T = 12, B = 24;
  const x = (t) => L + (xmax > 0 ? t / xmax : 0) * (W - L - R);
  const y = (q) => H - B - q * (H - T - B);
  MKCHART.pts = pts; MKCHART.xmax = xmax; MKCHART.geom = { L, R, T, B, W, H, x, y };

  const add = (n) => svg.appendChild(n);
  // Recessive gridlines + y ticks (q = 0..1).
  for (const q of [0, 0.25, 0.5, 0.75, 1]) {
    const line = document.createElementNS(SVGNS, "line");
    line.setAttribute("class", q === 0 ? "ch-axis" : "ch-grid");
    line.setAttribute("x1", L); line.setAttribute("x2", W - R);
    line.setAttribute("y1", y(q)); line.setAttribute("y2", y(q));
    add(line);
    const lbl = text(L - 6, y(q) + 3, q.toString(), "ch-tick");
    lbl.setAttribute("text-anchor", "end"); add(lbl);
  }
  // x axis + ticks.
  const ax = document.createElementNS(SVGNS, "line");
  ax.setAttribute("class", "ch-axis");
  ax.setAttribute("x1", L); ax.setAttribute("x2", L);
  ax.setAttribute("y1", T); ax.setAttribute("y2", H - B); add(ax);
  for (let i = 0; i <= 4; i++) {
    const t = (xmax * i) / 4;
    const lbl = text(x(t), H - B + 14, fmtNum(t), "ch-tick");
    lbl.setAttribute("text-anchor", "middle"); add(lbl);
  }
  // Single-series line (title in the panel head names it — no legend).
  let dpath = "";
  pts.forEach((p, i) => { dpath += (i ? "L" : "M") + x(p.t) + "," + y(p.q); });
  const path = document.createElementNS(SVGNS, "path");
  path.setAttribute("class", "ch-line"); path.setAttribute("d", dpath); add(path);
  // Direct-label the final value.
  const last = pts[pts.length - 1];
  const dot = document.createElementNS(SVGNS, "circle");
  dot.setAttribute("class", "ch-end"); dot.setAttribute("cx", x(last.t)); dot.setAttribute("cy", y(last.q)); dot.setAttribute("r", 3); add(dot);
  const el2 = text(x(last.t) + 5, y(last.q) + 3, fmtP(last.q), "ch-end-label"); add(el2);
  // Hover overlay group (populated on mousemove).
  const ov = document.createElementNS(SVGNS, "g"); ov.setAttribute("id", "ch-overlay"); add(ov);
}

function mkChartHover(ev) {
  const g = MKCHART.geom; if (!g || !MKCHART.pts.length) return;
  const svg = $("mk-chart-svg"); const rect = svg.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const t = g.xmax * (mx - g.L) / (g.W - g.L - g.R);
  if (t < 0 || t > g.xmax) return mkChartHoverClear();
  // nearest point
  let best = 0, bd = Infinity;
  MKCHART.pts.forEach((p, i) => { const dd = Math.abs(p.t - t); if (dd < bd) { bd = dd; best = i; } });
  const p = MKCHART.pts[best];
  const ov = $("ch-overlay"); if (!ov) return; ov.textContent = "";
  const cx = g.x(p.t), cy = g.y(p.q);
  const cross = document.createElementNS(SVGNS, "line");
  cross.setAttribute("class", "ch-cross"); cross.setAttribute("x1", cx); cross.setAttribute("x2", cx);
  cross.setAttribute("y1", g.T); cross.setAttribute("y2", g.H - g.B); ov.appendChild(cross);
  const dot = document.createElementNS(SVGNS, "circle");
  dot.setAttribute("class", "ch-dot"); dot.setAttribute("cx", cx); dot.setAttribute("cy", cy); dot.setAttribute("r", 4); ov.appendChild(dot);
  const label = `t=${fmtNum(p.t)}  q=${fmtP(p.q)}`;
  const tw = label.length * 6.4 + 10;
  let bx = cx + 8; if (bx + tw > g.W - g.R) bx = cx - 8 - tw;
  const by = Math.max(g.T + 2, cy - 22);
  const bg = document.createElementNS(SVGNS, "rect");
  bg.setAttribute("class", "ch-tip-bg"); bg.setAttribute("x", bx); bg.setAttribute("y", by);
  bg.setAttribute("width", tw); bg.setAttribute("height", 18); bg.setAttribute("rx", 4); ov.appendChild(bg);
  const tip = text(bx + 5, by + 13, label, "ch-tip"); ov.appendChild(tip);
}
function mkChartHoverClear() { const ov = $("ch-overlay"); if (ov) ov.textContent = ""; }

