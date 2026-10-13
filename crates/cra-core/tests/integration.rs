use cra::io::Request;

fn run(json: &str) -> cra::Response {
    let req: Request = serde_json::from_str(json).expect("request parses");
    cra::analyze_request(&req).expect("analysis succeeds")
}

/// Classic bridge network modeled as a fault tree of its minimal cut sets:
/// {1,2}, {4,5}, {1,3,5}, {2,3,4}. With q = 0.1 for every component the
/// exact failure probability is 1 - 0.97848 = 0.02152.
#[test]
fn bridge_fault_tree() {
    let json = r#"{
      "model": {
        "type": "fault_tree",
        "top": "top",
        "events": [
          {"id": "e1", "dist": {"type": "fixed", "q": 0.1}},
          {"id": "e2", "dist": {"type": "fixed", "q": 0.1}},
          {"id": "e3", "dist": {"type": "fixed", "q": 0.1}},
          {"id": "e4", "dist": {"type": "fixed", "q": 0.1}},
          {"id": "e5", "dist": {"type": "fixed", "q": 0.1}}
        ],
        "gates": [
          {"id": "c1", "op": "and", "inputs": ["e1", "e2"]},
          {"id": "c2", "op": "and", "inputs": ["e4", "e5"]},
          {"id": "c3", "op": "and", "inputs": ["e1", "e3", "e5"]},
          {"id": "c4", "op": "and", "inputs": ["e2", "e3", "e4"]},
          {"id": "top", "op": "or", "inputs": ["c1", "c2", "c3", "c4"]}
        ]
      },
      "options": {"cut_sets": true, "path_sets": true}
    }"#;
    let r = run(json);
    let p = r.results[0].top_probability;
    assert!((p - 0.02152).abs() < 1e-12, "p = {p}");

    let cuts = r.cut_sets.expect("cuts computed");
    assert!(!cuts.truncated);
    assert_eq!(cuts.count, 4);
    let mut orders: Vec<usize> = cuts.sets.iter().map(|s| s.order).collect();
    orders.sort_unstable();
    assert_eq!(orders, vec![2, 2, 3, 3]);
    // Highest-probability cut first: q^2 = 0.01.
    assert!((cuts.sets[0].probability - 0.01).abs() < 1e-15);

    // Dual: minimal path sets {1,4}, {2,5}, {1,3,5}, {2,3,4}... for this
    // cut structure the dual has 4 minimal solutions of orders 2,2,3,3.
    let paths = r.path_sets.expect("paths computed");
    assert_eq!(paths.count, 4);
    let mut porders: Vec<usize> = paths.sets.iter().map(|s| s.order).collect();
    porders.sort_unstable();
    assert_eq!(porders, vec![2, 2, 3, 3]);
    // Path probability = product of (1-q) = 0.81 for order-2 paths.
    assert!((paths.sets[0].probability - 0.81).abs() < 1e-12);
}

/// Shared basic event across gates: (a&b)|(b&c), q = 0.1 each.
/// Exact: P = P(ab) + P(bc) - P(abc) = 0.01 + 0.01 - 0.001 = 0.019.
#[test]
fn shared_event_exact_probability() {
    let json = r#"{
      "model": {
        "type": "fault_tree",
        "top": "top",
        "events": [
          {"id": "a", "dist": {"type": "fixed", "q": 0.1}},
          {"id": "b", "dist": {"type": "fixed", "q": 0.1}},
          {"id": "c", "dist": {"type": "fixed", "q": 0.1}}
        ],
        "gates": [
          {"id": "g1", "op": "and", "inputs": ["a", "b"]},
          {"id": "g2", "op": "and", "inputs": ["b", "c"]},
          {"id": "top", "op": "or", "inputs": ["g1", "g2"]}
        ]
      }
    }"#;
    let r = run(json);
    assert!((r.results[0].top_probability - 0.019).abs() < 1e-15);
    let cuts = r.cut_sets.unwrap();
    assert_eq!(cuts.count, 2); // {a,b}, {b,c}
}

/// 2-of-3 voting with exponential components at t = 1000 h.
#[test]
fn two_of_three_exponential() {
    let json = r#"{
      "model": {
        "type": "fault_tree",
        "top": "vote",
        "events": [
          {"id": "u1", "dist": {"type": "exponential", "lambda": 1e-4}},
          {"id": "u2", "dist": {"type": "exponential", "lambda": 1e-4}},
          {"id": "u3", "dist": {"type": "exponential", "lambda": 1e-4}}
        ],
        "gates": [
          {"id": "vote", "op": "atleast", "k": 2, "inputs": ["u1", "u2", "u3"]}
        ]
      },
      "mission_time": 1000
    }"#;
    let r = run(json);
    let q: f64 = 1.0 - (-0.1f64).exp();
    let expect = 3.0 * q * q * (1.0 - q) + q * q * q;
    assert!((r.results[0].top_probability - expect).abs() < 1e-12);
}

/// Markov basic event inside a tree must match the equivalent exponential.
#[test]
fn markov_node_matches_exponential() {
    let json = r#"{
      "model": {
        "type": "fault_tree",
        "top": "top",
        "events": [
          {"id": "m", "dist": {"type": "markov",
             "states": ["ok", "fail"],
             "transitions": [{"from": "ok", "to": "fail", "rate": 0.001}],
             "failed": ["fail"]}},
          {"id": "e", "dist": {"type": "exponential", "lambda": 0.001}}
        ],
        "gates": [
          {"id": "top", "op": "and", "inputs": ["m", "e"]}
        ]
      },
      "mission_time": 100
    }"#;
    let r = run(json);
    let q: f64 = 1.0 - (-0.1f64).exp();
    assert!((r.results[0].top_probability - q * q).abs() < 1e-8);
}

/// Canonical СФЦ mixed arcs: node t (fictive) has conjunctive input `a` and
/// two disjunctive inputs `b`, `c`. Its function is a & (b | c).
/// With q=0.1 (so p=P(works)=0.9 each): P = 0.9 * (1 - 0.1*0.1) = 0.891.
#[test]
fn sfc_mixed_conjunctive_disjunctive_arcs() {
    let json = r#"{
      "model": {
        "type": "sfc",
        "nodes": [
          {"id": "a", "dist": {"type": "fixed", "q": 0.1}},
          {"id": "b", "dist": {"type": "fixed", "q": 0.1}},
          {"id": "c", "dist": {"type": "fixed", "q": 0.1}},
          {"id": "t", "inputs": [
             {"from": "a", "conjunctive": true},
             {"from": "b", "conjunctive": false},
             {"from": "c", "conjunctive": false}
          ]}
        ],
        "criterion": {"target": "t"}
      },
      "options": {"cut_sets": true, "path_sets": true}
    }"#;
    let r = run(json);
    assert!((r.results[0].top_probability - 0.891).abs() < 1e-12,
        "got {}", r.results[0].top_probability);
    // Cut sets of a & (b|c): {a}, {b,c}.
    let cuts = r.cut_sets.unwrap();
    assert_eq!(cuts.count, 2);
    let mut orders: Vec<usize> = cuts.sets.iter().map(|s| s.order).collect();
    orders.sort_unstable();
    assert_eq!(orders, vec![1, 2]);
}

/// SFC: series-parallel scheme. Elements 1 and 2 in parallel feed element 3.
/// Criterion = output of node 3. With q = 0.1: P = 0.9 * (1 - 0.01) = 0.891.
/// Path sets: {1,3}, {2,3}. Cut sets: {3}, {1,2}.
#[test]
fn sfc_series_parallel() {
    let json = r#"{
      "model": {
        "type": "sfc",
        "nodes": [
          {"id": "n1", "dist": {"type": "fixed", "q": 0.1}},
          {"id": "n2", "dist": {"type": "fixed", "q": 0.1}},
          {"id": "n3", "dist": {"type": "fixed", "q": 0.1},
           "inputs": [{"from": "n1"}, {"from": "n2"}], "combine": "or"}
        ],
        "criterion": {"target": "n3"}
      },
      "options": {"cut_sets": true, "path_sets": true}
    }"#;
    let r = run(json);
    assert!((r.results[0].top_probability - 0.891).abs() < 1e-15);

    let paths = r.path_sets.expect("paths");
    assert_eq!(paths.count, 2);
    assert!(paths.sets.iter().all(|s| s.order == 2));
    assert!((paths.sets[0].probability - 0.81).abs() < 1e-12);

    let cuts = r.cut_sets.expect("cuts");
    assert_eq!(cuts.count, 2);
    let mut orders: Vec<usize> = cuts.sets.iter().map(|s| s.order).collect();
    orders.sort_unstable();
    assert_eq!(orders, vec![1, 2]);
    // Cut {3} has probability q = 0.1 and comes first.
    assert_eq!(cuts.sets[0].events, vec!["n3".to_string()]);
    assert!((cuts.sets[0].probability - 0.1).abs() < 1e-15);
}

/// Постоянную вероятность можно задать как вероятность успеха p = 1 − q:
/// та же схема с p = 0.9 даёт тот же ответ, что и с q = 0.1. Задать нужно
/// ровно одно из двух чисел.
#[test]
fn fixed_success_probability_p() {
    let json = |d1: &str, d3: &str| {
        format!(
            r#"{{"model": {{"type": "sfc", "nodes": [
                {{"id": "n1", "dist": {d1}}},
                {{"id": "n2", "dist": {{"type": "fixed", "q": 0.1}}}},
                {{"id": "n3", "dist": {d3}, "inputs": [{{"from": "n1"}}, {{"from": "n2"}}]}}
              ], "criterion": {{"target": "n3"}}}}}}"#
        )
    };
    let q = r#"{"type": "fixed", "q": 0.1}"#;
    let p = r#"{"type": "fixed", "p": 0.9}"#;
    let by_q = run(&json(q, q)).results[0].top_probability;
    let by_p = run(&json(p, p)).results[0].top_probability;
    let mixed = run(&json(p, q)).results[0].top_probability;
    assert!((by_q - 0.891).abs() < 1e-15);
    assert!((by_p - by_q).abs() < 1e-15);
    assert!((mixed - by_q).abs() < 1e-15);

    for bad in [
        r#"{"type": "fixed", "q": 0.1, "p": 0.9}"#,
        r#"{"type": "fixed"}"#,
        r#"{"type": "fixed", "p": 1.5}"#,
    ] {
        let req: Request = serde_json::from_str(&json(bad, q)).expect("request parses");
        assert!(cra::analyze_request(&req).is_err(), "{bad} must be rejected");
    }
}

/// Semi-Markov node: a single Weibull transition ok->fail must reproduce the
/// Weibull CDF exactly through the full JSON pipeline.
#[test]
fn semi_markov_weibull_transition() {
    let json = r#"{
      "model": {
        "type": "fault_tree",
        "top": "m",
        "events": [
          {"id": "m", "dist": {"type": "markov",
             "states": ["ok", "fail"],
             "transitions": [{"from": "ok", "to": "fail",
                "dist": {"type": "weibull", "shape": 2.0, "scale": 1000}}],
             "failed": ["fail"]}}
        ],
        "gates": []
      },
      "mission_time": 700
    }"#;
    let r = run(json);
    let expect = 1.0 - (-(0.7f64).powi(2)).exp();
    assert!((r.results[0].top_probability - expect).abs() < 2e-3,
        "got {} expect {expect}", r.results[0].top_probability);
}

/// Mixed clocks (Weibull failure + exponential repair) is a genuine
/// semi-Markov process; repair must lower the failure probability.
#[test]
fn semi_markov_repair_lowers_failure() {
    let base = |repair: &str| format!(r#"{{
      "model": {{"type": "fault_tree", "top": "m",
        "events": [{{"id": "m", "dist": {{"type": "markov",
           "states": ["ok", "fail"],
           "transitions": [{{"from": "ok", "to": "fail",
              "dist": {{"type": "weibull", "shape": 2.0, "scale": 500}}}}{repair}],
           "failed": ["fail"]}}}}],
        "gates": []}},
      "mission_time": 800}}"#);
    let no_repair = run(&base("")).results[0].top_probability;
    let with_repair = run(&base(r#", {"from": "fail", "to": "ok", "rate": 0.05}"#))
        .results[0].top_probability;
    assert!(with_repair < no_repair, "repair {with_repair} !< no-repair {no_repair}");
    assert!((0.0..=1.0).contains(&with_repair));
}

/// Modular decomposition must not change the exact result.
#[test]
fn modular_decomposition_is_exact() {
    let json = r#"{
      "model": {
        "type": "fault_tree",
        "top": "top",
        "events": [
          {"id": "a", "dist": {"type": "fixed", "q": 0.2}},
          {"id": "b", "dist": {"type": "fixed", "q": 0.3}},
          {"id": "c", "dist": {"type": "fixed", "q": 0.1}},
          {"id": "d", "dist": {"type": "fixed", "q": 0.4}},
          {"id": "e", "dist": {"type": "fixed", "q": 0.25}}
        ],
        "gates": [
          {"id": "m1", "op": "and", "inputs": ["a", "b"]},
          {"id": "m2", "op": "or", "inputs": ["d", "e"]},
          {"id": "m3", "op": "and", "inputs": ["c", "m2"]},
          {"id": "top", "op": "or", "inputs": ["m1", "m3"]}
        ]
      }
    }"#;
    let r = run(json);
    // P = P(ab) + P(c(d|e)) - product; independent modules.
    let p_m1 = 0.2 * 0.3;
    let p_m2 = 1.0 - (1.0 - 0.4) * (1.0 - 0.25);
    let p_m3 = 0.1 * p_m2;
    let expect = p_m1 + p_m3 - p_m1 * p_m3;
    assert!((r.results[0].top_probability - expect).abs() < 1e-15, "got {}", r.results[0].top_probability);
    assert!(r.stats.modules >= 3, "modules = {}", r.stats.modules);
}

/// Multiple evaluation times.
#[test]
fn multiple_times() {
    let json = r#"{
      "model": {
        "type": "fault_tree",
        "top": "top",
        "events": [{"id": "e", "dist": {"type": "exponential", "lambda": 0.01}}],
        "gates": [{"id": "top", "op": "or", "inputs": ["e"]}]
      },
      "times": [0, 100, 1000]
    }"#;
    let r = run(json);
    assert_eq!(r.results.len(), 3);
    assert!(r.results[0].top_probability.abs() < 1e-15);
    assert!((r.results[1].top_probability - (1.0 - (-1.0f64).exp())).abs() < 1e-12);
}
