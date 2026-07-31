package main

// [喵喵喵]: Snapline 混合行尾逐行保留回归矩阵 (2026-07-31)。
// 未修改行保留原 terminator；替换末行继承消费范围末行 terminator；新行使用
// 编辑位置附近的局部样式；BOM 与 trailing-newline 状态保持。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func runMixedEOLSnaplineApply(t *testing.T, original string, request SnaplineApplyRequest) (SnaplineApplyResult, string) {
	t.Helper()
	directory := t.TempDir()
	path := filepath.Join(directory, "mixed.txt")
	if err := os.WriteFile(path, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	file, err := parseTextFile([]byte(original))
	if err != nil {
		t.Fatal(err)
	}
	request.ProtocolVersion = 1
	request.Path = path
	request.ExpectedRevision = file.Revision
	request.Proof = []SnaplineProofRange{}
	if len(file.Lines) > 0 {
		request.Proof = []SnaplineProofRange{{Start: 1, Lines: append([]string(nil), file.Lines...)}}
	}
	if request.Replacements == nil {
		request.Replacements = []SnaplineReplacement{}
	}
	if request.Deletions == nil {
		request.Deletions = []SnaplineDeletion{}
	}
	if request.InsertionsBefore == nil {
		request.InsertionsBefore = []SnaplineInsertion{}
	}
	if request.InsertionsAfter == nil {
		request.InsertionsAfter = []SnaplineInsertion{}
	}
	output := snaplineApplyJSON(t, request)
	var result SnaplineApplyResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatalf("decode apply result: %v (output=%q)", err, output)
	}
	if !result.OK || result.Outcome != "applied" || !result.ContentChanged {
		t.Fatalf("apply result = %#v", result)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if result.NewRevision != rawFileRevision(content) {
		t.Fatalf("revision = %q; want %q", result.NewRevision, rawFileRevision(content))
	}
	return result, string(content)
}

func TestSnaplineMixedEOLMatrix(t *testing.T) {
	tests := map[string]struct {
		original string
		request  SnaplineApplyRequest
		want     string
	}{
		"replace preserves untouched terminators": {
			original: "a\r\nb\nc\r\nd\n",
			request:  SnaplineApplyRequest{Replacements: []SnaplineReplacement{{Start: 2, End: 2, Text: "B"}}},
			want:     "a\r\nB\nc\r\nd\n",
		},
		"replace first line keeps CRLF": {
			original: "a\r\nb\nc\r\nd\n",
			request:  SnaplineApplyRequest{Replacements: []SnaplineReplacement{{Start: 1, End: 1, Text: "A"}}},
			want:     "A\r\nb\nc\r\nd\n",
		},
		"expansion uses local style": {
			original: "a\r\nb\nc\r\nd\n",
			request:  SnaplineApplyRequest{Replacements: []SnaplineReplacement{{Start: 2, End: 2, Text: "X\nY"}}},
			want:     "a\r\nX\nY\nc\r\nd\n",
		},
		"range replacement inherits range end": {
			original: "a\r\nb\nc\r\nd\n",
			request:  SnaplineApplyRequest{Replacements: []SnaplineReplacement{{Start: 2, End: 3, Text: "BC"}}},
			want:     "a\r\nBC\r\nd\n",
		},
		"insert before first uses forward style": {
			original: "a\r\nb\nc\r\nd\n",
			request:  SnaplineApplyRequest{InsertionsBefore: []SnaplineInsertion{{Line: 1, Text: "N"}}},
			want:     "N\r\na\r\nb\nc\r\nd\n",
		},
		"insert after uses boundary style": {
			original: "a\r\nb\nc\r\nd\n",
			request:  SnaplineApplyRequest{InsertionsAfter: []SnaplineInsertion{{Line: 2, Text: "N"}}},
			want:     "a\r\nb\nN\nc\r\nd\n",
		},
		"insert after unterminated last line": {
			original: "a\r\nb",
			request:  SnaplineApplyRequest{InsertionsAfter: []SnaplineInsertion{{Line: 2, Text: "N"}}},
			want:     "a\r\nb\r\nN",
		},
		"delete through EOF preserves absent trailing newline": {
			original: "a\r\nb\nc",
			request:  SnaplineApplyRequest{Deletions: []SnaplineDeletion{{Start: 2, End: 3}}},
			want:     "a",
		},
		"delete last line preserves trailing newline": {
			original: "a\r\nb\n",
			request:  SnaplineApplyRequest{Deletions: []SnaplineDeletion{{Start: 2, End: 2}}},
			want:     "a\r\n",
		},
		"delete all lines produces empty file": {
			original: "a\r\nb\n",
			request:  SnaplineApplyRequest{Deletions: []SnaplineDeletion{{Start: 1, End: 2}}},
			want:     "",
		},
		"multiple edits preserve each region": {
			original: "a\r\nb\nc\r\nd\ne\r\n",
			request: SnaplineApplyRequest{
				Replacements:    []SnaplineReplacement{{Start: 1, End: 1, Text: "A"}},
				Deletions:       []SnaplineDeletion{{Start: 4, End: 4}},
				InsertionsAfter: []SnaplineInsertion{{Line: 3, Text: "N"}},
			},
			want: "A\r\nb\nc\r\nN\r\ne\r\n",
		},
		"BOM is preserved": {
			original: utf8BOM + "a\r\nb\n",
			request:  SnaplineApplyRequest{Replacements: []SnaplineReplacement{{Start: 2, End: 2, Text: "B"}}},
			want:     utf8BOM + "a\r\nB\n",
		},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			_, content := runMixedEOLSnaplineApply(t, test.original, test.request)
			if content != test.want {
				t.Fatalf("content = %q; want %q", content, test.want)
			}
		})
	}
}
