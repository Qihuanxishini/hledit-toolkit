package main

import (
	"strings"
	"testing"
)

func validReadRequestJSON(path string) string {
	return `{"protocolVersion":1,"path":"` + path + `","windows":[{"offset":1,"limit":160}]}`
}

func validApplyRequestJSON(path, revision string) string {
	return `{"protocolVersion":1,"path":"` + path + `","expectedRevision":"` + revision + `","proof":[],"replacements":[],"deletions":[],"insertionsBefore":[],"insertionsAfter":[]}`
}

func TestParseSnaplineReadRequestStrict(t *testing.T) {
	request, failure := parseSnaplineReadRequest([]byte(validReadRequestJSON("file.txt")))
	if failure != nil || request.Path != "file.txt" || len(request.Windows) != 1 {
		t.Fatalf("request/failure = %#v / %#v", request, failure)
	}
	for name, input := range map[string]string{
		"unknown root":     `{"protocolVersion":1,"path":"x","windows":[{"offset":1,"limit":1}],"extra":true}`,
		"unknown nested":   `{"protocolVersion":1,"path":"x","windows":[{"offset":1,"limit":1,"extra":true}]}`,
		"duplicate root":   `{"protocolVersion":1,"path":"x","path":"y","windows":[{"offset":1,"limit":1}]}`,
		"duplicate nested": `{"protocolVersion":1,"path":"x","windows":[{"offset":1,"offset":2,"limit":1}]}`,
		"null path":        `{"protocolVersion":1,"path":null,"windows":[{"offset":1,"limit":1}]}`,
		"NUL path":         `{"protocolVersion":1,"path":"\u0000","windows":[{"offset":1,"limit":1}]}`,
		"decimal offset":   `{"protocolVersion":1,"path":"x","windows":[{"offset":1.5,"limit":1}]}`,
		"zero limit":       `{"protocolVersion":1,"path":"x","windows":[{"offset":1,"limit":0}]}`,
		"empty windows":    `{"protocolVersion":1,"path":"x","windows":[]}`,
		"two documents":    validReadRequestJSON("x") + `{}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, failure := parseSnaplineReadRequest([]byte(input)); failure == nil || failure.Code != "invalid_request" {
				t.Fatalf("failure = %#v", failure)
			}
		})
	}
}

func TestParseSnaplineReadRequestWindowLimit(t *testing.T) {
	windows := strings.Repeat(`{"offset":1,"limit":1},`, 64) + `{"offset":1,"limit":1}`
	input := `{"protocolVersion":1,"path":"x","windows":[` + windows + `]}`
	if _, failure := parseSnaplineReadRequest([]byte(input)); failure == nil {
		t.Fatal("expected 65-window rejection")
	}
}

func TestParseSnaplineApplyRequestStrict(t *testing.T) {
	revision := "sha256:" + strings.Repeat("a", 64)
	input := `{"protocolVersion":1,"path":"x","expectedRevision":"` + revision + `","proof":[{"start":1,"lines":["a"]}],"replacements":[{"start":1,"end":1,"text":"A"}],"deletions":[],"insertionsBefore":[],"insertionsAfter":[]}`
	request, failure := parseSnaplineApplyRequest([]byte(input))
	if failure != nil || len(request.Proof) != 1 || len(request.Replacements) != 1 {
		t.Fatalf("request/failure = %#v / %#v", request, failure)
	}
	for name, malformed := range map[string]string{
		"missing group":  `{"protocolVersion":1,"path":"x","expectedRevision":"` + revision + `","proof":[],"replacements":[],"deletions":[],"insertionsBefore":[]}`,
		"null proof":     strings.Replace(validApplyRequestJSON("x", revision), `"proof":[]`, `"proof":null`, 1),
		"NUL path":       strings.Replace(validApplyRequestJSON("x", revision), `"path":"x"`, `"path":"\u0000"`, 1),
		"unknown item":   strings.Replace(input, `"text":"A"`, `"text":"A","lines":[]`, 1),
		"duplicate item": `{"protocolVersion":1,"path":"x","expectedRevision":"` + revision + `","proof":[],"replacements":[{"start":1,"end":1,"text":"A","text":"B"}],"deletions":[],"insertionsBefore":[],"insertionsAfter":[]}`,
		"numeric text":   strings.Replace(input, `"text":"A"`, `"text":1`, 1),
		"null array":     strings.Replace(input, `"deletions":[]`, `"deletions":null`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, failure := parseSnaplineApplyRequest([]byte(malformed)); failure == nil || failure.Code != "invalid_request" {
				t.Fatalf("failure = %#v", failure)
			}
		})
	}
}

func TestDecodeSnaplineTextTerminalLF(t *testing.T) {
	for _, test := range []struct {
		text       string
		want       []string
		endsWithLF bool
	}{
		{text: "", want: []string{""}},
		{text: "a", want: []string{"a"}},
		{text: "a\n", want: []string{"a"}, endsWithLF: true},
		{text: "a\n\n", want: []string{"a", ""}, endsWithLF: true},
		{text: "\n\n", want: []string{"", ""}, endsWithLF: true},
	} {
		decoded, err := decodeSnaplineText(test.text)
		if err != nil || !equalSnaplineLines(decoded.lines, test.want) || decoded.endsWithLF != test.endsWithLF {
			t.Fatalf("decode %q = %#v, %v", test.text, decoded, err)
		}
	}
	for _, text := range []string{"a\r\n", "a\x00b"} {
		if _, err := decodeSnaplineText(text); err == nil {
			t.Fatalf("decode %q unexpectedly succeeded", text)
		}
	}
}

func TestValidSnaplineRevision(t *testing.T) {
	if !validSnaplineRevision("sha256:" + strings.Repeat("0", 64)) {
		t.Fatal("valid revision rejected")
	}
	for _, invalid := range []string{"", strings.Repeat("0", 64), "sha256:" + strings.Repeat("A", 64), "sha256:" + strings.Repeat("0", 63)} {
		if validSnaplineRevision(invalid) {
			t.Fatalf("invalid revision accepted: %q", invalid)
		}
	}
}

func TestParseSnaplineApplyRequestGroupLimit(t *testing.T) {
	revision := "sha256:" + strings.Repeat("a", 64)
	items := strings.Repeat(`{"start":1,"end":1,"text":"x"},`, 100) + `{"start":1,"end":1,"text":"x"}`
	input := `{"protocolVersion":1,"path":"x","expectedRevision":"` + revision + `","proof":[],"replacements":[` + items + `],"deletions":[],"insertionsBefore":[],"insertionsAfter":[]}`
	if _, failure := parseSnaplineApplyRequest([]byte(input)); failure == nil || failure.Code != "invalid_request" {
		t.Fatalf("failure = %#v", failure)
	}
}

func TestLogicalFailureMessageIsBounded(t *testing.T) {
	unknownField := strings.Repeat("界", 2000)
	input := `{"` + unknownField + `":true,"protocolVersion":1,"path":"x","windows":[{"offset":1,"limit":1}]}`
	_, failure := parseSnaplineReadRequest([]byte(input))
	if failure == nil || failure.Code != "invalid_request" {
		t.Fatalf("failure = %#v", failure)
	}
	if len(failure.Message) > snaplineMessageByteLimit || !strings.HasSuffix(failure.Message, "…") {
		t.Fatalf("bounded message = %d bytes, suffix present: %t", len(failure.Message), strings.HasSuffix(failure.Message, "…"))
	}
}
