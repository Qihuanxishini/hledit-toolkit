use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

fn invoke(path: &Path, verb: &str, input: Option<&str>) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_hledit"))
        .arg(verb)
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Some(input) = input {
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn strict_wire_rejections_cannot_write() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("target.txt");
    fs::write(&path, "alpha\nbeta\ngamma\n").unwrap();
    let read = invoke(&path, "read-range", None);
    let pos = read["lines"][0]["anchor"].as_str().unwrap();
    let valid = json!({"op":"replace","pos":pos,"lines":["changed"]});
    let proof = json!({"revision":read["revision"],"anchors":[pos]});
    let mut cases = vec![
        r#"{"edits":[],"edits":[]}"#.to_string(),
        r#"{"Edits":[]}"#.to_string(),
        r#"{"edits":[]} {}"#.to_string(),
        json!({"edits":[valid],"proof":null}).to_string(),
        json!({"edits":[valid],"proof":{"revision":read["revision"],"anchors":[null]}}).to_string(),
        json!({"edits":[valid],"proof":{"revision":read["revision"],"anchors":[pos,pos]}})
            .to_string(),
    ];
    for lines in [
        json!(null),
        json!([null]),
        json!(["a\nb"]),
        json!(["a\u{0000}b"]),
    ] {
        cases.push(
            json!({"edits":[{"op":"replace","pos":pos,"lines":lines}],"proof":proof}).to_string(),
        );
    }
    for input in cases {
        let result = invoke(&path, "batch", Some(&input));
        assert_eq!(result["error"], "invalid", "{result}");
        assert_eq!(fs::read(&path).unwrap(), b"alpha\nbeta\ngamma\n");
    }
}

#[test]
fn complete_proof_and_conflict_checks_are_enforced_by_cli() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("target.txt");
    fs::write(&path, "alpha\nbeta\ngamma\n").unwrap();
    let read = invoke(&path, "read-range", None);
    let anchors: Vec<_> = read["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["anchor"].clone())
        .collect();
    let range = json!({"op":"delete","pos":anchors[0],"end_pos":anchors[2]});
    let incomplete = json!({"edits":[range],"proof":{"revision":read["revision"],"anchors":[anchors[0],anchors[2]]}});
    assert_eq!(
        invoke(&path, "batch", Some(&incomplete.to_string()))["error"],
        "insufficient_read_proof"
    );
    let conflict = json!({"edits":[range,{"op":"insert","pos":anchors[1],"lines":["intruder"]}],"proof":{"revision":read["revision"],"anchors":anchors}});
    assert_eq!(
        invoke(&path, "batch", Some(&conflict.to_string()))["error"],
        "invalid"
    );
    assert_eq!(fs::read(&path).unwrap(), b"alpha\nbeta\ngamma\n");
}

#[test]
fn invalid_encoding_and_bom_reinterpretation_preserve_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("target.txt");
    let request = r#"{"edits":[{"op":"delete","pos":"1#abc"}]}"#;
    for bytes in [&b"a\x00b"[..], &b"a\xffb"[..]] {
        fs::write(&path, bytes).unwrap();
        let result = invoke(&path, "batch", Some(request));
        assert_eq!(result["ok"], false);
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    fs::write(&path, "alpha\n\u{feff}literal\n").unwrap();
    let read = invoke(&path, "read-range", None);
    let result = invoke(
        &path,
        "batch",
        Some(&json!({"edits":[{"op":"delete","pos":read["lines"][0]["anchor"]}]}).to_string()),
    );
    assert_eq!(result["error"], "invalid");
    assert_eq!(
        fs::read(&path).unwrap(),
        "alpha\n\u{feff}literal\n".as_bytes()
    );
}
