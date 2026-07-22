//! Главный конвейер расчёта. Шаги:
//!   1) разбить схему на модули (независимые части);
//!   2) на каждый модуль построить свой BDD;
//!   3) снизу вверх собрать точную вероятность вершины;
//!   4) минимальные сечения/пути: minsol на каждый модуль, затем "свёртка"
//!      (соединяем наборы модулей в общие наборы), с обрезкой по вероятности.
//! Разбиение на модули — это то, что делает большие схемы быстрыми.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use crate::bdd::Bdd;
use crate::io::{Options, Request, Response, SetReport, SetsReport, Stats, TimeResult};
use crate::model::{EventId, Formula, ModelKind, Node, NodeId, System};
use crate::module::find_modules;

/// Что означает переменная внутри BDD модуля: базовое событие или вложенный
/// модуль (он выступает как одно "псевдо-событие").
#[derive(Debug, Clone, Copy)]
enum LocalVar {
    Event(EventId),
    Module(usize),
}

/// Один готовый модуль: его BDD и что означает каждая переменная BDD.
struct ModuleData {
    bdd: Bdd,
    bdd_root: u32,
    /// Уровень BDD -> смысл переменной (событие или модуль).
    vars: Vec<LocalVar>,
}

/// Все модули схемы. Порядок такой, что дети идут раньше родителей.
struct Compiled {
    mods: Vec<ModuleData>,
    top: usize,
}

fn compile_modules(f: &Formula) -> Compiled {
    let modset = find_modules(f);
    let mut mods: Vec<ModuleData> = Vec::new();
    let mut done: HashMap<NodeId, usize> = HashMap::new();
    let top = process_module(f, &modset, f.root, &mut done, &mut mods);
    Compiled { mods, top }
}

fn process_module(
    f: &Formula,
    modset: &HashSet<NodeId>,
    root: NodeId,
    done: &mut HashMap<NodeId, usize>,
    mods: &mut Vec<ModuleData>,
) -> usize {
    if let Some(&i) = done.get(&root) {
        return i;
    }
    // Collect local variables in DFS preorder (good BDD ordering heuristic).
    // A "variable" is either a basic event or a nested module (pseudo-event).
    let mut vars: Vec<LocalVar> = Vec::new();
    let mut node_level: HashMap<NodeId, u32> = HashMap::new();
    let mut seen: HashSet<NodeId> = HashSet::new();
    let mut stack: Vec<NodeId> = vec![root];
    seen.insert(root);
    while let Some(v) = stack.pop() {
        if v != root && modset.contains(&v) {
            let mi = process_module(f, modset, v, done, mods);
            node_level.insert(v, vars.len() as u32);
            vars.push(LocalVar::Module(mi));
            continue;
        }
        match &f.nodes[v] {
            Node::Var(e) => {
                node_level.insert(v, vars.len() as u32);
                vars.push(LocalVar::Event(*e));
            }
            _ => {
                for i in (0..f.child_count(v)).rev() {
                    let c = f.child_at(v, i);
                    if seen.insert(c) {
                        stack.push(c);
                    }
                }
            }
        }
    }
    let mut bdd = Bdd::new();
    let mut memo: HashMap<NodeId, u32> = HashMap::new();
    let bdd_root = translate(f, root, &node_level, &mut bdd, &mut memo);
    let idx = mods.len();
    mods.push(ModuleData { bdd, bdd_root, vars });
    done.insert(root, idx);
    idx
}

fn translate(
    f: &Formula,
    v: NodeId,
    node_level: &HashMap<NodeId, u32>,
    bdd: &mut Bdd,
    memo: &mut HashMap<NodeId, u32>,
) -> u32 {
    if let Some(&r) = memo.get(&v) {
        return r;
    }
    let r = if let Some(&lvl) = node_level.get(&v) {
        bdd.var(lvl)
    } else {
        match &f.nodes[v] {
            Node::True => crate::bdd::TRUE,
            Node::False => crate::bdd::FALSE,
            Node::Var(_) => unreachable!("Var nodes are always in node_level"),
            Node::Not(c) => {
                let x = translate(f, *c, node_level, bdd, memo);
                bdd.not(x)
            }
            Node::And(cs) => {
                let mut acc = crate::bdd::TRUE;
                for &c in cs {
                    let x = translate(f, c, node_level, bdd, memo);
                    acc = bdd.and(acc, x);
                }
                acc
            }
            Node::Or(cs) => {
                let mut acc = crate::bdd::FALSE;
                for &c in cs {
                    let x = translate(f, c, node_level, bdd, memo);
                    acc = bdd.or(acc, x);
                }
                acc
            }
            Node::Xor(cs) => {
                let mut acc = crate::bdd::FALSE;
                for &c in cs {
                    let x = translate(f, c, node_level, bdd, memo);
                    acc = bdd.xor(acc, x);
                }
                acc
            }
            Node::AtLeast { k, args } => {
                let xs: Vec<u32> = args
                    .iter()
                    .map(|&c| translate(f, c, node_level, bdd, memo))
                    .collect();
                bdd.atleast(*k, &xs)
            }
        }
    };
    memo.insert(v, r);
    r
}

/// Считаем вероятность каждого модуля снизу вверх. На вход — p[event] для
/// базовых событий; модуль-ребёнок уже посчитан, когда доходим до родителя.
fn module_probs(c: &Compiled, p_event: &[f64]) -> Vec<f64> {
    let mut out = vec![0.0f64; c.mods.len()];
    for i in 0..c.mods.len() {
        let m = &c.mods[i];
        let vp: Vec<f64> = m
            .vars
            .iter()
            .map(|v| match v {
                LocalVar::Event(e) => p_event[*e],
                LocalVar::Module(j) => out[*j],
            })
            .collect();
        out[i] = m.bdd.prob(m.bdd_root, &vp);
    }
    out
}

// --- свёртка минимальных наборов --------------------------------------------

/// Вспомогательные данные для свёртки наборов (чтобы не таскать много аргументов).
struct ExpandCtx<'a> {
    c: &'a Compiled,
    /// P(литерал истинен) по событиям для текущей функции.
    lit_p: &'a [f64],
    /// Вероятность каждого модуля (нужна, чтобы при обрезке оставить вероятные).
    mod_p: Vec<f64>,
    max_order: usize,
    max_sets: usize,
    cutoff: f64,
    truncated: bool,
    memo: Vec<Option<Rc<Vec<(Vec<EventId>, f64)>>>>,
}

/// "Разворачиваем" минимальные наборы модуля в наборы по базовым событиям:
/// вместо вложенного модуля подставляем его наборы (декартова свёртка).
/// Модули независимы и не делят события, so minimal sets stay minimal.
fn expand(ctx: &mut ExpandCtx, m: usize) -> Rc<Vec<(Vec<EventId>, f64)>> {
    if let Some(r) = &ctx.memo[m] {
        return Rc::clone(r);
    }
    let c = ctx.c;
    let md = &c.mods[m];
    let vp: Vec<f64> = md
        .vars
        .iter()
        .map(|v| match v {
            LocalVar::Event(e) => ctx.lit_p[*e],
            LocalVar::Module(j) => ctx.mod_p[*j],
        })
        .collect();
    let (local, trunc) = md
        .bdd
        .minsol(md.bdd_root, &vp, ctx.max_order, ctx.max_sets, ctx.cutoff);
    if trunc {
        ctx.truncated = true;
    }
    let mut out: Vec<(Vec<EventId>, f64)> = Vec::new();
    'sets: for (set, _) in &local {
        let mut acc: Vec<(Vec<EventId>, f64)> = vec![(Vec::new(), 1.0)];
        for &lvl in set {
            let mut next: Vec<(Vec<EventId>, f64)> = Vec::new();
            match md.vars[lvl as usize] {
                LocalVar::Event(e) => {
                    let p = ctx.lit_p[e];
                    for (ev, pr) in &acc {
                        let npr = pr * p;
                        if ev.len() + 1 <= ctx.max_order && npr >= ctx.cutoff {
                            let mut nev = ev.clone();
                            nev.push(e);
                            next.push((nev, npr));
                        } else {
                            ctx.truncated = true;
                        }
                    }
                }
                LocalVar::Module(j) => {
                    let sub = expand(ctx, j);
                    for (ev, pr) in &acc {
                        for (sev, spr) in sub.iter() {
                            let npr = pr * spr;
                            if ev.len() + sev.len() <= ctx.max_order && npr >= ctx.cutoff {
                                let mut nev = ev.clone();
                                nev.extend_from_slice(sev);
                                next.push((nev, npr));
                            } else {
                                ctx.truncated = true;
                            }
                        }
                    }
                }
            }
            if next.len() > ctx.max_sets {
                next.truncate(ctx.max_sets);
                ctx.truncated = true;
            }
            acc = next;
            if acc.is_empty() {
                continue 'sets;
            }
        }
        out.extend(acc);
        if out.len() > ctx.max_sets {
            out.truncate(ctx.max_sets);
            ctx.truncated = true;
            break;
        }
    }
    let rc = Rc::new(out);
    ctx.memo[m] = Some(Rc::clone(&rc));
    rc
}

/// Compute minimal solutions of `formula` expanded to basic events.
/// `lit_p[e]` is the probability that literal e is true.
fn minimal_sets(formula: &Formula, lit_p: &[f64], opts: &Options) -> (Vec<(Vec<EventId>, f64)>, bool) {
    let compiled = compile_modules(formula);
    let nmods = compiled.mods.len();
    let mod_p = module_probs(&compiled, lit_p);
    let mut ctx = ExpandCtx {
        c: &compiled,
        lit_p,
        mod_p,
        max_order: opts.max_order,
        max_sets: opts.max_sets,
        cutoff: opts.cutoff,
        truncated: false,
        memo: vec![None; nmods],
    };
    let top = ctx.c.top;
    let sets = expand(&mut ctx, top);
    let mut result: Vec<(Vec<EventId>, f64)> = (*sets).clone();
    for (ev, _) in result.iter_mut() {
        ev.sort_unstable();
    }
    // Most probable sets first.
    result.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut truncated = ctx.truncated;
    if result.len() > opts.max_sets {
        result.truncate(opts.max_sets);
        truncated = true;
    }
    (result, truncated)
}

fn sets_report(sets: Vec<(Vec<EventId>, f64)>, truncated: bool, sys: &System) -> SetsReport {
    let rare_event: f64 = sets.iter().map(|(_, p)| p).sum();
    let ep = 1.0 - sets.iter().map(|(_, p)| 1.0 - p).product::<f64>();
    SetsReport {
        count: sets.len(),
        truncated,
        rare_event_approx: rare_event,
        esary_proschan_bound: ep,
        sets: sets
            .into_iter()
            .map(|(ev, p)| SetReport {
                order: ev.len(),
                events: ev.iter().map(|&e| sys.events[e].name.clone()).collect(),
                probability: p,
            })
            .collect(),
    }
}

// --- вход в модуль (точка входа) --------------------------------------------

/// Главная функция: прочитать модель из запроса и посчитать её.
pub fn analyze_request(req: &Request) -> Result<Response, String> {
    let sys = crate::io::compile(&req.model)?;
    analyze_system(&sys, req)
}

/// Посчитать уже собранную систему: вероятность вершины по всем временам,
/// плюс минимальные сечения и пути.
pub fn analyze_system(sys: &System, req: &Request) -> Result<Response, String> {
    // Список времён: либо `times`, либо одно `mission_time` (или 0).
    let times: Vec<f64> = match &req.times {
        Some(ts) if !ts.is_empty() => ts.clone(),
        _ => vec![req.mission_time.unwrap_or(0.0)],
    };
    for t in &times {
        if !t.is_finite() || *t < 0.0 {
            return Err(format!("invalid time {t}"));
        }
    }
    let opts = &req.options;
    let mut warnings: Vec<String> = Vec::new();

    // P(Var истинно) для каждого события и времени (дерево: q; СФЦ: 1-q).
    let p_by_time: Vec<Vec<f64>> = times
        .iter()
        .map(|&t| (0..sys.events.len()).map(|e| sys.var_prob(e, t)).collect())
        .collect();

    // Точная вероятность вершины через модульные BDD.
    let compiled = compile_modules(&sys.formula);
    let results: Vec<TimeResult> = times
        .iter()
        .zip(p_by_time.iter())
        .map(|(&t, p)| TimeResult {
            time: t,
            top_probability: module_probs(&compiled, p)[compiled.top],
        })
        .collect();

    let noncoherent = sys.formula.has_negation();
    if noncoherent && (opts.cut_sets || opts.path_sets) {
        warnings.push(
            "model is non-coherent (contains NOT/XOR): minimal sets are computed \
             from positive literals only and may be approximate"
                .to_string(),
        );
    }

    // Прямой minsol = наборы, которые делают вершину ИСТИННОЙ.
    // Двойственный minsol = наборы, ложность которых делает вершину ЛОЖНОЙ.
    // Дерево (вершина = отказ):  прямой -> сечения, двойственный -> пути.
    // СФЦ    (вершина = критерий): прямой -> пути,   двойственный -> сечения.
    let p0 = &p_by_time[0];
    let dual_p: Vec<f64> = p0.iter().map(|p| 1.0 - p).collect();
    let want_primary = match sys.kind {
        ModelKind::FaultTree => opts.cut_sets,
        ModelKind::Sfc => opts.path_sets,
    };
    let want_dual = match sys.kind {
        ModelKind::FaultTree => opts.path_sets,
        ModelKind::Sfc => opts.cut_sets,
    };
    let primary = if want_primary {
        let (sets, trunc) = minimal_sets(&sys.formula, p0, opts);
        Some(sets_report(sets, trunc, sys))
    } else {
        None
    };
    let dual = if want_dual {
        let dual_formula = sys.formula.dual();
        let (sets, trunc) = minimal_sets(&dual_formula, &dual_p, opts);
        Some(sets_report(sets, trunc, sys))
    } else {
        None
    };
    let (cut_sets, path_sets) = match sys.kind {
        ModelKind::FaultTree => (primary, dual),
        ModelKind::Sfc => (dual, primary),
    };
    if let Some(r) = &cut_sets {
        if r.truncated {
            warnings.push("cut set list was truncated (max_order / max_sets / cutoff)".into());
        }
    }
    if let Some(r) = &path_sets {
        if r.truncated {
            warnings.push("path set list was truncated (max_order / max_sets / cutoff)".into());
        }
    }

    Ok(Response {
        interpretation: match sys.kind {
            ModelKind::FaultTree => "P(top event / failure)".to_string(),
            ModelKind::Sfc => "P(criterion is satisfied)".to_string(),
        },
        results,
        cut_sets,
        path_sets,
        stats: Stats {
            events: sys.events.len(),
            formula_nodes: sys.formula.nodes.len(),
            modules: compiled.mods.len(),
            bdd_nodes: compiled.mods.iter().map(|m| m.bdd.node_count()).sum(),
            noncoherent,
        },
        warnings,
    })
}
