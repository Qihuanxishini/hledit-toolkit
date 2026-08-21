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

`read-range`, `search`, and `batch` always write one structured JSON response to stdout. They have no text, ANSI, or compatibility output mode.

- Logical command outcomes, including `stale`, `invalid`, `binary`, `encoding`, `range`, and I/O errors, exit `0` and return `{ "ok": false, ... }` on stdout.
- Invalid command-line shape exits `2` with usage on stderr.
- Failures that prevent emitting a normal response exit `1`.

## 2. Capabilities

```text
hledit capabilities
```

The response is the compatibility gate for the Pi extension:

```json
{
  "ok": true,
  "version": "3.2.0",
  "anchorProtocolV2": true,
  "readRangeMetadata": true,
  "batchInsertAfter": true,
  "batchCheck": true,
  "batchUpdatedAnchors": true,
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
  "truncated": false
}
```

`revision` hashes the original bytes before BOM removal or newline parsing. `lines` are ordered physical source lines, and every `anchor` is an exact `LN#HHH` token. `nextOffset`, when present, is the physical source-line cursor for the next page. A source line that cannot fit in an otherwise empty 50 KiB JSON page is returned with `textTruncated:true`; that line is not usable as edit proof. When a complete line does not fit in the remaining page, it is left for the next page instead of being truncated.

Offset past a non-empty file returns:

```json
{ "ok": false, "error": "range", "message": "offset 500 exceeds file length 120", "requestedOffset": 500, "totalLines": 120 }
```

### 3.2 `search`

```text
hledit search <file> <pattern> [--offset N] [--limit M] [--literal] [--context N] [--ignore-case]
```

`search` is the only search verb. `pattern` uses Go RE2 syntax by default; `--literal` treats it as a substring. `--ignore-case` enables case folding and `--context N` includes adjacent physical source lines, merging overlapping windows. `offset` is a physical source-line cursor (default `1`), not a match index; `limit` defaults to `100` and bounds returned matching/context lines.

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

`totalMatches` counts matching lines before context expansion. Zero matches return success with `totalMatches:0`, an empty `lines` array, `truncated:false`, and no `nextOffset`. Empty or invalid patterns return `error:"pattern"`. Broad whole-file expressions such as `.*`, `.+`, and their anchored or dot-all variants return `error:"broad_pattern"`; callers must use `read-range` for contiguous source.

Both read verbs reject binary files and invalid UTF-8 with structured `binary` or `encoding` errors. They cap the serialized JSON page at 50 KiB.

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
- Each anchor is exactly `LN#HHH`; annotations, whitespace, aliases, and older hash forms are rejected.
- The decoder rejects unknown fields, trailing JSON values, non-string `lines`/proof anchors, requests larger than 8 MiB, batches above 200 edits, more than 1 MiB of canonical replacement UTF-8, and more than 20,000 replacement output lines.

`proof` is optional for standalone use. When supplied, its raw-byte revision must match the loaded file and its unique, strictly ascending anchors must cover each consumed `replace`/`delete` line and every insert attachment anchor. Missing coverage returns `insufficient_read_proof`; a mismatch returns `stale`.

All edits are validated against one original snapshot before writing. Conflicting ranges, duplicate insertion boundaries, inserts inside a consumed range, invalid anchors, and stale anchors reject the entire request with zero writes. The planner orders non-conflicting edits by physical boundary and rebuilds the file once.

Success includes the resulting revision, `contentChanged`, aggregate edit statistics, one `editDeltas` entry per request edit, and—except for `--check`—a bounded `updatedAnchors` window:

```json
{
  "ok": true,
  "revision": "sha256:<64 lowercase hex digits>",
  "contentChanged": true,
  "editsApplied": 1,
  "editDeltas": [{ "oldStart": 12, "oldEnd": 12, "delta": 0 }],
  "updatedAnchors": {
    "lines": [{ "line": 12, "anchor": "12#aB3", "text": "updated" }],
    "offset": 10,
    "limit": 1,
    "desiredLimit": 1,
    "truncated": false
  }
}
```

A stale response may include `remaps`, `currentRevision`, and a bounded same-snapshot `currentAnchors` window. These are diagnostic data only: the caller must explicitly re-read and submit a new batch.

## 5. Hashes, revisions, and writes

An anchor has the exact grammar:

```text
^(\d+)#([A-Za-z0-9_-]{3})$
```

The hash is the low 18 bits of FNV-1a-32 encoded with URL-safe Base64. Its input trims trailing `\r` and whitespace. Lines with no Unicode letter or digit additionally mix their 1-indexed line number into the hash, distinguishing otherwise identical structural lines.

Raw-byte revisions use `sha256:<64 lowercase hex digits>` over the unchanged source bytes, including BOM, line-ending style, and trailing newline. Revisions are concurrency preconditions; they do not replace per-line anchor validation.

A content-changing batch resolves symlink targets, rejects non-regular and multi-hard-link files, writes a synced temporary sibling, rechecks the raw-byte revision immediately before replacement, then atomically replaces the target. A detectable external change returns `source_changed_before_commit` without overwriting it. Untouched terminators, BOM state for non-empty results, and trailing-newline state are retained; deleting all logical lines produces a truly empty file, and mixed line endings are not globally normalized. A validated no-op reports `contentChanged:false` without touching the file.

## 6. Source layout

```text
main.go               command dispatch and capability response
read.go               structured read-range and search implementation
batch_request.go      strict batch wire v3 decoding
batch_plan.go         proof/edit validation and one-pass rebuild planning
batch_command.go      check/apply command flow
anchor.go             exact anchor parsing and validation
hash.go               anchor hash calculation
textfile.go           UTF-8, BOM, line terminators, raw-byte revision
write.go              atomic replacement and revision recheck
updated_anchors.go    bounded post-edit anchor window
types.go              shared JSON response types
```
