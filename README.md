# CRA — reliability analysis engine (fault trees / СФЦ)

Backend for computing the probability of large logical reliability schemes:
classic **fault trees** (И/ИЛИ/К-из-N/НЕ/XOR gates) and **functional
integrity schemes (СФЦ)** with direct/inverse arcs and fictive nodes.
Basic events carry standard lifetime distributions or embedded **Markov
chains**. Written in pure Rust (edition 2021, MSRV 1.70) with only
`serde`/`serde_json` as dependencies, so it builds on Astra Linux toolchains.

## Workspace layout

```
cra/                        Cargo workspace
├── crates/
│   ├── cra-core/           the engine (library crate `cra`) + tests
│   ├── cra-cli/            command-line frontend (binary `cra`) + examples
│   └── cra-server/         thin HTTP service + embedded web frontend
├── deploy/                 systemd unit + ГОСТ-TLS proxy example
└── README.md
```

`cra-core` has no dependency on the CLI or server, so the offline
`cargo vendor` deliverable for the engine stays clean. Frontends are separate
crates: the browser SPA is embedded in `cra-server`; a future C++/Qt desktop
frontend would live alongside as its own directory.

## Method

The scheme is never processed as one monolithic function:

1. **Compilation** — both input forms compile into a shared logic DAG over
   basic events (`model.rs`, `io.rs`).
2. **Modular decomposition** — the Dutuit–Rauzy linear-time algorithm
   (`module.rs`) finds every independent module (a gate none of whose
   descendants are shared with the rest of the scheme). Each module is
   analyzed separately and replaced by a single pseudo-event.
3. **Per-module ROBDD** (`bdd.rs`) — exact probability by Shannon
   decomposition; variable order = DFS first-occurrence heuristic.
4. **Roll-up** — module probabilities propagate bottom-up (modules are
   statistically independent, so this is exact).
5. **Minimal cut / path sets** — Rauzy's *minsol* with subsumption per
   module, then truncated cartesian expansion (convolution) of module
   solutions into global sets. Truncation is probability-guided: when limits
   (`max_order`, `max_sets`, `cutoff`) bite, the most probable sets are kept.
   Path sets come from the De Morgan dual of the structure.

Basic-event models (`dist.rs`, `markov.rs`): fixed q, exponential
(optionally with repair rate `mu`), Weibull, lognormal, normal, uniform,
gamma, and Markov / **semi-Markov** nodes — pure-exponential chains via
uniformization (exact CTMC), and chains with non-exponential transition clocks
(Weibull/gamma/lognormal/normal) via the Markov-renewal equations.

## Semantics

| Model | Root function | `top_probability` | cut sets | path sets |
|---|---|---|---|---|
| `fault_tree` | top event (failure) | P(failure) at t | minimal event sets causing failure, P = Πq | minimal sets whose survival prevents failure, P = Π(1−q) |
| `sfc` | criterion (success) | P(criterion) at t | minimal element sets whose failure breaks the criterion, P = Πq | minimal working-element sets satisfying the criterion, P = Π(1−q) |

Non-coherent structures (NOT/XOR gates, inverse arcs) are computed **exactly**
for probability (BDD handles them natively); minimal sets are then built from
positive literals only and flagged with a warning.

## Frontends

### CLI (`cra-cli`)

```
cra <input.json | -> [-o out.json] [--pretty]
```

Reads a request from a file or stdin, writes the JSON report. A C++/Qt
desktop frontend can drive the engine this way (JSON over stdin/stdout via
`QProcess`), or link `cra-core` directly through a C ABI.

### HTTP service (`cra-server`)

Thin std-only HTTP server (no async runtime, no third-party web stack — the
whole surface is auditable) that serves an embedded vanilla-JS frontend and a
JSON API. The deliverable is a **single self-contained binary**; thin clients
need only Firefox.

```
cra-server              # configured via environment variables, see --help
```

| Endpoint | Purpose |
|---|---|
| `GET /` | web frontend (JSON editor, results, cut/path sets) |
| `POST /api/analyze` | analyze a model — same request/response JSON as the CLI |
| `GET /api/examples/<name>` | built-in example request |
| `GET /healthz` | liveness probe |

Configuration (env vars): `CRA_ADDR`, `CRA_WORKERS`, `CRA_MAX_CONN`,
`CRA_TIMEOUT_SECS`, and authentication `CRA_AUTH` = `none` | `token` | `proxy`
(with `CRA_TOKEN` / `CRA_PROXY_HEADER` / `CRA_TRUSTED_PROXIES`).

#### Deployment on Astra (shared server, thin clients)

Designed to be certification-friendly for attested systems:

- **No in-app TLS.** Serve plain HTTP bound to `127.0.0.1` and terminate
  **ГОСТ-TLS in a certified СКЗИ** (nginx/Angie + КриптоПро) in front — the
  app never claims to be the protection mechanism. See
  [deploy/nginx-gost-tls.conf.example](deploy/nginx-gost-tls.conf.example).
- **No own password store.** `CRA_AUTH=proxy` trusts an identity header
  (`X-Remote-User`) set by that front proxy after SSO against the Astra domain
  (ALD Pro / FreeIPA — Kerberos). The header is accepted only from configured
  `CRA_TRUSTED_PROXIES`, so it can't be spoofed by a direct client.
- **Audit log.** Every auth decision and analysis request is written as a
  `key=value` line to stderr (captured by the journal / forwardable to a SIEM),
  with log-injection escaping.
- **Single classification level per instance** — run one server per level;
  don't mix data of different levels in one process (Astra PARSEC МРД).
- **systemd hardening** unit with sandboxing in
  [deploy/cra-server.service](deploy/cra-server.service).

The engine remains a plain library (`cra::analyze_request`) shared by both
frontends.

## Input schema

```jsonc
{
  "model": { ... },              // fault_tree | sfc, see below
  "mission_time": 1000,          // single time, or:
  "times": [100, 1000, 10000],   // multiple evaluation times
  "options": {
    "cut_sets": true,            // default true
    "path_sets": false,          // default false
    "max_order": 8,              // max literals per set
    "max_sets": 20000,           // max sets kept (per module and final)
    "cutoff": 0.0                // drop sets below this probability
  }
}
```

### Fault tree

```jsonc
{
  "type": "fault_tree",
  "top": "system_failure",
  "events": [
    {"id": "pump", "dist": {"type": "exponential", "lambda": 1e-4}},
    {"id": "pipe", "dist": {"type": "weibull", "shape": 2.0, "scale": 2e4}}
  ],
  "gates": [
    {"id": "g1", "op": "atleast", "k": 2, "inputs": ["a", "b", "c"]},
    {"id": "system_failure", "op": "or", "inputs": ["g1", "pump", "pipe"]}
  ]
}
```

Gate ops: `and`, `or`, `not` (1 input), `xor`, `atleast` (with `k`),
`nand`, `nor`. Shared events and shared gates (DAG) are allowed; cycles are
rejected.

### СФЦ (functional integrity scheme)

```jsonc
{
  "type": "sfc",
  "nodes": [
    {"id": "n1", "dist": {"type": "fixed", "q": 0.1}},
    {"id": "n3", "dist": {"type": "fixed", "q": 0.1},
     "inputs": [
       {"from": "n1", "conjunctive": true},              // конъюнктивная (И)
       {"from": "n2", "conjunctive": false, "inverse": true} // дизъюнктивная (ИЛИ), инверсный выход
     ]}
  ],
  "criterion": {"target": "n3"}             // or a logic expression:
  // {"op": "and", "args": [{"node": "n3"}, {"node": "n5", "inverse": true}]}
}
```

Canonical СФЦ semantics (Mozhaev's apparatus): each **arc** carries its own
kind — **conjunctive** (И) or **disjunctive** (ИЛИ) — and its own output —
direct or **inverse** (negated source function). The vertex output is

```
y = x · K · D
K = AND over conjunctive-arc literals   (TRUE if none)
D = OR  over disjunctive-arc literals   (TRUE if none)
```

where `x` is the node's own element (omitted for a fictive node — one without
`dist`). Legacy inputs without `conjunctive` fall back to the node-level
`combine` field ("or" → disjunctive, "and" → conjunctive; default "or"), so
older models keep working unchanged. The criterion is any and/or/not
expression over node outputs.

### Distributions

```jsonc
{"type": "fixed", "q": 0.01}
{"type": "exponential", "lambda": 1e-4}            // + optional "mu" (repair)
{"type": "weibull", "shape": 2.0, "scale": 1e4}
{"type": "lognormal", "mu": 7.0, "sigma": 0.5}
{"type": "normal", "mean": 1e4, "std": 2e3}
{"type": "uniform", "a": 0, "b": 1e4}
{"type": "gamma", "shape": 3.0, "rate": 1e-3}
{"type": "markov",
 "states": ["ok", "degraded", "failed"],
 "initial": [1, 0, 0],                              // default: first state
 "transitions": [
   {"from": "ok", "to": "degraded", "rate": 1e-4}, // exponential shorthand
   {"from": "degraded", "to": "failed",            // any sojourn distribution:
      "dist": {"type": "weibull", "shape": 2.0, "scale": 5000}}
 ],
 "failed": ["failed"],
 "steady": false}                                   // true => stationary dist
```

**Markov and semi-Markov transitions.** A transition is either exponential
(`"rate"`) or carries an arbitrary sojourn-time `"dist"`:
`exponential` / `weibull` / `gamma` / `lognormal` / `normal` / `deterministic`
(Dirac — fires exactly at `"delay"`, e.g. scheduled maintenance/inspection).
If **every**
transition is exponential the node is an ordinary CTMC, solved by
uniformization (fast, exact). If **any** transition is non-exponential the node
is a **semi-Markov process** with competing clocks (the first clock to fire
wins); it is solved numerically via the Markov-renewal equations
(`markov.rs`), and its stationary law by the embedded-chain formula
π_i ∝ ν_i·μ_i. This lets a state's dwell time follow a real ageing law
(Weibull shape > 1) or infant-mortality law (shape < 1), which a pure Markov
chain cannot express.

## Output

```jsonc
{
  "interpretation": "P(top event / failure)",
  "results": [{"time": 1000.0, "top_probability": 0.0077}],
  "cut_sets": {
    "count": 6, "truncated": false,
    "rare_event_approx": 0.0077,          // sum of set probabilities
    "esary_proschan_bound": 0.0077,       // 1 - prod(1 - P(set))
    "sets": [{"events": ["power"], "order": 1, "probability": 0.0048}, ...]
  },
  "path_sets": { ... },
  "stats": {"events": 7, "formula_nodes": 13, "modules": 3,
            "bdd_nodes": 41, "noncoherent": false},
  "warnings": []
}
```

Set probabilities are evaluated at the first time point. `top_probability`
is always **exact** (BDD), independent of set truncation.

## Build & test

```
cargo build --release              # binaries: cra (CLI), cra-server
cargo test                         # 40 tests across the workspace
./target/release/cra crates/cra-cli/examples/fault_tree.json --pretty
CRA_ADDR=127.0.0.1:8080 ./target/release/cra-server
```

For offline Astra hosts: run `cargo vendor` on a connected machine, ship the
`vendor/` directory and a `.cargo/config.toml` with the vendored source
replacement — no network is needed at build time. The web frontend is embedded
in the binary at compile time, so there is no separate npm/build step to
reproduce on the target.

Scale reference: a generated scheme with 15 000 events / 8 000 gates
(500 modules plus cross-linked shared events) analyzes in ~6 s for exact
probability and ~11 s with cut-set extraction (release build).

## Roadmap

- Interactive diagram editor in the web frontend (SVG node/edge, vanilla TS —
  currently the UI is a JSON editor + results view).
- Importance measures (Birnbaum, Fussell–Vesely) from the BDD.
- Prime implicants for non-coherent schemes (ZBDD-based).
- Common-cause failure groups (alpha/beta factor).
- C ABI / Qt desktop frontend (`cra-core` linked directly).
