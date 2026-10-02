//! Единое внутреннее представление: граф (DAG) логических узлов над базовыми
//! событиями. И дерево отказов, и СФЦ превращаются в такой граф. So the rest
//! of the engine works with one common form.

use std::collections::HashMap;

use crate::dist::ReliabilityModel;

pub type NodeId = usize;
pub type EventId = usize;

/// Один узел логической формулы.
#[derive(Debug, Clone)]
pub enum Node {
    True,
    False,
    /// Базовое событие. На одно событие ровно один узел Var.
    Var(EventId),
    Not(NodeId),
    And(Vec<NodeId>),
    Or(Vec<NodeId>),
    Xor(Vec<NodeId>),
    AtLeast { k: usize, args: Vec<NodeId> },
}

/// Вся формула. Узлы лежат в одном списке; `root` — вершина (top).
#[derive(Debug, Clone, Default)]
pub struct Formula {
    pub nodes: Vec<Node>,
    pub root: NodeId,
}

impl Formula {
    /// Добавить узел и вернуть его id (индекс в списке).
    pub fn add(&mut self, node: Node) -> NodeId {
        self.nodes.push(node);
        self.nodes.len() - 1
    }

    pub fn child_count(&self, id: NodeId) -> usize {
        match &self.nodes[id] {
            Node::True | Node::False | Node::Var(_) => 0,
            Node::Not(_) => 1,
            Node::And(v) | Node::Or(v) | Node::Xor(v) => v.len(),
            Node::AtLeast { args, .. } => args.len(),
        }
    }

    pub fn child_at(&self, id: NodeId, i: usize) -> NodeId {
        match &self.nodes[id] {
            Node::Not(c) => *c,
            Node::And(v) | Node::Or(v) | Node::Xor(v) => v[i],
            Node::AtLeast { args, .. } => args[i],
            _ => panic!("node has no children"),
        }
    }

    /// Узел — это "элемент" (gate), а не событие/константа?
    pub fn is_gate(&self, id: NodeId) -> bool {
        !matches!(self.nodes[id], Node::True | Node::False | Node::Var(_))
    }

    /// true, если формула немонотонная: есть НЕ или XOR. Non-coherent = harder
    /// case, minimal sets need more care.
    pub fn has_negation(&self) -> bool {
        self.nodes.iter().any(|n| matches!(n, Node::Not(_) | Node::Xor(_)))
    }

    /// Двойственная формула по Де Моргану: f^D(x) = !f(!x). Меняем И<->ИЛИ.
    /// Trick: minimal solutions of the dual of a failure function are the
    /// minimal path sets (и наоборот). Так мы получаем пути из сечений.
    pub fn dual(&self) -> Formula {
        let n = self.nodes.len();
        let mut nodes: Vec<Node> = Vec::with_capacity(n);
        let mut extra: Vec<Node> = Vec::new();
        for node in &self.nodes {
            let mapped = match node {
                Node::True => Node::False,
                Node::False => Node::True,
                Node::Var(e) => Node::Var(*e),
                Node::Not(c) => Node::Not(*c),
                Node::And(v) => Node::Or(v.clone()),
                Node::Or(v) => Node::And(v.clone()),
                Node::AtLeast { k, args } => Node::AtLeast {
                    k: args.len() - k + 1,
                    args: args.clone(),
                },
                Node::Xor(v) => {
                    if v.len() % 2 == 1 {
                        // Нечётное число входов: xor(!x) == !xor(x), so dual == xor.
                        Node::Xor(v.clone())
                    } else {
                        // Чётное число: dual == not(xor). Добавляем внутренний узел.
                        let j = n + extra.len();
                        extra.push(Node::Xor(v.clone()));
                        Node::Not(j)
                    }
                }
            };
            nodes.push(mapped);
        }
        nodes.extend(extra);
        Formula { nodes, root: self.root }
    }
}

/// Базовое событие: имя и модель надёжности (как оно отказывает во времени).
#[derive(Debug, Clone)]
pub struct BasicEvent {
    pub name: String,
    pub model: ReliabilityModel,
}

/// Тип модели. От него зависит смысл переменной Var и что считает вершина.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelKind {
    /// Дерево отказов: Var(e) истинно, когда событие ПРОИЗОШЛО (элемент отказал).
    /// Вершина = функция отказа. P(Var) = q(t).
    FaultTree,
    /// СФЦ: Var(e) истинно, когда элемент РАБОТАЕТ. Вершина = критерий
    /// работоспособности. P(Var) = 1 - q(t).
    Sfc,
}

/// Готовая к расчёту система: тип, список событий и логическая формула.
#[derive(Debug, Clone)]
pub struct System {
    pub kind: ModelKind,
    pub events: Vec<BasicEvent>,
    pub formula: Formula,
    /// Имена из входной схемы у узлов формулы: элемент дерева отказов или узел
    /// СФЦ, чья функция этот узел. Расчёту не нужны — по ним выдача называет
    /// модули (у служебных узлов имени нет).
    pub labels: HashMap<NodeId, String>,
}

impl System {
    /// Вероятность, что Var(e) истинно в момент t (с учётом типа модели).
    pub fn var_prob(&self, e: EventId, t: f64) -> f64 {
        let q = self.events[e].model.unavailability(t);
        match self.kind {
            ModelKind::FaultTree => q,
            ModelKind::Sfc => 1.0 - q,
        }
    }
}
