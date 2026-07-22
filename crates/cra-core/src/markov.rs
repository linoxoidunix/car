//! Марковские и **полумарковские** узлы (Markov / semi-Markov).
//!
//! У каждого перехода есть своё распределение времени. Если все переходы
//! экспоненциальные — это обычная марковская цепь (CTMC), and we solve it fast
//! and exactly by uniformization. Если хоть один переход не экспоненциальный
//! (Weibull, gamma, lognormal, normal, Dirac) — это полумарковский процесс, и
//! мы решаем его численно (Markov-renewal equations).
//!
//! Модель "конкурирующих часов" (competing clocks). Из состояния у каждого
//! перехода свой таймер со своим распределением. The clock that fires first
//! wins. Время жизни в состоянии = произведение "выживаний" всех таймеров.
//! Куда уйти — делим по рискам (hazard) таймеров.
//!
//! Важно: решатель работает только через функции выживания S(t) = 1 - F(t).
//! Интегральный риск за один шаг сетки = ln S(t_{s-1}) - ln S(t_s) >= 0.
//! So we never need the pdf. Поэтому нет проблемы с бесконечной плотностью в
//! нуле (это бывает у Вейбулла/гаммы при shape < 1).

use crate::dist::{norm_cdf, reg_lower_gamma};

/// Sentinel "ln of zero survival": a large finite negative so exp() underflows
/// to ~0 while the integrated hazard (a difference of ln-survivals) stays a
/// finite, dominating number. Used for the deterministic (Dirac) clock, whose
/// survival is a step and whose hazard is a Dirac impulse at the delay.
const LN_ZERO: f64 = -1.0e6;

/// Распределение времени одного перехода (одного "таймера").
#[derive(Debug, Clone)]
pub enum TransDist {
    Exponential { rate: f64 },
    Weibull { shape: f64, scale: f64 },
    Gamma { shape: f64, rate: f64 },
    Lognormal { mu: f64, sigma: f64 },
    Normal { mean: f64, std: f64 },
    /// Детерминированный (Дирак): переход срабатывает точно в момент `delay`.
    Deterministic { delay: f64 },
}

impl TransDist {
    /// Функция выживания S(t) = P(таймер ещё не сработал к моменту t), t >= 0.
    pub fn survival(&self, t: f64) -> f64 {
        if t <= 0.0 {
            return 1.0;
        }
        let s = match self {
            TransDist::Exponential { rate } => (-rate * t).exp(),
            TransDist::Weibull { shape, scale } => (-(t / scale).powf(*shape)).exp(),
            TransDist::Gamma { shape, rate } => 1.0 - reg_lower_gamma(*shape, rate * t),
            TransDist::Lognormal { mu, sigma } => 1.0 - norm_cdf((t.ln() - mu) / sigma),
            TransDist::Normal { mean, std } => 1.0 - norm_cdf((t - mean) / std),
            TransDist::Deterministic { delay } => {
                if t < *delay { 1.0 } else { 0.0 }
            }
        };
        s.clamp(0.0, 1.0)
    }

    /// ln S(t). Для экспоненты и Вейбулла считаем точно (это важно, когда S
    /// очень мало). For other laws we take ln of the survival value.
    pub fn ln_survival(&self, t: f64) -> f64 {
        if t <= 0.0 {
            return 0.0;
        }
        match self {
            TransDist::Exponential { rate } => -rate * t,
            TransDist::Weibull { shape, scale } => -(t / scale).powf(*shape),
            TransDist::Deterministic { delay } => {
                if t < *delay { 0.0 } else { LN_ZERO }
            }
            _ => self.survival(t).max(1e-300).ln(),
        }
    }

    pub fn as_rate(&self) -> Option<f64> {
        match self {
            TransDist::Exponential { rate } => Some(*rate),
            _ => None,
        }
    }
}

/// Один переход: из состояния `from` в состояние `to` со своим таймером.
#[derive(Debug, Clone)]
pub struct Transition {
    pub from: usize,
    pub to: usize,
    pub dist: TransDist,
}

/// Вся марковская/полумарковская цепь одного узла.
#[derive(Debug, Clone)]
pub struct MarkovModel {
    /// Сколько состояний.
    pub n: usize,
    /// Начальное распределение по состояниям (сумма = 1).
    pub initial: Vec<f64>,
    /// Переходы, у каждого своё распределение времени.
    pub trans: Vec<Transition>,
    /// Какие состояния считаем "отказом" для внешнего события.
    pub failed: Vec<bool>,
    /// true — берём стационарный режим, false — переходный (в момент t).
    pub steady: bool,
}

impl MarkovModel {
    /// true, если все переходы экспоненциальные (тогда это обычный CTMC).
    fn all_exponential(&self) -> bool {
        self.trans.iter().all(|t| t.dist.as_rate().is_some())
    }

    /// Вероятность того, что в момент t процесс в одном из отказовых состояний.
    pub fn prob_failed(&self, t: f64) -> f64 {
        let pi = if self.steady { self.steady_state() } else { self.transient(t) };
        pi.iter()
            .zip(self.failed.iter())
            .filter(|(_, &f)| f)
            .map(|(p, _)| *p)
            .sum::<f64>()
            .clamp(0.0, 1.0)
    }

    /// Transient state distribution at time t.
    pub fn transient(&self, t: f64) -> Vec<f64> {
        if t <= 0.0 {
            return self.initial.clone();
        }
        if self.all_exponential() {
            self.transient_ctmc(t)
        } else {
            self.transient_smp(t)
        }
    }

    // ----- CTMC transient (uniformization) --------------------------------

    fn rate_matrix(&self) -> (Vec<f64>, Vec<(usize, usize, f64)>) {
        let mut diag = vec![0.0f64; self.n];
        let mut edges = Vec::with_capacity(self.trans.len());
        for tr in &self.trans {
            let r = tr.dist.as_rate().unwrap_or(0.0);
            diag[tr.from] += r;
            edges.push((tr.from, tr.to, r));
        }
        (diag, edges)
    }

    fn transient_ctmc(&self, t: f64) -> Vec<f64> {
        let n = self.n;
        let (diag, edges) = self.rate_matrix();
        let lambda = diag.iter().cloned().fold(0.0f64, f64::max);
        if lambda <= 0.0 {
            return self.initial.clone();
        }
        let chunks = ((lambda * t / 200.0).ceil() as usize).max(1);
        let dt = t / chunks as f64;
        let m = lambda * dt;
        let mut v = self.initial.clone();
        for _ in 0..chunks {
            v = uniformization_step(&v, lambda, m, &diag, &edges, n);
        }
        v
    }

    // ----- полумарковский переходный режим (Markov-renewal equations) -----

    /// Строим сетку по времени и решаем полумарковскую задачу: где находится
    /// процесс в момент t. Идея — в шапке модуля (через функции выживания).
    fn transient_smp(&self, t: f64) -> Vec<f64> {
        let m = self.grid_steps(t);
        let dt = t / m as f64;
        let (c, sur) = self.build_grid(dt, m);
        let n = self.n;

        // e[r][i] = probability of entering state i exactly at step r.
        // Плотность "входов" в состояние i на шаге r.
        let mut e = vec![vec![0.0f64; n]; m + 1];
        e[0].copy_from_slice(&self.initial);
        for step in 1..=m {
            // e[step][j] = sum_i sum_{s=1..step} e[step-s][i] * c[s][i][j]
            // Вошли в i раньше, потом ушли в j — суммируем по всем прошлым шагам.
            let mut row = vec![0.0f64; n];
            for s in 1..=step {
                let cs = &c[s];
                let er = &e[step - s];
                for i in 0..n {
                    let ei = er[i];
                    if ei == 0.0 {
                        continue;
                    }
                    let base = i * n;
                    for j in 0..n {
                        row[j] += ei * cs[base + j];
                    }
                }
            }
            e[step] = row;
        }

        // Где мы в момент t: вошли в i на шаге r и ещё не ушли за (m-r) шагов.
        // P_i = sum_r e[r][i] * survival_i(lag = m-r).
        let mut p = vec![0.0f64; n];
        for (i, pi) in p.iter_mut().enumerate() {
            let mut acc = 0.0;
            for r in 0..=m {
                acc += e[r][i] * sur[m - r][i];
            }
            *pi = acc;
        }
        normalize(&mut p);
        p
    }

    /// Сколько шагов сетки взять. Больше шагов = точнее, но дольше. Смотрим на
    /// самый быстрый таймер и ограничиваем число шагов сверху и снизу.
    fn grid_steps(&self, t: f64) -> usize {
        let mut fastest = f64::INFINITY;
        for tr in &self.trans {
            let scale = clock_scale(&tr.dist);
            fastest = fastest.min(scale);
        }
        if !fastest.is_finite() || fastest <= 0.0 {
            return 1500;
        }
        let want = (20.0 * t / fastest).ceil() as usize;
        want.clamp(200, 4000)
    }

    /// Готовим две таблицы по шагам сетки s = 0..=m:
    ///   sur[s][i]     = P(остаться в i не меньше s шагов) = произведение
    ///                   выживаний всех выходных таймеров state i.
    ///   c[s][i*n + j] = P(зайти в i в момент 0 и уйти в j на шаге s).
    /// Массу ухода за шаг делим между целями j по интегральному риску, so the
    /// total mass is always kept (nothing is lost).
    fn build_grid(&self, dt: f64, m: usize) -> (Vec<Vec<f64>>, Vec<Vec<f64>>) {
        let n = self.n;
        let mut out: Vec<Vec<&Transition>> = vec![Vec::new(); n];
        for tr in &self.trans {
            out[tr.from].push(tr);
        }
        let mut sur = vec![vec![1.0f64; n]; m + 1];
        for (s, sur_s) in sur.iter_mut().enumerate() {
            let ts = s as f64 * dt;
            for (i, out_i) in out.iter().enumerate() {
                let mut ln = 0.0;
                for tr in out_i {
                    ln += tr.dist.ln_survival(ts);
                }
                sur_s[i] = ln.exp();
            }
        }
        let mut c = vec![vec![0.0f64; n * n]; m + 1];
        for s in 1..=m {
            let ts = s as f64 * dt;
            let tp = (s - 1) as f64 * dt;
            for i in 0..n {
                if out[i].is_empty() {
                    continue; // absorbing: no leaving mass
                }
                let dh = sur[s - 1][i] - sur[s][i]; // mass leaving i in this cell
                if dh <= 0.0 {
                    continue;
                }
                let mut atot = 0.0;
                let mut aj: Vec<(usize, f64)> = Vec::with_capacity(out[i].len());
                for tr in &out[i] {
                    let a = tr.dist.ln_survival(tp) - tr.dist.ln_survival(ts); // >= 0
                    if a > 0.0 {
                        aj.push((tr.to, a));
                        atot += a;
                    }
                }
                if atot <= 0.0 {
                    continue;
                }
                let base = i * n;
                for (j, a) in aj {
                    c[s][base + j] += dh * (a / atot);
                }
            }
        }
        (c, sur)
    }

    // ----- стационарное распределение (при t -> бесконечности) ------------

    /// Стационарное распределение (система "устоялась").
    ///
    /// Для чистой CTMC решаем Q^T pi = 0 (точно). For a semi-Markov process:
    /// pi_i пропорционально nu_i * mu_i, где nu — стационар вложенной цепи
    /// прыжков, а mu_i — среднее время жизни в состоянии i.
    pub fn steady_state(&self) -> Vec<f64> {
        if self.n == 1 {
            return vec![1.0];
        }
        if self.all_exponential() {
            return self.steady_ctmc();
        }
        self.steady_smp()
    }

    fn steady_ctmc(&self) -> Vec<f64> {
        let n = self.n;
        let (_, edges) = self.rate_matrix();
        let mut a = vec![vec![0.0f64; n]; n];
        for &(i, j, r) in &edges {
            a[j][i] += r;
            a[i][i] -= r;
        }
        for x in a[n - 1].iter_mut() {
            *x = 1.0;
        }
        let mut b = vec![0.0f64; n];
        b[n - 1] = 1.0;
        let mut pi = gauss_solve(a, b);
        clamp_normalize(&mut pi);
        pi
    }

    fn steady_smp(&self) -> Vec<f64> {
        let n = self.n;
        let t_max = self.stat_horizon();
        let m = 4000usize;
        let dt = t_max / m as f64;
        let (c, sur) = self.build_grid(dt, m);

        // Embedded jump matrix p[i][j] and mean sojourn mu_i.
        let mut p = vec![vec![0.0f64; n]; n];
        let mut mu = vec![0.0f64; n];
        for i in 0..n {
            for s in 1..=m {
                let base = i * n;
                for j in 0..n {
                    p[i][j] += c[s][base + j];
                }
            }
            let mut integ = 0.5 * (sur[0][i] + sur[m][i]);
            for s in 1..m {
                integ += sur[s][i];
            }
            mu[i] = integ * dt;
        }
        // Absorbing rows -> self-loop so the embedded solve stays well-posed.
        for i in 0..n {
            let rowsum: f64 = p[i].iter().sum();
            if rowsum < 1e-9 {
                p[i][i] = 1.0;
            } else if (rowsum - 1.0).abs() > 1e-6 {
                for x in p[i].iter_mut() {
                    *x /= rowsum;
                }
            }
        }
        // Embedded stationary nu: nu (I - P) = 0, sum nu = 1.
        let mut a = vec![vec![0.0f64; n]; n];
        for j in 0..n {
            for i in 0..n {
                a[j][i] = (if i == j { 1.0 } else { 0.0 }) - p[i][j];
            }
        }
        for x in a[n - 1].iter_mut() {
            *x = 1.0;
        }
        let mut b = vec![0.0f64; n];
        b[n - 1] = 1.0;
        let nu = gauss_solve(a, b);
        let mut pi: Vec<f64> = (0..n).map(|i| nu[i].max(0.0) * mu[i]).collect();
        clamp_normalize(&mut pi);
        pi
    }

    fn stat_horizon(&self) -> f64 {
        let mut h = 0.0f64;
        for tr in &self.trans {
            let scale = match &tr.dist {
                TransDist::Lognormal { mu, sigma } => (mu + 3.0 * sigma).exp(),
                TransDist::Normal { mean, std } => mean + 3.0 * std,
                other => clock_scale(other),
            };
            h = h.max(scale);
        }
        (h * 20.0).max(1.0)
    }
}

fn clock_scale(d: &TransDist) -> f64 {
    match d {
        TransDist::Exponential { rate } => 1.0 / rate.max(1e-30),
        TransDist::Weibull { scale, .. } => *scale,
        TransDist::Gamma { shape, rate } => shape / rate.max(1e-30),
        TransDist::Lognormal { mu, .. } => mu.exp(),
        TransDist::Normal { mean, .. } => mean.abs().max(1e-30),
        TransDist::Deterministic { delay } => delay.max(1e-30),
    }
}

fn uniformization_step(
    v0: &[f64],
    lambda: f64,
    m: f64,
    diag: &[f64],
    edges: &[(usize, usize, f64)],
    n: usize,
) -> Vec<f64> {
    let mut u = v0.to_vec();
    let mut w = (-m).exp();
    let mut acc: Vec<f64> = u.iter().map(|x| x * w).collect();
    let mut cum = w;
    let mut k = 1usize;
    while cum < 1.0 - 1e-13 && k < 200_000 {
        let mut nu = vec![0.0f64; n];
        for j in 0..n {
            nu[j] = u[j] * (1.0 - diag[j] / lambda);
        }
        for &(i, j, r) in edges {
            nu[j] += u[i] * r / lambda;
        }
        u = nu;
        w *= m / k as f64;
        for j in 0..n {
            acc[j] += w * u[j];
        }
        cum += w;
        k += 1;
    }
    acc
}

/// Gaussian elimination with partial pivoting for A x = b.
fn gauss_solve(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Vec<f64> {
    let n = b.len();
    for col in 0..n {
        let mut piv = col;
        for r in col + 1..n {
            if a[r][col].abs() > a[piv][col].abs() {
                piv = r;
            }
        }
        a.swap(col, piv);
        b.swap(col, piv);
        let p = a[col][col];
        if p.abs() < 1e-300 {
            continue;
        }
        for r in 0..n {
            if r == col {
                continue;
            }
            let f = a[r][col] / p;
            if f == 0.0 {
                continue;
            }
            for c2 in col..n {
                a[r][c2] -= f * a[col][c2];
            }
            b[r] -= f * b[col];
        }
    }
    (0..n)
        .map(|i| if a[i][i].abs() < 1e-300 { 0.0 } else { b[i] / a[i][i] })
        .collect()
}

fn normalize(p: &mut [f64]) {
    let s: f64 = p.iter().sum();
    if s > 0.0 {
        for x in p.iter_mut() {
            *x /= s;
        }
    }
}
fn clamp_normalize(p: &mut [f64]) {
    for x in p.iter_mut() {
        if *x < 0.0 {
            *x = 0.0;
        }
    }
    normalize(p);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exp_tr(from: usize, to: usize, rate: f64) -> Transition {
        Transition { from, to, dist: TransDist::Exponential { rate } }
    }

    #[test]
    fn two_state_matches_exponential() {
        let m = MarkovModel {
            n: 2,
            initial: vec![1.0, 0.0],
            trans: vec![exp_tr(0, 1, 1e-3)],
            failed: vec![false, true],
            steady: false,
        };
        let q = m.prob_failed(100.0);
        let expect = 1.0 - (-0.1f64).exp();
        assert!((q - expect).abs() < 1e-9, "q={q} expect={expect}");
    }

    #[test]
    fn repairable_steady_state() {
        let (lambda, mu) = (1e-3, 1e-1);
        let m = MarkovModel {
            n: 2,
            initial: vec![1.0, 0.0],
            trans: vec![exp_tr(0, 1, lambda), exp_tr(1, 0, mu)],
            failed: vec![false, true],
            steady: true,
        };
        let q = m.prob_failed(0.0);
        assert!((q - lambda / (lambda + mu)).abs() < 1e-12);
    }

    #[test]
    fn repairable_transient_converges_to_steady() {
        let (lambda, mu) = (1e-2, 1e-1);
        let m = MarkovModel {
            n: 2,
            initial: vec![1.0, 0.0],
            trans: vec![exp_tr(0, 1, lambda), exp_tr(1, 0, mu)],
            failed: vec![false, true],
            steady: false,
        };
        let q = m.prob_failed(1e4);
        assert!((q - lambda / (lambda + mu)).abs() < 1e-6);
    }

    // ---- semi-Markov ----

    /// Single Weibull clock ok->fail: P(fail, t) must equal the Weibull CDF.
    #[test]
    fn weibull_transition_equals_weibull_cdf() {
        let (shape, scale) = (2.0, 1000.0);
        let m = MarkovModel {
            n: 2,
            initial: vec![1.0, 0.0],
            trans: vec![Transition { from: 0, to: 1, dist: TransDist::Weibull { shape, scale } }],
            failed: vec![false, true],
            steady: false,
        };
        for &t in &[200.0, 700.0, 1500.0] {
            let q = m.prob_failed(t);
            let expect = 1.0 - (-(t / scale).powf(shape)).exp();
            assert!((q - expect).abs() < 2e-3, "t={t} q={q} expect={expect}");
        }
    }

    /// Two exponential stages (Erlang-2) must match a single Gamma(2, rate)
    /// transition — cross-check of the semi-Markov solver against the CTMC.
    #[test]
    fn gamma_shape2_matches_two_exponential_stages() {
        let rate = 1e-2;
        let staged = MarkovModel {
            n: 3,
            initial: vec![1.0, 0.0, 0.0],
            trans: vec![exp_tr(0, 1, rate), exp_tr(1, 2, rate)],
            failed: vec![false, false, true],
            steady: false,
        };
        let gamma = MarkovModel {
            n: 2,
            initial: vec![1.0, 0.0],
            trans: vec![Transition { from: 0, to: 1, dist: TransDist::Gamma { shape: 2.0, rate } }],
            failed: vec![false, true],
            steady: false,
        };
        for &t in &[50.0, 150.0, 400.0] {
            let a = staged.prob_failed(t);
            let b = gamma.prob_failed(t);
            assert!((a - b).abs() < 3e-3, "t={t} staged={a} gamma={b}");
        }
    }

    /// Deterministic (Dirac) clock: ok->fail exactly at delay d. Failure
    /// probability is a step: 0 before d, 1 after d.
    #[test]
    fn deterministic_clock_is_step() {
        let d = 500.0;
        let m = MarkovModel {
            n: 2,
            initial: vec![1.0, 0.0],
            trans: vec![Transition { from: 0, to: 1, dist: TransDist::Deterministic { delay: d } }],
            failed: vec![false, true],
            steady: false,
        };
        assert!(m.prob_failed(400.0) < 1e-6, "before delay must be ~0");
        assert!(m.prob_failed(600.0) > 0.99, "after delay must be ~1");
    }

    /// Deterministic inspection competing with exponential failure: a scheduled
    /// action at d returns to ok, so failure prob stays below the pure
    /// exponential CDF at times past the first inspection.
    #[test]
    fn deterministic_inspection_competes() {
        let lambda = 2e-3;
        let m = MarkovModel {
            n: 2,
            initial: vec![1.0, 0.0],
            trans: vec![
                Transition { from: 0, to: 1, dist: TransDist::Exponential { rate: lambda } },
                Transition { from: 1, to: 0, dist: TransDist::Deterministic { delay: 50.0 } },
            ],
            failed: vec![false, true],
            steady: false,
        };
        let q = m.prob_failed(1000.0);
        assert!((0.0..=1.0).contains(&q));
        let pure = 1.0 - (-lambda * 1000.0f64).exp();
        assert!(q < pure, "repair via inspection should lower failure: q={q} pure={pure}");
    }

    /// Non-exponential competing clocks: Weibull failure vs exponential repair.
    /// Repair can only lower the failure probability.
    #[test]
    fn competing_clocks_repair_helps() {
        let (shape, scale) = (2.0, 500.0);
        let repaired = MarkovModel {
            n: 2,
            initial: vec![1.0, 0.0],
            trans: vec![
                Transition { from: 0, to: 1, dist: TransDist::Weibull { shape, scale } },
                Transition { from: 1, to: 0, dist: TransDist::Exponential { rate: 0.05 } },
            ],
            failed: vec![false, true],
            steady: false,
        };
        let t = 800.0;
        let q = repaired.prob_failed(t);
        let no_repair = 1.0 - (-(t / scale).powf(shape)).exp();
        assert!((0.0..=1.0).contains(&q));
        assert!(q < no_repair, "repair should lower failure prob: q={q} vs {no_repair}");
    }
}
