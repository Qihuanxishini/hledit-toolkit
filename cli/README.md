# hledit

`hledit` is a small hash-anchored editor for coding agents. It has one structured protocol: read contiguous source with `read-range`, find locations with `search`, and submit all changes for a file in one atomic `batch`.

Every source row contains a stable `LN#HHH` anchor. A batch validates its anchors and optional snapshot proof against one original file state before it can write. Stale or incomplete requests are rejected without partial changes.

## Install and develop

```bash
go install github.com/Qihuanxishini/hledit-toolkit/cli@latest
# or, from this directory:
make build
```

Requirements: Go 1.21+.

```bash
go test ./...
go vet ./...
make check
```

## Commands

```text
hledit capabilities
hledit version
hledit help
hledit read-range <file> [--offset N] [--limit M]
hledit search <file> <pattern> [--offset N] [--limit M] [--literal] [--context N] [--ignore-case]
hledit batch [--check] <file>
```

`read-range`, `search`, and `batch` are JSON-only. There are no unstructured read, single-edit, ANSI, or compatibility command paths.

### Read a contiguous window

```bash
hledit read-range main.go --offset 40 --limit 20
```

```json
{
  "ok": true,
  "revision": "sha256:<digest>",
  "totalLines": 120,
  "lines": [{"line":40,"anchor":"40#aB3","text":"package main"}],
  "truncated": false
}
```

The `nextOffset` field appears when another page is needed. A `textTruncated:true` row is too long for an empty 50 KiB JSON page and must not be used as edit proof.

### Search anchors

```bash
hledit search main.go 'func\\s+main' --context 2
hledit search main.go 'fmt.Println' --literal --ignore-case
```

The required pattern uses Go RE2 syntax unless `--literal` is given. Search pagination uses a physical source-line cursor, so a returned `nextOffset` can be passed directly as `--offset`. `totalMatches` counts matches before context expansion. Empty patterns and whole-file patterns such as `.*` are rejected; use `read-range` to read source contiguously.

### Apply an atomic batch

`batch` reads one strict JSON document from stdin:

```bash
cat <<'JSON' | hledit batch main.go
{
  "edits": [
    {"op":"replace","pos":"12#aB3","lines":["new line"]},
    {"op":"insert","pos":"22#Qw_","after":true,"lines":["// inserted"]}
  ],
  "proof": {
    "revision":"sha256:<digest>",
    "anchors":["12#aB3","22#Qw_"]
  }
}
JSON
```

Use `batch --check main.go` with the same request to validate without writing. Batch wire v3 is exact:

- `replace` requires a `lines` array; an empty array deletes its target range.
- `delete` omits `lines`.
- `insert` requires non-empty `lines`; only `insert` may use `"after": true`.
- `end_pos`, when present on `replace` or `delete`, is an inclusive range end.
- All anchors are exact `LN#HHH` tokens; annotations and whitespace are rejected.

The optional proof is required by the Pi extension. Its revision and strictly increasing anchors must cover every consumed range line and each insert attachment anchor. Missing proof is `insufficient_read_proof`; an older snapshot is `stale`.

## Output and safety

A successful batch includes `revision`, `contentChanged`, edit counts, `editDeltas`, and a bounded `updatedAnchors` window. `--check` adds `checked:true` and never writes. A no-op reports `contentChanged:false` without changing the target.

Logical failures return JSON on stdout with exit code `0`; malformed command-line usage exits `2`. Read paths reject binary or invalid UTF-8 files. Revisions hash original bytes, including BOM, line endings, and trailing newline. Writes preserve untouched terminators and BOM state, use a temporary sibling plus atomic replacement, and recheck the original revision immediately before commit.

## Pi extension

[`../pi-hledit-diff`](../pi-hledit-diff/) bundles this CLI and exposes `hledit_read_anchors`, `hledit_search_anchors`, and `hledit_apply_file_changes`. It requires CLI 3.x with all capabilities in [`SPEC.md`](./SPEC.md), including `searchIgnoreCase`, `searchRegex`, `searchLiteral`, and `search`; `contentReplaceOnce` must be absent.

## Further reference

- [`SPEC.md`](./SPEC.md) — complete machine protocol
- [`CHANGELOG.md`](./CHANGELOG.md) — version history
