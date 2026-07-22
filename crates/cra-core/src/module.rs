//! Find modules in the tree (Dutuit & Rauzy algorithm, linear time).
//!
//! A module is a gate whose subtree does not share any node with the rest of
//! the tree. A module is independent from the rest. So we can solve it alone
//! and use it as one new "event". This is why big trees stay fast.
//!
//! How we find modules. We walk the tree (DFS) and write two numbers on each
//! node: the time of the first visit, and the time of the last visit. A gate
//! `v` is a module when all its descendants were both first seen and last seen
//! strictly inside the time window of `v`:
//!   min(first visit of descendants) > first visit of v   and
//!   max(last  visit of descendants) < last  visit of v.
//! If some descendant is also used outside `v`, its times fall outside this
//! window, and `v` is not a module.

use crate::model::{Formula, NodeId};
use std::collections::HashSet;

/// Return the set of gate ids that are modules. The root is always a module.
pub fn find_modules(f: &Formula) -> HashSet<NodeId> {
    let n = f.nodes.len();
    let mut result = HashSet::new();
    if n == 0 {
        return result;
    }
    let root = f.root;
    result.insert(root); // the whole tree is always a module

    let mut d1 = vec![0usize; n]; // time of first visit (0 means: not visited yet)
    let mut dl = vec![0usize; n]; // time of last visit
    let mut t: usize = 0; // clock; we add 1 on every step

    // Step 1: walk the tree and set the first/last visit time on each node.
    // We use our own stack, not recursion. Each item is (node, next child).
    let mut stack: Vec<(NodeId, usize)> = Vec::new();
    t += 1;
    d1[root] = t;
    dl[root] = t;
    stack.push((root, 0));
    while let Some((v, ci)) = stack.pop() {
        if ci < f.child_count(v) {
            stack.push((v, ci + 1)); // come back later for the next child
            let c = f.child_at(v, ci);
            t += 1;
            if d1[c] == 0 {
                // first time we see this child: go into it
                d1[c] = t;
                dl[c] = t;
                stack.push((c, 0));
            } else {
                dl[c] = t; // we saw it before: only update the last-visit time
            }
        } else {
            // all children are done: write the last-visit time again
            t += 1;
            dl[v] = t;
        }
    }

    // Step 2: for each node, find the smallest first-visit time and the biggest
    // last-visit time over all its descendants. We do this bottom-up. `state`
    // marks each node: 0 = not seen, 1 = on stack, 2 = done.
    let mut minf = vec![usize::MAX; n]; // min first-visit time of descendants
    let mut maxl = vec![0usize; n]; //     max last-visit  time of descendants
    let mut state = vec![0u8; n];
    let mut st: Vec<(NodeId, usize)> = vec![(root, 0)];
    state[root] = 1;
    while let Some((v, ci)) = st.pop() {
        if ci < f.child_count(v) {
            st.push((v, ci + 1));
            let c = f.child_at(v, ci);
            if state[c] == 0 {
                state[c] = 1;
                st.push((c, 0));
            }
        } else {
            // all children are done, so we can sum up the child values now
            state[v] = 2;
            let mut mn = usize::MAX;
            let mut mx = 0usize;
            for i in 0..f.child_count(v) {
                let c = f.child_at(v, i);
                mn = mn.min(d1[c]).min(minf[c]);
                mx = mx.max(dl[c]).max(maxl[c]);
            }
            minf[v] = mn;
            maxl[v] = mx;
        }
    }

    // Step 3: a gate is a module if all its descendants stay inside its window.
    for v in 0..n {
        if v == root || d1[v] == 0 || !f.is_gate(v) {
            continue; // skip the root (already added), unvisited nodes, and leaves
        }
        if minf[v] > d1[v] && maxl[v] < dl[v] {
            result.insert(v);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Node;

    /// (a&b) | (c&d): the two AND gates use different events, so both are
    /// modules. The top gate is a module too.
    #[test]
    fn independent_subtrees_are_modules() {
        let mut f = Formula::default();
        let a = f.add(Node::Var(0));
        let b = f.add(Node::Var(1));
        let c = f.add(Node::Var(2));
        let d = f.add(Node::Var(3));
        let g1 = f.add(Node::And(vec![a, b]));
        let g2 = f.add(Node::And(vec![c, d]));
        let top = f.add(Node::Or(vec![g1, g2]));
        f.root = top;
        let m = find_modules(&f);
        assert!(m.contains(&top));
        assert!(m.contains(&g1));
        assert!(m.contains(&g2));
        assert_eq!(m.len(), 3);
    }

    /// (a&b) | (b&c): both gates use event b, so b is shared. Because of this
    /// neither gate is a module. Only the top gate is.
    #[test]
    fn shared_event_blocks_modules() {
        let mut f = Formula::default();
        let a = f.add(Node::Var(0));
        let b = f.add(Node::Var(1));
        let c = f.add(Node::Var(2));
        let g1 = f.add(Node::And(vec![a, b]));
        let g2 = f.add(Node::And(vec![b, c]));
        let top = f.add(Node::Or(vec![g1, g2]));
        f.root = top;
        let m = find_modules(&f);
        assert!(m.contains(&top));
        assert!(!m.contains(&g1));
        assert!(!m.contains(&g2));
        assert_eq!(m.len(), 1);
    }

    /// A gate can have two parents and still be a module, if its own subtree
    /// (here p and q) is not used anywhere else.
    #[test]
    fn shared_gate_with_private_subtree_is_module() {
        let mut f = Formula::default();
        let p = f.add(Node::Var(0));
        let q = f.add(Node::Var(1));
        let x = f.add(Node::Var(2));
        let m_gate = f.add(Node::And(vec![p, q]));
        let g = f.add(Node::And(vec![x, m_gate]));
        let top = f.add(Node::Or(vec![m_gate, g]));
        f.root = top;
        let m = find_modules(&f);
        assert!(m.contains(&m_gate));
    }
}
