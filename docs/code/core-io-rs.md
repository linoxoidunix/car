# 8. `crates/cra-core/src/io.rs` — формат JSON и сборка модели

**Размер:** 713 строк, самый большой файл движка. **Задача:** описать формат
запроса и ответа, проверить пришедшие данные и превратить их во внутреннюю
`System`.

## Какую задачу решает

Всё внутри движка работает с `Formula` — плоским массивом узлов, где ссылки
это индексы. Пользователь же пишет:

```json
{"id": "system_failure", "op": "or", "inputs": ["hydraulics", "sensors"]}
```

то есть ссылается по **именам**, в произвольном порядке, и вполне может
ошибиться: сослаться на несуществующее имя, задать отрицательную интенсивность
отказов, замкнуть схему в цикл. Этот файл — граница между «недоверенным
внешним миром» и «заведомо корректной внутренней моделью».

Правило, действующее по всему движку: **после `io::compile` данные корректны
по построению**. Поэтому в `dist.rs`, `bdd.rs` и `analysis.rs` вообще нет
обработки ошибок.

## Часть 1: описание формата через типы

Формат JSON не описан отдельной спецификацией — он **выведен из типов Rust**
библиотекой `serde`. Атрибуты управляют переводом:

```rust
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ModelInput {
    FaultTree(FaultTreeInput),
    Sfc(SfcInput),
}
```

`tag = "type"` означает: поле `"type"` в JSON выбирает вариант.
`rename_all = "snake_case"` превращает `FaultTree` в `"fault_tree"`. Отсюда:

```json
{"type": "fault_tree", "top": "...", "events": [...], "gates": [...]}
```

Типы **и есть** документация формата, и они не могут разойтись с
реализацией — если поле переименуют, парсер изменится вместе с ним.

### Запрос

```rust
pub struct Request {
    pub model: ModelInput,
    #[serde(default)] pub mission_time: Option<f64>,
    #[serde(default)] pub times: Option<Vec<f64>>,
    #[serde(default)] pub options: Options,
}
```

`#[serde(default)]` делает поле необязательным. Минимальный корректный запрос —
это только `model`.

### Настройки и их значения по умолчанию

```rust
impl Default for Options {
    fn default() -> Self {
        Options {
            cut_sets: true,      // сечения нужны почти всегда
            path_sets: false,    // пути — по запросу (это второй расчёт)
            max_order: 8,        // наборов длиннее 8 практически не бывает значимых
            max_sets: 20_000,    // предел памяти
            cutoff: 0.0,         // порог по вероятности выключен
        }
    }
}
```

Значения выбраны так, чтобы «просто запустить» давало полезный результат без
риска съесть всю память.

### Ответ

```rust
#[derive(Debug, Serialize)]
pub struct Response {
    pub interpretation: String,   // "P(top event / failure)" или "P(criterion is satisfied)"
    pub results: Vec<TimeResult>, // по одному на каждое время
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cut_sets: Option<SetsReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_sets: Option<SetsReport>,
    pub stats: Stats,
    pub warnings: Vec<String>,
}
```

Поле `interpretation` — небольшая, но существенная деталь: одно и то же число
`top_probability` означает вероятность *отказа* в дереве и вероятность
*успеха* в СФЦ. Ответ проговаривает это словами, чтобы результат нельзя было
прочитать наоборот.

`skip_serializing_if` убирает из JSON пустые поля, вместо того чтобы слать
`null`.

## Часть 2: проверка распределений — `DistInput::to_model`

Каждое распределение проверяется до того, как станет `ReliabilityModel`:

```rust
fn check_pos(name, x)    -> Result<(), String>   // должно быть конечным и > 0
fn check_nonneg(name, x) -> Result<(), String>   // должно быть конечным и ≥ 0
```

Проверка на `is_finite()` важна: JSON пропустит очень большие числа, а
`f64::INFINITY` или `NaN`, попав в расчёт, отравят весь результат — и молча,
потому что арифметика с NaN не падает, а даёт NaN.

Правила по типам:

| Параметр | Правило | Почему |
|---|---|---|
| `fixed.q` | 0 ≤ q ≤ 1 | это вероятность |
| `lambda`, `mu`, `rate` | ≥ 0 | нулевая интенсивность допустима (никогда не отказывает) |
| `shape`, `scale`, `sigma`, `std` | > 0 | ноль дал бы деление на ноль |
| `uniform` | конечные, a ≤ b | иначе отрезок бессмыслен |

Хорошая деталь: наличие `mu` меняет саму модель, а не только параметр:

```rust
match mu {
    Some(mu) => ReliabilityModel::ExponentialRepair { lambda, mu },
    None     => ReliabilityModel::Exponential { lambda },
}
```

### Проверка марковских узлов

Самая объёмная проверка в файле, потому что структура сложнее:

```rust
// имена состояний уникальны
if idx.insert(s.as_str(), i).is_some() {
    return Err(format!("markov: duplicate state '{s}'"));
}
// начальное распределение — действительно распределение
if v.iter().any(|p| *p < 0.0) || (s - 1.0).abs() > 1e-6 {
    return Err("markov: initial must be a distribution (sum = 1)");
}
// переходы ссылаются на существующие состояния и не ведут в себя
if i == j { return Err(format!("markov: self-transition on '{}'", t.from)); }
```

Допуск `1e-6` на сумму начального распределения — уступка тому, что человек
пишет `[0.333, 0.333, 0.334]` от руки.

Если `initial` не задан, вся масса кладётся в первое состояние:

```rust
None => { let mut v = vec![0.0; n]; v[0] = 1.0; v }
```

Поэтому в примерах и пишут первым состояние `"ok"` или `"nominal"`.

Переход принимает либо краткую форму `rate` (экспонента), либо полный объект
`dist`. Приоритет у `dist`:

```rust
let dist = match (&t.dist, t.rate) {
    (Some(d), _)       => d.to_model(&ctx)?,
    (None, Some(rate)) => TransDist::Exponential { rate },
    (None, None)       => return Err(format!("{ctx}: needs a 'rate' or a 'dist'")),
};
```

Все сообщения об ошибках несут контекст (`markov transition ok->fail: shape
must be finite and > 0`), потому что в схеме из тысячи элементов «shape must
be > 0» без указания места бесполезно.

## Часть 3: сборка дерева отказов

```rust
fn compile_fault_tree(ft: &FaultTreeInput) -> Result<System, String>
```

### Сначала события

```rust
for e in &ft.events {
    if event_node.contains_key(e.id.as_str()) {
        return Err(format!("duplicate event id '{}'", e.id));
    }
    let model = e.dist.to_model().map_err(|err| format!("event '{}': {err}", e.id))?;
    let eid = events.len();
    events.push(BasicEvent { name: e.id.clone(), model });
    let node = formula.add(Node::Var(eid));      // РОВНО ОДИН узел Var на событие
    event_node.insert(e.id.as_str(), node);
}
```

Строчка «ровно один узел `Var` на событие» — это то самое инвариантное
свойство, на котором держится вся модульная декомпозиция. Если бы одно событие
получило два узла `Var`, `module.rs` счёл бы их независимыми и посчитал бы
неправильно.

### Затем разрешение имён — `resolve_ft`

Рекурсивный обход сверху вниз, от вершины:

```rust
if let Some(&n) = event_node.get(name) { return Ok(n); }   // это событие
if let Some(&n) = resolved.get(name)   { return Ok(n); }   // элемент уже собран
let gate = gate_map.get(name).ok_or_else(|| format!("unknown reference '{name}'"))?;
if in_progress.insert(name.to_string(), true).is_some() {
    return Err(format!("cycle detected through gate '{name}'"));
}
```

Три словаря делают три разные вещи:

| Словарь | Роль |
|---|---|
| `event_node` | имя события → узел `Var` |
| `resolved` | имя элемента → уже построенный узел (**мемоизация**: общий элемент строится один раз, что и создаёт ДАГ вместо дерева) |
| `in_progress` | имена на текущем пути рекурсии (**обнаружение циклов**) |

Обнаружение циклов заслуживает внимания. `in_progress` — это стек рекурсии.
Если имя встретилось, когда оно уже там, значит `g1 → g2 → g1`, и такая схема
не имеет смысла (и подвесила бы рекурсию). После успешной сборки имя убирается:

```rust
in_progress.remove(name);
resolved.insert(name.to_string(), node);
```

Убрать обязательно: элемент может законно встретиться в двух *разных* ветвях —
это ДАГ, а не цикл.

### Логические элементы

```rust
"and"     => { require_inputs(name, nch, 1)?; formula.add(Node::And(children)) }
"or"      => { require_inputs(name, nch, 1)?; formula.add(Node::Or(children))  }
"xor"     => { require_inputs(name, nch, 2)?; formula.add(Node::Xor(children)) }
"not"     => { /* ровно 1 вход */            formula.add(Node::Not(children[0])) }
"atleast" => { /* нужен k, 1 ≤ k ≤ n */      formula.add(Node::AtLeast { k, args }) }
"nand"    => { let inner = formula.add(Node::And(children)); formula.add(Node::Not(inner)) }
"nor"     => { let inner = formula.add(Node::Or(children));  formula.add(Node::Not(inner)) }
```

`nand` и `nor` не заводят новых типов узлов — они раскрываются в `Not(And(...))`
и `Not(Or(...))`. Внутреннее представление остаётся маленьким, а всё
последующее (двойственность, BDD, декомпозиция) работает без изменений.

## Часть 4: сборка СФЦ

Здесь сложнее, потому что СФЦ описывает не логику отказов, а структуру связей.

### Каноническая функция вершины

```
y = x · K · D
```

- `x` — собственный элемент узла (у фиктивного узла его нет);
- `K` — конъюнкция литералов всех конъюнктивных дуг (ИСТИНА, если их нет);
- `D` — дизъюнкция литералов всех дизъюнктивных дуг (ИСТИНА, если их нет);
- каждый литерал — выходная функция узла-источника, с отрицанием, если дуга
  инверсная.

Код:

```rust
for arc in &node.inputs {
    let src = resolve_sfc_output(&arc.from, …)?;       // рекурсия к источнику
    let lit = if arc.inverse { formula.add(Node::Not(src)) } else { src };
    if arc.conjunctive.unwrap_or(default_conj) { conj.push(lit); }
    else                                       { disj.push(lit); }
}
let mut parts = Vec::new();
if !conj.is_empty() { parts.push(/* И по conj */); }
if !disj.is_empty() { parts.push(/* ИЛИ по disj */); }
let comb = match parts.len() { 0 => None, 1 => Some(parts[0]), _ => Some(/* И */) };
let y = match (own, comb) {
    (Some(x), Some(c)) => formula.add(Node::And(vec![x, c])),
    (Some(x), None)    => x,             // источник: только свой элемент
    (None,    Some(c)) => c,             // фиктивный узел: только логика
    (None,    None)    => return Err(format!("node '{id}' is fictive and has no inputs")),
};
```

Обратите внимание: пустая группа не порождает узла `True`, который потом
пришлось бы упрощать. Вместо этого используется `Vec`, который просто остаётся
пустым, — тот же результат, но формула получается меньше.

### Совместимость со старыми моделями

```rust
if arc.conjunctive.unwrap_or(default_conj) { … }
```

Каноническая СФЦ задаёт вид **на каждой дуге**. Более ранние модели задавали
его на узле полем `combine` ("or"/"and"). Одна строчка обеспечивает
совместимость: если у дуги вид не указан, берётся умолчание узла. Старые
файлы, включая `sfc_bridge.json`, продолжают работать без изменений.

### Критерий

```rust
pub enum CriterionInput {
    Expr   { op: String, args: Vec<CriterionInput> },   // {"op":"and","args":[…]}
    Node   { node: String, inverse: bool },             // {"node":"n3"}
    Target { target: String, inverse: bool },           // {"target":"n3"}
}
```

С атрибутом `#[serde(untagged)]`: `serde` пробует варианты по очереди и берёт
первый подошедший. Так поддерживаются сразу три формы записи — и простая
ссылка на узел, и произвольное логическое выражение над выходами узлов.

Функция `resolve_criterion` рекурсивно собирает выражение, вызывая
`resolve_sfc_output` для листьев. Циклы ловятся тем же приёмом `in_progress`,
с более понятным текстом: «SFC contains a cycle through node 'x' (cyclic
schemes are not supported)».

## Итог

Файл делает четыре вещи, и все четыре — на границе:

1. **Описывает формат** (через типы `serde`, а не через отдельный документ).
2. **Проверяет** каждое число и каждую ссылку, с внятными сообщениями.
3. **Переводит** обе нотации в единую `Formula`.
4. **Гарантирует инварианты**: один `Var` на событие, отсутствие циклов,
   параметры в допустимых пределах.

Всё остальное в движке опирается на эти гарантии и потому может быть простым.
