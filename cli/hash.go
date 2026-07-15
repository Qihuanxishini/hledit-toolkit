package main

import (
	"hash/fnv"
	"strings"
	"unicode"
)

const alphabet = "ZPMQVRWSNKTXJBYH"

// computeLineHash computes a 2-character hash for a given line number and line content.
func computeLineHash(lineNum int, line string) string {
	// 1. line = trimRight(line, '\r') then trimRight of whitespace (unicode.IsSpace)
	line = strings.TrimRight(line, "\r")
	line = strings.TrimRightFunc(line, unicode.IsSpace)

	h := fnv.New32a()

	// 2. Determine if line is "significant": contains at least one unicode.IsLetter OR unicode.IsDigit rune.
	isSignificant := false
	for _, r := range line {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			isSignificant = true
			break
		}
	}

	// If NOT significant, mix lineNum into the FNV-1a state BEFORE the content:
	// write lineNum as a little-endian byte sequence (for n>0: h.Write([]byte{byte(n & 0xff)}); n >>= 8, repeat).
	if !isSignificant {
		n := lineNum
		for n > 0 {
			h.Write([]byte{byte(n & 0xff)})
			n >>= 8
		}
	}

	// 3. h := fnv.New32a(); h.Write([]byte(line)); sum := h.Sum32()
	h.Write([]byte(line))
	sum := h.Sum32()

	// 4. lo := byte(sum & 0xff)
	lo := byte(sum & 0xff)

	// 5. return two chars: nibble(lo>>4) + nibble(lo&0x0f) using alphabet "ZPMQVRWSNKTXJBYH"
	h1 := lo >> 4
	h2 := lo & 0x0f

	return string(alphabet[h1]) + string(alphabet[h2])
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
