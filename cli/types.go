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

// CommandError is the shared logical-error envelope for every CLI verb.
type CommandError struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message"`
}

// AnchorContext is a bounded, annotated source window used in batch responses.
type AnchorContext struct {
	Lines        []ReadLine `json:"lines"`
	Offset       int        `json:"offset"`
	Limit        int        `json:"limit"`
	DesiredLimit int        `json:"desiredLimit"`
	Truncated    bool       `json:"truncated"`
}

// EditDelta 描述一项编辑在原始行坐标系中的消费区间与行数变化。
// 空消费区间（OldEnd == OldStart-1，纯插入）与非空区间共用同一平移规则：
// 原始行 L 落在 [OldStart, OldEnd] 内表示已被消费；L > OldEnd 时行号累加 Delta。
type EditDelta struct {
	OldStart int `json:"oldStart"`
	OldEnd   int `json:"oldEnd"`
	Delta    int `json:"delta"`
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
	EditDeltas       []EditDelta    `json:"editDeltas"`
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

// CLICapabilities describes the strict protocol required by the Pi extension.
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
	BatchEditDeltas     bool   `json:"batchEditDeltas"`
	SearchIgnoreCase    bool   `json:"searchIgnoreCase"`
	SearchRegex         bool   `json:"searchRegex"`
	SearchLiteral       bool   `json:"searchLiteral"`
	Search              bool   `json:"search"`
}

// ────────────────────────────────────────────────────────────────────────────
// Structured read/search results
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

// SearchResult is written by the dedicated search verb. NextOffset remains a
// physical line cursor so callers can continue without carrying match indexes.
type SearchResult struct {
	OK           bool       `json:"ok"`
	Revision     string     `json:"revision"`
	TotalLines   int        `json:"totalLines"`
	TotalMatches int        `json:"totalMatches"`
	Lines        []ReadLine `json:"lines"`
	Truncated    bool       `json:"truncated"`
	NextOffset   int        `json:"nextOffset,omitempty"`
}

// ReadResult is written by the contiguous read-range verb.
type ReadResult struct {
	OK         bool       `json:"ok"`
	Revision   string     `json:"revision"`
	TotalLines int        `json:"totalLines"`
	Lines      []ReadLine `json:"lines"`
	Truncated  bool       `json:"truncated"`
	NextOffset int        `json:"nextOffset,omitempty"`
}
