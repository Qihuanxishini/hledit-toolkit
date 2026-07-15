# hledit — PRD

## What

A minimal CLI tool that lets AI coding agents read and edit files using hash-anchored line references instead of text matching.

## Why

LLM agents that edit by reproducing old text fail silently on whitespace mismatches, duplicate lines, and stale files. Hash anchors solve this: the agent references `5#TX` instead of retyping line 5's content. If the file changed, the hash won't match and the edit is rejected cleanly.

## Core Operations

| Verb | What | Example |
|---|---|---|
| `read` | Print file with `LN#HASH:` prefixes | `hledit read main.go` |
| `read-range` | Paginated read | `hledit read-range main.go --offset 10 --limit 50` |
| `replace` | Replace one line by anchor | `hledit replace main.go 5#TX -` |
| `replace-range` | Replace line range by start/end anchors | `hledit replace-range main.go 5#TX 8#NK -` |
| `insert` | Insert lines before or after an anchor | `hledit insert --after main.go 5#TX -` |

Delete is `replace`/`replace-range` with empty content.

## CLI Contract

```
hledit <verb> <file> <anchor> [end-anchor] <content-source>
```

- **content-source**: `-` for stdin, or a file path. Only for write verbs.
- **anchor format**: `LN#HH` — line number + `#` + 2-char hash from custom alphabet.
- **output**: read verbs → annotated text to stdout; write verbs → JSON result to stdout.

## Design Decisions

1. **FNV-1a 32-bit → 2-char hash** — fast, stdlib-only, no cgo. Custom alphabet (`ZPMQVRWSNKTXJBYH`) avoids overlap with digits/hex for unambiguous parsing.
2. **Line-number mixing for non-significant lines** — blank lines and structural lines (`{`, `}`) bake in the line number so identical lines at different positions get different hashes. (Cognitive guardrail for the model, not a correctness requirement.)
3. **Stdin for content via `-`** — no shell escaping issues, no temp file ambiguity. Heredocs work naturally: `hledit replace main.go 5#TX - <<EOF`
4. **Atomic writes** — write to temp file, then rename. Never leave a partially-written file.
5. **Batch edits** — validate against one original state, then rebuild the file once from sorted non-overlapping boundaries.
6. **Stale detection** — if any anchor doesn't match current content, reject the whole batch and return current-anchor hints so the agent can locate and re-read the affected range.

## Not In Scope

- ast-grep / tree-sitter block operations
- Ripgrep integration
- Multi-file edits
- Syntax validation after writes
