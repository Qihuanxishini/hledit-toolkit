package main

const updatedAnchorContextRadius = 2
const updatedAnchorMaxLines = 20
const updatedAnchorMaxBytes = 4096

func buildUpdatedAnchorContext(lines []string, firstChanged, lastChanged, linesAdded int) *UpdatedAnchorContext {
	if firstChanged <= 0 {
		return nil
	}
	if len(lines) == 0 {
		return &UpdatedAnchorContext{
			Lines:        []ReadLine{},
			Offset:       1,
			Limit:        0,
			DesiredLimit: 0,
			Truncated:    false,
		}
	}

	start := firstChanged
	end := lastChanged
	if end <= 0 {
		end = start
	}
	if start > end {
		start, end = end, start
	}
	changedSpan := end - start + 1
	if linesAdded > changedSpan {
		changedSpan = linesAdded
	}
	if changedSpan < 1 {
		changedSpan = 1
	}

	offset := start - updatedAnchorContextRadius
	if offset < 1 {
		offset = 1
	}
	if offset > len(lines) {
		offset = len(lines)
	}
	leadingContextLines := start - offset
	if leadingContextLines < 0 {
		leadingContextLines = 0
	}
	desiredLimit := leadingContextLines + changedSpan + updatedAnchorContextRadius
	limit := desiredLimit
	if limit > updatedAnchorMaxLines {
		limit = updatedAnchorMaxLines
	}
	available := len(lines) - offset + 1
	if limit > available {
		limit = available
	}
	if limit < 0 {
		limit = 0
	}

	endExclusive := offset - 1 + limit
	boundedLines := lines[:endExclusive]
	readLines, truncatedByBytes, _ := collectAnnotatedLines(
		boundedLines,
		offset-1,
		limit,
		updatedAnchorMaxBytes,
	)

	return &UpdatedAnchorContext{
		Lines:        readLines,
		Offset:       offset,
		Limit:        limit,
		DesiredLimit: desiredLimit,
		Truncated:    desiredLimit > updatedAnchorMaxLines || truncatedByBytes,
	}
}
