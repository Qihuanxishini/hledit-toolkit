# hledit — Spec

## 1. Binary & Invocation

```
hledit <verb> [flags] <file> [anchor] [end-anchor] <content-source>
```

- Logical outcomes (success, stale anchors, invalid anchors/content, binary/range/io errors) exit 0 and are reported on stdout.
- CLI misuse exits 2 with usage on stderr; unrecoverable infrastructure failures exit 1.

### 1.1 `capabilities`

```
hledit capabilities
```

Outputs one JSON object describing behavior that integrations may require:

```json
{ "ok": true, "version": "1.2.5", "batchInsertAfter": true, "batchUpdatedAnchors": true }
```

The bundled Pi extension requires both `batchInsertAfter:true` and `batchUpdatedAnchors:true`; a successful `help` command alone is not a compatibility guarantee.

## 2. Verbs

### 2.1 `read`

```
hledit read <file> [--grep <pattern>] [--context N] [--json]
```

Reads the entire file. Each line is emitted as:

```
<LN>#<HH>:<content>
```

- `LN` — 1-indexed line number.
- `HH` — 2-character hash (see §3).
- `:` — literal separator.
- Content includes the original line without trailing `\n` or `\r`.
- `--grep` — substring match; only matching lines are emitted.
- `--context` — include N lines before/after each match; overlapping windows merge.
- `--json` — emit JSON `{ok, lines:[{line,anchor,text}], truncated, nextOffset}`.

**Truncation:** Stop at 50 KB of output or 2,000 lines, whichever is first. Append a trailing line:

```
-- truncated: use read-range --offset <next> --
```

**Binary detection:** If the file is detected as binary (contains NUL byte in first 8 KB), emit:

```json
{ "ok": false, "error": "binary", "message": "file appears to be binary" }
```

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
{ "ok": false, "error": "range", "message": "offset 500 exceeds file length 120" }
```

### 2.3 `anchors`

```
hledit anchors <file> [--offset <N>] [--limit <M>] [--grep <pattern>] [--context N] [--json]
```

- Same flags and filtering as `read-range`.
- Emits `ANCHOR<TAB>TEXT` instead of `LN#HH:TEXT`.
- Same truncation behavior at 50 KB / 2,000 lines from the offset.
- `--json` — same JSON shape.

If `--offset` exceeds file length, emit:

```json
{ "ok": false, "error": "range", "message": "offset 500 exceeds file length 120" }
```

### 2.4 `replace`

```
hledit replace <file> <anchor> <content-source>
```

- `anchor` — `LN#HH` targeting a single line.
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

- `anchor` — start `LN#HH` (inclusive).
- `end-anchor` — end `LN#HH` (inclusive).
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
    { "op": "replace", "pos": "12#NK", "lines": ["new line"] },
    { "op": "replace", "pos": "12#NK", "end_pos": "18#VR", "lines": ["new block"] },
    { "op": "delete", "pos": "5#TX", "lines": [] },
    { "op": "insert", "pos": "8#VR", "after": true, "lines": ["inserted"] }
  ]
}
```

Validation:

- All anchors are validated against the original file state before any write.
- `replace` and `delete` use optional `end_pos` as an inclusive range end; if omitted, they target only `pos`.
- `replace` and `delete` require `pos.Line <= end_pos.Line` when `end_pos` is provided.
- `insert` requires non-empty `lines`, rejects `end_pos`, and inserts before `pos` unless `after:true` is set.
- Duplicate inserts and any insert/replace/delete overlap return `error: "invalid"`.
- Unknown operations or invalid anchors return `error: "invalid"`; stale anchors return `error: "stale"` with remaps.

Application:

- Validated edits are sorted by their original file boundary and applied through a single cursor-based rebuild.
- The file is written once, atomically, only after the full batch validates.

## 3. Hash Algorithm

```
computeLineHash(lineNum, line):
  1. line = trimRight(line, '\r')
  2. line = trimRight(line, whitespace)
  3. if line has NO letter AND NO digit:
       mix lineNum into FNV-1a state before content
  4. h = FNV-1a-32()
  5. h.write(line)
  6. sum = h.sum32()
  7. lo = sum & 0xFF
  8. return nibble(lo >> 4) + nibble(lo & 0x0F)
```

**Nibble alphabet:** `ZPMQVRWSNKTXJBYH` (index 0–15)

**Line-number mixing** (step 3): Write the line number as a varint-style sequence of bytes (little-endian, stopping at first zero high byte) into the hash state before the line content. This ensures structurally identical non-significant lines (e.g. two blank lines, or `}` at different positions) produce different hashes.

**Detection of "significant" lines:** A line is significant if it contains at least one Unicode letter (`IsLetter`) or one Unicode digit (`IsDigit`). Blank lines, `{`, `}`, `),` etc. are non-significant.

## 4. Edit Application

### 4.1 Batch semantics

Every write invocation validates all anchors and content before writing. If any anchor is stale or any operation is invalid, nothing is written.

### 4.2 Application order

Single-edit verbs apply one operation. `batch` sorts non-overlapping edits by original-file boundary and rebuilds the output once with a forward cursor. This preserves all original anchor references without repeatedly copying the file.

### 4.3 Atomic writes

1. Write new content to `<file>.hledit.tmp`.
2. `os.Rename` the temp file over the original.
3. If the process dies mid-write, the original file is intact (rename is atomic on POSIX).

## 5. Stale Detection & Error Response

When any anchor's hash doesn't match the current file content:

```json
{
  "ok": false,
  "error": "stale",
  "remaps": [
    { "requested": "5#TX", "current": "5#NK" },
    { "requested": "8#QR", "current": "9#VR" }
  ],
  "message": "anchor 5#TX: expected hash TX, got NK"
}
```

- `remaps` helps locate the current content for a required re-read.
- Call the read operation again and inspect the current file before retrying; do not automatically reuse remapped anchors.
- The whole edit is rejected — no partial writes.

## 6. Success Response

Single writes may include `lastChangedLine`:

```json
{ "ok": true, "firstChangedLine": 5, "lastChangedLine": 5 }
```

Batch writes include `firstChangedLine`, `lastChangedLine`, `editsApplied`, and a bounded `updatedAnchors` object. `--check` adds `checked:true`, does not write, and omits `updatedAnchors`.

```json
{
  "ok": true,
  "firstChangedLine": 5,
  "lastChangedLine": 5,
  "editsApplied": 1,
  "updatedAnchors": {
    "lines": [{"line":5,"anchor":"5#AB","text":"updated"}],
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
^\s*(\d+)\s*#\s*([ZPMQVRWSNKTXJBYH]{2})
```

Lenient: tolerates surrounding whitespace. If a model copy-pastes a full annotated line like `5#TX:func main() {`, the parser extracts `5#TX` and ignores the rest.

Invalid anchors return:

```json
{ "ok": false, "error": "invalid", "message": "invalid anchor \"foo\": expected LN#HH" }
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
├── main.go          # Entry point, CLI dispatch
├── read.go          # read + read-range + anchors verbs
├── edit.go          # replace, replace-range, insert verbs
├── hash.go          # FNV-1a hash, nibble alphabet, formatTag
├── types.go         # Anchor, EditResult, EditError, response types
├── anchor.go        # Anchor parsing + validation
├── write.go         # Atomic write logic (temp + rename)
├── go.mod
├── PRD.md
└── SPEC.md
```
