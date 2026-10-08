# hledit — Protocol Specification

## 1. Invocation and outcomes

```text
hledit <verb> [arguments]
```

The public command surface is deliberately small:

```text
hledit capabilities
hledit version
hledit help
hledit read-range <file> [--offset N] [--limit M]
hledit search <file> <pattern> [--offset N] [--limit M] [--literal] [--context N] [--ignore-case]
hledit batch [--check] <file>
```

`read-range`, `search`, and `batch` emit structured JSON for normal outcomes. They have no text, ANSI, or compatibility output mode. An uncertain write outcome instead exits nonzero with a diagnostic on stderr.

- Logical command failures confirmed to have made no write, including `stale`, `invalid`, `binary`, `encoding`, `directory`, `range`, and pre-commit I/O errors, exit `0` and return `{ "ok": false, ... }` on stdout. A `directory` error means the supplied path is a directory; read and search verbs require one concrete text file.
- Invalid command-line shape exits `2` with usage on stderr.
- Failures that prevent emitting a normal response, including a partially completed Windows replacement whose original file could not be restored, exit `1`. The caller must treat the write outcome as unknown, inspect the reported target and recovery files, and must not retry the original request.

## 2. Capabilities

```text
hledit capabilities
```

The response is the compatibility gate for the Pi extension:

```json
{
  "ok": true,
  "version": "3.4.0",
  "anchorProtocolV2": true,
  "readRangeMetadata": true,
  "batchInsertAfter": true,
  "batchCheck": true,
  "batchUpdatedAnchorSpans": true,
  "batchStaleContext": true,
  "batchWireV3": true,
  "batchReadProof": true,
  "batchEditDeltas": true,
  "searchIgnoreCase": true,
  "searchRegex": true,
  "searchLiteral": true,
  "search": true
}
```

A compatible integration requires CLI 3.x and every positive field above. `contentReplaceOnce` must be absent.

## 3. Read protocol

### 3.1 `read-range`

```text
hledit read-range <file> [--offset N] [--limit M]
```

`read-range` is the only contiguous-source read verb. `offset` is a 1-indexed physical source line and defaults to `1`; `limit` defaults to `160` and bounds returned source lines. It always returns JSON:

```json
{
  "ok": true,
  "revision": "sha256:<64 lowercase hex digits>",
  "totalLines": 120,
  "lines": [
    { "line": 51, "anchor": "51#aB3", "text": "source" }
  ],
  "truncated": true,
  "nextOffset": 52
}
```

`revision` hashes the original bytes before BOM removal or newline parsing. `lines` are ordered physical source lines, and every `anchor` is an exact `LN#HHH` token. `nextOffset`, when present, is the physical source-line cursor for the next page. A source line that cannot fit in an otherwise empty 50 KiB JSON page is returned alone with `textTruncated:true`; that line is not usable as edit proof, and `nextOffset` still points at the following line when one remains. When a complete line does not fit in the remaining page, it is left for the next page instead of being truncated.

Offset past a non-empty file returns:

```json
{ "ok": false, "error": "range", "message": "offset 500 exceeds file length 120", "requestedOffset": 500, "totalLines": 120 }
```

### 3.2 `search`

```text
hledit search <file> <pattern> [--offset N] [--limit M] [--literal] [--context N] [--ignore-case]
```

`search` is the only search verb. `pattern` uses RE2-compatible syntax by default; `--literal` treats it as a substring. The Rust matcher preserves ASCII Perl classes (`\d`, `\w`, `\s`) and word boundaries, Unicode 15.0 categories and case folding, and rejects lookaround/backreferences. `--ignore-case` enables case folding and `--context N` includes adjacent physical source lines, merging overlapping windows. `offset` is a physical source-line cursor (default `1`), not a match index; `limit` defaults to `100` and bounds returned matching/context lines.

```json
{
  "ok": true,
  "revision": "sha256:<64 lowercase hex digits>",
  "totalLines": 120,
  "totalMatches": 2,
  "lines": [{ "line": 51, "anchor": "51#aB3", "text": "source" }],
  "truncated": true,
  "nextOffset": 52
}
```

`totalMatches` counts matching lines in the entire file before context expansion, independently of `offset`. The offset is a lower bound on returned source lines; earlier matches may still contribute trailing context. An empty returned page can therefore have a nonzero `totalMatches`. Zero matches in the file return success with `totalMatches:0`, an empty `lines` array, `truncated:false`, and no `nextOffset`. Empty or invalid patterns return `error:"pattern"`. Broad whole-file expressions such as `.*`, `.+`, and their anchored or dot-all variants return `error:"broad_pattern"`; callers must use `read-range` for contiguous source.

Both read verbs reject directories, binary files, and invalid UTF-8 with structured `directory`, `binary`, or `encoding` errors. They cap the serialized JSON page at 50 KiB.

The read path owns one validated UTF-8 buffer and borrows logical lines from it without allocating whole-file line/terminator arrays. One matching pass counts all matching lines and collects bounded page candidates, including context; the page is then rendered with the exact `totalMatches` included in its JSON byte budget. No full-file match index is retained. Full-file scanning is still required for revision, line count, and match count; paging bounds response memory, not source scanning.

## 4. Batch edit protocol

```text
hledit batch [--check] <file>
```

`batch` reads exactly one strict JSON request from stdin. `--check` performs the entire validation and planning path without writing, and adds `checked:true` to success.

```json
{
  "edits": [
    { "op": "replace", "pos": "2#rT4", "lines": ["new line"] },
    { "op": "replace", "pos": "12#aB3", "end_pos": "18#xY7", "lines": ["new block"] },
    { "op": "delete", "pos": "5#nK2" },
    { "op": "insert", "pos": "8#Qw_", "after": true, "lines": ["inserted"] }
  ],
  "proof": {
    "revision": "sha256:<64 lowercase hex digits>",
    "anchors": ["2#rT4", "5#nK2", "8#Qw_", "12#aB3", "13#Ab1", "14#Ab2", "15#Ab3", "16#Ab4", "17#Ab5", "18#xY7"]
  }
}
```

Batch wire v3 has one canonical shape:

- `replace` requires `lines`; an empty array deletes its target range.
- `delete` omits `lines`.
- `insert` requires non-empty `lines`; `after` is permitted only on `insert`, where only `true` has meaning.
- `replace` and `delete` accept optional inclusive `end_pos`; without it they consume only `pos`.
- Each anchor is exactly `LN#HHH` with a positive line number and no leading zero; annotations, whitespace, aliases, and older hash forms are rejected.
- Each `lines` element is one logical line and must contain neither NUL nor LF; separate lines use separate array elements. An empty string represents one blank line.
- Field names are case-sensitive and must not repeat within an object. The decoder rejects unknown or duplicate fields, `null` objects, trailing JSON values, non-string `lines`/proof anchors, requests larger than 8 MiB, batches above 200 edits, more than 1 MiB of canonical replacement UTF-8, and more than 20,000 replacement output lines.

`proof` is optional for standalone use. When supplied, its raw-byte revision must match the loaded file and its unique, strictly ascending anchors must cover each consumed `replace`/`delete` line and every insert attachment anchor. Missing coverage returns `insufficient_read_proof`; a mismatch returns `stale`.

All edits are validated against one original snapshot before writing. Conflicting ranges, duplicate insertion boundaries, inserts inside a consumed range, invalid anchors, and stale anchors reject the entire request with zero writes. The planner orders non-conflicting edits by physical boundary and rebuilds the file once.

Success includes `revision`, `contentChanged`, aggregate edit statistics, one `editDeltas` entry per request edit, and—except for `--check`, where it is `null`—`updatedAnchorSpans`. An applied batch reports the resulting revision; `--check` writes nothing and reports the current source revision. Each span is context-free and covers exactly one producing edit's range in the new file, in physical order. Pure deletions produce no span. The spans share one budget (80 lines / 16 KiB): a span whose first line exceeds the remaining budget carries that line with `textTruncated:true`, and once the budget is exhausted later spans are still emitted with empty `lines` and `truncated:true` so callers can match spans to `editDeltas` one-to-one.

```json
{
  "ok": true,
  "revision": "sha256:<64 lowercase hex digits>",
  "contentChanged": true,
  "editsApplied": 1,
  "editDeltas": [{ "oldStart": 12, "oldEnd": 12, "delta": 0 }],
  "updatedAnchorSpans": [
    {
      "lines": [{ "line": 12, "anchor": "12#aB3", "text": "updated" }],
      "offset": 12,
      "limit": 1,
      "desiredLimit": 1,
      "truncated": false
    }
  ]
}
```

A stale response may include `remaps`, `currentRevision`, and a bounded same-snapshot `currentAnchors` window (the requested lines plus two lines of context on each side, capped at 20 lines / 4 KiB). Its `truncated` flag is true only when that budget shortened the window, not merely because the file continues after it. These are diagnostic data only: the caller must explicitly re-read and submit a new batch.

## 5. Hashes, revisions, and writes

An anchor has the exact grammar:

```text
^([1-9]\d*)#([A-Za-z0-9_-]{3})$
```

The hash is the low 18 bits of FNV-1a-32 encoded with URL-safe Base64. Its input trims trailing `\r` and Unicode White_Space. Lines with no Unicode 15.0 letter (`L*`) or decimal digit (`Nd`) additionally mix their 1-indexed line number into the hash, distinguishing otherwise identical structural lines.

Raw-byte revisions use `sha256:<64 lowercase hex digits>` over the unchanged source bytes, including BOM, line-ending style, and trailing newline. Revisions are concurrency preconditions; they do not replace per-line anchor validation.

A content-changing batch resolves symlink targets, rejects non-regular and multi-hard-link files, writes a synced temporary sibling, rechecks the raw-byte revision immediately before replacement, then atomically replaces the target. A detectable external change returns `source_changed_before_commit` without overwriting it. The recheck and replacement are not a linearizable compare-and-swap against other processes. A validated no-op reports `contentChanged:false` without touching the file.

Untouched terminators and BOM state for non-empty results are retained. Trailing-newline state is retained except when a final blank logical line needs a terminator to exist physically. A terminated line whose text ends in CR uses CRLF so that the text CR survives parsing. A batch that would reinterpret a leading U+FEFF text character as a BOM is rejected before writing, including when deleting preceding lines exposes that character. Deleting all logical lines produces a truly empty file; mixed line endings are not globally normalized.

On Windows, the temporary file receives the target DACL before any replacement text is written. Its creation descriptor contains only the DACL and its inheritance-control flags; owner and primary group use the creating token's defaults and are not guaranteed to retain their original values after replacement. Existing files use `ReplaceFileW` with metadata-merge errors enforced and a unique reserved recovery path, preserving DACL inheritance state and NTFS alternate data streams. When a replacement stops after moving the original to the recovery path, the original is moved back without overwriting; success reports a zero-write `io` failure. If the original cannot be restored, or an undocumented failure leaves the target missing, both candidate and recovery files are retained and the command exits `1`; a successful replacement whose recovery-file cleanup fails remains a success with a path-bearing warning. Only files reserved by the current transaction are candidates for cleanup.

## 6. Source layout

```text
src/main.rs          command dispatch and capability response
src/read.rs          bounded read/search pages and anchor contexts
src/pattern.rs       RE2-compatible matching and broad-pattern classification
src/batch.rs         strict wire decoding, proof validation, one-pass batch planning
src/text.rs          UTF-8 ownership, BOM, terminators, hashes and revisions
src/write.rs         platform atomic replacement and revision recheck
src/write/platform/tests.rs  Windows metadata and recovery safety cases
tests/write_contract.rs     raw CLI zero-write safety cases
build-bundle.ps1     Windows release artifact, licenses and source fingerprint
```
