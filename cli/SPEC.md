# hledit — Spec

## 1. Binary & Invocation

```
hledit <verb> [flags] <file> [anchor] [end-anchor] <content-source>
```

- Logical outcomes (success, stale anchors, invalid anchors/content, binary/encoding/range/io errors) exit 0 and are reported on stdout.
- CLI misuse exits 2 with usage on stderr; unrecoverable infrastructure failures exit 1.

### 1.1 `capabilities`

```
hledit capabilities
```

Outputs one JSON object describing behavior that integrations may require:

```json
{ "ok": true, "version": "2.0.0", "anchorProtocolV2": true, "readRangeMetadata": true, "batchInsertAfter": true, "batchCheck": true, "batchUpdatedAnchors": true, "batchStaleContext": true, "batchWireV3": true, "batchReadProof": true }
```

The bundled Pi extension requires every capability shown above; a successful `help` command alone is not a compatibility guarantee.

## 2. Verbs

### 2.1 `read`

```
hledit read <file> [--grep <pattern>] [--context N] [--json]
```

Reads the entire file. Each line is emitted as:

```
<LN>#<HHH>:<content>
```

- `LN` — 1-indexed line number.
- `HHH` — 3-character URL-safe Base64 hash (see §3).
- `:` — literal separator.
- Content includes the original line without trailing `\n` or `\r`.
- `--grep` — substring match; only matching lines are emitted.
- `--context` — include N lines before/after each match; overlapping windows merge.
- `--json` — emit JSON `{ok, revision, totalLines, lines:[{line,anchor,text,textTruncated?}], truncated, nextOffset?}`. `revision` is `sha256:<64 lowercase hex digits>` over the exact original bytes, including UTF-8 BOM, line endings, and trailing newline.

**Truncation:** Stop at 50 KB of output or 2,000 lines, whichever is first. Append a trailing line:

```
-- truncated: use read-range --offset <next> --
```

**Binary detection:** If the file is detected as binary (contains NUL byte in first 8 KB), emit:

```json
{ "ok": false, "error": "binary", "message": "file appears to be binary" }
```

**Text encoding:** Non-binary input must be valid UTF-8. Invalid UTF-8 emits:

```json
{ "ok": false, "error": "encoding", "message": "file is not valid UTF-8" }
```

An existing UTF-8 BOM is excluded from line text and hashes, then restored on write.

### 2.2 `read-range`

```
hledit read-range <file> [--offset <N>] [--limit <M>] [--grep <pattern>] [--context N] [--json]
```

- `--offset` — 1-indexed starting line (default 1).
- `--limit` — max lines to return (default 2000).
- `--grep` — substring match; only matching lines are emitted.
- `--context` — include N lines before/after each match; overlapping windows merge.

Same output format as `read`. Same truncation behavior at 50 KB / 2,000 lines from the offset.
- `--json` — same JSON shape.

If `--offset` exceeds file length, emit:

```json
{ "ok": false, "error": "range", "message": "offset 500 exceeds file length 120", "requestedOffset": 500, "totalLines": 120 }
```

### 2.3 `anchors`

```
hledit anchors <file> [--offset <N>] [--limit <M>] [--grep <pattern>] [--context N] [--json]
```

- Same flags and filtering as `read-range`.
- Emits `ANCHOR<TAB>TEXT` instead of `LN#HHH:TEXT`.
- Same truncation behavior at 50 KB / 2,000 lines from the offset.
- `--json` — same JSON shape.

If `--offset` exceeds file length, emit:

```json
{ "ok": false, "error": "range", "message": "offset 500 exceeds file length 120", "requestedOffset": 500, "totalLines": 120 }
```

### 2.4 `replace`

```
hledit replace <file> <anchor> <content-source>
```

- `anchor` — `LN#HHH` targeting a single line.
- `content-source` — `-` for stdin, or a file path.
- Reads replacement content from the source (one or more lines).
- If content is empty, the line is **deleted**.
- If content has multiple lines, the single targeted line is replaced with all of them (net insert).

**Behavior:**

1. Validate anchor against current file.
2. If hash mismatches, return stale error (see §5).
3. Replace the line at `LN` with the new content.
4. Write atomically (temp + rename).

### 2.5 `replace-range`

```
hledit replace-range <file> <anchor> <end-anchor> <content-source>
```

- `anchor` — start `LN#HHH` (inclusive).
- `end-anchor` — end `LN#HHH` (inclusive).
- Replaces all lines from `anchor.Line` through `end-anchor.Line` with the new content.
- If content is empty, the range is **deleted**.

**Validation:**

- `anchor.Line <= end-anchor.Line`.
- Both anchors must match current file hashes.

### 2.6 `insert`

```
hledit insert [--before|--after] <file> <anchor> <content-source>
```

- `--before` (default) — insert lines before the anchored line.
- `--after` — insert lines after the anchored line.
- Anchor is used **only for validation**, not for replacement. The anchored line stays untouched.
- Content must be non-empty.

**Behavior:**

1. Validate anchor against current file.
2. Insert new lines at the specified position.
3. Write atomically.

### 2.7 `batch`

```
hledit batch [--check] <file>
```

Reads a JSON `BatchEditRequest` from stdin:
`--check` validates stdin JSON, anchors, and ops without writing; success adds `checked:true`.

```json
{
  "edits": [
    { "op": "replace", "pos": "2#rT4", "lines": ["new line"] },
    { "op": "replace", "pos": "12#aB3", "end_pos": "18#xY7", "lines": ["new block"] },
    { "op": "delete", "pos": "5#nK2" },
    { "op": "insert", "pos": "8#Qw_", "after": true, "lines": ["inserted"] }
  ],
  "proof": {
    "revision": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "anchors": ["2#rT4", "5#nK2", "8#Qw_", "12#aB3", "13#Ab1", "14#Ab2", "15#Ab3", "16#Ab4", "17#Ab5", "18#xY7"]
  }
}
```

Validation:

- All anchors are validated against the original file state before any write.
- The JSON decoder rejects unknown fields and any additional top-level JSON value; protocol typos never degrade into a different edit.
- `proof` is optional for standalone CLI use. When present, it must contain a valid raw-byte SHA-256 `revision` and unique, strictly increasing anchors.
- Proof must cover every original line consumed by each replace/delete range and the anchor line used by each insert. Missing coverage returns `error:"insufficient_read_proof"`; revision or proof-anchor changes return `error:"stale"`.
- Batch wire v3 has one canonical shape: `replace` requires `lines` (an empty array deletes the range), while `delete` must omit `lines`.
- `replace` and `delete` use optional `end_pos` as an inclusive range end; if omitted, they target only `pos`.
- `replace` and `delete` require `pos.Line <= end_pos.Line` when `end_pos` is provided.
- `replace` and `delete` reject `after`; `delete` also rejects any present `lines` field.
- `insert` requires non-empty `lines`, rejects `end_pos`, and inserts before `pos` unless `after:true` is set; a present `after` must be `true`.
- Inserts that map to the same physical boundary (including `insert_after(N)` and `insert_before(N+1)`) and any insert/replace/delete boundary overlap return `error: "invalid"`.
- Unknown operations or invalid anchors return `error: "invalid"`; stale anchors return `error: "stale"` with remaps.

Application:

- Check and apply share the same pure planner: strict request decoding, proof validation, edit-anchor validation, physical conflict detection, statistics, and one cursor-based rebuild.
- `--check` returns the loaded revision without writing. Apply prepares and syncs one temporary replacement, rechecks the target's raw-byte revision, and then performs one atomic replacement.
- A detectable change between planning and commit returns `error:"source_changed_before_commit"` with `currentRevision`; the temporary file is removed and external content is preserved.

## 3. Hash Algorithm

```
computeLineHash(lineNum, line):
  1. line = trimRight(line, '\r')
  2. line = trimRight(line, whitespace)
  3. h = FNV-1a-32()
  4. if line has NO letter AND NO digit:
       mix lineNum into h before content
  5. h.write(line)
  6. sum = h.sum32()
  7. low18 = sum & 0x3FFFF
  8. return base64url((low18 >> 12) & 0x3F) + base64url((low18 >> 6) & 0x3F) + base64url(low18 & 0x3F)
```

**URL-safe Base64 alphabet:** `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_` (index 0–63)

**Anchor grammar:** `LN#HHH` has no internal whitespace. CLI parsing additionally permits either a direct `:source-text` annotation from rendered output or trailing whitespace; the Pi tool schema accepts only the bare anchor.

**Line-number mixing** (step 4): Write the line number as a varint-style sequence of bytes (little-endian, stopping at first zero high byte) into the hash state before the line content. This ensures structurally identical non-significant lines (e.g. two blank lines, or `}` at different positions) produce different hashes.

**Detection of "significant" lines:** A line is significant if it contains at least one Unicode letter (`IsLetter`) or one Unicode digit (`IsDigit`). Blank lines, `{`, `}`, `),` etc. are non-significant.

### 3.1 Raw-byte file revision

JSON reads and batch results identify a file snapshot as `sha256:<64 lowercase hex digits>`. The digest is computed before BOM removal or newline parsing, so BOM, CRLF/LF, trailing newline, and all other byte changes produce a different revision. Revision is a conservative concurrency precondition; it does not replace line anchors.

## 4. Edit Application

### 4.1 Batch semantics

Every write invocation validates all anchors and content before writing. If any anchor is stale or any operation is invalid, nothing is written.

### 4.2 Application order

Single-edit verbs apply one operation. `batch` sorts non-overlapping edits by original-file boundary and rebuilds the output once with a forward cursor. This preserves all original anchor references without repeatedly copying the file.

### 4.3 No-op detection

After rebuilding a validated edit, compare its logical lines with the loaded lines. If they are identical, return `contentChanged:false` and do not create, sync, rename, or otherwise touch a filesystem entry. Operation counts and attempted line metadata remain available for diagnostics.

### 4.4 Atomic writes

1. Resolve an existing symlink to its real target so replacement preserves the symlink entry.
2. Reject non-regular targets and files with more than one hard link. Preserving hard-link identity would require a non-atomic in-place write.
3. Create a unique temporary sibling, preserve existing permission bits, write all content, sync, and close it.
4. For batch apply, re-read the resolved target and compare its exact raw-byte revision with the planned revision. Mismatch or read failure rejects before replacement and removes the temporary file.
5. Replace the real target with the temporary sibling. POSIX implementations rename then sync the parent directory; Windows uses `MoveFileExW` with replace-existing and write-through flags.
6. A post-rename parent-sync failure is returned as a successful write with a durability warning, never as a zero-change rejection.

The revision recheck substantially narrows the external-writer window, but a very short race remains between recheck and rename. The CLI does not claim linearizable compare-and-swap against arbitrary non-cooperating processes.

## 5. Stale Detection & Error Response

When any anchor's hash doesn't match the current file content:

```json
{
  "ok": false,
  "error": "stale",
  "remaps": [
    { "requested": "5#nK2", "current": "5#nK3" },
    { "requested": "8#Qw_", "current": "9#xY7" }
  ],
  "currentRevision": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  "currentAnchors": {
    "lines": [{ "line": 5, "anchor": "5#nK3", "text": "current line" }],
    "offset": 3, "limit": 5, "desiredLimit": 5, "truncated": false
  },
  "message": "anchor 5#nK2: expected hash nK2, got nK3"
}
```

- `remaps` helps locate the current content; `currentAnchors` is a bounded window captured from the same file snapshot that rejected the batch.
- Inspect `currentAnchors` before an explicit retry. It may supply the new anchors only when its complete window still covers the intended target and range; otherwise re-read. It must never trigger automatic retry or overwrite concurrent changes.
- The whole edit is rejected — no partial writes.
- `source_changed_before_commit` is also a confirmed zero-write rejection by this batch; it reports `currentRevision` but does not overwrite the externally changed target.

## 6. Success Response

Single writes include `contentChanged`; successful writes may also include `lastChangedLine` and `warnings`:

```json
{ "ok": true, "contentChanged": true, "firstChangedLine": 5, "lastChangedLine": 5 }
```

Batch writes include the resulting raw-byte `revision`, `contentChanged`, changed-line statistics, `editsApplied`, and a bounded `updatedAnchors` object. `--check` returns the current revision with `checked:true`, does not write, and omits `updatedAnchors`. A no-op batch returns the unchanged revision and fresh `updatedAnchors`, but does not touch the target file.

```json
{
  "ok": true,
  "revision": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  "contentChanged": true,
  "firstChangedLine": 5,
  "lastChangedLine": 5,
  "editsApplied": 1,
  "updatedAnchors": {
    "lines": [{"line":5,"anchor":"5#aB3","text":"updated"}],
    "offset": 3,
    "limit": 5,
    "desiredLimit": 5,
    "truncated": false
  }
}
```

## 7. Content Source

The `<content-source>` argument:

| Value | Meaning |
|---|---|
| `-` | Read content from stdin |
| Any other path | Read content from that file |

Content is read as-is, split by `\n`. Trailing `\n` on the last line is stripped (does not introduce an extra empty line). `\r\n` is normalized to `\n`.

For `replace` / `replace-range` with empty content, the effect is deletion.

For `insert`, content must be non-empty. Empty content returns:

```json
{ "ok": false, "error": "invalid", "message": "insert requires non-empty content" }
```

## 8. Anchor Parsing

Anchors match the regex:

```
^(\d+)#([A-Za-z0-9_-]{3})(?::.*)?\s*$
```

The parser accepts an exact `LN#HHH` anchor, with either a direct colon-delimited rendered annotation such as `5#aB3:func main() {` or trailing whitespace. It rejects whitespace inside the anchor, legacy two-character anchors, and trailing text without a colon delimiter.

Invalid anchors return:

```json
{ "ok": false, "error": "invalid", "message": "invalid anchor \"foo\": expected LN#HHH" }
```

## 9. Exit Codes

| Code | Meaning |
|---|---|
| 0 | Normal — check JSON `ok` for success vs logical error |
| 1 | Unrecoverable I/O error (file not found, permission denied, etc.) |

Exit code 1 is only for infrastructure failures. All logical errors (stale, invalid anchor, empty content) return exit 0 with `ok: false` in JSON.

## 10. File Layout

```
.
├── main.go               # Entry point and explicit check/apply dispatch
├── batch_request.go      # Strict batch wire v3 and optional proof decoding
├── batch_plan.go         # Pure proof/edit validation, conflict detection, and rebuild plan
├── batch_command.go      # Shared plan loading with separate check/apply commit paths
├── read.go               # read + read-range + anchors verbs and revision output
├── edit.go               # replace, replace-range, insert verbs
├── textfile.go           # UTF-8/BOM/newline parsing and raw-byte revision
├── hash.go               # FNV-1a line hash and Base64url anchor format
├── types.go              # Shared response types
├── anchor.go             # Anchor parsing + validation
├── write.go              # Atomic replacement and pre-commit revision recheck
├── go.mod
├── PRD.md
└── SPEC.md
```
