package main

import (
	"strings"
	"testing"
)

func TestComputeLineHash(t *testing.T) {
	tests := []struct {
		name string
		line int
		text string
		want string
	}{
		{name: "significant text", line: 1, text: "alpha", want: "22r"},
		{name: "structural text", line: 2, text: "!!!", want: "SKi"},
		{name: "empty line", line: 2, want: "GBF"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := computeLineHash(tt.line, tt.text)
			if got != tt.want {
				t.Fatalf("computeLineHash(%d, %q) = %q; want %q", tt.line, tt.text, got, tt.want)
			}
			if len(got) != 3 || strings.IndexFunc(got, func(r rune) bool { return !strings.ContainsRune(anchorHashAlphabet, r) }) >= 0 {
				t.Fatalf("computeLineHash(%d, %q) = %q; want a three-character URL-safe Base64 hash", tt.line, tt.text, got)
			}
		})
	}
}

func TestIntToStr(t *testing.T) {
	tests := []struct {
		input int
		want  string
	}{
		{0, "0"},
		{123, "123"},
		{-123, "-123"},
		{123456789, "123456789"},
		{-123456789, "-123456789"},
		{-9223372036854775808, "-9223372036854775808"},
	}
	for _, tt := range tests {
		got := intToStr(tt.input)
		if got != tt.want {
			t.Errorf("intToStr(%d) = %s; want %s", tt.input, got, tt.want)
		}
	}
}

func TestFormatTag(t *testing.T) {
	// If line 2 is empty, hash is GBF. Tag is 2#GBF.
	if got := formatTag(2, ""); got != "2#GBF" {
		t.Errorf("formatTag(2, \"\") = %s; want 2#GBF", got)
	}
}
