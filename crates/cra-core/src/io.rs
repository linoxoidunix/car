//! Схема JSON (вход/выход) и сборка запроса во внутреннюю модель.
//!
//! Здесь мы читаем JSON от пользователя, проверяем его и превращаем в `System`
//! (события + логическая формула). Мы также описываем формат ответа.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::dist::ReliabilityModel;
use crate::markov::{MarkovModel, TransDist, Transition};
use crate::model::{BasicEvent, Formula, ModelKind, Node, NodeId, System};

// ---------------------------------------------------------------------------
// Запрос (Request)
// ---------------------------------------------------------------------------

/// Один запрос на расчёт: модель, время(-мена) и настройки.
#[derive(Debug, Deserialize)]
pub struct Request {
    pub model: ModelInput,
    /// Одно время расчёта (если нет `times`).
    #[serde(default)]
    pub mission_time: Option<f64>,
    /// Несколько времён; если задано — важнее, чем `mission_time`.
    #[serde(default)]
    pub times: Option<Vec<f64>>,
    #[serde(default)]
    pub options: Options,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ModelInput {
    FaultTree(FaultTreeInput),
    Sfc(SfcInput),
}

#[derive(Debug, Deserialize)]
pub struct FaultTreeInput {
    pub top: String,
    pub events: Vec<EventInput>,
    #[serde(default)]
    pub gates: Vec<GateInput>,
}

#[derive(Debug, Deserialize)]
pub struct EventInput {
    pub id: String,
    pub dist: DistInput,
}

#[derive(Debug, Deserialize)]
pub struct GateInput {
    pub id: String,
    /// "and" | "or" | "not" | "xor" | "atleast" | "nand" | "nor"
    pub op: String,
    #[serde(default)]
    pub k: Option<usize>,
    pub inputs: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct SfcInput {
    pub nodes: Vec<SfcNodeInput>,
    pub criterion: CriterionInput,
}

#[derive(Debug, Deserialize)]
pub struct SfcNodeInput {
    pub id: String,
    /// Element reliability model; absent for fictive (logic-only) nodes.
    #[serde(default)]
    pub dist: Option<DistInput>,
    #[serde(default)]
    pub inputs: Vec<SfcArcInput>,
    /// How ensuring inputs are combined: "or" (default) or "and".
    #[serde(default = "default_combine")]
    pub combine: String,
}

fn default_combine() -> String {
    "or".to_string()
}

#[derive(Debug, Deserialize)]
pub struct SfcArcInput {
    pub from: String,
    /// Inverse output of the source node (СФЦ: инверсный выход дуги).
    #[serde(default)]
    pub inverse: bool,
    /// Canonical СФЦ arc kind: `true` = conjunctive (И), `false` = disjunctive
    /// (ИЛИ). When absent, falls back to the node's legacy `combine` field.
    #[serde(default)]
    pub conjunctive: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum CriterionInput {
    Expr {
        /// "and" | "or" | "not"
        op: String,
        args: Vec<CriterionInput>,
    },
    Node {
        node: String,
        #[serde(default)]
        inverse: bool,
    },
    Target {
        target: String,
        #[serde(default)]
        inverse: bool,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DistInput {
    /// Постоянная вероятность. Задаётся ровно одно число: вероятность отказа
    /// `q` или вероятность успеха (безотказной работы) `p` = 1 − q.
    Fixed {
        #[serde(default)]
        q: Option<f64>,
        #[serde(default)]
        p: Option<f64>,
    },
    Exponential {
        lambda: f64,
        /// Optional repair rate: turns q(t) into steady-approaching unavailability.
        #[serde(default)]
        mu: Option<f64>,
    },
    Weibull {
        shape: f64,
        scale: f64,
    },
    Lognormal {
        mu: f64,
        sigma: f64,
    },
    Normal {
        mean: f64,
        std: f64,
    },
    Uniform {
        a: f64,
        b: f64,
    },
    Gamma {
        shape: f64,
        rate: f64,
    },
    Markov {
        states: Vec<String>,
        #[serde(default)]
        initial: Option<Vec<f64>>,
        transitions: Vec<TransitionInput>,
        failed: Vec<String>,
        #[serde(default)]
        steady: bool,
    },
}

#[derive(Debug, Deserialize)]
pub struct TransitionInput {
    pub from: String,
    pub to: String,
    /// Exponential shorthand: `rate` alone means an exponential clock.
    #[serde(default)]
    pub rate: Option<f64>,
    /// Full sojourn distribution for the transition clock (semi-Markov).
    /// Takes precedence over `rate` when present.
    #[serde(default)]
    pub dist: Option<TransDistInput>,
}

/// Sojourn-time distribution of a transition clock.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TransDistInput {
    Exponential { rate: f64 },
    Weibull { shape: f64, scale: f64 },
    Gamma { shape: f64, rate: f64 },
    Lognormal { mu: f64, sigma: f64 },
    Normal { mean: f64, std: f64 },
    Deterministic { delay: f64 },
}

impl TransDistInput {
    fn to_model(&self, ctx: &str) -> Result<TransDist, String> {
        Ok(match self {
            TransDistInput::Exponential { rate } => {
                check_nonneg("rate", *rate)?;
                TransDist::Exponential { rate: *rate }
            }
            TransDistInput::Weibull { shape, scale } => {
                check_pos("shape", *shape)?;
                check_pos("scale", *scale)?;
                TransDist::Weibull { shape: *shape, scale: *scale }
            }
            TransDistInput::Gamma { shape, rate } => {
                check_pos("shape", *shape)?;
                check_pos("rate", *rate)?;
                TransDist::Gamma { shape: *shape, rate: *rate }
            }
            TransDistInput::Lognormal { mu, sigma } => {
                check_pos("sigma", *sigma)?;
                if !mu.is_finite() {
                    return Err(format!("{ctx}: lognormal mu must be finite"));
                }
                TransDist::Lognormal { mu: *mu, sigma: *sigma }
            }
            TransDistInput::Normal { mean, std } => {
                check_pos("std", *std)?;
                if !mean.is_finite() {
                    return Err(format!("{ctx}: normal mean must be finite"));
                }
                TransDist::Normal { mean: *mean, std: *std }
            }
            TransDistInput::Deterministic { delay } => {
                check_pos("delay", *delay)?;
                TransDist::Deterministic { delay: *delay }
            }
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct Options {
    /// Compute minimal cut sets.
    pub cut_sets: bool,
    /// Compute minimal path sets.
    pub path_sets: bool,
    /// Maximum literals per set.
    pub max_order: usize,
    /// Maximum number of sets kept (per module and in the final report).
    pub max_sets: usize,
    /// Discard sets with probability below this value (0 = keep all).
    pub cutoff: f64,
    /// Return the ROBDD of every module (for drawing it).
    pub bdd: bool,
    /// Maximum ROBDD nodes returned, summed over modules; a module that does
    /// not fit comes without its nodes.
    pub bdd_max_nodes: usize,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            cut_sets: true,
            path_sets: false,
            max_order: 8,
            max_sets: 20_000,
            cutoff: 0.0,
            bdd: false,
            bdd_max_nodes: 2_000,
        }
    }
}

// ---------------------------------------------------------------------------
// Ответ (Response)
// ---------------------------------------------------------------------------

/// Ответ расчёта: вероятность вершины по времени, наборы (сечения/пути),
/// статистика и предупреждения.
#[derive(Debug, Serialize)]
pub struct Response {
    /// Что значит `top_probability`: "отказ" (дерево) или "критерий" (СФЦ).
    pub interpretation: String,
    pub results: Vec<TimeResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cut_sets: Option<SetsReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_sets: Option<SetsReport>,
    /// Only with `options.bdd`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bdd: Option<BddReport>,
    pub stats: Stats,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct TimeResult {
    pub time: f64,
    pub top_probability: f64,
}

#[derive(Debug, Serialize)]
pub struct SetsReport {
    pub count: usize,
    pub truncated: bool,
    /// Sum of set probabilities (rare-event approximation of the union).
    pub rare_event_approx: f64,
    /// 1 - prod(1 - P(set)): Esary-Proschan upper bound.
    pub esary_proschan_bound: f64,
    pub sets: Vec<SetReport>,
}

#[derive(Debug, Serialize)]
pub struct SetReport {
    pub events: Vec<String>,
    pub order: usize,
    /// Probability of the set at the first evaluation time.
    pub probability: f64,
}

/// ROBDD модулей — ровно те диаграммы, по которым считалась вероятность.
#[derive(Debug, Serialize)]
pub struct BddReport {
    /// Index of the top module in `modules`.
    pub top: usize,
    /// Nested modules come before the modules that use them.
    pub modules: Vec<BddModuleReport>,
    /// Some modules did not fit into `bdd_max_nodes` and have no `nodes`.
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct BddModuleReport {
    /// Gate / SFC node whose function the module is; absent for internal nodes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Variables by BDD level, top to bottom: a basic event or a nested module.
    pub vars: Vec<BddVarReport>,
    /// Root: 0 = FALSE, 1 = TRUE, otherwise a node id.
    pub root: u32,
    /// Number of nodes reachable from the root (terminals not counted).
    pub size: usize,
    /// Nodes with ids 2, 3, ... ordered top to bottom; empty if over the limit.
    pub nodes: Vec<BddNodeReport>,
    /// P(module function is true) at the first evaluation time.
    pub probability: f64,
}

#[derive(Debug, Serialize)]
pub struct BddVarReport {
    /// Basic event name...
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    /// ...or index of a nested module in `modules`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module: Option<usize>,
    /// P(variable is true) at the first evaluation time.
    pub probability: f64,
}

#[derive(Debug, Serialize)]
pub struct BddNodeReport {
    pub id: u32,
    /// Level, i.e. index into `vars`.
    pub var: u32,
    /// Branch taken when the variable is false (`lo`) / true (`hi`).
    pub lo: u32,
    pub hi: u32,
    /// P(the sub-function rooted here is true) at the first evaluation time.
    pub probability: f64,
}

#[derive(Debug, Serialize)]
pub struct Stats {
    pub events: usize,
    pub formula_nodes: usize,
    pub modules: usize,
    pub bdd_nodes: usize,
    pub noncoherent: bool,
}

// ---------------------------------------------------------------------------
// Сборка (compilation): JSON-модель -> внутренняя System
// ---------------------------------------------------------------------------

/// Собрать модель из входа. Дерево и СФЦ идут разными путями.
pub fn compile(model: &ModelInput) -> Result<System, String> {
    match model {
        ModelInput::FaultTree(ft) => compile_fault_tree(ft),
        ModelInput::Sfc(sfc) => compile_sfc(sfc),
    }
}

impl DistInput {
    pub fn to_model(&self) -> Result<ReliabilityModel, String> {
        match self {
            DistInput::Fixed { q, p } => {
                let q = match (q, p) {
                    (Some(q), None) => *q,
                    (None, Some(p)) => {
                        if !(0.0..=1.0).contains(p) {
                            return Err(format!("fixed p must be in [0,1], got {p}"));
                        }
                        1.0 - p
                    }
                    _ => return Err("fixed: give exactly one of q (failure) or p (success)".into()),
                };
                if !(0.0..=1.0).contains(&q) {
                    return Err(format!("fixed q must be in [0,1], got {q}"));
                }
                Ok(ReliabilityModel::Fixed { q })
            }
            DistInput::Exponential { lambda, mu } => {
                check_nonneg("lambda", *lambda)?;
                match mu {
                    Some(mu) => {
                        check_nonneg("mu", *mu)?;
                        Ok(ReliabilityModel::ExponentialRepair { lambda: *lambda, mu: *mu })
                    }
                    None => Ok(ReliabilityModel::Exponential { lambda: *lambda }),
                }
            }
            DistInput::Weibull { shape, scale } => {
                check_pos("shape", *shape)?;
                check_pos("scale", *scale)?;
                Ok(ReliabilityModel::Weibull { shape: *shape, scale: *scale })
            }
            DistInput::Lognormal { mu, sigma } => {
                check_pos("sigma", *sigma)?;
                if !mu.is_finite() {
                    return Err("lognormal mu must be finite".into());
                }
                Ok(ReliabilityModel::Lognormal { mu: *mu, sigma: *sigma })
            }
            DistInput::Normal { mean, std } => {
                check_pos("std", *std)?;
                if !mean.is_finite() {
                    return Err("normal mean must be finite".into());
                }
                Ok(ReliabilityModel::Normal { mean: *mean, std: *std })
            }
            DistInput::Uniform { a, b } => {
                if !a.is_finite() || !b.is_finite() || b < a {
                    return Err(format!("uniform requires finite a <= b, got a={a}, b={b}"));
                }
                Ok(ReliabilityModel::Uniform { a: *a, b: *b })
            }
            DistInput::Gamma { shape, rate } => {
                check_pos("shape", *shape)?;
                check_pos("rate", *rate)?;
                Ok(ReliabilityModel::Gamma { shape: *shape, rate: *rate })
            }
            DistInput::Markov { states, initial, transitions, failed, steady } => {
                let n = states.len();
                if n == 0 {
                    return Err("markov: empty state list".into());
                }
                let mut idx: HashMap<&str, usize> = HashMap::new();
                for (i, s) in states.iter().enumerate() {
                    if idx.insert(s.as_str(), i).is_some() {
                        return Err(format!("markov: duplicate state '{s}'"));
                    }
                }
                let initial = match initial {
                    Some(v) => {
                        if v.len() != n {
                            return Err("markov: initial length != number of states".into());
                        }
                        let s: f64 = v.iter().sum();
                        if v.iter().any(|p| *p < 0.0) || (s - 1.0).abs() > 1e-6 {
                            return Err("markov: initial must be a distribution (sum = 1)".into());
                        }
                        v.clone()
                    }
                    None => {
                        let mut v = vec![0.0; n];
                        v[0] = 1.0;
                        v
                    }
                };
                let mut trans = Vec::with_capacity(transitions.len());
                for t in transitions {
                    let i = *idx
                        .get(t.from.as_str())
                        .ok_or_else(|| format!("markov: unknown state '{}'", t.from))?;
                    let j = *idx
                        .get(t.to.as_str())
                        .ok_or_else(|| format!("markov: unknown state '{}'", t.to))?;
                    if i == j {
                        return Err(format!("markov: self-transition on '{}'", t.from));
                    }
                    let ctx = format!("markov transition {}->{}", t.from, t.to);
                    let dist = match (&t.dist, t.rate) {
                        (Some(d), _) => d.to_model(&ctx)?,
                        (None, Some(rate)) => {
                            check_nonneg("rate", rate)?;
                            TransDist::Exponential { rate }
                        }
                        (None, None) => {
                            return Err(format!("{ctx}: needs a 'rate' or a 'dist'"))
                        }
                    };
                    trans.push(Transition { from: i, to: j, dist });
                }
                let mut fl = vec![false; n];
                for s in failed {
                    let i = *idx
                        .get(s.as_str())
                        .ok_or_else(|| format!("markov: unknown failed state '{s}'"))?;
                    fl[i] = true;
                }
                Ok(ReliabilityModel::Markov(MarkovModel {
                    n,
                    initial,
                    trans,
                    failed: fl,
                    steady: *steady,
                }))
            }
        }
    }
}

fn check_pos(name: &str, x: f64) -> Result<(), String> {
    if x.is_finite() && x > 0.0 {
        Ok(())
    } else {
        Err(format!("{name} must be finite and > 0, got {x}"))
    }
}

fn check_nonneg(name: &str, x: f64) -> Result<(), String> {
    if x.is_finite() && x >= 0.0 {
        Ok(())
    } else {
        Err(format!("{name} must be finite and >= 0, got {x}"))
    }
}

// --- дерево отказов ---------------------------------------------------------

/// Собрать дерево отказов: события -> Var-узлы, элементы -> И/ИЛИ/... узлы.
fn compile_fault_tree(ft: &FaultTreeInput) -> Result<System, String> {
    let mut events: Vec<BasicEvent> = Vec::new();
    let mut formula = Formula::default();
    // На каждое событие ровно один узел Var.
    let mut event_node: HashMap<&str, NodeId> = HashMap::new();
    for e in &ft.events {
        if event_node.contains_key(e.id.as_str()) {
            return Err(format!("duplicate event id '{}'", e.id));
        }
        let model = e.dist.to_model().map_err(|err| format!("event '{}': {err}", e.id))?;
        let eid = events.len();
        events.push(BasicEvent { name: e.id.clone(), model });
        let node = formula.add(Node::Var(eid));
        event_node.insert(e.id.as_str(), node);
    }
    let mut gate_map: HashMap<&str, &GateInput> = HashMap::new();
    for g in &ft.gates {
        if event_node.contains_key(g.id.as_str()) || gate_map.insert(g.id.as_str(), g).is_some() {
            return Err(format!("duplicate id '{}'", g.id));
        }
    }
    let mut resolved: HashMap<String, NodeId> = HashMap::new();
    let mut in_progress: HashMap<String, bool> = HashMap::new();
    let root = resolve_ft(
        &ft.top,
        &event_node,
        &gate_map,
        &mut formula,
        &mut resolved,
        &mut in_progress,
    )?;
    formula.root = root;
    let labels = name_nodes(resolved);
    Ok(System { kind: ModelKind::FaultTree, events, formula, labels })
}

/// Найти (по имени) узел для события или элемента и построить его поддерево.
/// `in_progress` ловит циклы: если имя уже на пути рекурсии — это цикл.
fn resolve_ft(
    name: &str,
    event_node: &HashMap<&str, NodeId>,
    gate_map: &HashMap<&str, &GateInput>,
    formula: &mut Formula,
    resolved: &mut HashMap<String, NodeId>,
    in_progress: &mut HashMap<String, bool>,
) -> Result<NodeId, String> {
    if let Some(&n) = event_node.get(name) {
        return Ok(n); // это событие
    }
    if let Some(&n) = resolved.get(name) {
        return Ok(n); // этот элемент уже собрали раньше
    }
    let gate = gate_map
        .get(name)
        .ok_or_else(|| format!("unknown reference '{name}'"))?;
    if in_progress.insert(name.to_string(), true).is_some() {
        return Err(format!("cycle detected through gate '{name}'")); // нашли цикл
    }
    let mut children = Vec::with_capacity(gate.inputs.len());
    for input in &gate.inputs {
        children.push(resolve_ft(input, event_node, gate_map, formula, resolved, in_progress)?);
    }
    let nch = children.len();
    let node = match gate.op.as_str() {
        "and" => {
            require_inputs(name, nch, 1)?;
            formula.add(Node::And(children))
        }
        "or" => {
            require_inputs(name, nch, 1)?;
            formula.add(Node::Or(children))
        }
        "xor" => {
            require_inputs(name, nch, 2)?;
            formula.add(Node::Xor(children))
        }
        "not" => {
            if nch != 1 {
                return Err(format!("gate '{name}': 'not' needs exactly 1 input"));
            }
            formula.add(Node::Not(children[0]))
        }
        "atleast" => {
            let k = gate
                .k
                .ok_or_else(|| format!("gate '{name}': 'atleast' requires field 'k'"))?;
            if k == 0 || k > nch {
                return Err(format!("gate '{name}': need 1 <= k <= {nch}, got k={k}"));
            }
            formula.add(Node::AtLeast { k, args: children })
        }
        "nand" => {
            require_inputs(name, nch, 1)?;
            let inner = formula.add(Node::And(children));
            formula.add(Node::Not(inner))
        }
        "nor" => {
            require_inputs(name, nch, 1)?;
            let inner = formula.add(Node::Or(children));
            formula.add(Node::Not(inner))
        }
        other => return Err(format!("gate '{name}': unknown op '{other}'")),
    };
    in_progress.remove(name);
    resolved.insert(name.to_string(), node);
    Ok(node)
}

fn require_inputs(name: &str, n: usize, min: usize) -> Result<(), String> {
    if n < min {
        Err(format!("gate '{name}': needs at least {min} input(s)"))
    } else {
        Ok(())
    }
}

// --- СФЦ (схема функциональной целостности) ---------------------------------

/// Собрать СФЦ: у каждого узла своя выходная функция y = x · K · D (см. ниже).
fn compile_sfc(sfc: &SfcInput) -> Result<System, String> {
    let mut events: Vec<BasicEvent> = Vec::new();
    let mut formula = Formula::default();
    let mut node_map: HashMap<&str, &SfcNodeInput> = HashMap::new();
    let mut event_node: HashMap<&str, NodeId> = HashMap::new();
    for n in &sfc.nodes {
        if node_map.insert(n.id.as_str(), n).is_some() {
            return Err(format!("duplicate SFC node id '{}'", n.id));
        }
        if let Some(dist) = &n.dist {
            let model = dist.to_model().map_err(|err| format!("node '{}': {err}", n.id))?;
            let eid = events.len();
            events.push(BasicEvent { name: n.id.clone(), model });
            let node = formula.add(Node::Var(eid));
            event_node.insert(n.id.as_str(), node);
        }
    }
    let mut outputs: HashMap<String, NodeId> = HashMap::new();
    let mut in_progress: HashMap<String, bool> = HashMap::new();
    let root = resolve_criterion(
        &sfc.criterion,
        &node_map,
        &event_node,
        &mut formula,
        &mut outputs,
        &mut in_progress,
    )?;
    formula.root = root;
    let labels = name_nodes(outputs);
    Ok(System { kind: ModelKind::Sfc, events, formula, labels })
}

/// Перевернуть «имя -> узел формулы» в «узел -> имя». Узел СФЦ без своего
/// элемента и с одним прямым входом не строит нового узла, а берёт функцию
/// источника, — тогда у узла формулы два имени, их пишем через запятую.
fn name_nodes(by_name: HashMap<String, NodeId>) -> HashMap<NodeId, String> {
    let mut named: Vec<(String, NodeId)> = by_name.into_iter().collect();
    named.sort();
    let mut labels: HashMap<NodeId, String> = HashMap::new();
    for (name, node) in named {
        labels
            .entry(node)
            .and_modify(|l| {
                l.push_str(", ");
                l.push_str(&name);
            })
            .or_insert(name);
    }
    labels
}

/// Output function of an SFC node: y = x AND combine(inputs), where x is the
/// node's own element (absent for fictive nodes) and inputs are the ensuring
/// functions, each possibly taken from the inverse output of its source.
fn resolve_sfc_output(
    id: &str,
    node_map: &HashMap<&str, &SfcNodeInput>,
    event_node: &HashMap<&str, NodeId>,
    formula: &mut Formula,
    outputs: &mut HashMap<String, NodeId>,
    in_progress: &mut HashMap<String, bool>,
) -> Result<NodeId, String> {
    if let Some(&n) = outputs.get(id) {
        return Ok(n);
    }
    let node = node_map
        .get(id)
        .ok_or_else(|| format!("unknown SFC node '{id}'"))?;
    if in_progress.insert(id.to_string(), true).is_some() {
        return Err(format!("SFC contains a cycle through node '{id}' (cyclic schemes are not supported)"));
    }
    // Canonical СФЦ vertex function: y = x · K · D, where K is the conjunction
    // of conjunctive-arc literals and D the disjunction of disjunctive-arc
    // literals (an empty group is TRUE). Each literal is the source vertex's
    // output function, negated when the arc has an inverse output. Per-arc kind
    // (`conjunctive`) wins; otherwise the node's legacy `combine` sets the
    // default ("and" => conjunctive, "or" => disjunctive).
    let default_conj = match node.combine.as_str() {
        "and" => true,
        "or" => false,
        other => return Err(format!("node '{id}': combine must be 'or' or 'and', got '{other}'")),
    };
    let mut conj: Vec<NodeId> = Vec::new();
    let mut disj: Vec<NodeId> = Vec::new();
    for arc in &node.inputs {
        let src = resolve_sfc_output(&arc.from, node_map, event_node, formula, outputs, in_progress)?;
        let lit = if arc.inverse { formula.add(Node::Not(src)) } else { src };
        if arc.conjunctive.unwrap_or(default_conj) {
            conj.push(lit);
        } else {
            disj.push(lit);
        }
    }
    let mut parts: Vec<NodeId> = Vec::new();
    if !conj.is_empty() {
        parts.push(if conj.len() == 1 { conj[0] } else { formula.add(Node::And(conj)) });
    }
    if !disj.is_empty() {
        parts.push(if disj.len() == 1 { disj[0] } else { formula.add(Node::Or(disj)) });
    }
    let comb = match parts.len() {
        0 => None,
        1 => Some(parts[0]),
        _ => Some(formula.add(Node::And(parts))),
    };
    let own = event_node.get(id).copied();
    let y = match (own, comb) {
        (Some(x), Some(c)) => formula.add(Node::And(vec![x, c])),
        (Some(x), None) => x,
        (None, Some(c)) => c,
        (None, None) => {
            return Err(format!("node '{id}' is fictive (no dist) and has no inputs"))
        }
    };
    in_progress.remove(id);
    outputs.insert(id.to_string(), y);
    Ok(y)
}

fn resolve_criterion(
    c: &CriterionInput,
    node_map: &HashMap<&str, &SfcNodeInput>,
    event_node: &HashMap<&str, NodeId>,
    formula: &mut Formula,
    outputs: &mut HashMap<String, NodeId>,
    in_progress: &mut HashMap<String, bool>,
) -> Result<NodeId, String> {
    match c {
        CriterionInput::Target { target, inverse } | CriterionInput::Node { node: target, inverse } => {
            let y = resolve_sfc_output(target, node_map, event_node, formula, outputs, in_progress)?;
            Ok(if *inverse { formula.add(Node::Not(y)) } else { y })
        }
        CriterionInput::Expr { op, args } => {
            let mut ch = Vec::with_capacity(args.len());
            for a in args {
                ch.push(resolve_criterion(a, node_map, event_node, formula, outputs, in_progress)?);
            }
            match op.as_str() {
                "and" => {
                    if ch.is_empty() {
                        return Err("criterion 'and' needs at least 1 argument".into());
                    }
                    Ok(formula.add(Node::And(ch)))
                }
                "or" => {
                    if ch.is_empty() {
                        return Err("criterion 'or' needs at least 1 argument".into());
                    }
                    Ok(formula.add(Node::Or(ch)))
                }
                "not" => {
                    if ch.len() != 1 {
                        return Err("criterion 'not' needs exactly 1 argument".into());
                    }
                    Ok(formula.add(Node::Not(ch[0])))
                }
                other => Err(format!("criterion: unknown op '{other}'")),
            }
        }
    }
}
