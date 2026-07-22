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

