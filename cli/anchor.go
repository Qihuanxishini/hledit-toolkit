package main

import (
	"fmt"
	"regexp"
)

var anchorRE = regexp.MustCompile(`^(\d+)#([A-Za-z0-9_-]{3})(?::.*)?\s*$`)

// parseAnchor accepts a strict LN#HHH anchor with an optional direct :text annotation.
func parseAnchor(s string) (Anchor, error) {
	matches := anchorRE.FindStringSubmatch(s)
	if len(matches) != 3 {
		return Anchor{}, fmt.Errorf("invalid anchor %q: expected LN#HHH (e.g. \"5#aB3\")", s)
	}

	var lineNum int
	_, err := fmt.Sscanf(matches[1], "%d", &lineNum)
	if err != nil {
		return Anchor{}, err
	}

	if lineNum < 1 {
		return Anchor{}, fmt.Errorf("anchor line number must be >= 1, got %d in %q", lineNum, s)
	}

	return Anchor{Line: lineNum, Hash: matches[2]}, nil
}

// validateAnchors iterates through a set of anchors and returns remaps for any stale ones.
// Out-of-range anchors are treated as stale with an empty Current tag.
func validateAnchors(lines []string, anchors []Anchor) (remaps []Remap, firstBad int) {
	firstBad = -1
	for i, a := range anchors {
		requestedTag := intToStr(a.Line) + "#" + a.Hash

		var currentTag string
		if a.Line >= 1 && a.Line <= len(lines) {
			currentTag = formatTag(a.Line, lines[a.Line-1])
		}

		if currentTag != requestedTag {
			if firstBad == -1 {
				firstBad = i
			}
			remaps = append(remaps, Remap{
				Requested: requestedTag,
				Current:   currentTag,
			})
		}
	}
	return remaps, firstBad
}
