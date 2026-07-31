package main

import (
	"hash/fnv"
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

// formatTag returns intToStr(lineNum) + "#" + computeLineHash(lineNum, line).
func formatTag(lineNum int, line string) string {
	return intToStr(lineNum) + "#" + computeLineHash(lineNum, line)
}

// intToStr converts an integer to a decimal string WITHOUT fmt (avoid allocations).
// It handles 0 and negatives using a fixed [20]byte buffer, building digits right-to-left.
func intToStr(n int) string {
	if n == 0 {
		return "0"
	}

	// Using a 22-byte buffer to safely handle sign and digits for 64-bit int.
	var buf [22]byte
	i := 22

	neg := false
	var un uint64
	if n < 0 {
		neg = true
		// Using unsigned conversion to handle MinInt correctly.
		un = uint64(-n)
	} else {
		un = uint64(n)
	}

	for un > 0 {
		i--
		buf[i] = byte('0' + (un % 10))
		un /= 10
	}

	if neg {
		i--
		buf[i] = '-'
	}

	return string(buf[i:])
}
