use crate::{
    failure, pattern,
    text::{Snapshot, tag},
};
use serde::Serialize;
use serde_json::{Value, json};
use std::path::Path;

const MAX_BYTES: usize = 50 * 1024;
fn is_false(value: &bool) -> bool {
    !*value
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub line: usize,
    pub anchor: String,
    pub text: String,
    #[serde(skip_serializing_if = "is_false")]
    pub text_truncated: bool,
}

fn escaped_size(text: &str) -> usize {
    text.bytes()
        .map(|byte| match byte {
            b'"' | b'\\' | b'\n' | b'\r' | b'\t' | 8 | 12 => 2,
            0..=31 => 6,
            _ => 1,
        })
        .sum()
}

pub struct Page {
    pub rows: Vec<Row>,
    pub used: usize,
    budget: usize,
}
impl Page {
    pub fn new(budget: usize) -> Self {
        Self {
            rows: Vec::new(),
            used: 0,
            budget,
        }
    }
    pub fn source_truncated(&self) -> bool {
        self.rows.last().is_some_and(|row| row.text_truncated)
    }
    pub fn append(&mut self, number: usize, text: &str) -> bool {
        let separator = usize::from(!self.rows.is_empty());
        let available = self.budget.saturating_sub(self.used + separator);
        let mut row = Row {
            line: number,
            anchor: tag(number, text),
            text: String::new(),
            text_truncated: false,
        };
        let base = serde_json::to_vec(&row).expect("row serialization").len();
        let size = base + escaped_size(text);
        if size <= available {
            row.text.push_str(text);
            self.used += separator + size;
            self.rows.push(row);
            return true;
        }
        if !self.rows.is_empty() {
            return false;
        }
        row.text_truncated = true;
        let base = serde_json::to_vec(&row).expect("row serialization").len();
        if base > available {
            return false;
        }
        let suffix = "… [truncated]";
        let suffix = if base + suffix.len() <= available {
            suffix
        } else {
            ""
        };
        let mut remaining = available - base - suffix.len();
        let mut end = 0;
        // [喵喵喵]: 按实际 JSON 转义大小线性截断，不序列化超长整行，也不反复分配候选前缀。
        for (index, ch) in text.char_indices() {
            let size = escaped_size(&text[index..index + ch.len_utf8()]);
            if size > remaining {
                break;
            }
            remaining -= size;
            end = index + ch.len_utf8();
        }
        row.text.push_str(&text[..end]);
        row.text.push_str(suffix);
        self.used += separator + base + escaped_size(&row.text);
        self.rows.push(row);
        true
    }
}

pub fn context(lines: &[&str], requested_start: usize, requested_end: usize) -> Value {
    if lines.is_empty() {
        return json!({"lines":[],"offset":1,"limit":0,"desiredLimit":0,"truncated":false});
    }
    let start = requested_start.min(requested_end).min(lines.len());
    let end = requested_start.max(requested_end).min(lines.len());
    let offset = start.saturating_sub(2).max(1);
    let desired = end - offset + 3;
    let limit = desired.min(20).min(lines.len() - offset + 1);
    let mut page = Page::new(4096);
    for (index, text) in lines.iter().enumerate().skip(offset - 1).take(limit) {
        if !page.append(index + 1, text) || page.source_truncated() {
            break;
        }
    }
    json!({"offset":offset,"limit":page.rows.len(),"desiredLimit":desired,
        "truncated":desired > 20 || page.source_truncated() || page.rows.len() < limit,"lines":page.rows})
}

#[allow(clippy::too_many_arguments)]
pub fn run(
    path: &Path,
    pattern_text: Option<&str>,
    offset: usize,
    limit: usize,
    literal: bool,
    context: usize,
    ignore_case: bool,
) -> Value {
    let snapshot = match Snapshot::load(path) {
        Ok(s) => s,
        Err(error) => return error,
    };
    if pattern_text == Some("") {
        return failure("pattern", "search pattern must not be empty");
    }
    if (snapshot.total > 0 && offset > snapshot.total)
        || (snapshot.total == 0 && pattern_text.is_none())
    {
        return json!({"ok":false,"error":"range","message":format!("offset {offset} exceeds file length {}", snapshot.total),"requestedOffset":offset,"totalLines":snapshot.total});
    }
    let matcher = match pattern_text {
        Some(p) => match pattern::compile(p, literal, ignore_case) {
            Ok(matcher) if matcher.broad => {
                return failure(
                    "broad_pattern",
                    "search pattern is an unconstrained wildcard; use a contiguous range read instead",
                );
            }
            Ok(matcher) => Some(matcher),
            Err(error) => return failure("pattern", format!("invalid search pattern: {error}")),
        },
        None => None,
    };
    let limit = if limit == 0 {
        if matcher.is_some() { 100 } else { 160 }
    } else {
        limit
    };
    let mut result = json!({"ok":true,"revision":snapshot.revision,"totalLines":snapshot.total,"lines":[],"truncated":true,"nextOffset":snapshot.total + 1});
    if let Some(matcher) = &matcher {
        // [喵喵喵]: 首遍仅计数，预算包含真实 totalMatches；第二遍流式展开窗口，不保存全文件命中索引。
        result["totalMatches"] = json!(
            snapshot
                .lines()
                .filter(|(line, _)| matcher.regex.is_match(line))
                .count()
        );
    }
    let shell = serde_json::to_vec(&result)
        .expect("result serialization")
        .len()
        + 1;
    let mut page = Page::new(MAX_BYTES.saturating_sub(shell));
    let mut next = None;
    if let Some(matcher) = &matcher {
        let context = context.min(snapshot.total);
        let mut source = snapshot.lines().enumerate();
        let mut cursor = 0;
        'matches: for (index, (line, _)) in snapshot.lines().enumerate() {
            if !matcher.regex.is_match(line) {
                continue;
            }
            let start = (index + 1)
                .saturating_sub(context)
                .max(offset)
                .max(cursor + 1);
            let end = (index + 1).saturating_add(context).min(snapshot.total);
            if start > end {
                continue;
            }
            for number in start..=end {
                let (_, (text, _)) = source
                    .nth(number - cursor - 1)
                    .expect("source window within snapshot");
                cursor = number;
                if page.rows.len() >= limit || page.source_truncated() || !page.append(number, text)
                {
                    next = Some(page.rows.last().map_or(number, |row| row.line + 1));
                    break 'matches;
                }
            }
        }
    } else {
        for (index, (text, _)) in snapshot.lines().enumerate().skip(offset - 1) {
            if page.rows.len() >= limit || page.source_truncated() || !page.append(index + 1, text)
            {
                next = Some(index + 1);
                break;
            }
        }
    }
    result["truncated"] = json!(next.is_some() || page.source_truncated());
    result["lines"] = json!(page.rows);
    if let Some(next) = next {
        result["nextOffset"] = json!(next);
    } else {
        result.as_object_mut().unwrap().remove("nextOffset");
    }
    result
}
