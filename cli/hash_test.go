package main

import (
	"testing"
)

func TestComputeLineHash(t *testing.T) {
	// Expected for line 2 (empty/non-significant) -> VR
	if got := computeLineHash(2, ""); got != "VR" {
		t.Errorf("computeLineHash(2, \"\") = %v; want VR", got)
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
	// If line 2 is empty, hash is VR. Tag is 2#VR
	if got := formatTag(2, ""); got != "2#VR" {
		t.Errorf("formatTag(2, \"\") = %s; want 2#VR", got)
	}
}
