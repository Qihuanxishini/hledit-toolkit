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
		{name: "annotated line", input: "5#aB3:func main() {", want: Anchor{Line: 5, Hash: "aB3"}},
		{name: "whitespace inside anchor", input: "  12 # xY7 :suffix", wantErr: "expected LN#HHH"},
		{name: "whitespace before annotation", input: "5#aB3 :suffix", wantErr: "expected LN#HHH"},
		{name: "trailing whitespace", input: "5#aB3   ", want: Anchor{Line: 5, Hash: "aB3"}},
		{name: "legacy two-character hash", input: "5#WS", wantErr: "expected LN#HHH"},
		{name: "trailing garbage", input: "5#aB3garbage", wantErr: "expected LN#HHH"},
		{name: "invalid format", input: "not-an-anchor", wantErr: "expected LN#HHH"},
		{name: "line zero", input: "0#aB3", wantErr: ">= 1"},
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

func TestValidateAnchors(t *testing.T) {
	t.Run("all good", func(t *testing.T) {
		lines := []string{"alpha", "", "beta"}
		anchors := []Anchor{
			{Line: 1, Hash: computeLineHash(1, lines[0])},
			{Line: 2, Hash: computeLineHash(2, lines[1])},
			{Line: 3, Hash: computeLineHash(3, lines[2])},
		}

		remaps, firstBad := validateAnchors(lines, anchors)
		if firstBad != -1 {
			t.Fatalf("firstBad = %d; want -1", firstBad)
		}
		if len(remaps) != 0 {
			t.Fatalf("remaps = %#v; want empty", remaps)
		}
	})

	t.Run("two stale anchors", func(t *testing.T) {
		lines := []string{"alpha", "beta"}
		anchors := []Anchor{
			{Line: 1, Hash: computeLineHash(1, lines[1])},
			{Line: 2, Hash: computeLineHash(2, lines[0])},
		}

		remaps, firstBad := validateAnchors(lines, anchors)
		if firstBad != 0 {
			t.Fatalf("firstBad = %d; want 0", firstBad)
		}
		if len(remaps) != 2 {
			t.Fatalf("len(remaps) = %d; want 2", len(remaps))
		}

		want0Requested := "1#" + anchors[0].Hash
		want0Current := formatTag(1, lines[0])
		if remaps[0].Requested != want0Requested || remaps[0].Current != want0Current {
			t.Fatalf("remaps[0] = %#v; want Requested %q Current %q", remaps[0], want0Requested, want0Current)
		}

		want1Requested := "2#" + anchors[1].Hash
		want1Current := formatTag(2, lines[1])
		if remaps[1].Requested != want1Requested || remaps[1].Current != want1Current {
			t.Fatalf("remaps[1] = %#v; want Requested %q Current %q", remaps[1], want1Requested, want1Current)
		}
	})
}
