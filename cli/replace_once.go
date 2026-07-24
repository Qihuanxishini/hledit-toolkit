package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
)

const maxContentMatchCandidates = 20

type ReplaceOnceRequest struct {
	OldLines []string `json:"old_lines"`
	NewLines []string `json:"new_lines"`
}

type ContentMatchCandidate struct {
	StartLine int `json:"startLine"`
	EndLine   int `json:"endLine"`
}

type ContentReplaceOnceError struct {
	OK                  bool                    `json:"ok"`
	Error               string                  `json:"error"`
	Message             string                  `json:"message"`
	CurrentRevision     string                  `json:"currentRevision,omitempty"`
	MatchCount          int                     `json:"matchCount,omitempty"`
	Candidates          []ContentMatchCandidate `json:"candidates,omitempty"`
	CandidatesTruncated bool                    `json:"candidatesTruncated,omitempty"`
}

func parseReplaceOnceRequest() (ReplaceOnceRequest, error) {
	var request ReplaceOnceRequest
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		return request, err
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return request, err
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return request, errors.New("replace-once request must contain exactly one JSON object")
		}
		return request, err
	}
	if len(request.OldLines) == 0 {
		return request, errors.New("old_lines must contain at least one line")
	}
	if len(request.NewLines) == 0 {
		return request, errors.New("new_lines must contain at least one line; use a dedicated delete operation to remove content")
	}
	return request, nil
}

func contiguousLineMatches(lines, needle []string) []int {
	if len(needle) == 0 || len(needle) > len(lines) {
		return nil
	}

	matches := make([]int, 0)
	for start := 0; start <= len(lines)-len(needle); start++ {
		if slices.Equal(lines[start:start+len(needle)], needle) {
			matches = append(matches, start)
		}
	}
	return matches
}

func contentMatchCandidates(matches []int, oldLineCount int) ([]ContentMatchCandidate, bool) {
	limit := min(len(matches), maxContentMatchCandidates)
	candidates := make([]ContentMatchCandidate, 0, limit)
	for _, start := range matches[:limit] {
		candidates = append(candidates, ContentMatchCandidate{
			StartLine: start + 1,
			EndLine:   start + oldLineCount,
		})
	}
	return candidates, len(matches) > limit
}

func emitContentReplaceOnceError(
	code, message, revision string,
	matches []int,
	oldLineCount int,
) error {
	result := ContentReplaceOnceError{
		OK:              false,
		Error:           code,
		Message:         message,
		CurrentRevision: revision,
	}
	if len(matches) > 0 {
		result.MatchCount = len(matches)
		result.Candidates, result.CandidatesTruncated = contentMatchCandidates(matches, oldLineCount)
	}
	return emitJSON(result)
}

// cmdReplaceOnce uses exact current content as its write precondition instead of a prior anchor read.
func cmdReplaceOnce(path string) error {
	request, err := parseReplaceOnceRequest()
	if err != nil {
		return emitContentReplaceOnceError("invalid", err.Error(), "", nil, 0)
	}

	file, err := loadEditableFile(path)
	if err != nil {
		return nil
	}

	matches := contiguousLineMatches(file.Lines, request.OldLines)
	if len(matches) == 0 {
		return emitContentReplaceOnceError(
			"content_not_found",
			"old_lines did not match any contiguous block in the current file",
			file.Revision,
			nil,
			len(request.OldLines),
		)
	}
	if len(matches) > 1 {
		return emitContentReplaceOnceError(
			"content_ambiguous",
			fmt.Sprintf("old_lines matched %d contiguous blocks in the current file", len(matches)),
			file.Revision,
			matches,
			len(request.OldLines),
		)
	}

	start := matches[0]
	end := start + len(request.OldLines)
	resultLines := append([]string{}, file.Lines[:start]...)
	resultLines = append(resultLines, request.NewLines...)
	resultLines = append(resultLines, file.Lines[end:]...)

	firstChanged := start + 1
	lastChanged := end
	contentChanged := !slices.Equal(file.Lines, resultLines)
	revision := file.Revision
	if contentChanged {
		joined := file.JoinLines(resultLines)
		revision = rawFileRevision([]byte(joined))
	}
	result := BatchEditResult{
		OK:               true,
		FirstChangedLine: firstChanged,
		LastChangedLine:  lastChanged,
		LinesAdded:       len(request.NewLines),
		LinesDeleted:     len(request.OldLines),
		EditsApplied:     1,
		ContentChanged:   contentChanged,
		Revision:         revision,
		UpdatedAnchors:   buildUpdatedAnchorContext(resultLines, firstChanged, lastChanged, len(request.NewLines)),
	}
	if !contentChanged {
		return emitJSON(result)
	}

	warning, writeErr := atomicWriteIfRevision(path, []byte(file.JoinLines(resultLines)), file.Revision)
	if writeErr != nil {
		var changedErr *sourceChangedBeforeCommitError
		if errors.As(writeErr, &changedErr) {
			return emitContentReplaceOnceError(
				"source_changed_before_commit",
				changedErr.Error(),
				changedErr.CurrentRevision,
				nil,
				0,
			)
		}
		emitError("io", writeErr.Error())
		return nil
	}
	if warning != "" {
		result.Warnings = []string{warning}
	}
	return emitJSON(result)
}
