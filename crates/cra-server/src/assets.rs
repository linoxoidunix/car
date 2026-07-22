//! Файлы фронтенда, встроенные прямо в бинарник при сборке. So the whole app
//! is one файл: на Астре нечего ставить рядом и ничего не тянется из сети.

pub struct Asset {
    pub path: &'static str,
    pub content_type: &'static str,
    pub bytes: &'static [u8],
}

pub const ASSETS: &[Asset] = &[
    Asset {
        path: "/",
        content_type: "text/html; charset=utf-8",
        bytes: include_bytes!("../assets/index.html"),
    },
    Asset {
        path: "/index.html",
        content_type: "text/html; charset=utf-8",
        bytes: include_bytes!("../assets/index.html"),
    },
    Asset {
        path: "/style.css",
        content_type: "text/css; charset=utf-8",
        bytes: include_bytes!("../assets/style.css"),
    },
    Asset {
        path: "/app.js",
        content_type: "text/javascript; charset=utf-8",
        bytes: include_bytes!("../assets/app.js"),
    },
];

pub fn find(path: &str) -> Option<&'static Asset> {
    ASSETS.iter().find(|a| a.path == path)
}

/// Built-in example requests, served to the frontend example picker.
pub const EXAMPLES: &[(&str, &str)] = &[
    ("fault_tree", include_str!("../../cra-cli/examples/fault_tree.json")),
    ("sfc_bridge", include_str!("../../cra-cli/examples/sfc_bridge.json")),
];

pub fn example(name: &str) -> Option<&'static str> {
    EXAMPLES.iter().find(|(n, _)| *n == name).map(|(_, c)| *c)
}
