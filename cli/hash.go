package main

import (
	"hash/fnv"
	"strconv"
	"strings"
	"unicode"
)

const anchorHashAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

// computeLineHash computes a 3-character URL-safe Base64 hash for a given line number and line content.
func computeLineHash(lineNum int, line string) string {
	// Trailing whitespace is presentation-only for anchor identity.
	line = strings.TrimRight(line, "\r")
	line = strings.TrimRightFunc(line, unicode.IsSpace)

	h := fnv.New32a()

	// Structural-only lines share little semantic content, so include their position to distinguish them.
	isSignificant := false
	for _, r := range line {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			isSignificant = true
			break
		}
	}

	if !isSignificant {
		n := lineNum
		for n > 0 {
			h.Write([]byte{byte(n & 0xff)})
			n >>= 8
		}
	}

	h.Write([]byte(line))
	sum := h.Sum32()

	// The v2 wire format encodes the low 18 bits as three URL-safe Base64 characters.
	return string(anchorHashAlphabet[(sum>>12)&0x3f]) + string(anchorHashAlphabet[(sum>>6)&0x3f]) + string(anchorHashAlphabet[sum&0x3f])
}

// formatTag returns the canonical LN#HHH anchor for one line.
func formatTag(lineNum int, line string) string {
	return strconv.Itoa(lineNum) + "#" + computeLineHash(lineNum, line)
}
