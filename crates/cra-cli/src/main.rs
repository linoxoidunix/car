//! Командная строка (CLI) для движка CRA.
//!
//! Читает JSON-запрос из файла или stdin, пишет JSON-ответ. Пример:
//!   cra model.json --pretty
//! Фронтенд на C++ может звать этот CLI и общаться через stdin/stdout.

use std::io::Read;

fn main() {
    // Разбираем аргументы командной строки вручную (без внешних библиотек).
    let mut input: Option<String> = None;
    let mut output: Option<String> = None;
    let mut pretty = false; // --pretty: красивый JSON с отступами
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "-o" | "--output" => {
                output = args.next();
                if output.is_none() {
                    eprintln!("error: {a} requires a path");
                    std::process::exit(2);
                }
            }
            "--pretty" => pretty = true,
            "-h" | "--help" => {
                print_usage();
                return;
            }
            _ if input.is_none() => input = Some(a),
            _ => {
                eprintln!("error: unexpected argument '{a}'");
                std::process::exit(2);
            }
        }
    }
    let Some(input) = input else {
        print_usage();
        std::process::exit(2);
    };
    let text = if input == "-" {
        let mut s = String::new();
        if let Err(e) = std::io::stdin().read_to_string(&mut s) {
            eprintln!("error: reading stdin: {e}");
            std::process::exit(1);
        }
        s
    } else {
        match std::fs::read_to_string(&input) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("error: reading '{input}': {e}");
                std::process::exit(1);
            }
        }
    };
    let req: cra::Request = match serde_json::from_str(&text) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error: invalid request JSON: {e}");
            std::process::exit(1);
        }
    };
    let resp = match cra::analyze_request(&req) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    };
    let out = if pretty {
        serde_json::to_string_pretty(&resp)
    } else {
        serde_json::to_string(&resp)
    }
    .expect("response serialization cannot fail");
    match output {
        Some(path) => {
            if let Err(e) = std::fs::write(&path, out + "\n") {
                eprintln!("error: writing '{path}': {e}");
                std::process::exit(1);
            }
        }
        None => println!("{out}"),
    }
}

fn print_usage() {
    eprintln!(
        "cra — fault tree / SFC reliability analysis\n\
         \n\
         usage: cra <input.json | -> [-o out.json] [--pretty]\n\
         \n\
         Reads a JSON request (model + times + options), writes a JSON report\n\
         with top probability, minimal cut sets and minimal path sets."
    );
}
