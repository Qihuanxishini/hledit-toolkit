package main

const updatedAnchorContextRadius = 2
const updatedAnchorMaxLines = 20
const updatedAnchorMaxBytes = 4096

func buildUpdatedAnchorContext(lines []string, firstChanged, lastChanged, linesAdded int) *AnchorContext {
	if firstChanged <= 0 {
		return nil
	}
	if len(lines) == 0 {
		return &AnchorContext{
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

	readLines, truncatedByBytes, _ := collectAnnotatedLines(
		lines,
		offset-1,
		limit,
		updatedAnchorMaxBytes,
	)

	return &AnchorContext{
		Lines:        readLines,
		Offset:       offset,
		Limit:        len(readLines),
		DesiredLimit: desiredLimit,
		Truncated:    desiredLimit > updatedAnchorMaxLines || truncatedByBytes,
	}
}

// buildCurrentAnchorContext returns a bounded window from the same snapshot that rejected a stale edit.
func buildCurrentAnchorContext(lines []string, requestedStart, requestedEnd int) *AnchorContext {
	if requestedStart <= 0 {
		return nil
	}
	if len(lines) == 0 {
		return buildUpdatedAnchorContext(lines, 1, 1, 0)
	}
	if requestedEnd <= 0 {
		requestedEnd = requestedStart
	}
	if requestedStart > requestedEnd {
		requestedStart, requestedEnd = requestedEnd, requestedStart
	}
	if requestedStart > len(lines) {
		requestedStart = len(lines)
	}
	if requestedEnd > len(lines) {
		requestedEnd = len(lines)
	}
	if requestedStart < 1 {
		requestedStart = 1
	}
	if requestedEnd < requestedStart {
		requestedEnd = requestedStart
	}
	return buildUpdatedAnchorContext(lines, requestedStart, requestedEnd, requestedEnd-requestedStart+1)
}
