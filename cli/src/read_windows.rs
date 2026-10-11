use crate::{failure, read::Page, text::Snapshot};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io::{self, Read},
    path::Path,
};

const MAX_WINDOWS: usize = 8;
const MAX_LINES: usize = 2000;
const MAX_BYTES: usize = 96 * 1024;
const MAX_REQUEST_BYTES: u64 = 16 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Window {
    offset: usize,
    limit: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    windows: Vec<Window>,
}
struct Segment {
    start: usize,
    end: usize,
    requested: Vec<usize>,
}

pub fn run(path: &Path) -> Value {
    let mut input = Vec::new();
    if let Err(error) = io::stdin()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut input)
    {
        return failure("invalid", format!("cannot read windows request: {error}"));
    }
    if input.len() as u64 > MAX_REQUEST_BYTES {
        return failure("invalid", "windows request exceeds 16 KiB");
    }
    let request: Request = match serde_json::from_slice(&input) {
        Ok(request) => request,
        Err(error) => return failure("invalid", format!("invalid windows request: {error}")),
    };
    if request.windows.is_empty() || request.windows.len() > MAX_WINDOWS {
        return failure("invalid", "provide 1-8 windows");
    }
    if request.windows.iter().any(|w| {
        w.offset == 0
            || w.limit == 0
            || w.limit > MAX_LINES
            || w.offset.checked_add(w.limit - 1).is_none()
    }) {
        return failure(
            "invalid",
            "each window needs a positive offset and a limit in 1-2000 without coordinate overflow",
        );
    }
    // [喵喵喵]: 一次加载决定所有窗口的 revision；绝不逐窗重开文件拼接多个快照。
    let snapshot = match Snapshot::load(path) {
        Ok(snapshot) => snapshot,
        Err(error) => return error,
    };
    if let Some(window) = request.windows.iter().find(|w| w.offset > snapshot.total) {
        return json!({"ok":false,"error":"range","message":format!("offset {} exceeds file length {}",window.offset,snapshot.total),"requestedOffset":window.offset,"totalLines":snapshot.total});
    }
    let mut sorted: Vec<Segment> = request
        .windows
        .iter()
        .enumerate()
        .map(|(index, w)| Segment {
            start: w.offset,
            end: (w.offset + w.limit - 1).min(snapshot.total),
            requested: vec![index + 1],
        })
        .collect();
    sorted.sort_by_key(|segment| segment.start);
    let mut segments: Vec<Segment> = Vec::new();
    for segment in sorted {
        if let Some(previous) = segments.last_mut()
            && segment.start <= previous.end.saturating_add(1)
        {
            previous.end = previous.end.max(segment.end);
            previous.requested.extend(segment.requested);
            continue;
        }
        segments.push(segment);
    }
    for segment in &mut segments {
        segment.requested.sort_unstable();
    }
    // [喵喵喵]: 先为最坏元数据与换行计费；Page 已按 JSON 转义后的行大小计费。
    let windows: Vec<Value> = segments.iter().map(|segment| json!({
        "offset":segment.start,"limit":segment.end-segment.start+1,"requestedWindows":segment.requested,
        "lines":[],"truncated":false,"nextOffset":snapshot.total+1
    })).collect();
    let mut result = json!({"ok":true,"revision":snapshot.revision,"totalLines":snapshot.total,"windows":windows,"truncated":false});
    let shell = serde_json::to_vec(&result)
        .expect("windows serialization")
        .len()
        + 1;
    let mut remaining_bytes = MAX_BYTES.saturating_sub(shell);
    let mut remaining_lines = MAX_LINES;
    let mut source = snapshot.lines();
    let mut cursor = 0;
    let mut incomplete = false;
    for (index, segment) in segments.iter().enumerate() {
        let mut page = Page::new(remaining_bytes);
        for number in segment.start..=segment.end {
            if page.rows.len() >= remaining_lines || page.source_truncated() {
                break;
            }
            let (text, _) = source
                .nth(number - cursor - 1)
                .expect("window within snapshot");
            cursor = number;
            if !page.append(number, text) {
                break;
            }
        }
        remaining_bytes -= page.used;
        remaining_lines -= page.rows.len();
        let truncated =
            page.rows.len() < segment.end - segment.start + 1 || page.source_truncated();
        let window = &mut result["windows"][index];
        if truncated {
            window["nextOffset"] = json!(page.rows.last().map_or(segment.start, |row| row.line
                + usize::from(!row.text_truncated)));
        } else {
            window.as_object_mut().unwrap().remove("nextOffset");
        }
        window["truncated"] = json!(truncated);
        window["lines"] = json!(page.rows);
        incomplete |= truncated;
    }
    result["truncated"] = json!(incomplete);
    result
}
