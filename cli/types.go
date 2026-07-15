package main

import (
	"encoding/json"
	"io"
	"os"
)

// ────────────────────────────────────────────────────────────────────────────
// Anchor
// ────────────────────────────────────────────────────────────────────────────

// Anchor is a validated line reference: a 1-indexed line number paired with
// the expected 2-character hash computed by computeLineHash.
type Anchor struct {
	Line int
	Hash string
}

// ────────────────────────────────────────────────────────────────────────────
// Result / error types (JSON output)
// ────────────────────────────────────────────────────────────────────────────

// Remap maps a stale requested anchor to its current correct anchor.
type Remap struct {
	Requested string `json:"requested"`
	Current   string `json:"current"`
}

// EditResult is written to stdout after a successful edit.
type EditResult struct {
	OK               bool     `json:"ok"`
	FirstChangedLine int      `json:"firstChangedLine,omitempty"`
	LastChangedLine  int      `json:"lastChangedLine,omitempty"`
	LinesAdded       int      `json:"linesAdded"`
	LinesDeleted     int      `json:"linesDeleted"`
	Warnings         []string `json:"warnings,omitempty"`
}

// EditError is written to stdout when validation fails (stale anchor, invalid
// anchor, empty content, etc.). Always paired with exit code 0.
type EditError struct {
	OK      bool    `json:"ok"`
	Error   string  `json:"error"`
	Message string  `json:"message"`
	Remaps  []Remap `json:"remaps,omitempty"`
}

// ────────────────────────────────────────────────────────────────────────────
// Batch edit types
// ────────────────────────────────────────────────────────────────────────────

// BatchEditOp is a single operation within a batch edit request.
type BatchEditOp struct {
	OP     string   `json:"op"`              // "insert", "replace", or "delete"
	Pos    string   `json:"pos"`             // start anchor (e.g. "5#TX")
	EndPos string   `json:"end_pos"`         // end anchor for replace_range (optional)
	After  bool     `json:"after,omitempty"` // insert after Pos when true
	Lines  []string `json:"lines"`           // replacement/inserted lines; empty = delete
}

// BatchEditRequest is the top-level JSON document accepted by hledit batch.
type BatchEditRequest struct {
	Edits []BatchEditOp `json:"edits"`
}

// UpdatedAnchorContext 是一次成功写入后返回给调用方的受限新锚点窗口。
type UpdatedAnchorContext struct {
	Lines        []ReadLine `json:"lines"`
	Offset       int        `json:"offset"`
	Limit        int        `json:"limit"`
	DesiredLimit int        `json:"desiredLimit"`
	Truncated    bool       `json:"truncated"`
}

// BatchEditResult is written to stdout after a successful batch edit.
// Checked is true when the batch was run with --check (validate-only, no write).
type BatchEditResult struct {
	OK               bool                  `json:"ok"`
	FirstChangedLine int                   `json:"firstChangedLine,omitempty"`
	LastChangedLine  int                   `json:"lastChangedLine,omitempty"`
	LinesAdded       int                   `json:"linesAdded"`
	LinesDeleted     int                   `json:"linesDeleted"`
	EditsApplied     int                   `json:"editsApplied"`
	Checked          bool                  `json:"checked,omitempty"`
	UpdatedAnchors   *UpdatedAnchorContext `json:"updatedAnchors,omitempty"`
}

// BatchEditError is written to stdout when any anchor in the batch is stale.
type BatchEditError struct {
	OK      bool    `json:"ok"`
	Error   string  `json:"error"`
	Message string  `json:"message"`
	Remaps  []Remap `json:"remaps,omitempty"`
	Failed  int     `json:"failed"` // index of first failing edit
}

// CLICapabilities 描述插件启动前必须验证的 CLI 行为。
type CLICapabilities struct {
	OK                  bool   `json:"ok"`
	Version             string `json:"version"`
	BatchInsertAfter    bool   `json:"batchInsertAfter"`
	BatchUpdatedAnchors bool   `json:"batchUpdatedAnchors"`
}

// ────────────────────────────────────────────────────────────────────────────
// Read result types (JSON output for --json flag)
// ────────────────────────────────────────────────────────────────────────────

// ReadLine is a single annotated line in a JSON read result.
type ReadLine struct {
	Line          int    `json:"line"`
	Anchor        string `json:"anchor"`
	Text          string `json:"text"`
	TextTruncated bool   `json:"textTruncated,omitempty"`
}

// ReadResult is written to stdout by read/read-range when --json is set.
type ReadResult struct {
	OK         bool       `json:"ok"`
	Lines      []ReadLine `json:"lines"`
	Truncated  bool       `json:"truncated"`
	NextOffset int        `json:"nextOffset,omitempty"`
}

// ────────────────────────────────────────────────────────────────────────────
// Batch edit types
// ────────────────────────────────────────────────────────────────────────────

// parseBatchRequest unmarshals a BatchEditRequest from stdin.
func parseBatchRequest() (BatchEditRequest, error) {
	var req BatchEditRequest
	data, err := readStdin()
	if err != nil {
		return req, err
	}
	err = json.Unmarshal(data, &req)
	return req, err
}

func readStdin() ([]byte, error) {
	return io.ReadAll(os.Stdin)
}
