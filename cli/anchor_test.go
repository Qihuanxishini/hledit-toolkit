package main

import (
	"strings"
	"testing"
)

func TestParseAnchor(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    Anchor
		wantErr string
	}{
		{name: "valid", input: "5#aB3", want: Anchor{Line: 5, Hash: "aB3"}},
		{name: "annotated line", input: "5#aB3:func main() {", wantErr: "expected LN#HHH"},
		{name: "whitespace inside anchor", input: "  12 # xY7 :suffix", wantErr: "expected LN#HHH"},
		{name: "whitespace before annotation", input: "5#aB3 :suffix", wantErr: "expected LN#HHH"},
		{name: "trailing whitespace", input: "5#aB3   ", wantErr: "expected LN#HHH"},
		{name: "legacy two-character hash", input: "5#WS", wantErr: "expected LN#HHH"},
		{name: "trailing garbage", input: "5#aB3garbage", wantErr: "expected LN#HHH"},
		{name: "invalid format", input: "not-an-anchor", wantErr: "expected LN#HHH"},
		{name: "line zero", input: "0#aB3", wantErr: "positive line number"},
		{name: "leading zero", input: "01#aB3", wantErr: "positive line number"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseAnchor(tt.input)
			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("parseAnchor(%q) = %#v, nil; want error containing %q", tt.input, got, tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("parseAnchor(%q) error = %q; want substring %q", tt.input, err.Error(), tt.wantErr)
				}
				return
			}

			if err != nil {
				t.Fatalf("parseAnchor(%q) unexpected error: %v", tt.input, err)
			}
			if got != tt.want {
				t.Fatalf("parseAnchor(%q) = %#v; want %#v", tt.input, got, tt.want)
			}
		})
	}
}
