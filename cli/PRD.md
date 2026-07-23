# hledit — PRD

## What

A minimal CLI tool that lets AI coding agents read and edit files using hash-anchored line references instead of text matching.

## Why

LLM agents that edit by reproducing old text fail silently on whitespace mismatches, duplicate lines, and stale files. Hash anchors solve this: the agent references `5#aB3` instead of retyping line 5's content. If the file changed, the hash won't match and the edit is rejected cleanly.

## Core Operations

| Verb | What | Example |
|---|---|---|
| `read` | Print file with `LN#HASH:` prefixes | `hledit read main.go` |
| `read-range` | Paginated read | `hledit read-range main.go --offset 10 --limit 50` |
| `replace` | Replace one line by anchor | `hledit replace main.go 5#aB3 -` |
| `replace-range` | Replace line range by start/end anchors | `hledit replace-range main.go 5#aB3 8#xY7 -` |
| `insert` | Insert lines before or after an anchor | `hledit insert --after main.go 5#aB3 -` |
| `batch` | Validate and atomically apply multiple edits; optional read proof covers every consumed source line | `hledit batch main.go` |

Delete is `replace`/`replace-range` with empty content.

## CLI Contract

```
hledit <verb> <file> <anchor> [end-anchor] <content-source>
```

- **content-source**: `-` for stdin, or a file path. Only for write verbs.
- **anchor format**: `LN#HHH` — line number + `#` + 3-character URL-safe Base64 hash.
- **output**: read verbs → annotated text to stdout; write verbs → JSON result to stdout.

## Design Decisions

1. **FNV-1a 32-bit → 3-character hash** — fast, stdlib-only, no cgo. Encoding the low 18 bits with URL-safe Base64 expands the content check from 256 to 262,144 values for one additional character.
2. **Line-number mixing for non-significant lines** — blank lines and structural lines (`{`, `}`) bake in the line number so identical lines at different positions get different hashes. (Cognitive guardrail for the model, not a correctness requirement.)
3. **Stdin for content via `-`** — no shell escaping issues, no temp file ambiguity. Heredocs work naturally: `hledit replace main.go 5#aB3 - <<EOF`
4. **Atomic writes** — write to temp file, then rename. Never leave a partially-written file.
5. **Batch edits** — validate against one original state, then rebuild the file once from sorted non-overlapping boundaries.
6. **Stale detection** — if any anchor doesn't match current content, reject the whole batch and return current-anchor hints so the agent can locate and re-read the affected range.
7. **Raw-byte revision + read proof** — JSON reads expose a SHA-256 revision; optional batch proof binds that revision to every source line consumed by the request, detecting interior changes that stable endpoint anchors alone would miss.
8. **Pre-commit revision recheck** — after preparing and syncing the temporary replacement, batch apply re-reads the target and rejects detectable source changes before rename. A very short race remains between this check and the platform replacement call; this is not a linearizable CAS guarantee.

## Not In Scope

- ast-grep / tree-sitter block operations
- Ripgrep integration
- Multi-file edits
- Syntax validation after writes
