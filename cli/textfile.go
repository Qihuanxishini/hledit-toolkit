package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"strings"
	"unicode/utf8"
)

var (
	errBinaryFile  = errors.New("file appears to be binary")
	errInvalidUTF8 = errors.New("file is not valid UTF-8")
)

const utf8BOM = "\xEF\xBB\xBF"

// mixedLineEndingWarning 在混合行尾文件发生内容变更时随成功写入响应返回：
// 归一化本身是文档化行为，但必须显式告知，不得让未编辑行的行尾静默变化。
const mixedLineEndingWarning = "file mixed CRLF and LF line endings; the rewritten file uses CRLF throughout"

func rawFileRevision(content []byte) string {
	digest := sha256.Sum256(content)
	return "sha256:" + hex.EncodeToString(digest[:])
}

type LoadedTextFile struct {
	Lines              []string
	LineEnding         string
	HasTrailingNewline bool
	HasUTF8BOM         bool
	// HasMixedLineEndings 表示原文件同时含 CRLF 与裸 LF。此时任何内容变更都会把
	// 整份文件统一为 CRLF（文档化行为）；写入方必须据此返回显式 warning，不得静默。
	HasMixedLineEndings bool
	Revision            string
}

func loadTextFile(path string) (LoadedTextFile, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return LoadedTextFile{}, err
	}
	return parseTextFile(content)
}

func parseTextFile(content []byte) (LoadedTextFile, error) {
	searchLimit := len(content)
	if searchLimit > 8192 {
		searchLimit = 8192
	}
	if bytes.IndexByte(content[:searchLimit], 0x00) >= 0 {
		return LoadedTextFile{}, errBinaryFile
	}
	if !utf8.Valid(content) {
		return LoadedTextFile{}, errInvalidUTF8
	}
	revision := rawFileRevision(content)

	hasUTF8BOM := bytes.HasPrefix(content, []byte(utf8BOM))
	if hasUTF8BOM {
		content = content[len(utf8BOM):]
	}

	lineEnding := "\n"
	if bytes.Contains(content, []byte("\r\n")) {
		lineEnding = "\r\n"
	}

	text := string(content)
	// 裸 LF 数量 = \n 总数 - \r\n 数量；与 CRLF 并存即为混合行尾。
	hasMixedLineEndings := lineEnding == "\r\n" && strings.Count(text, "\n") > strings.Count(text, "\r\n")
	hasTrailingNewline := strings.HasSuffix(text, "\n")
	lines := splitTextFile(text)
	return LoadedTextFile{
		Lines:               lines,
		LineEnding:          lineEnding,
		HasTrailingNewline:  hasTrailingNewline,
		HasUTF8BOM:          hasUTF8BOM,
		HasMixedLineEndings: hasMixedLineEndings,
		Revision:            revision,
	}, nil
}

func splitTextFile(text string) []string {
	lines := strings.Split(text, "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	for i := range lines {
		lines[i] = strings.TrimSuffix(lines[i], "\r")
	}
	return lines
}

func (f LoadedTextFile) JoinLines(lines []string) string {
	joined := strings.Join(lines, f.LineEnding)
	if f.HasTrailingNewline && len(lines) > 0 {
		joined += f.LineEnding
	}
	if f.HasUTF8BOM {
		joined = utf8BOM + joined
	}
	return joined
}
