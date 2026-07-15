# Changelog

## [1.2.5] — 2026-07-15

### Added

- Add `batchUpdatedAnchors:true` capability.
- Return a bounded `updatedAnchors` window after successful non-check batch writes.

### Changed

- Rebuild validated batch edits once with a forward cursor instead of repeatedly copying the file for every edit.
- Bound updated-anchor output to 20 lines and approximately 4096 bytes.

## [1.2.4] — 2026-07-07

### Changed

- Report `linesAdded` and `linesDeleted` metadata on successful edit and batch operations.

## [1.2.3] — 2026-07-07

### Changed

- Highlight braces, brackets, parentheses, and double-quoted strings in `--pretty` output.

## [1.2.2] — 2026-07-07

### Changed

- Use an ASCII pipe divider in `--pretty` output for safer terminal rendering.

## [1.2.1] — 2026-07-07

### Changed

- Improve `--pretty` readability by separating anchors from content with a tabbed vertical divider.

## [1.2.0] — 2026-07-01

### Added

- Add `--pretty` ANSI-styled human output for `read`, `read-range`, and `anchors` while keeping default and JSON output unchanged.

## [1.1.2] — 2026-07-01

### Changed

- Track README demo assets so the linked cast/script/gif live in repo.

## [1.1.1] — 2026-07-01

### Changed

- Add README requirements, development, failure-mode, and agent-family guidance.
- Add Unicode JSON and complex Markdown golden fixtures for UTF-8 and larger-doc coverage.
## [1.1.0] — 2026-06-29

### Changed

- Add read/read-range `--grep` substring filtering and `--context` surrounding-line windows.
- Add `--json` on `read` / `read-range` with structured output.
- Add `anchors` command with `ANCHOR<TAB>TEXT` output and read-shaped JSON.
- Add `batch --check` validate-only mode and batch `lastChangedLine` / `checked` metadata.

## [1.0.3] — 2026-06-28

### Fixed

- Honor `end_pos` in batch `replace`/`delete` operations.
- Report the minimum `firstChangedLine` across batch edits.
- Reject binary files consistently in write paths.
- Treat dash-prefixed positional values such as `-prefix` as positionals unless they are known flags.
- Reject invalid batch ranges and empty batch inserts before writing.

### Changed

- Document batch JSON range semantics and update the public CLI version.

### Changed

- Restore the original content-source contract: use `-` for stdin or pass a file path; a literal empty argument (`""`) is not treated as replacement content.
- Improve I/O error messages so failures identify whether the file argument or content-source argument caused the error and show the empty-stdin deletion form.

## [1.0.1] — 2026-06-22

### Fixed

- Treat an empty CLI content-source argument (`""`) as empty replacement content, so `hledit replace <file> <anchor> ""` deletes the anchored line instead of trying to open an empty file path.

## [1.0.0] — 2026-06-22

### Changed

- Promote `hledit` CLI to stable 1.0.0 release.
- Align public CLI version with the first stable `pi-hledit` package release.

## [0.1.1] — 2026-06-21

### Changed

- **Pi extension: single `hledit` tool** — collapsed 5 separate tools (hledit_read, hledit_replace, hledit_replace_range, hledit_insert, hledit_batch) into one unified `hledit` tool with `op` parameter (read/edit/batch). Reduces token overhead and simplifies model usage.
- **Enriched error messages** — pi tool errors now include remediation hints with correct JSON format examples, valid op names, and anchor format guidance. Model can self-correct instead of guessing.
- **Batch edit input format** — simplified to JSON string with `anchor`/`end_anchor`/`lines` fields (consistent with single-edit param names).

## [0.1.0] — 2026-06-21

### Added

- `hledit` — hash-anchored line editor CLI for AI coding agents
- `read` / `read-range` — paginated file reading with LN#HASH anchors
- `replace` / `replace-range` / `insert` — stale-safe edit operations
- `batch` — multi-edit atomic operations (validates all anchors, applies bottom-up, single write)
- `--grep` flag — filter lines by substring match for token-efficient targeted reads
- `--version` / `version` — print version and exit
- Atomic writes (temp file + rename) with original file permission preservation
- Trailing newline preservation across all edit operations
- `pi-hledit` pi coding agent extension
- 22 golden integration tests covering all operations and edge cases
- Comprehensive unit test suite
- CHANGELOG.md, LICENSE (MIT), Makefile, ROADMAP.md
