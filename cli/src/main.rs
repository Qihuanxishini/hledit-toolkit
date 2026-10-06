mod batch;
mod pattern;
mod read;
mod text;
mod write;

use serde_json::{Value, json};
use std::{
    env,
    io::{self, Write},
    path::PathBuf,
};

pub fn failure(code: &str, message: impl ToString) -> Value {
    json!({"ok": false, "error": code, "message": message.to_string()})
}

const USAGE: &str = "hledit — hash-anchored line editor\nUsage:\n  hledit capabilities|version|help\n  hledit read-range <file> [--offset N] [--limit M]\n  hledit search <file> <pattern> [--offset N] [--limit M] [--literal] [--context N] [--ignore-case]\n  hledit batch [--check] <file>\n";

#[derive(Default)]
struct Args {
    positional: Vec<std::ffi::OsString>,
    offset: usize,
    limit: usize,
    context: usize,
    literal: bool,
    ignore_case: bool,
    check: bool,
}

fn arguments(verb: &str, args: impl Iterator<Item = std::ffi::OsString>) -> Result<Args, ()> {
    let mut result = Args {
        offset: 1,
        ..Args::default()
    };
    let mut positional = false;
    let mut args = args;
    while let Some(arg) = args.next() {
        let flag = arg.to_str().unwrap_or("");
        if !positional && flag == "--" {
            positional = true;
            continue;
        }
        if !positional {
            match flag {
                "--offset" | "-offset" | "--limit" | "-limit" | "--context" | "-context" => {
                    if verb == "batch" || (flag.ends_with("context") && verb != "search") {
                        return Err(());
                    }
                    let n: i64 = args
                        .next()
                        .and_then(|v| v.to_str().and_then(|s| s.parse().ok()))
                        .ok_or(())?;
                    let n = n.max(0) as usize;
                    if flag.ends_with("offset") {
                        result.offset = n.max(1);
                    } else if flag.ends_with("limit") {
                        result.limit = n;
                    } else {
                        result.context = n;
                    }
                    continue;
                }
                "--literal" | "-literal" if verb == "search" => {
                    result.literal = true;
                    continue;
                }
                "--ignore-case" | "-ignore-case" if verb == "search" => {
                    result.ignore_case = true;
                    continue;
                }
                "--check" | "-check" if verb == "batch" => {
                    result.check = true;
                    continue;
                }
                "--literal" | "-literal" | "--ignore-case" | "-ignore-case" | "--check"
                | "-check" => return Err(()),
                _ => {}
            }
        }
        result.positional.push(arg);
    }
    if result.positional.len() != if verb == "search" { 2 } else { 1 } {
        return Err(());
    }
    Ok(result)
}

fn run() -> Result<(), i32> {
    let mut args = env::args_os().skip(1);
    let Some(verb) = args.next() else {
        print!("{USAGE}");
        return Ok(());
    };
    let verb = verb.to_str().unwrap_or("");
    if matches!(verb, "version" | "--version" | "-v") {
        println!("hledit {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if matches!(verb, "help" | "--help" | "-h") {
        print!("{USAGE}");
        return Ok(());
    }
    let result = if verb == "capabilities" {
        json!({"ok":true,"version":env!("CARGO_PKG_VERSION"),"anchorProtocolV2":true,"readRangeMetadata":true,
            "batchInsertAfter":true,"batchCheck":true,"batchUpdatedAnchorSpans":true,"batchStaleContext":true,
            "batchWireV3":true,"batchReadProof":true,"batchEditDeltas":true,"searchIgnoreCase":true,
            "searchRegex":true,"searchLiteral":true,"search":true})
    } else if matches!(verb, "read-range" | "search" | "batch") {
        let args = arguments(verb, args).map_err(|_| {
            eprint!("{USAGE}");
            2
        })?;
        let path = PathBuf::from(&args.positional[0]);
        if verb == "batch" {
            batch::run(&path, args.check).map_err(|error| {
                eprintln!("{error}");
                1
            })?
        } else {
            read::run(
                &path,
                if verb == "search" {
                    Some(args.positional[1].to_str().ok_or_else(|| {
                        eprintln!("search pattern must be valid UTF-8");
                        2
                    })?)
                } else {
                    None
                },
                args.offset,
                args.limit,
                args.literal,
                args.context,
                args.ignore_case,
            )
        }
    } else {
        eprint!("unknown verb {verb:?}\n{USAGE}");
        return Err(2);
    };
    let stdout = io::stdout();
    let mut out = stdout.lock();
    serde_json::to_writer(&mut out, &result).map_err(|e| {
        eprintln!("{e}");
        1
    })?;
    out.write_all(b"\n").map_err(|e| {
        eprintln!("{e}");
        1
    })
}

fn main() {
    if let Err(code) = run() {
        std::process::exit(code);
    }
}
