package main

import (
	"fmt"
	"regexp"
	"strconv"
)

// [喵喵喵]: 行号不接受前导零，保证每个锚点只有一种拼写，与 formatTag 输出一致。
var anchorRE = regexp.MustCompile(`^([1-9][0-9]*)#([A-Za-z0-9_-]{3})$`)

// parseAnchor accepts only an exact LN#HHH token from the structured protocol.
func parseAnchor(s string) (Anchor, error) {
	matches := anchorRE.FindStringSubmatch(s)
	if len(matches) != 3 {
		return Anchor{}, fmt.Errorf("invalid anchor %q: expected LN#HHH with a positive line number (e.g. \"5#aB3\")", s)
	}
	lineNum, err := strconv.Atoi(matches[1])
	if err != nil {
		return Anchor{}, fmt.Errorf("invalid anchor %q: %w", s, err)
	}
	return Anchor{Line: lineNum, Hash: matches[2]}, nil
}
