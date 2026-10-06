use crate::{
    failure,
    read::{self, Page},
    text::{self, Ending, Snapshot, anchor, tag},
    write,
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    io::{self, Read},
    path::Path,
};

// [喵喵喵]: Option 会把显式 null 当作缺省；wire v3 要区分缺失和 null，字段存在时必须按实际类型解码。
struct Field<T>(Option<T>);
impl<T> Default for Field<T> {
    fn default() -> Self {
        Self(None)
    }
}
impl<'de, T: Deserialize<'de>> Deserialize<'de> for Field<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        T::deserialize(d).map(|v| Self(Some(v)))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Edit {
    #[serde(default)]
    op: String,
    #[serde(default)]
    pos: String,
    #[serde(default)]
    end_pos: Field<String>,
    #[serde(default)]
    after: Field<bool>,
    #[serde(default)]
    lines: Field<Vec<String>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Proof {
    revision: String,
    anchors: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    #[serde(default)]
    edits: Vec<Edit>,
    #[serde(default)]
    proof: Field<Proof>,
}
struct Planned<'a> {
    edit: &'a Edit,
    index: usize,
    start: usize,
    end: usize,
    boundary: usize,
}
impl Planned<'_> {
    fn insert(&self) -> bool {
        self.edit.op == "insert"
    }
    fn replacement(&self) -> &[String] {
        self.edit.lines.0.as_deref().unwrap_or_default()
    }
    fn consumed(&self) -> usize {
        if self.insert() {
            0
        } else {
            self.end - self.start + 1
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Delta {
    old_start: usize,
    old_end: usize,
    delta: isize,
}

fn rejected(code: &str, message: impl ToString, failed: isize) -> Value {
    let mut error = failure(code, message);
    error["failed"] = json!(failed);
    error
}
fn invalid(message: impl ToString, failed: isize) -> Value {
    rejected("invalid", message, failed)
}
fn stale(
    message: impl ToString,
    failed: isize,
    snapshot: &Snapshot,
    lines: &[&str],
    start: usize,
    end: usize,
    remaps: Vec<Value>,
) -> Value {
    let mut result = rejected("stale", message, failed);
    result["currentRevision"] = json!(snapshot.revision);
    if start > 0 {
        result["currentAnchors"] = read::context(lines, start, end);
    }
    if !remaps.is_empty() {
        result["remaps"] = json!(remaps);
    }
    result
}
fn remap(lines: &[&str], requested: &str, number: usize) -> Option<Value> {
    let current = lines
        .get(number - 1)
        .map(|line| tag(number, line))
        .unwrap_or_default();
    if current == requested {
        None
    } else {
        Some(json!({"requested":requested,"current":current}))
    }
}
fn plan_edit(edit: &Edit, index: usize) -> Result<Planned<'_>, Value> {
    let fail = |message: String| invalid(format!("edit {index}: {message}"), index as isize);
    let start = anchor(&edit.pos).ok_or_else(|| fail(format!("invalid anchor {:?}", edit.pos)))?;
    let end = match &edit.end_pos.0 {
        Some(value) => {
            anchor(value).ok_or_else(|| fail(format!("invalid end anchor {value:?}")))?
        }
        None => start,
    };
    match edit.op.as_str() {
        "replace" | "delete" => {
            if edit.op == "replace" && edit.lines.0.is_none() {
                return Err(fail("replace requires lines".into()));
            }
            if edit.op == "delete" && edit.lines.0.is_some() {
                return Err(fail("delete does not accept lines".into()));
            }
            if edit.after.0.is_some() {
                return Err(fail(format!("{} does not accept after", edit.op)));
            }
            if start > end {
                return Err(fail(format!("start line {start} > end line {end}")));
            }
        }
        "insert" => {
            if edit.end_pos.0.is_some() {
                return Err(fail("insert does not accept end_pos".into()));
            }
            if edit.lines.0.as_ref().is_none_or(|lines| lines.is_empty()) {
                return Err(fail("insert requires non-empty content".into()));
            }
            if edit.after.0 == Some(false) {
                return Err(fail("insert after must be true when provided".into()));
            }
        }
        _ => return Err(fail(format!("unknown op {:?}", edit.op))),
    }
    if let Some(lines) = &edit.lines.0 {
        for (index, line) in lines.iter().enumerate() {
            if line.contains('\0') {
                return Err(fail(format!(
                    "lines[{index}] contains NUL; replacement must remain readable text"
                )));
            }
            if line.contains('\n') {
                return Err(fail(format!(
                    "lines[{index}] contains LF; each wire array element must be one logical line"
                )));
            }
        }
    }
    Ok(Planned {
        edit,
        index,
        start,
        end,
        boundary: start - 1 + usize::from(edit.after.0 == Some(true)),
    })
}

fn validate<'a>(
    request: &'a Request,
    snapshot: &Snapshot,
    lines: &[&str],
) -> Result<Vec<Planned<'a>>, Value> {
    if request.edits.is_empty() {
        return Err(invalid("batch request contains no edits", -1));
    }
    if let Some(proof) = &request.proof.0 {
        if !text::valid_revision(&proof.revision) {
            return Err(invalid(
                "read proof revision must be sha256:<64 lowercase hexadecimal digits>",
                -1,
            ));
        }
        if proof.revision != snapshot.revision {
            let first = plan_edit(&request.edits[0], 0).ok();
            return Err(stale(
                "read proof revision does not match the current file",
                -1,
                snapshot,
                lines,
                first.as_ref().map_or(0, |e| e.start),
                first.as_ref().map_or(0, |e| e.end),
                vec![],
            ));
        }
    }
    let edits: Vec<_> = request
        .edits
        .iter()
        .enumerate()
        .map(|(i, e)| plan_edit(e, i))
        .collect::<Result<_, _>>()?;
    if let Some(proof) = &request.proof.0 {
        let insufficient = |message: String, index: usize| {
            let mut e = rejected("insufficient_read_proof", message, index as isize);
            e["currentRevision"] = json!(snapshot.revision);
            e
        };
        if proof.anchors.is_empty() {
            return Err(insufficient("read proof contains no anchors".into(), 0));
        }
        let mut covered = BTreeSet::new();
        let mut previous = 0;
        let mut remaps = Vec::new();
        let mut first_stale = 0;
        for (index, token) in proof.anchors.iter().enumerate() {
            let number = anchor(token).ok_or_else(|| {
                invalid(
                    format!("read proof anchor {index} {token:?} is invalid"),
                    -1,
                )
            })?;
            if number <= previous {
                return Err(invalid(
                    format!(
                        "read proof anchors must be unique and strictly increasing; line {number} follows line {previous}"
                    ),
                    -1,
                ));
            }
            previous = number;
            covered.insert(number);
            if let Some(remap) = remap(lines, token, number) {
                if first_stale == 0 {
                    first_stale = number;
                }
                remaps.push(remap);
            }
        }
        if first_stale > 0 {
            let failed = edits
                .iter()
                .find(|e| first_stale >= e.start && first_stale <= e.end)
                .map_or(-1, |e| e.index as isize);
            return Err(stale(
                format!("read proof anchor at line {first_stale} is stale"),
                failed,
                snapshot,
                lines,
                first_stale,
                first_stale,
                remaps,
            ));
        }
        for edit in &edits {
            // [喵喵喵]: 通过已排序 proof 查首个缺口，不枚举请求可伪造的巨大行号区间。
            let mut expected = edit.start;
            for &number in covered.range(edit.start..=edit.end) {
                if number != expected {
                    break;
                }
                expected += 1;
            }
            if expected <= edit.end {
                return Err(insufficient(
                    format!(
                        "edit {} requires read proof for line {expected}",
                        edit.index
                    ),
                    edit.index,
                ));
            }
        }
    }
    let mut remaps = Vec::new();
    let mut first = None;
    for edit in &edits {
        if let Some(remap) = remap(lines, &edit.edit.pos, edit.start) {
            first.get_or_insert(edit);
            remaps.push(remap);
        }
        if let Some(end) = &edit.edit.end_pos.0
            && let Some(remap) = remap(lines, end, edit.end)
        {
            first.get_or_insert(edit);
            remaps.push(remap);
        }
    }
    if let Some(first) = first {
        return Err(stale(
            format!("edit {}: anchor stale", first.index),
            first.index as isize,
            snapshot,
            lines,
            first.start,
            first.end,
            remaps,
        ));
    }
    for (i, first) in edits.iter().enumerate() {
        for second in &edits[i + 1..] {
            let conflicts = match (first.insert(), second.insert()) {
                (true, true) => first.boundary == second.boundary,
                (false, false) => first.start <= second.end && second.start <= first.end,
                (true, false) => first.boundary > second.start - 1 && first.boundary < second.end,
                (false, true) => second.boundary > first.start - 1 && second.boundary < first.end,
            };
            if conflicts {
                return Err(invalid(
                    format!(
                        "edit {} overlaps edit {}: conflicting physical ranges or insert boundaries",
                        second.index, first.index
                    ),
                    second.index as isize,
                ));
            }
        }
    }
    Ok(edits)
}

fn request() -> Result<Request, Value> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| invalid(format!("invalid batch request: {e}"), -1))?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(invalid(
            "invalid batch request: batch request exceeds 8388608-byte limit",
            -1,
        ));
    }
    let request: Request = serde_json::from_slice(&bytes)
        .map_err(|e| invalid(format!("invalid batch request: {e}"), -1))?;
    if request.edits.len() > 200 {
        return Err(invalid(
            "invalid batch request: batch request exceeds maximum 200 edits",
            -1,
        ));
    }
    let mut bytes = 0;
    let mut count = 0;
    for edit in &request.edits {
        if let Some(lines) = &edit.lines.0 {
            bytes += lines.iter().map(String::len).sum::<usize>() + lines.len().saturating_sub(1);
            count += lines.len();
        }
    }
    if bytes > 1024 * 1024 {
        return Err(invalid(
            "invalid batch request: batch replacement text exceeds 1048576-byte canonical UTF-8 limit",
            -1,
        ));
    }
    if count > 20_000 {
        return Err(invalid(
            "invalid batch request: batch replacement output exceeds 20000 lines",
            -1,
        ));
    }
    Ok(request)
}

pub fn run(path: &Path, check: bool) -> Result<Value, String> {
    let request = match request() {
        Ok(r) => r,
        Err(e) => return Ok(e),
    };
    let snapshot = match Snapshot::load(path) {
        Ok(s) => s,
        Err(e) => return Ok(e),
    };
    let (original, original_endings): (Vec<_>, Vec<_>) = snapshot.lines().unzip();
    let mut edits = match validate(&request, &snapshot, &original) {
        Ok(e) => e,
        Err(e) => return Ok(e),
    };
    // [喵喵喵]: 物理顺序只排序一次；统计、重建、行尾和 delta 共用该顺序，边界上的 insert 必须先于 range。
    edits.sort_by_key(|e| (e.boundary, !e.insert(), e.index));
    let added: usize = edits.iter().map(|e| e.replacement().len()).sum();
    let deleted: usize = edits.iter().map(Planned::consumed).sum();
    let mut rebuilt = Vec::with_capacity(original.len() + added - deleted);
    let mut endings = Vec::with_capacity(rebuilt.capacity());
    let mut deltas = Vec::with_capacity(edits.len());
    let mut cursor = 0;
    let mut first_changed = usize::MAX;
    let mut last_changed = 0;
    for edit in &edits {
        rebuilt.extend_from_slice(&original[cursor..edit.boundary]);
        endings.extend_from_slice(&original_endings[cursor..edit.boundary]);
        let change_start = rebuilt.len() + 1;
        first_changed = first_changed.min(change_start);
        last_changed =
            last_changed.max(change_start + edit.consumed().max(edit.replacement().len()) - 1);
        rebuilt.extend(edit.replacement().iter().map(String::as_str));
        let old_start = edit.boundary + 1;
        let old_end = if edit.insert() {
            edit.boundary
        } else {
            edit.end
        };
        let local = if old_end == 0 {
            original_endings
                .iter()
                .copied()
                .find(|e| *e != Ending::None)
                .unwrap_or(Ending::Lf)
        } else {
            text::local_ending(&original_endings, old_end - 1)
        };
        endings.extend(std::iter::repeat_n(local, edit.replacement().len()));
        if !edit.insert() && !edit.replacement().is_empty() {
            *endings.last_mut().unwrap() = original_endings[old_end - 1];
        }
        deltas.push(Delta {
            old_start,
            old_end,
            delta: edit.replacement().len() as isize - edit.consumed() as isize,
        });
        cursor = old_end;
    }
    rebuilt.extend_from_slice(&original[cursor..]);
    endings.extend_from_slice(&original_endings[cursor..]);
    if !snapshot.bom
        && rebuilt
            .first()
            .is_some_and(|line| line.starts_with(text::BOM))
    {
        return Ok(invalid(
            "result would reinterpret leading U+FEFF text as a UTF-8 BOM; keep it out of the first text position",
            -1,
        ));
    }
    let changed = original != rebuilt;
    let mut result = json!({"ok":true,"firstChangedLine":first_changed,"lastChangedLine":last_changed,"linesAdded":added,"linesDeleted":deleted,"editsApplied":edits.len(),"contentChanged":changed,"revision":snapshot.revision,"editDeltas":deltas,"updatedAnchorSpans":null});
    if check {
        result["checked"] = json!(true);
        return Ok(result);
    }
    let mut remaining_lines = 80;
    let mut remaining_bytes = 16 * 1024;
    let mut shift = 0isize;
    let mut spans = Vec::new();
    for delta in &deltas {
        let start = (delta.old_start as isize + shift) as usize;
        let produced =
            (delta.old_end as isize - delta.old_start as isize + 1 + delta.delta) as usize;
        shift += delta.delta;
        if produced == 0 {
            continue;
        }
        let mut page = Page::new(remaining_bytes);
        for (index, line) in rebuilt
            .iter()
            .enumerate()
            .skip(start - 1)
            .take(produced.min(remaining_lines))
        {
            if !page.append(index + 1, line) || page.source_truncated() {
                break;
            }
        }
        remaining_lines -= page.rows.len();
        remaining_bytes -= page.used;
        spans.push(json!({"offset":start,"limit":page.rows.len(),"desiredLimit":produced,"truncated":page.rows.len() < produced || page.source_truncated(),"lines":page.rows}));
    }
    result["updatedAnchorSpans"] = json!(spans);
    if changed {
        let encoded = text::encode(
            snapshot.bom,
            &rebuilt,
            &mut endings,
            original_endings.last().is_some_and(|e| *e != Ending::None),
        );
        result["revision"] = json!(text::revision(&encoded));
        match write::atomic(path, &encoded, &snapshot.revision) {
            Ok(Some(warning)) => result["warnings"] = json!([warning]),
            Ok(None) => {}
            Err(write::Error::Known(error)) => return Ok(failure("io", error)),
            Err(write::Error::Changed(current, error)) => {
                let mut result = rejected("source_changed_before_commit", error, -1);
                if let Some(current) = current {
                    result["currentRevision"] = json!(current);
                }
                return Ok(result);
            }
            #[cfg(windows)]
            Err(write::Error::Unknown(error)) => return Err(error),
        }
    }
    Ok(result)
}
