//! Файлы фронтенда, встроенные прямо в бинарник при сборке. So the whole app
//! is one файл: на Астре нечего ставить рядом и ничего не тянется из сети.
//!
//! Режим разработки. В отладочной сборке можно задать `CRA_ASSETS_DIR` — тогда
//! файлы читаются с диска на каждый запрос, и правка видна сразу после
//! сохранения, без пересборки. В HTML при этом дописывается маленький скрипт,
//! который сам перезагружает страницу, когда ассеты изменились.
//!
//! В release-сборке этого пути нет вовсе (`#[cfg(debug_assertions)]`), поэтому
//! поставляемый бинарник ведёт себя ровно как раньше: только встроенные файлы,
//! никакого чтения с диска.

pub struct Asset {
    pub path: &'static str,
    /// Имя файла в каталоге assets/. Берётся только отсюда и никогда из URL,
    /// поэтому выйти за пределы каталога запросом невозможно. Нужно лишь
    /// режиму разработки, поэтому в release-сборке поле не читается.
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    pub file: &'static str,
    pub content_type: &'static str,
    pub bytes: &'static [u8],
}

pub const ASSETS: &[Asset] = &[
    Asset {
        path: "/",
        file: "index.html",
        content_type: "text/html; charset=utf-8",
        bytes: include_bytes!("../assets/index.html"),
    },
    Asset {
        path: "/index.html",
        file: "index.html",
        content_type: "text/html; charset=utf-8",
        bytes: include_bytes!("../assets/index.html"),
    },
    Asset {
        path: "/style.css",
        file: "style.css",
        content_type: "text/css; charset=utf-8",
        bytes: include_bytes!("../assets/style.css"),
    },
    Asset {
        path: "/app.js",
        file: "app.js",
        content_type: "text/javascript; charset=utf-8",
        bytes: include_bytes!("../assets/app.js"),
    },
];

pub fn find(path: &str) -> Option<&'static Asset> {
    ASSETS.iter().find(|a| a.path == path)
}

/// Содержимое ассета для ответа. В обычной сборке — встроенные байты.
pub fn body(a: &Asset) -> Vec<u8> {
    #[cfg(debug_assertions)]
    if let Some(bytes) = dev::read(a) {
        return bytes;
    }
    a.bytes.to_vec()
}

/// Built-in example requests, served to the frontend example picker.
pub const EXAMPLES: &[(&str, &str)] = &[
    ("fault_tree", include_str!("../../cra-cli/examples/fault_tree.json")),
    ("sfc_bridge", include_str!("../../cra-cli/examples/sfc_bridge.json")),
];

pub fn example(name: &str) -> Option<&'static str> {
    EXAMPLES.iter().find(|(n, _)| *n == name).map(|(_, c)| *c)
}

/// Режим разработки: ассеты с диска и автоперезагрузка страницы.
/// Существует только в отладочной сборке.
#[cfg(debug_assertions)]
pub mod dev {
    use super::{Asset, ASSETS};
    use std::path::PathBuf;

    /// Каталог с ассетами, если разработчик его задал.
    pub fn dir() -> Option<PathBuf> {
        std::env::var_os("CRA_ASSETS_DIR").map(PathBuf::from)
    }

    /// Скрипт, который дописывается к HTML: раз в полсекунды спрашивает метку
    /// ассетов и перезагружает страницу, когда та поменялась.
    const RELOAD_JS: &str = r#"
<script>
// dev-режим: перезагрузить страницу, когда ассеты изменились на диске.
(function () {
  let last = null;
  setInterval(async function () {
    try {
      const r = await fetch("/__dev/token", { cache: "no-store" });
      const t = await r.text();
      if (last !== null && t !== last) location.reload();
      last = t;
    } catch (e) { /* сервер перезапускается — просто ждём */ }
  }, 500);
})();
</script>
"#;

    /// Прочитать ассет с диска. `None`, если режим выключен или файла нет —
    /// тогда вызывающий берёт встроенную копию.
    pub fn read(a: &Asset) -> Option<Vec<u8>> {
        let path = dir()?.join(a.file);
        let mut bytes = std::fs::read(path).ok()?;
        if a.content_type.starts_with("text/html") {
            bytes.extend_from_slice(RELOAD_JS.as_bytes());
        }
        Some(bytes)
    }

    /// Метка состояния ассетов — времена последней записи всех файлов.
    /// Меняется при любом сохранении, этого достаточно.
    pub fn token() -> Option<String> {
        let dir = dir()?;
        let mut out = String::new();
        for a in ASSETS {
            let stamp = std::fs::metadata(dir.join(a.file))
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
                .unwrap_or(0);
            out.push_str(&format!("{}:{};", a.file, stamp));
        }
        Some(out)
    }
}
