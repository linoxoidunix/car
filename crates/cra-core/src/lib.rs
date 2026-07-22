//! CRA — движок расчёта надёжности для деревьев отказов и СФЦ.
//!
//! Путь данных: JSON -> логический граф -> разбиение на модули (Дутуит-Рози)
//! -> BDD на каждый модуль -> точная вероятность вершины + минимальные сечения
//! и пути. Базовые события: обычные распределения и марковские/полумарковские
//! узлы. Each module below is one step of this pipeline.

pub mod analysis; // главный конвейер
pub mod bdd; // двоичные диаграммы решений
pub mod dist; // распределения надёжности
pub mod io; // JSON вход/выход
pub mod markov; // марковские / полумарковские узлы
pub mod model; // общая внутренняя модель (логический граф)
pub mod module; // разбиение на модули

pub use analysis::{analyze_request, analyze_system};
pub use io::{Options, Request, Response};
