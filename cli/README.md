# hledit

`hledit` is a small hash-anchored editor for coding agents. It has one structured protocol: read contiguous source with `read-range`, find locations with `search`, and submit all changes for a file in one atomic `batch`.

Every source row contains a stable `LN#HHH` anchor. A batch validates its anchors and optional snapshot proof against one original file state before it can write. Stale or incomplete requests are rejected without partial changes.

## Install and develop

From this directory:

```bash
cargo install --path . --locked
# or build locally:
make build
make check
```

The toolchain is pinned in `rust-toolchain.toml` and dependencies in `Cargo.lock`. Windows metadata preservation uses `windows-sys`. Read-only commands borrow lines from a single UTF-8 buffer; batch sorting and file reconstruction each run once.

Build or verify the bundled Windows x64 CLI from the repository root:

```powershell
pwsh -NoProfile -File cli/build-bundle.ps1
pwsh -NoProfile -File cli/build-bundle.ps1 -VerifyOnly
```

The bundle uses a static CRT and includes dependency licenses plus a source/artifact fingerprint. Fingerprints detect stale artifacts; they are not a reproducible-build or authenticity proof. CI validates both the tracked and rebuilt binaries against the plugin contract.

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

The required pattern uses RE2-compatible syntax unless `--literal` is given. Perl character classes and word boundaries remain ASCII; Unicode categories and case folding use Unicode 15.0. Search pagination uses a physical source-line cursor, so a returned `nextOffset` can be passed directly as `--offset`. `totalMatches` counts matches before context expansion and is included in the final JSON budget. Empty patterns and whole-file patterns such as `.*` are rejected; use `read-range` to read source contiguously.

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

A successful batch includes `revision`, `contentChanged`, edit counts, `editDeltas`, and `updatedAnchorSpans`: one bounded span per edit that produced lines, covering exactly its produced range. `--check` adds `checked:true` and never writes. A no-op reports `contentChanged:false` without changing the target.

Confirmed zero-write failures return JSON on stdout with exit code `0`; malformed command-line usage exits `2`. Unknown write outcomes exit `1` with recovery diagnostics on stderr and must not be retried without inspection. Read paths reject binary or invalid UTF-8 files, and replacement line-array elements reject NUL and embedded LF. Revisions hash original bytes, including BOM, line endings, and trailing newline. Writes preserve logical text, existing BOM metadata, and local terminators; a final blank line gains a terminator when needed to exist physically. Windows replacements preserve DACLs and alternate streams, restore the original without overwriting after a partial failure, and retain recovery files when that is impossible. See [SPEC.md](./SPEC.md#5-hashes-revisions-and-writes) for the full encoding and failure contract.

## Pi extension

[`../pi-hledit-diff`](../pi-hledit-diff/) bundles this CLI and exposes `hledit_read_anchors`, `hledit_search_anchors`, and `hledit_apply_file_changes`. It requires CLI 3.x with all capabilities in [`SPEC.md`](./SPEC.md), including `searchIgnoreCase`, `searchRegex`, `searchLiteral`, and `search`; `contentReplaceOnce` must be absent.

## Further reference

- [`SPEC.md`](./SPEC.md) — complete machine protocol
- [`CHANGELOG.md`](./CHANGELOG.md) — version history
