//! Модели надёжности для базовых событий.
//!
//! Каждая модель даёт q(t) — probability that the event happened (the element
//! is failed) at time t. Есть простые распределения (экспонента, Вейбулл и
//! т.д.) и марковский узел. All formulas give a number between 0 and 1.

use crate::markov::MarkovModel;

/// How one basic event fails over time. We pick one of these per event.
#[derive(Debug, Clone)]
pub enum ReliabilityModel {
    /// Постоянная вероятность, не зависит от времени.
    Fixed { q: f64 },
    /// Экспонента без ремонта: q(t) = 1 - exp(-lambda*t).
    Exponential { lambda: f64 },
    /// Экспонента с ремонтом (unavailability = доля времени в отказе):
    /// q(t) = lambda/(lambda+mu) * (1 - exp(-(lambda+mu)*t)).
    ExponentialRepair { lambda: f64, mu: f64 },
    /// Weibull (износ/старение): q(t) = 1 - exp(-(t/scale)^shape).
    Weibull { shape: f64, scale: f64 },
    /// Логнормальное: q(t) = Phi((ln t - mu)/sigma).
    Lognormal { mu: f64, sigma: f64 },
    /// Нормальное (CDF, обрезаем в [0,1]).
    Normal { mean: f64, std: f64 },
    /// Равномерное на отрезке [a, b].
    Uniform { a: f64, b: f64 },
    /// Гамма: q(t) = P(shape, rate*t) (нижняя неполная гамма-функция).
    Gamma { shape: f64, rate: f64 },
    /// Markov / semi-Markov node; q(t) = P(the chain is in a failed state at t).
    Markov(MarkovModel),
}

impl ReliabilityModel {
    /// Probability that the element is failed at time t. Всегда в [0,1].
    pub fn unavailability(&self, t: f64) -> f64 {
        let q = match self {
            ReliabilityModel::Fixed { q } => *q,
            ReliabilityModel::Exponential { lambda } => {
                if t <= 0.0 { 0.0 } else { -(-lambda * t).exp_m1() }
            }
            ReliabilityModel::ExponentialRepair { lambda, mu } => {
                if t <= 0.0 {
                    0.0
                } else {
                    let s = lambda + mu;
                    if s <= 0.0 { 0.0 } else { lambda / s * -(-s * t).exp_m1() }
                }
            }
            ReliabilityModel::Weibull { shape, scale } => {
                if t <= 0.0 { 0.0 } else { -(-(t / scale).powf(*shape)).exp_m1() }
            }
            ReliabilityModel::Lognormal { mu, sigma } => {
                if t <= 0.0 { 0.0 } else { norm_cdf((t.ln() - mu) / sigma) }
            }
            ReliabilityModel::Normal { mean, std } => norm_cdf((t - mean) / std),
            ReliabilityModel::Uniform { a, b } => {
                if b <= a { if t >= *a { 1.0 } else { 0.0 } } else { (t - a) / (b - a) }
            }
            ReliabilityModel::Gamma { shape, rate } => {
                if t <= 0.0 { 0.0 } else { reg_lower_gamma(*shape, rate * t) }
            }
            ReliabilityModel::Markov(m) => m.prob_failed(t),
        };
        q.clamp(0.0, 1.0)
    }
}

// The functions below are math helpers. We write them by hand so the crate
// needs no math library. Мы пишем их сами, чтобы не тянуть внешние зависимости.

/// Функция ошибок erf(x). Формула Abramowitz & Stegun 7.1.26 (ошибка < 1.5e-7).
pub fn erf(x: f64) -> f64 {
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    let x = x.abs();
    let t = 1.0 / (1.0 + 0.3275911 * x);
    let y = 1.0
        - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
            + 0.254829592)
            * t
            * (-x * x).exp();
    sign * y
}

/// CDF стандартного нормального распределения (mean 0, std 1).
pub fn norm_cdf(z: f64) -> f64 {
    0.5 * (1.0 + erf(z / std::f64::consts::SQRT_2))
}

/// ln of Gamma(x). We use the Lanczos approximation (g = 7, n = 9).
pub fn ln_gamma(x: f64) -> f64 {
    const COEF: [f64; 9] = [
        0.999_999_999_999_809_93,
        676.520_368_121_885_1,
        -1_259.139_216_722_402_8,
        771.323_428_777_653_13,
        -176.615_029_162_140_59,
        12.507_343_278_686_905,
        -0.138_571_095_265_720_12,
        9.984_369_578_019_571_6e-6,
        1.505_632_735_149_311_6e-7,
    ];
    if x < 0.5 {
        // Для маленьких x используем формулу отражения (reflection formula).
        let pi = std::f64::consts::PI;
        (pi / (pi * x).sin()).ln() - ln_gamma(1.0 - x)
    } else {
        let x = x - 1.0;
        let mut a = COEF[0];
        let t = x + 7.5;
        for (i, &c) in COEF.iter().enumerate().skip(1) {
            a += c / (x + i as f64);
        }
        0.5 * (2.0 * std::f64::consts::PI).ln() + (x + 0.5) * t.ln() - t + a.ln()
    }
}

/// Нижняя неполная гамма-функция P(a, x), нормированная. This is the CDF of the
/// gamma distribution. Мы считаем её двумя способами: рядом (для маленьких x)
/// и цепной дробью (для больших x). So the result is accurate everywhere.
pub fn reg_lower_gamma(a: f64, x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if a <= 0.0 {
        return 1.0;
    }
    if x < a + 1.0 {
        // Маленькие x: ряд Тейлора (series expansion).
        let mut term = 1.0 / a;
        let mut sum = term;
        for n in 1..500 {
            term *= x / (a + n as f64);
            sum += term;
            if term.abs() < sum.abs() * 1e-15 {
                break;
            }
        }
        (sum.ln() + a * x.ln() - x - ln_gamma(a)).exp()
    } else {
        // Большие x: цепная дробь (метод Ленца) для Q(a, x) = 1 - P(a, x).
        let tiny = 1e-300;
        let mut b = x + 1.0 - a;
        let mut c = 1.0 / tiny;
        let mut d = 1.0 / b;
        let mut h = d;
        for i in 1..500 {
            let an = -(i as f64) * (i as f64 - a);
            b += 2.0;
            d = an * d + b;
            if d.abs() < tiny {
                d = tiny;
            }
            c = b + an / c;
            if c.abs() < tiny {
                c = tiny;
            }
            d = 1.0 / d;
            let del = d * c;
            h *= del;
            if (del - 1.0).abs() < 1e-15 {
                break;
            }
        }
        let q = (a * x.ln() - x - ln_gamma(a)).exp() * h;
        (1.0 - q).clamp(0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exponential_basic() {
        let m = ReliabilityModel::Exponential { lambda: 1e-3 };
        let q = m.unavailability(100.0);
        assert!((q - (1.0 - (-0.1f64).exp())).abs() < 1e-12);
    }

    #[test]
    fn weibull_shape_one_is_exponential() {
        let w = ReliabilityModel::Weibull { shape: 1.0, scale: 1000.0 };
        let e = ReliabilityModel::Exponential { lambda: 1e-3 };
        assert!((w.unavailability(250.0) - e.unavailability(250.0)).abs() < 1e-12);
    }

    #[test]
    fn norm_cdf_sane() {
        assert!((norm_cdf(0.0) - 0.5).abs() < 1e-7);
        assert!((norm_cdf(1.96) - 0.975).abs() < 1e-3);
    }

    #[test]
    fn gamma_shape_one_is_exponential() {
        // Gamma(1, rate) == Exponential(rate)
        let g = ReliabilityModel::Gamma { shape: 1.0, rate: 2e-3 };
        let e = ReliabilityModel::Exponential { lambda: 2e-3 };
        assert!((g.unavailability(700.0) - e.unavailability(700.0)).abs() < 1e-9);
    }
}
