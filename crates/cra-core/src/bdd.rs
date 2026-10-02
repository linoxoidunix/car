//! BDD — двоичная диаграмма решений (ROBDD) с хеш-консингом.
//!
//! Что это. BDD — компактный способ хранить булеву функцию как граф. У каждого
//! узла есть переменная и две ветки: `lo` (переменная = 0) и `hi` (= 1).
//! Одинаковые подграфы храним один раз (hash-consing), so it stays small.
//!
//! Что умеет этот модуль: apply (И/ИЛИ/XOR), отрицание, "K из N", точный
//! расчёт вероятности (разложение Шеннона) и минимальные наборы (алгоритм
//! Рози, minsol) — из них получаем минимальные сечения и пути.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

pub const FALSE: u32 = 0;
pub const TRUE: u32 = 1;
/// Специальная "переменная" у листьев TRUE/FALSE (больше любой настоящей).
const TERMINAL_VAR: u32 = u32::MAX;

/// Один узел BDD: переменная и две ветки (lo = 0, hi = 1).
#[derive(Debug, Clone, Copy)]
struct BddNode {
    var: u32,
    lo: u32,
    hi: u32,
}

/// Узел BDD для выдачи наружу (см. `Bdd::export`): уровень переменной и ветки
/// в новой, плотной нумерации.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExportNode {
    pub var: u32,
    pub lo: u32,
    pub hi: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Op {
    And,
    Or,
    Xor,
}

/// Хранилище BDD. Все узлы в одном списке; кеши не дают делать лишнюю работу.
#[derive(Debug)]
pub struct Bdd {
    nodes: Vec<BddNode>,
    /// Чтобы одинаковые узлы были одним узлом (var, lo, hi) -> id.
    unique: HashMap<(u32, u32, u32), u32>,
    /// Кеш операций apply (op, a, b) -> результат.
    apply_cache: HashMap<(u8, u32, u32), u32>,
    /// Кеш отрицания.
    not_cache: HashMap<u32, u32>,
}

impl Default for Bdd {
    fn default() -> Self {
        Self::new()
    }
}

impl Bdd {
    pub fn new() -> Self {
        Bdd {
            nodes: vec![
                BddNode { var: TERMINAL_VAR, lo: FALSE, hi: FALSE },
                BddNode { var: TERMINAL_VAR, lo: TRUE, hi: TRUE },
            ],
            unique: HashMap::new(),
            apply_cache: HashMap::new(),
            not_cache: HashMap::new(),
        }
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// Сама функция `root` как граф — чтобы её можно было нарисовать.
    ///
    /// В хранилище кроме неё лежат промежуточные узлы, оставшиеся от apply
    /// (поэтому `node_count` больше); берём только достижимые из корня. Нумерация
    /// новая и плотная: 0 = FALSE, 1 = TRUE, узлы — с 2, сверху вниз по уровням
    /// (внутри уровня — в порядке обхода). Узел `nodes[i]` имеет id `i + 2`.
    /// Возвращает (id корня, узлы).
    pub fn export(&self, root: u32) -> (u32, Vec<ExportNode>) {
        let mut seen: HashSet<u32> = HashSet::new();
        let mut order: Vec<u32> = Vec::new();
        let mut stack: Vec<u32> = vec![root];
        while let Some(u) = stack.pop() {
            if u == FALSE || u == TRUE || !seen.insert(u) {
                continue;
            }
            order.push(u);
            let n = self.nodes[u as usize];
            stack.push(n.hi);
            stack.push(n.lo);
        }
        // Устойчивая сортировка: по уровню, а внутри уровня порядок обхода
        // сохраняется — выдача детерминирована. Ветки всегда ведут на уровни
        // ниже, поэтому дети стоят в списке после родителей.
        order.sort_by_key(|&u| self.nodes[u as usize].var);
        let new_id: HashMap<u32, u32> =
            order.iter().enumerate().map(|(i, &u)| (u, i as u32 + 2)).collect();
        let map = |u: u32| if u == FALSE || u == TRUE { u } else { new_id[&u] };
        let nodes = order
            .iter()
            .map(|&u| {
                let n = self.nodes[u as usize];
                ExportNode { var: n.var, lo: map(n.lo), hi: map(n.hi) }
            })
            .collect();
        (map(root), nodes)
    }

    /// Сделать (или найти) узел. Два правила ROBDD: если обе ветки равны —
    /// узел не нужен, возвращаем ветку; одинаковые узлы не дублируем.
    fn mk(&mut self, var: u32, lo: u32, hi: u32) -> u32 {
        if lo == hi {
            return lo;
        }
        if let Some(&id) = self.unique.get(&(var, lo, hi)) {
            return id;
        }
        let id = self.nodes.len() as u32;
        self.nodes.push(BddNode { var, lo, hi });
        self.unique.insert((var, lo, hi), id);
        id
    }

    /// BDD одной переменной v: если v=0 -> FALSE, если v=1 -> TRUE.
    pub fn var(&mut self, v: u32) -> u32 {
        self.mk(v, FALSE, TRUE)
    }

    pub fn and(&mut self, a: u32, b: u32) -> u32 {
        self.apply(Op::And, a, b)
    }

    pub fn or(&mut self, a: u32, b: u32) -> u32 {
        self.apply(Op::Or, a, b)
    }

    pub fn xor(&mut self, a: u32, b: u32) -> u32 {
        self.apply(Op::Xor, a, b)
    }

    pub fn not(&mut self, a: u32) -> u32 {
        if a == FALSE {
            return TRUE;
        }
        if a == TRUE {
            return FALSE;
        }
        if let Some(&r) = self.not_cache.get(&a) {
            return r;
        }
        let BddNode { var, lo, hi } = self.nodes[a as usize];
        let nlo = self.not(lo);
        let nhi = self.not(hi);
        let r = self.mk(var, nlo, nhi);
        self.not_cache.insert(a, r);
        self.not_cache.insert(r, a);
        r
    }

    /// Применить операцию (И/ИЛИ/XOR) к двум BDD. Работаем по переменным
    /// сверху вниз (разложение Шеннона) и кешируем результаты.
    fn apply(&mut self, op: Op, a: u32, b: u32) -> u32 {
        // Простые случаи с листьями TRUE/FALSE (terminal cases).
        match op {
            Op::And => {
                if a == FALSE || b == FALSE {
                    return FALSE;
                }
                if a == TRUE {
                    return b;
                }
                if b == TRUE || a == b {
                    return a;
                }
            }
            Op::Or => {
                if a == TRUE || b == TRUE {
                    return TRUE;
                }
                if a == FALSE {
                    return b;
                }
                if b == FALSE || a == b {
                    return a;
                }
            }
            Op::Xor => {
                if a == b {
                    return FALSE;
                }
                if a == FALSE {
                    return b;
                }
                if b == FALSE {
                    return a;
                }
                if a == TRUE {
                    return self.not(b);
                }
                if b == TRUE {
                    return self.not(a);
                }
            }
        }
        // AND/OR/XOR are commutative: normalize the cache key.
        let key = (op as u8, a.min(b), a.max(b));
        if let Some(&r) = self.apply_cache.get(&key) {
            return r;
        }
        let na = self.nodes[a as usize];
        let nb = self.nodes[b as usize];
        let v = na.var.min(nb.var);
        let (a0, a1) = if na.var == v { (na.lo, na.hi) } else { (a, a) };
        let (b0, b1) = if nb.var == v { (nb.lo, nb.hi) } else { (b, b) };
        let lo = self.apply(op, a0, b0);
        let hi = self.apply(op, a1, b1);
        let r = self.mk(v, lo, hi);
        self.apply_cache.insert(key, r);
        r
    }

    /// "K из N": истинно, когда работают хотя бы k из входов xs. Рекурсия:
    /// f(i,k) = (x_i И f(i+1,k-1)) ИЛИ f(i+1,k) — берём вход i или пропускаем.
    pub fn atleast(&mut self, k: usize, xs: &[u32]) -> u32 {
        let mut memo: HashMap<(usize, usize), u32> = HashMap::new();
        self.atleast_rec(k, 0, xs, &mut memo)
    }

    fn atleast_rec(
        &mut self,
        k: usize,
        i: usize,
        xs: &[u32],
        memo: &mut HashMap<(usize, usize), u32>,
    ) -> u32 {
        if k == 0 {
            return TRUE;
        }
        if xs.len() - i < k {
            return FALSE;
        }
        if let Some(&r) = memo.get(&(i, k)) {
            return r;
        }
        let hi = self.atleast_rec(k - 1, i + 1, xs, memo);
        let taken = self.and(xs[i], hi);
        let skipped = self.atleast_rec(k, i + 1, xs, memo);
        let r = self.or(taken, skipped);
        memo.insert((i, k), r);
        r
    }

    /// Точная вероятность, что функция истинна. На вход — p[i] = P(переменная i
    /// истинна). Формула на каждом узле: P = p_v*P(hi) + (1-p_v)*P(lo). This is
    /// exact because variables are independent (modules make sure of that).
    pub fn prob(&self, root: u32, p: &[f64]) -> f64 {
        let mut memo: HashMap<u32, f64> = HashMap::new();
        self.prob_rec(root, p, &mut memo)
    }

    fn prob_rec(&self, u: u32, p: &[f64], memo: &mut HashMap<u32, f64>) -> f64 {
        if u == FALSE {
            return 0.0;
        }
        if u == TRUE {
            return 1.0;
        }
        if let Some(&r) = memo.get(&u) {
            return r;
        }
        let n = self.nodes[u as usize];
        let pv = p[n.var as usize];
        let r = pv * self.prob_rec(n.hi, p, memo) + (1.0 - pv) * self.prob_rec(n.lo, p, memo);
        memo.insert(u, r);
        r
    }

    /// Минимальные наборы (minsol, алгоритм Рози). Это наименьшие наборы
    /// переменных, при истинности которых функция истинна. Для функции отказа
    /// это и есть минимальные сечения (МНС). Каждый набор идёт с его
    /// вероятностью (произведение p по переменным набора).
    ///
    /// Обрезка по вероятности: `max_order` — предел размера набора, `cutoff`
    /// выкидывает слишком редкие наборы, а при переполнении `max_sets` мы
    /// оставляем самые вероятные. Returns (наборы, был_ли_обрез).
    pub fn minsol(
        &self,
        root: u32,
        p: &[f64],
        max_order: usize,
        max_sets: usize,
        cutoff: f64,
    ) -> (Vec<(Vec<u32>, f64)>, bool) {
        let mut memo: HashMap<u32, Rc<Vec<(Vec<u32>, f64)>>> = HashMap::new();
        let mut truncated = false;
        let sets = self.minsol_rec(root, p, max_order, max_sets, cutoff, &mut memo, &mut truncated);
        ((*sets).clone(), truncated)
    }

    #[allow(clippy::too_many_arguments)]
    fn minsol_rec(
        &self,
        u: u32,
        p: &[f64],
        max_order: usize,
        max_sets: usize,
        cutoff: f64,
        memo: &mut HashMap<u32, Rc<Vec<(Vec<u32>, f64)>>>,
        truncated: &mut bool,
    ) -> Rc<Vec<(Vec<u32>, f64)>> {
        if u == FALSE {
            return Rc::new(Vec::new());
        }
        if u == TRUE {
            return Rc::new(vec![(Vec::new(), 1.0)]);
        }
        if let Some(r) = memo.get(&u) {
            return Rc::clone(r);
        }
        let n = self.nodes[u as usize];
        let s0 = self.minsol_rec(n.lo, p, max_order, max_sets, cutoff, memo, truncated);
        let s1 = self.minsol_rec(n.hi, p, max_order, max_sets, cutoff, memo, truncated);
        let mut res: Vec<(Vec<u32>, f64)> = (*s0).clone();
        let pv = p[n.var as usize];
        for (c, cp) in s1.iter() {
            if c.len() + 1 > max_order {
                *truncated = true;
                continue;
            }
            let cand_p = pv * cp;
            if cand_p < cutoff {
                *truncated = true;
                continue;
            }
            // Набор {var} + c минимален, только если ни один набор из ветки lo
            // не входит в c целиком. Иначе {var}+c не минимален — выкидываем.
            if s0.iter().any(|(z, _)| is_subset(z, c)) {
                continue;
            }
            let mut cand = Vec::with_capacity(c.len() + 1);
            cand.push(n.var);
            cand.extend_from_slice(c);
            res.push((cand, cand_p));
        }
        if res.len() > max_sets {
            // Слишком много наборов: оставляем самые вероятные. Быстрый выбор
            // (O(n)) без полной сортировки.
            res.select_nth_unstable_by(max_sets - 1, |a, b| {
                b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)
            });
            res.truncate(max_sets);
            *truncated = true;
        }
        let rc = Rc::new(res);
        memo.insert(u, Rc::clone(&rc));
        rc
    }
}

/// Проверка a ⊆ b для отсортированных наборов (a является подмножеством b).
fn is_subset(a: &[u32], b: &[u32]) -> bool {
    let mut j = 0usize;
    for &x in a {
        while j < b.len() && b[j] < x {
            j += 1;
        }
        if j >= b.len() || b[j] != x {
            return false;
        }
        j += 1;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn and_or_prob() {
        let mut b = Bdd::new();
        let x = b.var(0);
        let y = b.var(1);
        let f_and = b.and(x, y);
        let f_or = b.or(x, y);
        let p = [0.1, 0.2];
        assert!((b.prob(f_and, &p) - 0.02).abs() < 1e-15);
        assert!((b.prob(f_or, &p) - 0.28).abs() < 1e-15);
    }

    #[test]
    fn two_of_three() {
        let mut b = Bdd::new();
        let xs = [b.var(0), b.var(1), b.var(2)];
        let f = b.atleast(2, &xs);
        let p = [0.1, 0.1, 0.1];
        // 3*q^2*(1-q) + q^3 = 0.028
        assert!((b.prob(f, &p) - 0.028).abs() < 1e-15);
        let (sets, trunc) = b.minsol(f, &p, 8, 1000, 0.0);
        assert!(!trunc);
        assert_eq!(sets.len(), 3);
        assert!(sets.iter().all(|(s, sp)| s.len() == 2 && (sp - 0.01).abs() < 1e-15));
    }

    #[test]
    fn minsol_subsumes() {
        // f = a | (a & b) -> minimal solutions: {a}
        let mut b = Bdd::new();
        let a = b.var(0);
        let x = b.var(1);
        let ab = b.and(a, x);
        let f = b.or(a, ab);
        let p = [0.5, 0.5];
        let (sets, _) = b.minsol(f, &p, 8, 1000, 0.0);
        assert_eq!(sets.len(), 1);
        assert_eq!(sets[0].0, vec![0]);
    }

    #[test]
    fn minsol_truncation_keeps_most_probable() {
        // f = a | b | c with very different probabilities; cap at 2 sets.
        let mut b = Bdd::new();
        let x = b.var(0);
        let y = b.var(1);
        let z = b.var(2);
        let xy = b.or(x, y);
        let f = b.or(xy, z);
        let p = [0.001, 0.5, 0.2];
        let (sets, trunc) = b.minsol(f, &p, 8, 2, 0.0);
        assert!(trunc);
        assert_eq!(sets.len(), 2);
        let kept: Vec<u32> = sets.iter().map(|(s, _)| s[0]).collect();
        assert!(kept.contains(&1) && kept.contains(&2), "kept = {kept:?}");
    }

    #[test]
    fn export_keeps_only_the_function() {
        // f = a | (a & b) = a: the store also holds the node of a & b, left
        // over from apply, but the function itself is a single node.
        let mut b = Bdd::new();
        let a = b.var(0);
        let x = b.var(1);
        let ab = b.and(a, x);
        let f = b.or(a, ab);
        assert!(b.node_count() > 3);
        let (root, nodes) = b.export(f);
        assert_eq!(root, 2);
        assert_eq!(nodes, vec![ExportNode { var: 0, lo: FALSE, hi: TRUE }]);
        // Terminal roots export as themselves, with no nodes.
        assert_eq!(b.export(TRUE), (TRUE, Vec::new()));
    }

    #[test]
    fn export_orders_levels_top_down() {
        // 2-of-3 over levels 0..2: every branch points to a node further down
        // the list (a higher level) or to a terminal.
        let mut b = Bdd::new();
        let xs = [b.var(0), b.var(1), b.var(2)];
        let f = b.atleast(2, &xs);
        let (root, nodes) = b.export(f);
        assert_eq!(root, 2);
        assert_eq!(nodes.len(), 4); // x0; x1 twice (after x0=0 / x0=1); x2 once
        for (i, n) in nodes.iter().enumerate() {
            for c in [n.lo, n.hi] {
                if c > TRUE {
                    let child = nodes[c as usize - 2];
                    assert!(c as usize > i + 2 && child.var > n.var);
                }
            }
        }
        let levels: Vec<u32> = nodes.iter().map(|n| n.var).collect();
        assert_eq!(levels, vec![0, 1, 1, 2]);
    }

    #[test]
    fn not_is_involution() {
        let mut b = Bdd::new();
        let x = b.var(0);
        let y = b.var(1);
        let f = b.and(x, y);
        let nf = b.not(f);
        let nnf = b.not(nf);
        assert_eq!(f, nnf);
    }
}
