use crate::failure;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Read},
    path::Path,
};
use unicode_general_category::{GeneralCategory as G, get_general_category};

pub const BOM: &str = "\u{feff}";

pub fn revision(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

pub fn revision_from_path(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 32 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("sha256:{:x}", hash.finalize()))
}

pub fn valid_revision(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value.as_bytes()[7..]
            .iter()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c))
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Ending {
    None,
    Lf,
    CrLf,
}
impl Ending {
    pub fn text(self) -> &'static str {
        match self {
            Self::None => "",
            Self::Lf => "\n",
            Self::CrLf => "\r\n",
        }
    }
}

pub struct Snapshot {
    text: String,
    pub revision: String,
    pub bom: bool,
    pub total: usize,
}
impl Snapshot {
    pub fn parse(bytes: Vec<u8>) -> Result<Self, Value> {
        if bytes.contains(&0) {
            return Err(failure("binary", "file appears to be binary"));
        }
        let revision = revision(&bytes);
        // [喵喵喵]: 转移原始缓冲的所有权，不复制全文件；只读路径通过迭代器借用行，不建立行尾数组。
        let text =
            String::from_utf8(bytes).map_err(|_| failure("encoding", "file is not valid UTF-8"))?;
        let bom = text.starts_with(BOM);
        let body = text.strip_prefix(BOM).unwrap_or(&text);
        let total = body.bytes().filter(|b| *b == b'\n').count()
            + usize::from(!body.is_empty() && !body.ends_with('\n'));
        Ok(Self {
            text,
            revision,
            bom,
            total,
        })
    }
    pub fn load(path: &Path) -> Result<Self, Value> {
        let bytes = fs::read(path).map_err(|error| {
            if path.is_dir() {
                failure(
                    "directory",
                    "path is a directory; provide a regular text file",
                )
            } else {
                failure("io", error)
            }
        })?;
        Self::parse(bytes)
    }
    pub fn lines(&self) -> impl Iterator<Item = (&str, Ending)> {
        self.text
            .strip_prefix(BOM)
            .unwrap_or(&self.text)
            .split_inclusive('\n')
            .map(|line| {
                if let Some(line) = line.strip_suffix("\r\n") {
                    (line, Ending::CrLf)
                } else if let Some(line) = line.strip_suffix('\n') {
                    (line, Ending::Lf)
                } else {
                    (line, Ending::None)
                }
            })
    }
}

pub fn tag(number: usize, line: &str) -> String {
    let line = line.trim_end_matches(char::is_whitespace);
    let significant = line.chars().any(|c| {
        matches!(
            get_general_category(c),
            G::UppercaseLetter
                | G::LowercaseLetter
                | G::TitlecaseLetter
                | G::ModifierLetter
                | G::OtherLetter
                | G::DecimalNumber
        )
    });
    let mut hash = 0x811c9dc5u32;
    let mut mix = |byte| hash = (hash ^ u32::from(byte)).wrapping_mul(0x01000193);
    if !significant {
        let mut n = number;
        while n > 0 {
            mix((n & 0xff) as u8);
            n >>= 8;
        }
    }
    for byte in line.bytes() {
        mix(byte);
    }
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    format!(
        "{number}#{}{}{}",
        alphabet[((hash >> 12) & 63) as usize] as char,
        alphabet[((hash >> 6) & 63) as usize] as char,
        alphabet[(hash & 63) as usize] as char
    )
}

pub fn anchor(value: &str) -> Option<usize> {
    let (number, hash) = value.split_once('#')?;
    if number.starts_with('0')
        || number.is_empty()
        || !number.bytes().all(|c| c.is_ascii_digit())
        || hash.len() != 3
        || !hash
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return None;
    }
    // [喵喵喵]: 与 JSON/TypeScript 的安全整数边界一致，拒绝无法精确回传的坐标。
    number
        .parse::<usize>()
        .ok()
        .filter(|n| *n <= 9_007_199_254_740_991)
}

pub fn local_ending(endings: &[Ending], index: usize) -> Ending {
    endings[..index.saturating_add(1).min(endings.len())]
        .iter()
        .rev()
        .copied()
        .chain(
            endings
                .get(index.saturating_add(1)..)
                .unwrap_or_default()
                .iter()
                .copied(),
        )
        .find(|e| *e != Ending::None)
        .unwrap_or(Ending::Lf)
}

pub fn encode(bom: bool, lines: &[&str], endings: &mut [Ending], had_trailing: bool) -> Vec<u8> {
    if lines.is_empty() {
        return Vec::new();
    }
    for index in 0..endings.len() - 1 {
        if endings[index] == Ending::None {
            endings[index] = local_ending(endings, index);
        }
    }
    let last = endings.len() - 1;
    if had_trailing || lines[last].is_empty() {
        if endings[last] == Ending::None {
            endings[last] = local_ending(endings, last);
        }
    } else {
        endings[last] = Ending::None;
    }
    for (line, ending) in lines.iter().zip(endings.iter_mut()) {
        if *ending == Ending::Lf && line.ends_with('\r') {
            *ending = Ending::CrLf;
        }
    }
    let size: usize = lines
        .iter()
        .zip(endings.iter())
        .map(|(line, ending)| line.len() + ending.text().len())
        .sum();
    let mut bytes = Vec::with_capacity(size + if bom { 3 } else { 0 });
    if bom {
        bytes.extend_from_slice(BOM.as_bytes());
    }
    for (line, ending) in lines.iter().zip(endings.iter()) {
        bytes.extend_from_slice(line.as_bytes());
        bytes.extend_from_slice(ending.text().as_bytes());
    }
    bytes
}
