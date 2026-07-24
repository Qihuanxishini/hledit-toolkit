package main

// ────────────────────────────────────────────────────────────────────────────
// Anchor
// ────────────────────────────────────────────────────────────────────────────

// Anchor is a validated line reference: a 1-indexed line number paired with
// the expected 3-character hash computed by computeLineHash.
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
	ContentChanged   bool     `json:"contentChanged"`
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

// AnchorContext is a bounded, annotated source window used in batch responses.
type AnchorContext struct {
	Lines        []ReadLine `json:"lines"`
	Offset       int        `json:"offset"`
	Limit        int        `json:"limit"`
	DesiredLimit int        `json:"desiredLimit"`
	Truncated    bool       `json:"truncated"`
}

// BatchEditResult is written to stdout after a successful batch edit.
// Checked is true when the batch was run with --check (validate-only, no write).
type BatchEditResult struct {
	OK               bool           `json:"ok"`
	FirstChangedLine int            `json:"firstChangedLine,omitempty"`
	LastChangedLine  int            `json:"lastChangedLine,omitempty"`
	LinesAdded       int            `json:"linesAdded"`
	LinesDeleted     int            `json:"linesDeleted"`
	EditsApplied     int            `json:"editsApplied"`
	ContentChanged   bool           `json:"contentChanged"`
	Revision         string         `json:"revision"`
	Warnings         []string       `json:"warnings,omitempty"`
	Checked          bool           `json:"checked,omitempty"`
	UpdatedAnchors   *AnchorContext `json:"updatedAnchors,omitempty"`
}

// BatchEditError is written to stdout when any anchor in the batch is stale.
type BatchEditError struct {
	OK              bool           `json:"ok"`
	Error           string         `json:"error"`
	Message         string         `json:"message"`
	Remaps          []Remap        `json:"remaps,omitempty"`
	Failed          int            `json:"failed"` // index of first failing edit
	CurrentAnchors  *AnchorContext `json:"currentAnchors,omitempty"`
	CurrentRevision string         `json:"currentRevision,omitempty"`
}

// CLICapabilities 描述插件启动前必须验证的 CLI 行为。
type CLICapabilities struct {
	OK                  bool   `json:"ok"`
	Version             string `json:"version"`
	AnchorProtocolV2    bool   `json:"anchorProtocolV2"`
	BatchInsertAfter    bool   `json:"batchInsertAfter"`
	BatchCheck          bool   `json:"batchCheck"`
	BatchUpdatedAnchors bool   `json:"batchUpdatedAnchors"`
	BatchStaleContext   bool   `json:"batchStaleContext"`
	ReadRangeMetadata   bool   `json:"readRangeMetadata"`
	BatchWireV3         bool   `json:"batchWireV3"`
	BatchReadProof      bool   `json:"batchReadProof"`
	ContentReplaceOnce  bool   `json:"contentReplaceOnce"`
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

// ReadRangeError reports a requested offset beyond the current file length.
type ReadRangeError struct {
	OK              bool   `json:"ok"`
	Error           string `json:"error"`
	Message         string `json:"message"`
	RequestedOffset int    `json:"requestedOffset"`
	TotalLines      int    `json:"totalLines"`
}

// ReadResult is written to stdout by read/read-range when --json is set.
type ReadResult struct {
	OK         bool       `json:"ok"`
	Revision   string     `json:"revision"`
	TotalLines int        `json:"totalLines"`
	Lines      []ReadLine `json:"lines"`
	Truncated  bool       `json:"truncated"`
	NextOffset int        `json:"nextOffset,omitempty"`
}
