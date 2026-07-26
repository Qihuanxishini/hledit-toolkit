# Changelog

## [Unreleased]

### Fixed

- Recheck the target's raw-byte revision before standalone `replace`, `replace-range`, and `insert` commits so a detected external change is rejected with `source_changed_before_commit` instead of being overwritten.

## [2.3.1] — 2026-07-25

### Changed

- Build the final file bytes exactly once per write: batch, replace-once, and single-edit verbs encode BOM, line text, and per-line terminators into one precisely sized buffer that both the revision hash and the atomic write consume. Cumulative allocations for a 10 MiB edit drop from ~42 MB to ~10.6 MB.
- The pre-commit revision recheck streams the target through SHA-256 instead of reading the whole file into memory (~33 KB instead of ~10.5 MB per recheck on a 10 MiB target). Error mapping and commit ordering are unchanged.

## [2.3.0] — 2026-07-25

### Changed

- Preserve line terminators per line: untouched source lines keep their exact terminator bytes, so mixed CRLF/LF files are no longer normalized to a single dominant ending on write. New lines from an edit use the local terminator style near the edit; the last replacement line inherits the terminator of the last replaced line; appending after an unterminated last line terminates that line locally while the new last line stays unterminated. Trailing-newline presence and the UTF-8 BOM are preserved. Applies to single edits, batch, and replace-once.
- A lone `\r` at the end of an unterminated last line is now preserved as line text instead of being stripped.

### Removed

- The mixed line ending normalization warning: whole-file normalization no longer happens, so the warning contract is gone.

## [2.2.2] — 2026-07-25

### Added

- Return an explicit warning on every successful write that normalized a mixed-EOL file: rebuilding the whole file with the dominant CRLF ending is documented behavior, but it is no longer silent. Applies to single edits, batch, and replace-once.

## [2.2.1] — 2026-07-25

### Fixed

- Remove the pre-write sweep of stale `.hledit-*` files introduced in 2.2.0. A name prefix plus age cannot prove that this tool created a file, so the sweep could delete an unrelated `.hledit-*` file — or the edit target itself when its own name starts with `.hledit-` — and then report `source_changed_before_commit` as if nothing had been written. Abandoned temporary files from killed processes are now left in place.

## [2.2.0] — 2026-07-25

### Added

- Return `editDeltas` in successful batch and replace-once responses: per-edit consumed line ranges and line-count deltas in original-file coordinates, enabling callers to remap read evidence for unchanged lines without rereading. Advertise `batchEditDeltas:true`.
- Add `--ignore-case` to `read`, `read-range`, and `anchors` for case-insensitive grep matching. Advertise `readIgnoreCase:true`.
- Sweep abandoned `.hledit-*` temporary files older than one hour from the write target's directory before each atomic write, cleaning up residue from killed or timed-out processes.

### Changed

- Allow deterministic inserts at the leading and trailing physical boundaries of a replace/delete range: an insert whose boundary equals the range's leading edge is emitted before the range output, and one at the trailing edge after it. Only inserts mapping to an interior boundary of a consumed range are still rejected as overlapping.
- Unify rebuild, statistics, and delta ordering on physical boundaries with insert-before-range tie-breaking, so reported change windows always match the rebuilt output.

## [2.1.0] — 2026-07-24

### Added

- Add `hledit replace-once <file>` for strict JSON stdin requests that atomically replace one unique exact contiguous line block.
- Advertise `contentReplaceOnce:true`; successful replacements return revision-bearing `BatchEditResult` metadata and bounded `updatedAnchors`.
- Return `content_not_found` for zero exact matches and `content_ambiguous` with up to 20 candidate line ranges for multiple matches; both paths write nothing.

### Fixed

- Build post-edit anchor windows from the actual local offset instead of incorrectly annotating lines from the start of files changed near the end.


## [2.0.0] — 2026-07-21

### Changed

- Breaking anchor protocol: replace `LN#HH` with `LN#HHH`, a 3-character URL-safe Base64 encoding of the low 18 bits of FNV-1a-32. Legacy two-character anchors are rejected.
- Require `anchorProtocolV2:true` so integrations reject a partially upgraded or older CLI before parsing anchors.
- Accept annotated anchors only with a colon delimiter, preventing trailing text from silently being ignored.
- Require stale-snapshot callers to confirm that the bounded window still covers the intended target and complete range; otherwise they must re-read.
## [1.5.0] — 2026-07-21

### Added

- Return bounded `currentAnchors` captured from the same file snapshot that rejects a stale batch, and advertise `batchStaleContext:true` for strict integrations.
- Keep stale recovery explicit: the CLI returns recovery context but never retries or writes after a stale rejection.

## [1.4.0] — 2026-07-19

### Added

- Reject invalid UTF-8 input before reading or editing, and preserve an existing UTF-8 BOM across writes.
- Reject unknown fields and trailing JSON values in batch requests instead of silently accepting misspelled protocol fields.
- Advertise `batchCheck:true` so integrations can require validate-only batch support before relying on `batch --check`.

### Changed

- Remove unused validation and pass-through helpers so anchor validation and JSON emission each have one production path.

## [1.3.0] — 2026-07-19

### Added

- Report `contentChanged` for successful edits and skip filesystem writes when validated replacement content is unchanged.
- Return model-visible warnings when content was replaced but parent-directory durability synchronization failed.

### Changed

- Resolve symlink targets before atomic replacement so edits preserve the symlink itself.
- Use unique temporary siblings, preserve existing permission bits, and synchronize replacement metadata.
- Reject files with multiple hard links rather than silently breaking link identity or weakening atomicity.

## [1.2.6] — 2026-07-18

### Added

- Add `readRangeMetadata:true` capability for structured read consumers.
- Include `totalLines` in successful JSON reads and explicit `requestedOffset` / `totalLines` metadata in range errors.

### Fixed

- Report the actual returned line count in byte-truncated `updatedAnchors` contexts.
- Preserve a truly empty file when an edit deletes every logical line from a file with a trailing newline.
- Avoid emitting a grep `nextOffset` past EOF when the last match exactly fills the JSON byte budget.

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
