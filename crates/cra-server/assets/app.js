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
// graph.prob: "q" | "p" — в каком виде задавать постоянные вероятности новых
//   узлов (отказ q или успех p); его же показывает галочка «успех p у всех».
// graph.edges: { parent, child, inverse?, conj? }
//   смысл: `child` — это ВХОД для `parent` (ребёнок питает родителя).
//   рисуем: линия от нижнего порта ребёнка (источника) вниз к родителю.
// graph.options: настройки расчёта из открытого файла (нет — значения редактора)
// ---------------------------------------------------------------------------
let graph = { kind: "fault_tree", nodes: [], edges: [] };
let selNodes = new Set();      // id выбранных узлов (можно несколько)
let selEdge = null;            // выбранная связь {parent, child} (или null)
let seq = 0;                   // счётчик для новых id
const view = { tx: 40, ty: 40, s: 1 }; // сдвиг и масштаб холста
const NODE_W = 132, NODE_H = 52;
// Инструмент «Новая дуга» (СФЦ): с каким типом и выходом создаётся следующая
// дуга. Это настройка редактора, а не схемы, — в документ не попадает.
let arcStyle = { conj: false, inverse: false };
// «Считать»: что, кроме вероятности вершины, просить у сервера. Тоже настройка
// редактора (галочки в шапке панели результатов), изначально включено всё.
let calc = { cut_sets: true, path_sets: true, bdd: true, importance: true, curve: true };
// Флаги движка (опции запроса). curve — только интерфейс: кривая P(t) в
// результатах, в запрос и в файл не попадает.
const CALC_ENGINE = ["cut_sets", "path_sets", "importance", "bdd"];
function calcOptions() {
  const o = {};
  for (const k of CALC_ENGINE) o[k] = calc[k];
  return o;
}

// ---- схема параметров распределений (числовые поля) ----
const DIST_SCHEMA = {
  fixed:       [["q", "q (вероятность отказа)", 0.01]],
  exponential: [["lambda", "λ (интенсивность)", 1e-4], ["mu", "μ (ремонт, опц.)", "", true]],
  weibull:     [["shape", "форма (k)", 2], ["scale", "масштаб (λ)", 10000]],
  lognormal:   [["mu", "μ", 7], ["sigma", "σ", 0.5]],
  normal:      [["mean", "среднее", 10000], ["std", "ст. отклонение", 2000]],
  uniform:     [["a", "a", 0], ["b", "b", 10000]],
  gamma:       [["shape", "форма", 3], ["rate", "интенсивность", 1e-3]],
};
const DIST_NAMES = {
  fixed: "Постоянная вероятность", exponential: "Экспоненциальное", weibull: "Вейбулла",
  lognormal: "Логнормальное", normal: "Нормальное", uniform: "Равномерное",
  gamma: "Гамма", markov: "Марковский узел",
};
// Постоянная вероятность задаётся одним числом: вероятностью отказа q или
// вероятностью успеха p = 1 − q. Какое из двух — решает узел (в dist лежит
// либо q, либо p), движок понимает оба. Переключение пересчитывает число,
// поэтому расчёт от него не меняется.
const PROB_LABEL = { q: "q (вероятность отказа)", p: "p (вероятность успеха)" };
function probKey(d) { return d.p != null ? "p" : "q"; }
// 1 − x с округлением до 15 знаков после запятой: 1 − 0.7 даёт
// 0.30000000000000004, а ждут 0.3.
function complement(x) { return +(1 - x).toFixed(15); }
function setProbKey(d, key) {
  if (!d || d.type !== "fixed" || probKey(d) === key) return;
  const other = key === "p" ? "q" : "p";
  d[key] = complement(+d[other]); delete d[other];
}
// Новая постоянная вероятность — в том виде, что выбран для схемы.
function fixedDist(q) { const d = { type: "fixed", q }; setProbKey(d, graph.prob || "q"); return d; }
// Числовые поля распределения: у постоянной вероятности поле одно, q или p.
function distFields(d) {
  if (d.type !== "fixed") return DIST_SCHEMA[d.type];
  const k = probKey(d);
  return [[k, PROB_LABEL[k], DIST_SCHEMA.fixed[0][2]]];
}

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
// Марковские узлы приводятся к полной форме (у переходов `dist`, у состояний
// координаты) сразу, как схема попала в редактор. Инспектор делает то же
// самое, но тогда простой выбор узла менял бы схему и становился шагом
// истории правок, который нечем отменить.
function normalizeGraph(g) {
  for (const n of g.nodes) {
    if (n.dist && n.dist.type === "markov") { normalizeMarkovDist(n.dist); mkEnsurePos(n.dist); }
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
    { label: "Узел (элемент)", make: () => ({ role: "sfc", dist: fixedDist(0.1) }) },
    { label: "Фиктивный узел", make: () => ({ role: "sfc", dist: null }) },
  ],
};

// ===========================================================================
// Хранение (localStorage): не потерять схему
// ===========================================================================
function save() {
  const s = JSON.stringify(graph);
  try { localStorage.setItem("cra.graph", s); } catch (e) {}
  record(s);
}
function load() {
  try {
    const s = localStorage.getItem("cra.graph");
    if (s) { graph = JSON.parse(s); normalizeGraph(graph); seq = graph.nodes.reduce((m, n) => Math.max(m, idNum(n.id)), 0); }
  } catch (e) {}
}
function idNum(id) { const m = /(\d+)$/.exec(id); return m ? +m[1] : 0; }
// Выбранный тип новой дуги хранится отдельно от схемы: он переживает
// «Очистить», открытие файла и перезагрузку страницы.
function loadArcStyle() {
  try {
    const s = JSON.parse(localStorage.getItem("cra.arc"));
    if (s) arcStyle = { conj: !!s.conj, inverse: !!s.inverse };
  } catch (e) {}
}
function setArcStyle(patch) {
  Object.assign(arcStyle, patch);
  try { localStorage.setItem("cra.arc", JSON.stringify(arcStyle)); } catch (e) {}
  renderArcTool();
}
// Выбор «Считать» хранится так же: он переживает перезагрузку, «Очистить» и
// открытие файлов — флаги из открытого файла его не меняют.
function loadCalc() {
  try {
    const s = JSON.parse(localStorage.getItem("cra.calc"));
    if (s) for (const k of Object.keys(calc)) if (typeof s[k] === "boolean") calc[k] = s[k];
  } catch (e) {}
}
function setCalc(key, on) {
  calc[key] = on;
  try { localStorage.setItem("cra.calc", JSON.stringify(calc)); } catch (e) {}
  renderCalc();
  // Вкладка JSON показывает документ схемы — с новыми флагами.
  if ($("tab-json").classList.contains("active") && !jsonEdited && graph.nodes.length) setJsonText(graphToDocument().doc);
}
function renderCalc() {
  for (const c of document.querySelectorAll("[data-calc]")) c.checked = calc[c.dataset.calc];
}

// ===========================================================================
// История правок: отменить (Ctrl+Z) и повторить (Ctrl+Y)
// ===========================================================================
// Шаг истории — снимок всей схемы, та же JSON-строка, которую save() кладёт в
// localStorage после каждой правки. Если строка изменилась, прежняя уходит в
// стек отмены. Выделение, сдвиг и масштаб холста в схему не входят, поэтому
// шагов не создают.
const HISTORY_LIMIT = 100;
const hist = { undo: [], redo: [], cur: null };

function record(s) {
  if (s === hist.cur || historyHeld()) return;
  if (hist.cur !== null) {
    hist.undo.push(hist.cur);
    if (hist.undo.length > HISTORY_LIMIT) hist.undo.shift();
  }
  hist.redo.length = 0;   // новая правка обрывает ветку отменённого
  hist.cur = s;
  renderHistory();
}
// Пока узел тащат или открыто окно марковской диаграммы, промежуточные
// состояния не записываются: всё перетаскивание и все правки в окне — один
// шаг, он запишется, когда кнопку мыши отпустят или окно закроют.
function historyHeld() {
  return (drag && drag.mode === "node") || !$("mk-modal").classList.contains("hidden");
}
function undo() { step(hist.undo, hist.redo, "правка отменена"); }
function redo() { step(hist.redo, hist.undo, "правка повторена"); }
// Перейти к соседнему снимку; текущий уходит в противоположный стек.
function step(from, to, msg) {
  if (!from.length || historyHeld()) return;
  to.push(hist.cur);
  hist.cur = from.pop();
  graph = JSON.parse(hist.cur);
  seq = graph.nodes.reduce((m, n) => Math.max(m, idNum(n.id)), 0);
  // Выделение остаётся, если выделенное есть и в восстановленной схеме.
  selNodes = new Set([...selNodes].filter((id) => nodeById(id)));
  if (selEdge && !edgeByPair(selEdge.parent, selEdge.child)) selEdge = null;
  $("kind").value = graph.kind;   // шаг мог отменить смену типа модели
  buildPalette(); renderInspector(); render(); renderHistory();
  setStatus(msg, "ok");   // прежнее сообщение могло относиться к отменённому
}
function renderHistory() {
  $("undo").disabled = !hist.undo.length;
  $("redo").disabled = !hist.redo.length;
}

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
// CSS-класс вида узла. Узел СФЦ без собственного элемента (dist = null) —
// фиктивный: чистая логика, и рисуется он иначе, чем реальный элемент.
function nodeKind(n) { return n.role + (n.role === "sfc" && !n.dist ? " fictive" : ""); }
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
  renderProbAll();
  save();
}

function renderNodes() {
  const layer = $("nodes-layer");
  layer.textContent = "";
  const st = hlState();
  canvas.classList.toggle("hl", !!st);
  canvas.classList.toggle("hl-cut", !!st && hl.which !== "path");
  canvas.classList.toggle("hl-path", !!st && hl.which === "path");
  renderHlBanner(st);
  for (const n of graph.nodes) {
    const g = document.createElementNS(SVGNS, "g");
    const lit = !st ? "" : st.src.has(n.id) ? " hl-src" : st.hit.has(n.id) ? " hl-via" : "";
    g.setAttribute("class", "node " + nodeKind(n) + (selNodes.has(n.id) ? " selected" : "") + (n.top ? " top" : "") + lit);
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

    // Порт — выход узла, от него тянут связь. Выход есть у любого узла, в том
    // числе у события дерева отказов: событие — вход для элемента.
    const port = document.createElementNS(SVGNS, "circle");
    port.setAttribute("class", "port");
    port.setAttribute("cx", NODE_W / 2); port.setAttribute("cy", NODE_H);
    port.setAttribute("r", 6);
    port.dataset.port = n.id;
    g.appendChild(port);
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
    case "fixed": return probKey(d) + "=" + fmtNum(d[probKey(d)]);
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
  const st = hlState();
  for (const e of graph.edges) {
    const p = nodeById(e.parent), c = nodeById(e.child);
    if (!p || !c) continue;
    // Arc is drawn source (child, provides the signal) -> consumer (parent,
    // owns the input), matching the drag gesture direction in addEdge below.
    const a = bottomPort(c), b = topCenter(p);
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
    path.setAttribute("class", "edge" + (e.inverse ? " inverse" : "") + kindCls + (isSel ? " selected" : "") +
      (st && hlEdge(st, e) ? " hl-via" : ""));
    path.setAttribute("d", d);
    // The visible line lies on top of the hit area, so it must carry the id
    // too — otherwise a click right on the line would miss the edge.
    path.dataset.edge = hit.dataset.edge;
    layer.appendChild(path);

    if (sfc) {
      const mid = text((a.x + b.x) / 2, (a.y + b.y) / 2 - 3, arcBadge(e), "edge-label" + (e.conj ? " conj" : " disj") +
        (path.classList.contains("hl-via") ? " hl-via" : ""));
      mid.setAttribute("text-anchor", "middle");
      layer.appendChild(mid);
    } else if (e.inverse) {
      const mid = text((a.x + b.x) / 2, (a.y + b.y) / 2 - 3, "¬", "edge-label");
      mid.setAttribute("text-anchor", "middle");
      layer.appendChild(mid);
    }
  }
}
// Canonical СФЦ arc badge: & (conjunctive) / ≥1 (disjunctive), + ¬ if inverse.
// Takes a real edge or arcStyle (the badge on the arc being dragged).
function arcBadge(a) { return (a.conj ? "&" : "≥1") + (a.inverse ? " ¬" : ""); }
function edgePath(a, b) {
  // The control-point offset must grow with the horizontal gap too, not just
  // the vertical one — otherwise a wide, nearly-level edge keeps curving right
  // up to the endpoint instead of straightening out, so the marker (arrow/dot)
  // ends up rotated correctly but visually meets the node off-center.
  const dy = Math.max(24, Math.abs(b.y - a.y) / 2, Math.abs(b.x - a.x) / 3);
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
// Удалить узлы вместе со всеми их связями — одной правкой, то есть одним
// шагом истории, сколько бы узлов ни было.
function deleteNodes(ids) {
  const gone = new Set(ids);
  graph.nodes = graph.nodes.filter((n) => !gone.has(n.id));
  graph.edges = graph.edges.filter((e) => !gone.has(e.parent) && !gone.has(e.child));
  selectNodes([...selNodes].filter((id) => !gone.has(id)));
  if (gone.size > 1) setStatus(`удалено узлов: ${gone.size} (Ctrl+Z — вернуть)`, "ok");
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
  // СФЦ: тип и выход берём из инструмента «Новая дуга» (изначально —
  // дизъюнктивная с прямым выходом, как в канонической СФЦ).
  const e = { parent, child };
  if (graph.kind === "sfc") applyArcStyle(e);
  graph.edges.push(e);
  render();
}
// Связь тянули от порта узла `from` и бросили на узел `to`. В СФЦ жест и
// задаёт направление: `to` принимает сигнал `from`. В дереве отказов вход
// бывает только у логического элемента, поэтому событие с элементом можно
// связать в любую сторону — событие всегда станет входом. Между двумя
// элементами направление по-прежнему задаёт жест.
function connect(from, to) {
  if (from === to) return;
  if (graph.kind === "fault_tree" && nodeById(to).role === "event") {
    if (nodeById(from).role === "event") {
      setStatus("два события не связать: вход бывает только у логического элемента", "err"); return;
    }
    addEdge(from, to);   // тянули от элемента к событию: событие — его вход
    return;
  }
  addEdge(to, from);
}
function applyArcStyle(e) {
  e.conj = arcStyle.conj;
  if (arcStyle.inverse) e.inverse = true; else delete e.inverse;
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

function select(id) { selectNodes(id ? [id] : []); }
function selectNodes(ids) {
  selNodes = new Set(ids);
  selEdge = null;
  renderInspector();
  renderNodes();
  renderEdges();
}
// Ctrl/Shift+клик по узлу: добавить к выделению или убрать из него.
function toggleNode(id) {
  const s = new Set(selNodes);
  if (!s.delete(id)) s.add(id);
  selectNodes(s);
}
function selectEdge(parent, child) {
  selEdge = { parent, child };
  selNodes = new Set();
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
    // Узел из выделения тащит за собой всю группу, невыделенный — только себя.
    const ids = selNodes.has(id) ? [...selNodes] : [id];
    drag = { mode: "node", id, w0: screenToWorld(ev.clientX, ev.clientY),
      start: ids.map((k) => { const n = nodeById(k); return { n, x: n.x, y: n.y }; }),
      toggle: ev.ctrlKey || ev.metaKey || ev.shiftKey, sx: ev.clientX, sy: ev.clientY, moved: false };
    nodeG.classList.add("dragging");
    ev.preventDefault();
    return;
  }
  if (edgeId) {
    // Click on an edge: select it (edit type/output in the inspector).
    // Shift+click in СФЦ first gives it the type from «Новая дуга».
    const [p, c] = edgeId.split(">");
    if (ev.shiftKey && graph.kind === "sfc") { applyArcStyle(edgeByPair(p, c)); save(); }
    selectEdge(p, c);
    return;
  }
  // Shift+тянуть по пустому месту — рамка: добавляет к выделению узлы,
  // целиком попавшие в неё.
  if (ev.shiftKey) {
    if (selEdge) selectNodes([]);   // рамка выделяет узлы, а не дугу
    drag = { mode: "frame", w0: screenToWorld(ev.clientX, ev.clientY), base: new Set(selNodes) };
    ev.preventDefault();
    return;
  }
  // Empty space: pan. Промах мимо узла при Ctrl+клике не сбрасывает
  // набранное выделение.
  drag = { mode: "pan", sx: ev.clientX, sy: ev.clientY, tx: view.tx, ty: view.ty, moved: false,
    keep: ev.ctrlKey || ev.metaKey };
});

window.addEventListener("mousemove", (ev) => {
  if (!drag) return;
  if (drag.mode === "pan") {
    view.tx = drag.tx + (ev.clientX - drag.sx);
    view.ty = drag.ty + (ev.clientY - drag.sy);
    if (Math.abs(ev.clientX - drag.sx) + Math.abs(ev.clientY - drag.sy) > 3) drag.moved = true;
    render();
  } else if (drag.mode === "node") {
    // Тот же порог в 3 px, что у панорамы: дрогнувшая рука не превращает клик
    // по узлу в перемещение (и в шаг истории).
    if (!drag.moved && Math.abs(ev.clientX - drag.sx) + Math.abs(ev.clientY - drag.sy) <= 3) return;
    const w = screenToWorld(ev.clientX, ev.clientY);
    const dx = w.x - drag.w0.x, dy = w.y - drag.w0.y;
    for (const p of drag.start) { p.n.x = p.x + dx; p.n.y = p.y + dy; }
    drag.moved = true;
    render();
  } else if (drag.mode === "connect") {
    const w = screenToWorld(ev.clientX, ev.clientY);
    const tmp = $("temp-layer");
    tmp.textContent = "";
    // В СФЦ тянущаяся дуга сразу показывает, какой она станет.
    const sfc = graph.kind === "sfc";
    const kindCls = sfc ? (arcStyle.conj ? " conj" : " disj") : "";
    const path = document.createElementNS(SVGNS, "path");
    path.setAttribute("class", "temp-edge" + kindCls);
    path.setAttribute("d", edgePath(drag.start, w));
    tmp.appendChild(path);
    if (sfc) tmp.appendChild(text(w.x + 10, w.y - 8, arcBadge(arcStyle), "edge-label" + kindCls));
  } else if (drag.mode === "frame") {
    const w = screenToWorld(ev.clientX, ev.clientY);
    const x0 = Math.min(drag.w0.x, w.x), y0 = Math.min(drag.w0.y, w.y);
    const x1 = Math.max(drag.w0.x, w.x), y1 = Math.max(drag.w0.y, w.y);
    const tmp = $("temp-layer");
    tmp.textContent = "";
    const r = document.createElementNS(SVGNS, "rect");
    r.setAttribute("class", "sel-frame");
    r.setAttribute("x", x0); r.setAttribute("y", y0);
    r.setAttribute("width", x1 - x0); r.setAttribute("height", y1 - y0);
    tmp.appendChild(r);
    // Выделение растёт по ходу жеста: сразу видно, что попадёт в рамку.
    selNodes = new Set(drag.base);
    for (const n of graph.nodes) {
      if (n.x >= x0 && n.y >= y0 && n.x + NODE_W <= x1 && n.y + NODE_H <= y1) selNodes.add(n.id);
    }
    renderNodes();
  }
});

window.addEventListener("mouseup", (ev) => {
  if (!drag) return;
  // Жест закончен до render(): пока drag в режиме "node", история стоит
  // (historyHeld), а этот render() как раз должен записать перемещение.
  const d = drag;
  drag = null;
  if (d.mode === "connect") {
    $("temp-layer").textContent = "";
    const nodeG = ev.target.closest && ev.target.closest(".node");
    // Кто чей вход, решает connect: обычно брошенный узел принимает сигнал
    // того, от чьего порта тянули.
    if (nodeG) connect(d.from, nodeG.dataset.id);
  } else if (d.mode === "node") {
    document.querySelectorAll(".node.dragging").forEach((e) => e.classList.remove("dragging"));
    // Клик без движения выделяет узел, с Ctrl или Shift — добавляет или убирает.
    if (!d.moved) { if (d.toggle) toggleNode(d.id); else select(d.id); }
    render();
  } else if (d.mode === "pan") {
    if (!d.moved && !d.keep) select(null);   // click empty = deselect
  } else if (d.mode === "frame") {
    $("temp-layer").textContent = "";
    selectNodes(selNodes);   // инспектор — по итогу жеста, а не на каждое движение
  }
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

// Del: выделенные узлы (со связями) или выделенная дуга.
function deleteSelection() {
  if (selNodes.size) deleteNodes(selNodes);
  else if (selEdge) deleteEdge(selEdge.parent, selEdge.child);
}

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
  if (selNodes.size > 1) { renderGroupInspector(body); return; }
  const n = selNodes.size ? nodeById([...selNodes][0]) : null;
  if (!n) { body.innerHTML = '<p class="hint">Выберите узел или связь, чтобы задать параметры.</p>'; return; }

  body.appendChild(el("h3", {}, (n.role === "gate" ? "Логический элемент" : n.role === "sfc" ? "Узел СФЦ" : "Событие")));

  // id
  body.appendChild(field("Идентификатор", inputEl("text", n.id, (v) => {
    v = v.trim();
    if (!v || nodeById(v) && v !== n.id) { setStatus("id пустой или занят", "err"); return; }
    const old = n.id;
    for (const e of graph.edges) { if (e.parent === old) e.parent = v; if (e.child === old) e.child = v; }
    n.id = v; if (selNodes.delete(old)) selNodes.add(v);
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
        n.dist = on ? fixedDist(0.1) : null; renderInspector(); render();
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
  del.onclick = () => deleteNodes([n.id]);
  body.appendChild(del);
}

// Выделено несколько узлов. Общих свойств у них нет, поэтому панель показывает
// состав выделения и удаляет его целиком.
const GROUP_CHIPS = 60;   // больше имён панель не перечисляет
function renderGroupInspector(body) {
  const ids = graph.nodes.filter((n) => selNodes.has(n.id)).map((n) => n.id);
  const links = graph.edges.filter((e) => selNodes.has(e.parent) || selNodes.has(e.child)).length;
  body.appendChild(el("h3", {}, "Выделено узлов: " + ids.length));
  const chips = el("div", { class: "chips" });
  for (const id of ids.slice(0, GROUP_CHIPS)) chips.append(el("span", {}, id));
  if (ids.length > GROUP_CHIPS) chips.append(` … и ещё ${ids.length - GROUP_CHIPS}`);
  body.appendChild(chips);
  body.appendChild(el("p", { class: "meta" },
    "Ctrl+клик или Shift+клик по узлу — добавить к выделению или убрать, " +
    "Shift+тянуть по холсту — добавить рамкой. " +
    "Тянуть любой выделенный узел — двигать всю группу. Esc — снять выделение."));
  const del = el("button", { class: "del" }, `Удалить выделенные (${ids.length})`);
  del.onclick = () => deleteNodes(ids);
  body.appendChild(del);
  if (links) body.appendChild(el("p", { class: "meta" }, "Вместе с узлами удалятся и их связи: " + links + "."));
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
  if (n.dist.type === "fixed") {
    body.appendChild(field("Задана как", selectEl(
      [["q", "Вероятность отказа q"], ["p", "Вероятность успеха p = 1 − q"]], probKey(n.dist), (v) => {
        setProbKey(n.dist, v); renderInspector(); render();
      })));
  }
  for (const [key, label, def, opt] of distFields(n.dist)) {
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
  if (type === "fixed") return fixedDist(DIST_SCHEMA.fixed[0][2]);
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
const MKCHART = { pts: [], geom: null };

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
    const pts = data.results.map((x) => ({ t: x.time, v: x.top_probability }));
    drawChart($("mk-chart-svg"), MKCHART, pts, xmax, { ymax: 1, name: "q" });
    mkPlotStatus("q(" + fmtNum(xmax) + ") = " + fmtP(pts[pts.length - 1].v));
  } catch (e) { mkPlotStatus("ошибка: " + e.message); }
}

// ---- линейный график: q(t) марковского узла, P(t) системы ----
// Один ряд точек {t, v}. st хранит точки и геометрию для подсказки при
// наведении. opts: ymax — верх оси значений (1 для вероятности узла, «круглое»
// число над максимумом — для системы, иначе малые вероятности слипнутся у
// нуля); name — буква значения в подсказке; marks — моменты, отмеченные точками.
function drawChart(svg, st, pts, xmax, opts) {
  const rect = svg.getBoundingClientRect();
  const W = rect.width, H = rect.height;
  if (W < 10 || H < 10) {
    if (svg.isConnected) setTimeout(() => drawChart(svg, st, pts, xmax, opts), 40);
    return;
  }
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.textContent = "";
  const ymax = opts.ymax || 1;
  const L = 52, R = 56, T = 12, B = 24;
  const x = (t) => L + (xmax > 0 ? t / xmax : 0) * (W - L - R);
  const y = (v) => H - B - (v / ymax) * (H - T - B);
  Object.assign(st, { pts, name: opts.name || "q", geom: { L, R, T, B, W, H, xmax, x, y } });

  const add = (n) => svg.appendChild(n);
  // Recessive gridlines + y ticks.
  for (let i = 0; i <= 4; i++) {
    const v = +((ymax * i) / 4).toPrecision(6);
    const line = document.createElementNS(SVGNS, "line");
    line.setAttribute("class", i === 0 ? "ch-axis" : "ch-grid");
    line.setAttribute("x1", L); line.setAttribute("x2", W - R);
    line.setAttribute("y1", y(v)); line.setAttribute("y2", y(v));
    add(line);
    const lbl = text(L - 6, y(v) + 3, fmtNum(v), "ch-tick");
    lbl.setAttribute("text-anchor", "end"); add(lbl);
  }
  // x axis + ticks.
  const ax = document.createElementNS(SVGNS, "line");
  ax.setAttribute("class", "ch-axis");
  ax.setAttribute("x1", L); ax.setAttribute("x2", L);
  ax.setAttribute("y1", T); ax.setAttribute("y2", H - B); add(ax);
  for (let i = 0; i <= 4; i++) {
    const t = +((xmax * i) / 4).toPrecision(6);
    const lbl = text(x(t), H - B + 14, fmtNum(t), "ch-tick");
    lbl.setAttribute("text-anchor", "middle"); add(lbl);
  }
  // Single-series line (title in the panel head names it — no legend).
  let dpath = "";
  pts.forEach((p, i) => { dpath += (i ? "L" : "M") + x(p.t) + "," + y(p.v); });
  const path = document.createElementNS(SVGNS, "path");
  path.setAttribute("class", "ch-line"); path.setAttribute("d", dpath); add(path);
  for (const t of opts.marks || []) {
    const p = pts.find((q) => q.t === t);
    if (!p) continue;
    const m = document.createElementNS(SVGNS, "circle");
    m.setAttribute("class", "ch-mark"); m.setAttribute("cx", x(p.t)); m.setAttribute("cy", y(p.v)); m.setAttribute("r", 3.5); add(m);
  }
  // Direct-label the final value.
  const last = pts[pts.length - 1];
  const dot = document.createElementNS(SVGNS, "circle");
  dot.setAttribute("class", "ch-end"); dot.setAttribute("cx", x(last.t)); dot.setAttribute("cy", y(last.v)); dot.setAttribute("r", 3); add(dot);
  add(text(x(last.t) + 5, y(last.v) + 3, fmtP(last.v), "ch-end-label"));
  // Hover overlay group (populated on mousemove).
  const ov = document.createElementNS(SVGNS, "g"); ov.setAttribute("class", "ch-overlay"); add(ov);
}
// «Круглый» верх оси над максимумом: 1, 2, 4 или 8 × 10^k (шаг сетки — четверть).
function niceMax(v) {
  if (!(v > 0)) return 1;
  const k = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 4, 8]) if (m * k >= v * (1 - 1e-12)) return m * k;
  return 10 * k;
}

function chartHover(ev, svg, st) {
  const g = st.geom; if (!g || !st.pts.length) return;
  const rect = svg.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const t = g.xmax * (mx - g.L) / (g.W - g.L - g.R);
  if (!(t >= 0 && t <= g.xmax)) return chartHoverClear(svg);
  // nearest point
  let best = 0, bd = Infinity;
  st.pts.forEach((p, i) => { const dd = Math.abs(p.t - t); if (dd < bd) { bd = dd; best = i; } });
  const p = st.pts[best];
  const ov = svg.querySelector(".ch-overlay"); if (!ov) return; ov.textContent = "";
  const cx = g.x(p.t), cy = g.y(p.v);
  const cross = document.createElementNS(SVGNS, "line");
  cross.setAttribute("class", "ch-cross"); cross.setAttribute("x1", cx); cross.setAttribute("x2", cx);
  cross.setAttribute("y1", g.T); cross.setAttribute("y2", g.H - g.B); ov.appendChild(cross);
  const dot = document.createElementNS(SVGNS, "circle");
  dot.setAttribute("class", "ch-dot"); dot.setAttribute("cx", cx); dot.setAttribute("cy", cy); dot.setAttribute("r", 4); ov.appendChild(dot);
  const label = `t=${fmtNum(p.t)}  ${st.name}=${fmtP(p.v)}`;
  const tw = label.length * 6.4 + 10;
  let bx = cx + 8; if (bx + tw > g.W - g.R) bx = cx - 8 - tw;
  const by = Math.max(g.T + 2, cy - 22);
  const bg = document.createElementNS(SVGNS, "rect");
  bg.setAttribute("class", "ch-tip-bg"); bg.setAttribute("x", bx); bg.setAttribute("y", by);
  bg.setAttribute("width", tw); bg.setAttribute("height", 18); bg.setAttribute("rx", 4); ov.appendChild(bg);
  const tip = text(bx + 5, by + 13, label, "ch-tip"); ov.appendChild(tip);
}
function chartHoverClear(svg) { const ov = svg.querySelector(".ch-overlay"); if (ov) ov.textContent = ""; }

// ---- modal canvas interaction ----
(function wireMk() {
  const cv = $("mk-canvas");
  function world(ev) { const r = cv.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; }
  cv.addEventListener("mousedown", (ev) => {
    const port = ev.target.dataset && ev.target.dataset.mkport;
    const stateG = ev.target.closest && ev.target.closest(".mk-state");
    const trId = ev.target.dataset && ev.target.dataset.tr;
    if (port) { MK.drag = { mode: "connect", from: port, start: MK.dist._pos[port] }; ev.preventDefault(); return; }
    if (stateG) {
      const name = stateG.dataset.state; const w = world(ev); const p = MK.dist._pos[name];
      MK.drag = { mode: "move", name, dx: w.x - p.x, dy: w.y - p.y, moved: false }; ev.preventDefault(); return;
    }
    if (trId) { const [f, t] = trId.split(">"); MK.sel = { type: "trans", from: f, to: t }; mkRender(); return; }
    MK.sel = null; mkRender();
  });
  window.addEventListener("mousemove", (ev) => {
    if (!MK.drag) return;
    const w = world(ev);
    if (MK.drag.mode === "move") {
      const p = MK.dist._pos[MK.drag.name]; p.x = w.x - MK.drag.dx; p.y = w.y - MK.drag.dy; MK.drag.moved = true; mkRender();
    } else if (MK.drag.mode === "connect") {
      const tmp = $("mk-temp"); tmp.textContent = "";
      const path = document.createElementNS(SVGNS, "path");
      path.setAttribute("class", "mk-temp");
      path.setAttribute("d", `M${MK.drag.start.x},${MK.drag.start.y} L${w.x},${w.y}`);
      tmp.appendChild(path);
    }
  });
  window.addEventListener("mouseup", (ev) => {
    if (!MK.drag) return;
    if (MK.drag.mode === "connect") {
      $("mk-temp").textContent = "";
      const stateG = ev.target.closest && ev.target.closest(".mk-state");
      if (stateG) mkAddTransition(MK.drag.from, stateG.dataset.state);
    } else if (MK.drag.mode === "move" && !MK.drag.moved) {
      MK.sel = { type: "state", name: MK.drag.name }; mkRender();
    }
    MK.drag = null;
  });
  cv.addEventListener("keydown", (ev) => {
    if ((ev.key === "Delete" || ev.key === "Backspace") && MK.sel) {
      ev.preventDefault();
      if (MK.sel.type === "state") mkDeleteState(MK.sel.name);
      else { MK.dist.transitions = MK.dist.transitions.filter((t) => !(t.from === MK.sel.from && t.to === MK.sel.to)); MK.sel = null; mkRender(); }
    }
  });
})();

// small DOM helpers
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (k === "class") n.className = v; else n.setAttribute(k, v); }
  for (const c of kids) n.append(c);
  return n;
}
function field(label, control) { const f = el("div", { class: "field" }); f.append(el("label", {}, label), control); return f; }
function fieldRow(control, label) { const f = el("div", { class: "field row" }); f.append(control, el("label", {}, label)); return f; }
function inputEl(type, val, onchange) {
  const i = el("input", { type }); i.value = val;
  i.addEventListener("change", () => onchange(i.value));
  return i;
}
function selectEl(opts, val, onchange) {
  const s = el("select");
  for (const [v, label] of opts) { const o = el("option", { value: v }, label); if (v === val) o.selected = true; s.append(o); }
  s.addEventListener("change", () => onchange(s.value));
  return s;
}
function checkboxEl(checked, onchange) {
  const c = el("input", { type: "checkbox" }); c.checked = checked;
  c.addEventListener("change", () => onchange(c.checked));
  return c;
}

// ===========================================================================
// Сериализация: граф -> запрос на расчёт
// ===========================================================================
// Собрать из нарисованного графа JSON-запрос для бэкенда. Заодно собираем
// список ошибок (errs), если схема неполная.
function graphToRequest() {
  const errs = [];
  if (!graph.nodes.length) errs.push("схема пуста");

  const { top, err } = findTop();
  if (err) errs.push(err);

  let model = null;
  if (graph.kind === "fault_tree") {
    const events = [], gates = [];
    for (const n of graph.nodes) {
      const kids = childrenEdges(n.id).map((e) => e.child);
      if (n.role === "event") {
        if (kids.length) errs.push(`событие «${n.id}» не может иметь входов`);
        if (!n.dist) errs.push(`у события «${n.id}» не задано распределение`);
        else events.push({ id: n.id, dist: cleanDist(n.dist) });
      } else {
        if (!kids.length) errs.push(`у элемента «${n.id}» нет входов`);
        const g = { id: n.id, op: n.op, inputs: kids };
        if (n.op === "atleast") { g.k = n.k || 2; if (g.k > kids.length) errs.push(`«${n.id}»: k=${g.k} больше числа входов`); }
        gates.push(g);
      }
    }
    model = { type: "fault_tree", top: top ? top.id : "", events, gates };
  } else {
    const nodes = [];
    for (const n of graph.nodes) {
      // Canonical СФЦ: each arc carries its own kind (conjunctive/disjunctive)
      // and output (direct/inverse).
      const inputs = childrenEdges(n.id).map((e) => {
        const arc = { from: e.child, conjunctive: !!e.conj };
        if (e.inverse) arc.inverse = true;
        return arc;
      });
      const o = { id: n.id };
      if (n.dist) o.dist = cleanDist(n.dist);
      if (inputs.length) o.inputs = inputs;
      if (!n.dist && !inputs.length) errs.push(`фиктивный узел «${n.id}» без входов`);
      nodes.push(o);
    }
    model = { type: "sfc", nodes, criterion: { target: top ? top.id : "" } };
  }

  const times = parseTimes($("mtime").value);
  // Пределы (max_order, cutoff…) — из открытого файла; что считать — из
  // галочек «Считать». В сохранённый файл попадает то же, так что CLI по нему
  // посчитает то же, что редактор.
  const req = { model, options: Object.assign({}, graph.options || { max_order: 8 }, calcOptions()) };
  if (times.length > 1) req.times = times; else req.mission_time = times[0] || 0;
  return { req, errs };
}
// Вершина (top) — узел с галочкой «вершина», а без неё — единственный узел, у
// которого есть входы, но сам он никуда не входит. err — почему не найдена.
function findTop() {
  const isChild = new Set(graph.edges.map((e) => e.child));
  const isParent = new Set(graph.edges.map((e) => e.parent));
  const rootCandidates = graph.nodes.filter((n) => isParent.has(n.id) && !isChild.has(n.id));
  const marked = graph.nodes.filter((n) => n.top);
  if (marked.length === 1) return { top: marked[0] };
  if (marked.length > 1) return { top: null, err: "отмечено несколько вершинных узлов" };
  if (rootCandidates.length === 1) return { top: rootCandidates[0] };
  if (graph.nodes.length === 1) return { top: graph.nodes[0] };
  return { top: null, err: "не удаётся определить вершину — отметьте её галочкой в инспекторе" };
}
function cleanDist(d) {
  const o = { type: d.type };
  if (d.type === "markov") {
    o.states = d.states || [];
    o.transitions = (d.transitions || []).map((tr) => {
      const dist = tr.dist || { type: "exponential", rate: tr.rate != null ? tr.rate : 1e-3 };
      // Exponential is sent as the compact `rate` shorthand; others as `dist`.
      if (dist.type === "exponential") return { from: tr.from, to: tr.to, rate: +dist.rate };
      const dd = { type: dist.type };
      for (const [k] of TR_DIST_SCHEMA[dist.type]) dd[k] = +dist[k];
      return { from: tr.from, to: tr.to, dist: dd };
    });
    o.failed = d.failed || []; if (d.initial) o.initial = d.initial; if (d.steady) o.steady = true;
    return o;
  }
  for (const [k, , , opt] of distFields(d)) if (d[k] != null && d[k] !== "") o[k] = +d[k];
  return o;
}
function parseTimes(s) {
  return String(s).split(",").map((x) => +x.trim()).filter((x) => isFinite(x));
}

// ===========================================================================
// Документ: схема ⇄ JSON (то, что сохраняется в файл и видно во вкладке JSON)
// ===========================================================================
// Документ — это обычный запрос на расчёт плюс поле `layout` с координатами.
// Движок `layout` не читает (serde пропускает незнакомые поля), поэтому один и
// тот же файл открывается в редакторе и считается из командной строки:
// `cra схема.json`.
function graphToDocument() {
  const { req, errs } = graphToRequest();
  req.layout = graphLayout();
  return { doc: req, errs };
}
function graphLayout() {
  const xy = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) });
  const nodes = {}, markov = {};
  for (const n of graph.nodes) {
    nodes[n.id] = xy(n);
    if (n.dist && n.dist.type === "markov" && n.dist._pos) {
      const st = {};
      for (const [s, p] of Object.entries(n.dist._pos)) st[s] = xy(p);
      markov[n.id] = st;
    }
  }
  const layout = { nodes };
  if (Object.keys(markov).length) layout.markov = markov;
  return layout;
}

// Обратное преобразование: документ -> редактируемый граф. Структурные ошибки
// (не тот тип модели, повтор id, неизвестное распределение) бросают Error —
// такой граф редактор показать не сможет. Мелочи, которые можно поправить
// мышью, собираются в `warns`. Если координат в файле нет, схема
// раскладывается автоматически (`autoLayout`).
function documentToGraph(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("ожидается JSON-объект");
  // Принимаем и голую модель — без обёртки запроса.
  const req = doc.model ? doc : doc.type ? { model: doc } : null;
  if (!req) throw new Error("нет поля «model»");
  const m = req.model;
  if (m.type !== "fault_tree" && m.type !== "sfc") {
    throw new Error(`неизвестный тип модели «${m.type}» (ожидается fault_tree или sfc)`);
  }
  const g = { kind: m.type, nodes: [], edges: [] };
  if (req.options && typeof req.options === "object") g.options = req.options;
  const warns = [];

  const list = (v, what) => {
    if (v == null) return [];
    if (!Array.isArray(v)) throw new Error(`«${what}» должно быть массивом`);
    return v;
  };
  const ids = new Set();
  const push = (n) => {
    if (typeof n.id !== "string" || !n.id) throw new Error("у узла нет строкового id");
    if (ids.has(n.id)) throw new Error(`повторяющийся идентификатор «${n.id}»`);
    ids.add(n.id);
    g.nodes.push(n);
    return n;
  };
  const dist = (id, d) => {
    if (!d || typeof d !== "object" || !DIST_NAMES[d.type]) {
      throw new Error(`узел «${id}»: неизвестное распределение «${d && d.type}»`);
    }
    return d;
  };

  let top = null;
  if (m.type === "fault_tree") {
    for (const e of list(m.events, "events")) push({ id: e.id, role: "event", dist: dist(e.id, e.dist) });
    const gates = list(m.gates, "gates");
    for (const gt of gates) {
      if (!OP_LABEL[gt.op]) throw new Error(`элемент «${gt.id}»: неизвестная операция «${gt.op}»`);
      const n = push({ id: gt.id, role: "gate", op: gt.op });
      if (gt.k != null) n.k = gt.k;
    }
    for (const gt of gates) {
      for (const inp of list(gt.inputs, gt.id + ".inputs")) g.edges.push({ parent: gt.id, child: inp });
    }
    top = m.top;
  } else {
    const nodes = list(m.nodes, "nodes");
    for (const nd of nodes) push({ id: nd.id, role: "sfc", dist: nd.dist ? dist(nd.id, nd.dist) : null });
    for (const nd of nodes) {
      // Per-arc kind; legacy files fall back to the node's `combine` default.
      const defaultConj = (nd.combine || "or") === "and";
      for (const inp of list(nd.inputs, nd.id + ".inputs")) {
        const e = { parent: nd.id, child: inp.from, conj: inp.conjunctive != null ? !!inp.conjunctive : defaultConj };
        if (inp.inverse) e.inverse = true;
        g.edges.push(e);
      }
    }
    const c = m.criterion;
    top = c && (c.target || c.node);
    if (c && !top) warns.push("составной критерий (op/args) редактор не показывает — отметьте вершину вручную");
  }

  // Связи, которые редактор не сможет ни показать, ни удалить, отбрасываем.
  const seen = new Set();
  g.edges = g.edges.filter((e) => {
    const key = e.parent + ">" + e.child;
    if (!ids.has(e.child)) { warns.push(`«${e.parent}»: вход «${e.child}» не найден — связь отброшена`); return false; }
    if (seen.has(key)) { warns.push(`«${e.parent}»: вход «${e.child}» указан дважды — повтор отброшен`); return false; }
    seen.add(key);
    return true;
  });
  if (top) {
    const n = g.nodes.find((x) => x.id === top);
    if (n) n.top = true; else warns.push(`вершина «${top}» не найдена`);
  }

  // Координаты: из `layout`, а для узлов без них — авто-раскладка, сдвинутая
  // вправо от уже расставленных, чтобы новые узлы не легли поверх старых.
  const lay = req.layout && typeof req.layout === "object" ? req.layout : {};
  const saved = lay.nodes || {};
  const ok = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);
  const auto = autoLayout(g.nodes, g.edges);
  let shift = 0;
  if (g.nodes.some((n) => ok(saved[n.id]))) {
    let right = -Infinity, left = Infinity;
    for (const n of g.nodes) {
      if (ok(saved[n.id])) right = Math.max(right, saved[n.id].x + NODE_W);
      else left = Math.min(left, auto.get(n.id).x);
    }
    if (left < Infinity) shift = right + 80 - left;
  }
  for (const n of g.nodes) {
    const p = ok(saved[n.id]) ? saved[n.id] : { x: auto.get(n.id).x + shift, y: auto.get(n.id).y };
    n.x = p.x; n.y = p.y;
    const mk = lay.markov && lay.markov[n.id];
    if (n.dist && n.dist.type === "markov" && mk && typeof mk === "object") {
      n.dist._pos = {};
      for (const [s, sp] of Object.entries(mk)) if (ok(sp)) n.dist._pos[s] = { x: sp.x, y: sp.y };
    }
  }
  // Схема «в p», если все её постоянные вероятности заданы как p.
  const fixed = g.nodes.filter((n) => n.dist && n.dist.type === "fixed");
  g.prob = fixed.length && fixed.every((n) => probKey(n.dist) === "p") ? "p" : "q";
  normalizeGraph(g);   // состояниям без координат — раскладка по кругу
  return { g, req, warns };
}

// Авто-раскладка по рядам (упрощённый Sugiyama). Ряд узла — длина самого
// длинного пути от него до стока: вершина оказывается внизу, каждый узел — на
// ряд выше самого нижнего из своих потребителей, и все дуги идут сверху вниз,
// как их рисует renderEdges. Порядок внутри рядов — несколько проходов по
// барицентрам соседей, это заметно уменьшает число пересечений.
const LAYOUT_GAP_X = NODE_W + 40, LAYOUT_GAP_Y = NODE_H + 60;
function autoLayout(nodes, edges) {
  const ins = new Map(nodes.map((n) => [n.id, []]));   // входы — ряды выше
  const outs = new Map(nodes.map((n) => [n.id, []]));  // потребители — ниже
  for (const e of edges) {
    if (!ins.has(e.parent) || !ins.has(e.child)) continue;
    ins.get(e.parent).push(e.child);
    outs.get(e.child).push(e.parent);
  }
  // Ряды считаем алгоритмом Кана от стоков, без рекурсии: схемы бывают
  // глубокими, а стек браузера — нет.
  const rank = new Map();
  const left = new Map(nodes.map((n) => [n.id, outs.get(n.id).length]));
  const queue = nodes.filter((n) => left.get(n.id) === 0).map((n) => n.id);
  for (const id of queue) rank.set(id, 0);
  for (let i = 0; i < queue.length; i++) {
    const r = rank.get(queue[i]) + 1;
    for (const c of ins.get(queue[i])) {
      if (!(rank.get(c) >= r)) rank.set(c, r);
      left.set(c, left.get(c) - 1);
      if (left.get(c) === 0) queue.push(c);
    }
  }
  // Узлы на цикле в очередь так и не попадут (такую схему отвергнет движок).
  for (const n of nodes) if (!rank.has(n.id)) rank.set(n.id, 0);

  let maxRank = 0;
  for (const r of rank.values()) maxRank = Math.max(maxRank, r);
  const rows = Array.from({ length: maxRank + 1 }, () => []);
  for (const n of nodes) rows[maxRank - rank.get(n.id)].push(n.id);

  const cx = new Map();   // центр узла по x; ряды центрированы относительно 0
  const place = (row) => row.forEach((id, i) => cx.set(id, (i - (row.length - 1) / 2) * LAYOUT_GAP_X));
  rows.forEach(place);
  const bary = (id, nb) => {
    const xs = nb.get(id);
    return xs.length ? xs.reduce((s, o) => s + cx.get(o), 0) / xs.length : cx.get(id);
  };
  for (let pass = 0; pass < 8; pass++) {
    // Чётные проходы — сверху вниз по входам, нечётные — снизу вверх по потребителям.
    const down = pass % 2 === 0;
    const nb = down ? ins : outs;
    for (const row of down ? rows : rows.slice().reverse()) {
      const key = new Map(row.map((id) => [id, bary(id, nb)]));
      row.sort((a, b) => key.get(a) - key.get(b));
      place(row);
    }
  }

  let minX = Infinity;
  for (const x of cx.values()) minX = Math.min(minX, x);
  const pos = new Map();
  rows.forEach((row, r) => row.forEach((id) => {
    pos.set(id, { x: Math.round(cx.get(id) - minX) + 60, y: 60 + r * LAYOUT_GAP_Y });
  }));
  return pos;
}

// Заменить текущую схему документом. Бросает Error, если документ не годится;
// возвращает список предупреждений.
function applyDocument(doc) {
  const { g, req, warns } = documentToGraph(doc);
  graph = g;
  seq = graph.nodes.reduce((m, n) => Math.max(m, idNum(n.id)), 0);
  if (Array.isArray(req.times) && req.times.length) $("mtime").value = req.times.join(", ");
  else if (req.mission_time != null) $("mtime").value = String(req.mission_time);
  $("kind").value = graph.kind;
  jsonEdited = false;     // вкладка JSON снова показывает схему
  // Результаты относились к прежней схеме.
  $("results").innerHTML = '<p class="hint">Постройте схему и нажмите «Рассчитать».</p>';
  hl = null;
  switchTab("diagram");   // fitView меряет холст, а скрытый холст имеет размер 0
  buildPalette(); select(null); fitView();
  return warns;
}

// ===========================================================================
// Файлы: сохранить на диск и открыть с диска
// ===========================================================================
// Вкладка JSON показывает документ текущей схемы, пока его не правили руками.
let jsonEdited = false;
function setJsonText(doc) { $("input").value = JSON.stringify(doc, null, 2); jsonEdited = false; }

function setFileName(name) {
  $("file-name").value = name;
  try { localStorage.setItem("cra.file", name); } catch (e) {}
}

// Сохраняется то, что видно: на вкладке «Схема» — документ схемы, на вкладке
// JSON — текст как есть (лишь проверяем, что это JSON).
function saveFile() {
  let text, note = "";
  if ($("tab-json").classList.contains("active")) {
    text = $("input").value;
    try { JSON.parse(text); } catch (e) { setStatus("некорректный JSON: " + e.message, "err"); return; }
  } else {
    if (!graph.nodes.length) { setStatus("схема пуста — сохранять нечего", "err"); return; }
    const { doc, errs } = graphToDocument();
    if (errs.length) note = " (схема неполна)";
    text = JSON.stringify(doc, null, 2) + "\n";
  }
  let name = $("file-name").value.trim() || (graph.kind === "sfc" ? "sfc" : "fault-tree");
  if (!/\.json$/i.test(name)) name += ".json";
  setFileName(name);
  downloadText(name, text);
  setStatus("сохранено: " + name + note, note ? "err" : "ok");
}

// Страница не может сама писать на диск: файл отдаётся как загрузка, а куда
// его положить (папка загрузок или диалог «Сохранить как»), решает браузер.
function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = el("a", { href: url, download: name });
  document.body.append(a);   // Firefox нажимает только ссылки, стоящие в документе
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function openFile(file) {
  let doc, warns;
  try { doc = JSON.parse(await file.text()); }
  catch (e) { setStatus(`«${file.name}»: некорректный JSON — ${e.message}`, "err"); return; }
  try { warns = applyDocument(doc); }
  catch (e) { setStatus(`«${file.name}»: ${e.message}`, "err"); return; }
  setFileName(file.name);
  reportLoad("открыт " + file.name, warns);
}

function reportLoad(what, warns) {
  if (!warns.length) { setStatus(what, "ok"); return; }
  setStatus(`${what} — предупреждений: ${warns.length}`, "err");
  const out = $("results"); out.textContent = "";
  out.append(el("h3", {}, "Предупреждения при загрузке"));
  for (const w of warns) out.append(el("p", { class: "warn" }, "⚠ " + w));
  openDrawer();
}

// ===========================================================================
// Запуск расчёта (Analyze)
// ===========================================================================
function setStatus(msg, kind) { const e = $("status"); e.textContent = msg; e.className = "status" + (kind ? " " + kind : ""); }

async function analyze() {
  let payload;
  if ($("tab-json").classList.contains("active")) {
    try { payload = JSON.parse($("input").value); }
    catch (e) { setStatus("некорректный JSON: " + e.message, "err"); return; }
  } else {
    const { req, errs } = graphToRequest();
    if (errs.length) { showError("Схема неполна:\n• " + errs.join("\n• ")); setStatus("исправьте схему", "err"); return; }
    payload = req;
    setJsonText(graphToDocument().doc);   // keep JSON tab in sync
  }
  // Галочки «Считать» решают на любой вкладке — и для JSON, набранного руками.
  if (!payload || typeof payload !== "object") { setStatus("запрос должен быть JSON-объектом", "err"); return; }
  payload.options = Object.assign({}, payload.options, calcOptions());
  const view = { kind: payload.model && payload.model.type, shown: 0, curve: null };
  // Кривая P(t): к моментам запроса добавляется сетка 0…max. Свои моменты идут
  // первыми — по первому движок считает наборы, значимость и ROBDD, — а таблица
  // показывает только их. Модули и BDD строятся один раз, так что лишние точки
  // почти ничего не стоят.
  const base = Array.isArray(payload.times) && payload.times.length ? payload.times.slice()
    : [payload.mission_time != null ? payload.mission_time : 0];
  view.shown = base.length;
  if (calc.curve) {
    const grid = curveGrid(base);
    if (grid.length) { payload.times = base.concat(grid); delete payload.mission_time; view.curve = base; }
  }
  openDrawer();
  setStatus("расчёт…");
  $("analyze").disabled = true;
  const t0 = performance.now();
  try {
    const r = await fetch("/api/analyze", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) { showError(data.error || "HTTP " + r.status); setStatus("ошибка расчёта", "err"); return; }
    renderResponse(data, view);
    setStatus("готово за " + Math.round(performance.now() - t0) + " мс", "ok");
  } catch (e) { setStatus("сетевая ошибка: " + e.message, "err"); }
  finally { $("analyze").disabled = false; }
}

// ===========================================================================
// Показ результатов
// ===========================================================================
function fmtP(p) { if (p === 0) return "0"; return p >= 1e-3 ? p.toFixed(6) : p.toExponential(4); }
function showError(msg) { clearHl(); $("results").innerHTML = ""; $("results").append(el("div", { class: "err-box" }, msg)); }

// Наборы: сечения (which = "cut") или пути ("path"); сервер отдаёт их по
// убыванию вероятности. P сечения — вероятность совместного отказа его
// элементов, сумма по сечениям — оценка Q сверху. Доля сечения и накопленная
// доля — от этой суммы: видно, сколько первых сечений дают почти весь риск.
// P пути — вероятность того, что все его элементы исправны; складывать её
// осмысленно не с чем, поэтому долей у путей нет.
const SETS_ROWS = 200;
function renderSets(report, which, kind) {
  if (!report) return null;
  const cut = which === "cut";
  const box = el("div", { class: "sets " + which });
  box.append(el("h3", {}, `${cut ? "Минимальные сечения (МНС)" : "Минимальные пути (МНП)"} — ` +
    `${report.count}${report.truncated ? " (усечено)" : ""}`));
  const sum = report.rare_event_approx;
  const share = (p) => (cut && sum > 0 ? p / sum : null);
  let meta = `Σ P(набор) ≈ ${fmtP(sum)} · оценка Эзари–Прошана ${fmtP(report.esary_proschan_bound)}`;
  if (cut && sum > 0) {
    let acc = 0, k = 0;
    while (k < report.sets.length && acc < 0.9 * sum) acc += report.sets[k++].probability;
    meta += k === 1 ? " · 90 % суммы даёт сечение №1" : ` · 90 % суммы дают сечения №1–${k}`;
  }
  box.append(el("div", { class: "meta" }, meta + " · щелчок по строке — показать на схеме"));
  if (cut) { const sp = singleFailures(report, kind); if (sp) box.append(sp); }
  box.append(ordersLine(report, share));

  const table = el("table", { class: "sets-table" });
  const head = el("tr", {}, el("th", { class: "num" }, "№"), el("th", { class: "num" }, "Порядок"),
    el("th", {}, "Элементы"), el("th", { class: "num" }, "P"));
  if (cut) head.append(el("th", { class: "num" }, "Доля"), el("th", { class: "num" }, "Накопл."));
  table.append(head);
  let acc = 0;
  report.sets.slice(0, SETS_ROWS).forEach((s, i) => {
    const chips = el("td", { class: "chips" });
    for (const ev of s.events) chips.append(el("span", {}, ev));
    const tr = el("tr", { "data-no": i + 1, title: "Показать на схеме" }, el("td", { class: "num" }, String(i + 1)),
      el("td", { class: "num" }, String(s.order)), chips, el("td", { class: "num" }, fmtP(s.probability)));
    // Выделение текста мышью (скопировать имена) — не щелчок по строке.
    tr.onclick = () => { if (!String(getSelection())) pickSet(which, i + 1, s.events); };
    if (cut) {
      acc += s.probability;
      const sh = share(s.probability);
      const td = el("td", { class: "num bar" }, fmtShare(sh));
      td.style.setProperty("--w", Math.max(0, Math.min(1, sh || 0)) * 100 + "%");
      tr.append(td, el("td", { class: "num" }, fmtShare(share(acc))));
    }
    table.append(tr);
  });
  if (report.sets.length > SETS_ROWS) {
    table.append(el("tr", {}, el("td", { colspan: cut ? 6 : 4, class: "meta" },
      `показаны первые ${SETS_ROWS} из ${report.sets.length}`)));
  }
  box.append(table);
  return box;
}

// Единичные отказы — сечения первого порядка: элемент, отказ которого в
// одиночку валит систему. Если их нет и список не усечён, это тоже стоит
// сказать: система переносит отказ любого одного элемента. При усечённом
// списке (max_order, max_sets, cutoff) сечение первого порядка могло не
// попасть в ответ, и «нет» утверждать нельзя.
function singleFailures(report, kind) {
  const sfc = kind === "sfc";
  const singles = report.sets.filter((s) => s.order === 1).map((s) => s.events[0]);
  if (!singles.length) {
    if (report.truncated) return null;
    return el("p", { class: "spof ok" }, sfc
      ? "Единичных отказов нет: критерий выполняется при отказе любого одного элемента."
      : "Единичных отказов нет: отказ любого одного элемента система переносит.");
  }
  const p = el("p", { class: "spof warn" }, `⚠ Единичные отказы — ${singles.length}: `);
  const chips = el("span", { class: "chips" });
  for (const ev of singles.slice(0, GROUP_CHIPS)) chips.append(el("span", {}, ev));
  p.append(chips);
  if (singles.length > GROUP_CHIPS) p.append(` и ещё ${singles.length - GROUP_CHIPS}`);
  p.append(sfc ? ". Отказ любого из них в одиночку нарушает критерий."
    : ". Отказ любого из них в одиночку приводит к отказу системы.");
  return p;
}

// Сколько наборов каждого порядка (у сечений — и их доля суммы): сечения
// высоких порядков многочисленны, но риск обычно дают низкие.
function ordersLine(report, share) {
  const by = new Map();
  for (const s of report.sets) {
    const o = by.get(s.order) || { n: 0, p: 0 };
    o.n++; o.p += s.probability;
    by.set(s.order, o);
  }
  const parts = [...by.keys()].sort((a, b) => a - b).map((k) => {
    const o = by.get(k), sh = share(o.p);
    return `порядок ${k}: ${o.n}` + (sh == null ? "" : ` (${fmtShare(sh)})`);
  });
  return el("div", { class: "meta orders" }, "По порядку — " + parts.join(" · "));
}

// ---- Подсветка набора на схеме ----
// Щелчок по строке сечения или пути подсвечивает набор на схеме: его элементы
// и узлы, до которых доходит их отказ (у пути — их исправность). Схема для
// этого вычисляется при «отказали ровно элементы сечения, остальные исправны»
// (у пути — «исправны ровно элементы пути»), и подсвечиваются узлы в том же
// состоянии, что и набор: у сечения — в отказе, у пути — работающие.
// Вычисляется заново при каждой отрисовке: правка схемы сразу видна.
// Щелчок по строке таблицы значимости (which = "elem") — то же для одного
// элемента: докуда доходит его отказ в одиночку.
let hl = null;   // { which: "cut" | "path" | "elem", no, events } или null

// Узлы схемы в отказе, когда отказали ровно элементы failed. Логика — та же,
// что у движка (io.rs): дерево — вентили над событиями; СФЦ — узел работает,
// если исправен его элемент (у фиктивного его нет), доставляют сигнал все
// И-дуги и хотя бы одна ИЛИ-дуга (пустая группа не мешает), а инверсная дуга
// доставляет сигнал, когда источник НЕ работает.
function failedNodes(failed) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const ins = new Map();
  for (const e of graph.edges) {
    if (!ins.has(e.parent)) ins.set(e.parent, []);
    ins.get(e.parent).push(e);
  }
  const sfc = graph.kind === "sfc";
  const memo = new Map();
  const down = (id) => {
    if (memo.has(id)) return memo.get(id);
    memo.set(id, false);   // циклов схема не допускает, но и зависать не должна
    const n = byId.get(id), es = ins.get(id) || [];
    let v = false;
    if (n && sfc) {
      const conj = [], disj = [];
      for (const e of es) (e.conj ? conj : disj).push(down(e.child) === !!e.inverse);
      const works = !(n.dist && failed.has(id)) && !conj.includes(false) && (!disj.length || disj.includes(true));
      v = !works;
    } else if (n && n.role === "event") v = failed.has(id);
    else if (n) {
      const m = es.length, k = es.filter((e) => down(e.child)).length;
      v = !!{ and: k === m, or: k > 0, xor: k % 2 === 1, not: k === 0,
        atleast: k >= (n.k || 2), nand: k < m, nor: k === 0 }[n.op];
    }
    memo.set(id, v);
    return v;
  };
  const out = new Set();
  for (const n of graph.nodes) if (down(n.id)) out.add(n.id);
  return out;
}

// Что подсвечено: src — элементы набора, hit — узлы в том же состоянии, что
// набор, top — дошло ли это состояние до вершины.
function hlState() {
  if (!hl) return null;
  const src = new Set(hl.events);
  let hit;
  if (hl.which === "path") {
    const down = failedNodes(new Set(graph.nodes.map((n) => n.id).filter((id) => !src.has(id))));
    hit = new Set(graph.nodes.map((n) => n.id).filter((id) => !down.has(id)));
  } else hit = failedNodes(src);
  const { top } = findTop();
  return { src, hit, top: !!top && hit.has(top.id) };
}
// Дуга подсвечена, если по ней это состояние пришло в узел: оба конца в нём.
// У инверсной дуги СФЦ и у входа НЕ, И-НЕ, ИЛИ-НЕ — наоборот: источник не в нём.
function hlEdge(st, e) {
  if (!st.hit.has(e.parent)) return false;
  const p = nodeById(e.parent);
  const neg = graph.kind === "sfc" ? !!e.inverse : !!p && ["not", "nand", "nor"].includes(p.op);
  return st.hit.has(e.child) !== neg;
}

// Плашка над схемой: что подсвечено и чем это кончается для вершины.
function renderHlBanner(st) {
  const b = $("hl-banner");
  b.textContent = "";
  b.hidden = !st;
  if (!st) return;
  b.className = "hl-banner " + hl.which;
  const sfc = graph.kind === "sfc", cut = hl.which !== "path";
  const on = hl.events.filter((id) => nodeById(id)), off = hl.events.filter((id) => !nodeById(id));
  const chips = el("span", { class: "chips" });
  for (const id of on) chips.append(el("span", {}, id));
  const one = hl.events.length === 1;
  let msg;
  if (hl.which === "elem") {
    msg = st.top ? "его отказ в одиночку " + (sfc ? "нарушает критерий" : "приводит к отказу системы")
      : "в одиночку его отказ " + (sfc ? "критерий не нарушает" : "до вершины не доходит") + "; подсвечено, докуда доходит";
  } else if (st.top && cut) msg = (one ? "его отказ " : "их совместный отказ ") + (sfc ? "нарушает критерий" : "приводит к отказу системы");
  else if (st.top) msg = sfc ? (one ? "его" : "их") + " работоспособности достаточно для выполнения критерия"
    : (one ? "пока он исправен" : "пока они исправны") + ", система не откажет";
  else msg = (cut ? "до вершины отказ не доходит" : (one ? "его" : "их") + " исправности не хватает") +
    " — схема изменилась после расчёта или немонотонна";
  const head = hl.which === "elem" ? "Элемент " : (cut ? "Сечение" : "Путь") + " №" + hl.no + ": ";
  const text = el("span", {}, el("b", {}, head), chips, " — " + msg + ".");
  if (off.length) text.append(el("span", { class: "warn" }, " Нет на схеме: " + off.join(", ") + "."));
  const close = el("button", { type: "button", class: "secondary", title: "Снять подсветку (Esc)" }, "✕");
  close.onclick = clearHl;
  b.append(text, close);
}

// Щелчок по строке набора: подсветить его, повторный щелчок — снять.
function pickSet(which, no, events) {
  if (hl && hl.which === which && hl.no === no) { clearHl(); return; }
  hl = { which, no, events };
  if (!$("tab-diagram").classList.contains("active")) switchTab("diagram");
  markHlRows();
  renderEdges(); renderNodes();
  revealNodes(events);
}
function clearHl() {
  if (!hl) return;
  hl = null;
  markHlRows();
  renderEdges(); renderNodes();
}
function markHlRows() {
  for (const tr of document.querySelectorAll("#results tr.on[data-no]")) tr.classList.remove("on");
  if (!hl) return;
  const table = hl.which === "elem" ? ".imp-table" : `.sets.${hl.which}`;
  for (const tr of document.querySelectorAll(`#results ${table} tr[data-no]`)) {
    if (tr.dataset.no === String(hl.no)) tr.classList.add("on");
  }
}
// Сдвинуть холст, не меняя масштаба, чтобы узлы ids были видны: если хоть один
// за краем или под плашкой — поставить их рамку в центр того, что видно.
function revealNodes(ids) {
  const ns = ids.map(nodeById).filter(Boolean);
  if (!ns.length) return;
  const minx = Math.min(...ns.map((n) => n.x)), maxx = Math.max(...ns.map((n) => n.x + NODE_W));
  const miny = Math.min(...ns.map((n) => n.y)), maxy = Math.max(...ns.map((n) => n.y + NODE_H));
  const r = canvas.getBoundingClientRect(), b = $("hl-banner");
  const top = b.hidden ? 0 : b.offsetTop + b.offsetHeight;   // плашка закрывает верх холста
  const sx = (x) => view.tx + x * view.s, sy = (y) => view.ty + y * view.s;
  if (sx(minx) >= 0 && sx(maxx) <= r.width && sy(miny) >= top && sy(maxy) <= r.height) return;
  view.tx = r.width / 2 - ((minx + maxx) / 2) * view.s;
  view.ty = (top + r.height) / 2 - ((miny + maxy) / 2) * view.s;
  render();
}
// Сетка кривой: CURVE_STEPS равных шагов от 0 до наибольшего момента, без
// моментов, которые уже есть в запросе.
const CURVE_STEPS = 60;
function curveGrid(base) {
  const tmax = Math.max(...base.map(Number));
  if (!(isFinite(tmax) && tmax > 0)) return [];
  const have = new Set(base.map(Number));
  const grid = [];
  for (let i = 0; i <= CURVE_STEPS; i++) {
    const t = (tmax * i) / CURVE_STEPS;
    if (!have.has(t)) grid.push(t);
  }
  return grid;
}

// view: kind — тип модели из запроса; shown — сколько первых результатов —
// моменты из запроса (остальные — сетка кривой); curve — эти моменты, если
// кривая строится.
function renderResponse(resp, view) {
  clearHl();   // номера наборов — из прежнего ответа
  const kind = view.kind;
  const shown = resp.results.slice(0, view.shown || resp.results.length);
  const out = $("results"); out.textContent = "";
  out.append(el("h2", {}, resp.interpretation));
  if (shown.length === 1) out.append(el("div", { class: "kpi" }, fmtP(shown[0].top_probability)));
  const table = el("table");
  table.append(el("tr", {}, el("th", {}, "Время"), el("th", {}, "Вероятность")));
  for (const r of shown)
    table.append(el("tr", {}, el("td", { class: "num" }, String(r.time)), el("td", { class: "num" }, fmtP(r.top_probability))));
  out.append(table);
  if (view.curve) renderCurve(out, resp, view);
  // Значимость и диаграммы — сразу под вероятностью: под списком из сотен
  // наборов их было бы не найти.
  const imp = renderImportance(resp); if (imp) out.append(imp);
  const bdd = renderBdd(resp, kind); if (bdd) out.append(bdd);
  // Движок старой версии молча пропускает незнакомые флаги. Так бывает, когда
  // в режиме разработки ассеты уже новые, а сервер не перезапущен.
  const missing = [];
  if (calc.importance && !resp.importance) missing.push("значимость элементов");
  if (calc.bdd && !resp.bdd) missing.push("ROBDD");
  if (missing.length) out.append(el("p", { class: "warn" }, `⚠ Запрошено, но сервер не вернул: ${missing.join(", ")}. ` +
    "Похоже, он запущен до обновления движка — пересоберите и перезапустите сервер."));
  const cuts = renderSets(resp.cut_sets, "cut", kind); if (cuts) out.append(cuts);
  const paths = renderSets(resp.path_sets, "path", kind); if (paths) out.append(paths);
  for (const w of resp.warnings || []) out.append(el("p", { class: "warn" }, "⚠ " + w));
  const s = resp.stats;
  out.append(el("div", { class: "meta" },
    `события: ${s.events} · узлы формулы: ${s.formula_nodes} · модули: ${s.modules} · узлы BDD: ${s.bdd_nodes}` +
    (s.noncoherent ? " · немонотонная схема" : "")));
}

// Кривая P(t) — общий линейный график (drawChart) по всем точкам ответа;
// кружки — моменты из запроса. Ось значений — от нуля до «круглого» числа над
// максимумом: вероятность отказа порядка 1e-3 на оси 0…1 слиплась бы с нулём.
const CURVE = { pts: [], geom: null };
function renderCurve(out, resp, view) {
  const sfc = view.kind === "sfc";
  const box = foldSection("curve", "cra.curve",
    sfc ? "Вероятность выполнения критерия P(t)" : "Вероятность отказа P(t)");
  const pts = resp.results.map((r) => ({ t: r.time, v: r.top_probability })).sort((a, b) => a.t - b.t);
  const xmax = pts[pts.length - 1].t;
  box.append(el("div", { class: "meta" },
    `${pts.length} точек от 0 до t = ${fmtNum(xmax)}; кружки — моменты из поля «t», они же в таблице выше.`));
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("class", "curve-svg");
  box.append(svg);
  out.append(box);
  const ymax = niceMax(Math.max(...pts.map((p) => p.v)));
  const opts = { ymax, name: "P", marks: view.curve.map(Number) };
  // Рисуем, когда у svg есть размер: раздел может быть свёрнут, панель —
  // скрыта. Наблюдатель заодно перерисует график при изменении ширины окна.
  const ro = new ResizeObserver(() => {
    if (!svg.isConnected) { ro.disconnect(); return; }
    if (svg.getBoundingClientRect().width >= 10) drawChart(svg, CURVE, pts, xmax, opts);
  });
  ro.observe(svg);
  svg.addEventListener("mousemove", (e) => chartHover(e, svg, CURVE));
  svg.addEventListener("mouseleave", () => chartHoverClear(svg));
}

// Сворачиваемый раздел результатов; раскрыт ли он, помнит браузер (ключ key).
function foldSection(cls, key, title) {
  const box = el("details", { class: "fold " + cls });
  try { box.open = localStorage.getItem(key) !== "0"; } catch (e) { box.open = true; }
  box.addEventListener("toggle", () => {
    try { localStorage.setItem(key, box.open ? "1" : "0"); } catch (e) {}
  });
  box.append(el("summary", {}, title));
  return box;
}

// ===========================================================================
// Значимость элементов (options.importance)
// ===========================================================================
// Таблица мер значимости из ответа: щелчок по заголовку столбца сортирует по
// нему (по убыванию; элемент — по алфавиту). Изначально — по FV, как отдаёт
// сервер. Все меры — в терминах отказа, в дереве и в СФЦ одинаково.
const IMP = { rep: null, sort: "criticality" };
const IMP_COLS = [
  ["event", "Элемент"], ["q", "q"], ["birnbaum", "Бирнбаум"],
  ["criticality", "FV (критичность)"], ["raw", "RAW"], ["rrw", "RRW"],
];
const IMP_ROWS = 200;

function renderImportance(resp) {
  const rep = resp.importance;
  if (!rep) return null;
  IMP.rep = rep;
  const box = foldSection("imp", "cra.imp", "Значимость элементов — " + rep.events.length);
  box.append(el("div", { class: "meta" },
    `Q = ${fmtP(rep.failure_probability)} — вероятность отказа системы при t = ${fmtNum(resp.results[0].time)}, ` +
    "q — вероятность отказа элемента. Бирнбаум — чувствительность Q к q; FV — доля риска, " +
    "связанная с элементом; RAW — во сколько раз вырастет Q, если элемент отказал; RRW — во " +
    "сколько раз Q упадёт, если элемент безотказен. Щелчок по заголовку столбца — сортировка, " +
    "по строке — показать элемент на схеме."));
  box.append(el("table", { class: "imp-table" }));
  renderImpTable(box);
  return box;
}

function renderImpTable(box) {
  const t = box.querySelector(".imp-table");
  t.textContent = "";
  const head = el("tr");
  for (const [k, label] of IMP_COLS) {
    const th = el("th", { class: "sortable" + (k === "event" ? "" : " num") + (k === IMP.sort ? " on" : "") },
      label + (k === IMP.sort ? " ▾" : ""));
    th.onclick = () => { IMP.sort = k; renderImpTable(box); };
    head.append(th);
  }
  t.append(head);
  const k = IMP.sort, rep = IMP.rep;
  // null у RRW при Q > 0 — бесконечность (элемент в одиночку держит систему).
  const val = (e) => (k === "rrw" && e.rrw == null && rep.failure_probability > 0 ? Infinity
    : e[k] == null ? -Infinity : e[k]);
  const rows = rep.events.slice();
  if (k === "event") rows.sort((a, b) => a.event.localeCompare(b.event));
  else rows.sort((a, b) => { const x = val(a), y = val(b); return x === y ? 0 : x < y ? 1 : -1; });
  for (const e of rows.slice(0, IMP_ROWS)) {
    const fv = el("td", { class: "num bar" }, fmtShare(e.criticality));
    fv.style.setProperty("--w", Math.max(0, Math.min(1, e.criticality || 0)) * 100 + "%");
    const tr = el("tr", { "data-no": e.event, title: "Показать на схеме" },
      el("td", {}, e.event), el("td", { class: "num" }, fmtP(e.q)), el("td", { class: "num" }, fmtP(e.birnbaum)),
      fv, el("td", { class: "num" }, fmtRatio(e.raw, rep)), el("td", { class: "num" }, fmtRatio(e.rrw, rep)));
    tr.onclick = () => { if (!String(getSelection())) pickSet("elem", e.event, [e.event]); };
    t.append(tr);
  }
  if (rows.length > IMP_ROWS) {
    t.append(el("tr", {}, el("td", { colspan: IMP_COLS.length, class: "meta" },
      `показаны первые ${IMP_ROWS} из ${rows.length}`)));
  }
  markHlRows();   // сортировка строит строки заново
}
// Доля риска в процентах: 62.43 %, 0.05 %, 3.1e-4 %.
function fmtShare(x) {
  if (x == null) return "—";
  const pct = x * 100;
  return (pct === 0 || Math.abs(pct) >= 0.01 ? pct.toFixed(2) : pct.toExponential(1)) + " %";
}
// Отношение (RAW, RRW): null — не определено (Q = 0) или, у RRW, бесконечно.
function fmtRatio(x, rep) {
  if (x == null) return rep.failure_probability > 0 ? "∞" : "—";
  const a = Math.abs(x);
  return a >= 1000 ? x.toExponential(2) : a >= 100 ? x.toFixed(0) : a >= 10 ? x.toFixed(1) : x.toFixed(3);
}

// ===========================================================================
// ROBDD модулей: диаграммы, по которым посчитан ответ (options.bdd)
// ===========================================================================
// Схема считается не целиком, а по независимым модулям: у каждого свой ROBDD,
// вложенный модуль в нём — одна переменная. Раздел показывает эти диаграммы по
// одной, с вкладками модулей. Рисунок послойный: строка — уровень (переменная)
// в порядке BDD, внизу листья 0 и 1; сплошная линия — ветка «переменная = 1»,
// пунктир — «= 0».
const BDD = { rep: null, kind: null, cur: 0 };
const BDD_ROW = 66, BDD_H = 28, BDD_GAP = 16, BDD_PAD = 18;

function renderBdd(resp, kind) {
  const b = resp.bdd;
  if (!b || !b.modules || !b.modules.length) return null;
  BDD.rep = b; BDD.kind = kind; BDD.cur = b.top;
  const box = foldSection("bdd", "cra.bdd", "Диаграммы решений (ROBDD) — модулей: " + b.modules.length);
  const one = kind === "sfc" ? "элемент работоспособен" : "событие произошло";
  const leaf = kind === "sfc" ? "критерий выполнен" : "вершинное событие наступило";
  const split = b.modules.length > 1
    ? "Схема разбита на независимые модули, у каждого свой ROBDD; вложенный модуль в нём — " +
      "одна переменная (прямоугольник, щелчок открывает его диаграмму). "
    : "Независимых модулей в схеме нет — вся она одна диаграмма. ";
  box.append(el("div", { class: "meta" }, split +
    `Строки сверху вниз — порядок переменных. Сплошная линия — переменная = 1 (${one}), пунктир — = 0; ` +
    `лист 1 — ${leaf}. Вероятности — при t = ${fmtNum(resp.results[0].time)}, ` +
    "подробности — при наведении на узел."));
  box.append(el("div", { class: "bdd-tabs" }), el("div", { class: "bdd-view" }));
  renderBddModule(box);
  return box;
}

// Вкладки модулей: от вершины вниз по вложенности (обход в ширину).
function bddOrder(b) {
  const order = [b.top], seen = new Set(order);
  for (let i = 0; i < order.length; i++) {
    for (const v of b.modules[order[i]].vars) {
      if (v.module != null && !seen.has(v.module)) { seen.add(v.module); order.push(v.module); }
    }
  }
  b.modules.forEach((_, i) => { if (!seen.has(i)) order.push(i); });
  return order;
}
function bddName(i) {
  const m = BDD.rep.modules[i];
  return m.name || "модуль " + i;
}
function bddVarName(m, v) {
  const x = m.vars[v];
  return x.event != null ? x.event : bddName(x.module);
}

function renderBddModule(box) {
  box = box || document.querySelector("#results .bdd");
  const b = BDD.rep;
  const tabs = box.querySelector(".bdd-tabs");
  tabs.textContent = "";
  if (b.modules.length > 1) {
    for (const i of bddOrder(b)) {
      const m = b.modules[i];
      const t = el("button", { type: "button", class: i === BDD.cur ? "on" : "",
        title: `узлов: ${m.size} · P = ${fmtP(m.probability)}` },
        (i === b.top ? "▲ " : "") + bddName(i) + " · " + m.size);
      t.onclick = () => { BDD.cur = i; renderBddModule(box); };
      tabs.append(t);
    }
  }
  const view = box.querySelector(".bdd-view");
  view.textContent = "";
  const m = b.modules[BDD.cur];
  if (m.size && !m.nodes.length) {
    view.append(el("p", { class: "warn" },
      `Диаграмма модуля «${bddName(BDD.cur)}» не выдана: в ней ${m.size} узлов — больше предела bdd_max_nodes.`));
    return;
  }
  view.append(drawBdd(m));
}

// Послойная раскладка (упрощённый Sugiyama). Строка — уровень BDD, внизу
// листья: 0 слева, 1 справа. Ветка через несколько уровней проходит через
// «пустые» точки во всех промежуточных строках: они занимают место в
// раскладке, и линия обходит узлы, а не идёт сквозь них. Порядок внутри строк —
// несколько проходов по барицентрам соседей, как у авто-раскладки схемы.
function drawBdd(m) {
  const byId = new Map(m.nodes.map((n) => [n.id, n]));
  const label = (id) => (id < 2 ? String(id) : bddVarName(m, byId.get(id).var));
  const levels = [...new Set(m.nodes.map((n) => n.var))].sort((a, b) => a - b);
  const rowOfVar = new Map(levels.map((v, r) => [v, r]));
  const leafRow = levels.length;
  const rowOf = (id) => (id < 2 ? leafRow : rowOfVar.get(byId.get(id).var));
  const rows = Array.from({ length: leafRow + 1 }, () => []);
  for (const n of m.nodes) rows[rowOf(n.id)].push(n.id);
  rows[leafRow] = [0, 1].filter((t) => m.root === t || m.nodes.some((n) => n.lo === t || n.hi === t));

  // Узлы — числа (id), пустые точки — строки: так ключи не пересекаются.
  const ups = new Map(), downs = new Map();
  const touch = (k) => { ups.set(k, []); downs.set(k, []); };
  rows.forEach((row) => row.forEach(touch));
  const edges = [];
  for (const n of m.nodes) {
    for (const [c, cls] of [[n.lo, "bdd-lo"], [n.hi, "bdd-hi"]]) {
      const chain = [n.id];
      for (let r = rowOf(n.id) + 1; r < rowOf(c); r++) {
        const k = n.id + cls + r;
        rows[r].push(k); touch(k); chain.push(k);
      }
      chain.push(c);
      for (let i = 1; i < chain.length; i++) { downs.get(chain[i - 1]).push(chain[i]); ups.get(chain[i]).push(chain[i - 1]); }
      edges.push({ cls, chain, from: n.id, to: c });
    }
  }

  const width = (k) => (typeof k === "string" ? 6 : k < 2 ? BDD_H : Math.max(44, label(k).length * 7.2 + 20));
  const cx = new Map();
  const place = (row) => {
    let x = -(row.reduce((s, k) => s + width(k), 0) + BDD_GAP * (row.length - 1)) / 2;
    for (const k of row) { cx.set(k, x + width(k) / 2); x += width(k) + BDD_GAP; }
  };
  rows.forEach(place);
  const bary = (k, nb) => {
    const xs = nb.get(k);
    return xs.length ? xs.reduce((s, o) => s + cx.get(o), 0) / xs.length : cx.get(k);
  };
  const inner = rows.slice(0, -1);   // листья не переставляем
  for (let pass = 0; pass < 8; pass++) {
    const down = pass % 2 === 0;
    for (const row of down ? inner : inner.slice().reverse()) {
      const key = new Map(row.map((k) => [k, bary(k, down ? ups : downs)]));
      row.sort((a, b) => key.get(a) - key.get(b));
      place(row);
    }
  }

  // Слева — колонка уровней: имя переменной и её вероятность.
  const gutter = Math.max(60, ...levels.map((v) => bddVarName(m, v).length * 7 + 16));
  let minX = Infinity, maxX = -Infinity;
  for (const [k, x] of cx) { minX = Math.min(minX, x - width(k) / 2); maxX = Math.max(maxX, x + width(k) / 2); }
  const rowIdx = new Map();
  rows.forEach((row, r) => row.forEach((k) => rowIdx.set(k, r)));
  const ox = BDD_PAD + gutter - minX, oy = BDD_PAD + 18;
  const X = (k) => ox + cx.get(k);
  const Y = (k) => oy + rowIdx.get(k) * BDD_ROW + BDD_H / 2;
  const W = ox + maxX + BDD_PAD, H = oy + leafRow * BDD_ROW + BDD_H + BDD_PAD;
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("width", W); svg.setAttribute("height", H);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const add = (parent, tag, attrs, txt) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (txt != null) e.textContent = txt;
    parent.appendChild(e);
    return e;
  };

  levels.forEach((v, r) => {
    const y = oy + r * BDD_ROW + BDD_H / 2;
    add(svg, "line", { class: "bdd-level-line", x1: BDD_PAD, x2: W - BDD_PAD, y1: y, y2: y });
    add(svg, "text", { class: "bdd-level", x: BDD_PAD, y: y - 3 }, bddVarName(m, v));
    add(svg, "text", { class: "bdd-level p", x: BDD_PAD, y: y + 11 }, "P=" + fmtP(m.vars[v].probability));
  });
  // Ветки выходят из узла чуть левее (0) и чуть правее (1) центра, а в
  // пустых точках касательная вертикальна — линия идёт плавно.
  for (const { cls, chain, from, to } of edges) {
    const side = Math.min(10, width(from) / 4) * (cls === "bdd-hi" ? 1 : -1);
    let d = "";
    for (let i = 0; i + 1 < chain.length; i++) {
      const a = chain[i], b = chain[i + 1];
      const x1 = X(a) + (i === 0 ? side : 0), y1 = Y(a) + (i === 0 ? BDD_H / 2 : 0);
      const x2 = X(b), y2 = Y(b) - (i + 2 === chain.length ? BDD_H / 2 : 0);
      const dy = (y2 - y1) / 2;
      d += (i ? " " : `M${x1},${y1} `) + `C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`;
    }
    add(svg, "path", { class: cls, d, "data-from": from, "data-to": to });
  }
  add(svg, "text", { class: "bdd-root", x: X(m.root), y: Y(m.root) - BDD_H / 2 - 6 }, "▼ " + bddName(BDD.cur));
  for (const row of rows) {
    for (const id of row) {
      if (typeof id === "string") continue;
      const n = byId.get(id);
      const isMod = !!n && m.vars[n.var].module != null;
      const g = add(svg, "g", { class: "bdd-node" + (id < 2 ? " leaf" : isMod ? " mod" : ""), "data-id": id });
      const w = width(id), x = X(id), y = Y(id);
      if (id < 2 || isMod) add(g, "rect", { x: x - w / 2, y: y - BDD_H / 2, width: w, height: BDD_H, rx: id < 2 ? 3 : 6 });
      else add(g, "ellipse", { cx: x, cy: y, rx: w / 2, ry: BDD_H / 2 });
      add(g, "text", { x, y }, label(id));
      let tip;
      if (id < 2) tip = id ? "лист 1: функция модуля истинна" : "лист 0: функция модуля ложна";
      else {
        tip = `${label(id)} — уровень ${n.var + 1}\nP(подфункции от этого узла) = ${fmtP(n.probability)}` +
          `\nP(${label(id)} = 1) = ${fmtP(m.vars[n.var].probability)}`;
        if (isMod) {
          tip += "\nщелчок — открыть диаграмму модуля";
          g.addEventListener("click", () => { BDD.cur = m.vars[n.var].module; renderBddModule(); });
        }
      }
      add(g, "title", {}, tip);
    }
  }
  return svg;
}

// ===========================================================================
// Палитра / вкладки / кнопки (связываем события)
// ===========================================================================
function buildPalette() {
  const box = $("palette-buttons"); box.textContent = "";
  for (const spec of PALETTE[graph.kind]) {
    // Образец рядом с подписью: кнопка показывает, как узел будет выглядеть на холсте.
    const b = el("button", { class: "pal pal-node" }, el("span", { class: "swatch " + nodeKind(spec.make()) }), spec.label);
    b.onclick = () => {
      const r = canvas.getBoundingClientRect();
      const c = screenToWorld(r.left + r.width / 2, r.top + r.height / 3);
      addNode(spec, c.x - NODE_W / 2 + (Math.random() * 40 - 20), c.y + (Math.random() * 40 - 20));
    };
    box.append(b);
  }
  renderArcTool();
}
// Блок «Новая дуга» есть только у СФЦ: в дереве отказов тип входа задаёт
// логический элемент, а не дуга. Кнопка с data-arc="conj:1" горит, когда
// arcStyle.conj === true, и т. д.
function renderArcTool() {
  const box = $("arc-tool");
  box.hidden = graph.kind !== "sfc";
  for (const b of box.querySelectorAll("[data-arc]")) {
    const [key, val] = b.dataset.arc.split(":");
    const on = arcStyle[key] === (val === "1");
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  }
}
// Клавиши 1–4 — те же четыре кнопки. e.code, чтобы работало в любой раскладке.
const ARC_KEYS = {
  Digit1: { conj: false }, Digit2: { conj: true }, Digit3: { inverse: false }, Digit4: { inverse: true },
  Numpad1: { conj: false }, Numpad2: { conj: true }, Numpad3: { inverse: false }, Numpad4: { inverse: true },
};
function arcKeyAllowed(e) {
  return !(e.ctrlKey || e.metaKey || e.altKey) && graph.kind === "sfc" && editorKeyAllowed(e);
}
// Клавиши редактора схемы: только на вкладке «Схема» при закрытом марковском
// окне и не в поле ввода — там у тех же клавиш своя работа (цифра — это ввод,
// Ctrl+Z отменяет набранный текст).
function editorKeyAllowed(e) {
  if (!$("tab-diagram").classList.contains("active") || !$("mk-modal").classList.contains("hidden")) return false;
  // Галочка своих клавиш, кроме пробела, не имеет: после щелчка по ней Del и
  // Ctrl+Z по-прежнему относятся к схеме.
  return !(e.target.closest && e.target.closest("input:not([type=checkbox]), textarea, select, [contenteditable]"));
}

// Галочка «успех p у всех»: отмечена — постоянные вероятности схемы задаются
// как p, снята — как q; «частично» — узлы расходятся с выбором схемы.
function renderProbAll() {
  const c = $("prob-all"), key = graph.prob || "q";
  c.checked = key === "p";
  c.indeterminate = graph.nodes.some((n) => n.dist && n.dist.type === "fixed" && probKey(n.dist) !== key);
}

function switchTab(name) {
  if (name === "json" && !jsonEdited && graph.nodes.length) setJsonText(graphToDocument().doc);
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $("tab-diagram").classList.toggle("active", name === "diagram");
  $("tab-json").classList.toggle("active", name === "json");
}
function openDrawer() { $("results-drawer").classList.remove("collapsed"); $("drawer-toggle").textContent = "свернуть ▾"; }

async function loadExample(name) {
  const r = await fetch("/api/examples/" + name);
  const warns = applyDocument(await r.json());
  setFileName(name + ".json");
  reportLoad("пример загружен", warns);
}

// ---- events ----
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
$("kind").addEventListener("change", () => {
  if (graph.nodes.length && !confirm("Сменить тип модели? Палитра изменится, узлы сохранятся, но их роли могут не подойти.")) {
    $("kind").value = graph.kind; return;
  }
  graph.kind = $("kind").value; buildPalette(); render();
});
$("analyze").addEventListener("click", analyze);
$("undo").addEventListener("click", undo);
$("redo").addEventListener("click", redo);
$("fit").addEventListener("click", fitView);
$("clear").addEventListener("click", () => {
  if (!confirm("Очистить схему?")) return;
  graph = { kind: graph.kind, prob: graph.prob, nodes: [], edges: [] }; seq = 0;
  $("input").value = ""; jsonEdited = false; setFileName(""); clearHl();
  select(null); render();
});
// Привести все узлы к одному виду вероятности; новые узлы тоже получат его.
$("prob-all").addEventListener("change", () => {
  graph.prob = $("prob-all").checked ? "p" : "q";
  for (const n of graph.nodes) setProbKey(n.dist, graph.prob);
  renderInspector(); render();
});
$("example-ft").addEventListener("click", () => loadExample("fault_tree"));
$("example-sfc").addEventListener("click", () => loadExample("sfc_bridge"));
$("from-diagram").addEventListener("click", () => {
  const { doc, errs } = graphToDocument();
  setJsonText(doc);
  if (errs.length) setStatus("схема неполна, JSON частичный", "err"); else setStatus("JSON построен", "ok");
});
$("to-diagram").addEventListener("click", () => {
  let warns;
  try { warns = applyDocument(JSON.parse($("input").value)); }
  catch (e) { setStatus("в схему не перевести: " + e.message, "err"); return; }
  reportLoad("схема построена по JSON", warns);
});
$("input").addEventListener("input", () => { jsonEdited = true; });
$("open").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", () => {
  const f = $("file-input").files[0];
  $("file-input").value = "";   // иначе повторное открытие того же файла не сработает
  if (f) openFile(f);
});
$("save").addEventListener("click", saveFile);
$("file-name").addEventListener("change", () => setFileName($("file-name").value.trim()));
$("format").addEventListener("click", () => {
  try { $("input").value = JSON.stringify(JSON.parse($("input").value), null, 2); setStatus("отформатировано", "ok"); }
  catch (e) { setStatus("некорректный JSON", "err"); }
});
for (const c of document.querySelectorAll("[data-calc]")) {
  c.addEventListener("change", () => setCalc(c.dataset.calc, c.checked));
}
$("drawer-toggle").addEventListener("click", () => {
  const d = $("results-drawer"); const c = d.classList.toggle("collapsed");
  $("drawer-toggle").textContent = c ? "развернуть ▴" : "свернуть ▾";
});
// Markov modal controls
$("mk-close").addEventListener("click", closeMarkov);
$("mk-add").addEventListener("click", mkAddState);
$("mk-steady").addEventListener("change", () => { MK.dist.steady = $("mk-steady").checked; mkRender(); });
$("mk-initial").addEventListener("change", () => {
  const v = $("mk-initial").value; const d = MK.dist;
  if (v === "__default") { delete d.initial; }
  else { d.initial = d.states.map((s) => (s === v ? 1 : 0)); }
  mkRender();
});
$("mk-plot").addEventListener("click", mkPlot);
$("mk-chart-svg").addEventListener("mousemove", (e) => chartHover(e, $("mk-chart-svg"), MKCHART));
$("mk-chart-svg").addEventListener("mouseleave", () => chartHoverClear($("mk-chart-svg")));
$("mk-modal").addEventListener("mousedown", (e) => { if (e.target.id === "mk-modal") closeMarkov(); });
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === "Escape" && !$("mk-modal").classList.contains("hidden")) closeMarkov();
  else if (e.key === "Escape" && editorKeyAllowed(e)) { select(null); clearHl(); }
  else if (mod && e.key === "Enter") analyze();
  // e.code — физическая клавиша: в русской раскладке e.key был бы «ы» / «щ».
  else if (mod && e.code === "KeyS") { e.preventDefault(); saveFile(); }
  else if (mod && e.code === "KeyO") { e.preventDefault(); $("file-input").click(); }
  else if (mod && e.code === "KeyZ" && editorKeyAllowed(e)) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  else if (mod && e.code === "KeyY" && editorKeyAllowed(e)) { e.preventDefault(); redo(); }
  else if (mod && e.code === "KeyA" && editorKeyAllowed(e)) { e.preventDefault(); selectNodes(graph.nodes.map((n) => n.id)); }
  else if ((e.key === "Delete" || e.key === "Backspace") && editorKeyAllowed(e)) { e.preventDefault(); deleteSelection(); }
  else if (ARC_KEYS[e.code] && arcKeyAllowed(e)) setArcStyle(ARC_KEYS[e.code]);
});
for (const b of document.querySelectorAll("[data-arc]")) {
  b.addEventListener("click", () => {
    const [key, val] = b.dataset.arc.split(":");
    setArcStyle({ [key]: val === "1" });
  });
}

// ---- init ----
load();
loadArcStyle();
loadCalc();
renderCalc();
try { $("file-name").value = localStorage.getItem("cra.file") || ""; } catch (e) {}
$("kind").value = graph.kind;
buildPalette();
render();
renderInspector();
if (graph.nodes.length) fitView();
